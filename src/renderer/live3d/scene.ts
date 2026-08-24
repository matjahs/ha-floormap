import type { FloorplanIR, CameraIR } from "../../import/ir";
import { pointInPolygon } from "../../import/ir";
import type { LightParams, Vec3 } from "../../types";
import type { SunShading } from "../../sun";
import {
  resolveFixtureKind,
  resolveStripSamples,
  stripSamplePositions,
} from "../../strip";
import { groupHue } from "../../groups";
import { isCeilingObject } from "./ceilings";
import {
  isTransparentGlassMaterial,
  simplifyGltfMaterial,
} from "./gltf-materials";
import {
  geographicNorthRenderDir,
  horizontalDirToScreenDeg,
  PLAN_NORTH_RENDER_DIR,
  type CompassBearings,
} from "../../compass";
import type {
  Scene,
  PerspectiveCamera,
  PointLight,
  Color,
  Mesh,
  Raycaster,
  Plane,
  Object3D,
} from "three";
import {
  createLive3dGpuRenderer,
  type Live3dGpuBackend,
} from "./renderer-backend";

export interface Live3dHandle {
  canvas: HTMLCanvasElement;
  /** Active GPU backend after init (WebGPURenderer may fall back to WebGL2). */
  rendererBackend: Live3dGpuBackend;
  setLight(fixtureId: string, params: LightParams): void;
  /** Per-sample params for strip fixtures (length = sample count). */
  setLightSamples(fixtureId: string, params: LightParams[]): void;
  setLightPosition(fixtureId: string, pos: Vec3): void;
  /** Move strip while preserving start→end vector (translate by delta from old start). */
  setStripPose(fixtureId: string, start: Vec3, end: Vec3): void;
  setCamera(cam: CameraIR): void;
  /** No-op: view is always the locked miniature dollhouse framing. */
  setEditTopDown(enabled: boolean): void;
  /** No-op: orbit is always disabled (fixed dollhouse camera). */
  setOrbitEnabled(enabled: boolean): void;
  setHandlesVisible(visible: boolean): void;
  /** Raycast floor plane; keeps Z elevation from current light or default. */
  raycastFloor(
    clientX: number,
    clientY: number,
    fixtureId?: string,
  ): Vec3 | null;
  /** Pick nearest light handle under pointer (optional allow-list). */
  pickFixture(
    clientX: number,
    clientY: number,
    allowedIds?: Set<string>,
  ): string | null;
  /** Drive directional sun / ambient from HA sun.sun (or clock fallback). */
  setSun(shading: SunShading): void;
  /** Screen bearings for geographic N, plan +Y, and sun (playground compass). */
  getCompassBearings(): CompassBearings;
  resize(width: number, height: number): void;
  render(): void;
  dispose(): void;
}

export interface Live3dOptions {
  /** Initial poses keyed by fixture id (plan cm). */
  poses?: Record<string, Vec3>;
  /** Strip endpoints keyed by fixture id. */
  stripEnds?: Record<string, Vec3>;
  levelElevation?: number;
  /** When set, only these fixtures get visible/pickable edit handles. */
  editableFixtureIds?: string[];
  /** Display labels for edit handles (friendly name / entity). */
  editableFixtureLabels?: Record<string, string>;
  /** Room/tag id per fixture — colors edit markers by room. */
  editableFixtureRooms?: Record<string, string>;
  /** Full-scene GLB (Blender export). Skips extruded FML/SH3D meshes. */
  sceneGltfUrl?: string;
  /** Compass heading of plan +Y (degrees geographic). Default 0. */
  planNorthDeg?: number;
  /** live3d GPU API — default webgpu (falls back to WebGL2 when unavailable). */
  gpu?: Live3dGpuBackend;
}

function planToRender(pos: Vec3): { x: number; y: number; z: number } {
  // SH3D plan X/Y, Z elevation → three.js Y-up
  return { x: pos.x, y: pos.z, z: pos.y };
}

function renderToPlan(x: number, y: number, z: number): Vec3 {
  return { x, y: z, z: y };
}

/**
 * Export tags Blender Ceilings with this prefix (avoid matching "Living ceiling" fixtures).
 * Ceilings stay on the default layer so they cast into the sun shadow map. WebGLShadowMap
 * tests casters against the *main* camera layers, so a separate hidden layer never works.
 */

/** Collapse glTF PBR materials — see gltf-materials.ts */
function assignSimplifiedMaterials(
  mesh: Mesh,
  THREE: typeof import("three"),
): void {
  if (Array.isArray(mesh.material)) {
    mesh.material = mesh.material.map((m) => simplifyGltfMaterial(m, THREE, mesh.name));
    return;
  }
  mesh.material = simplifyGltfMaterial(mesh.material, THREE, mesh.name);
}

function prepareGltfMesh(
  mesh: Mesh,
  THREE: typeof import("three"),
  opts: { ceiling?: boolean; castShadow?: boolean; receiveShadow?: boolean },
): void {
  assignSimplifiedMaterials(mesh, THREE);
  const ceiling = opts.ceiling ?? isCeilingObject(mesh);
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const glass = mats.every((m) => isTransparentGlassMaterial(m));
  mesh.castShadow = opts.castShadow ?? (ceiling && !glass);
  mesh.receiveShadow = opts.receiveShadow ?? !ceiling;
  if (ceiling) {
    for (const m of mats) {
      // Invisible in dollhouse color pass; WebGLShadowMap still depth-renders casters.
      m.colorWrite = false;
      m.depthWrite = false;
      m.side = THREE.DoubleSide;
    }
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
      side: THREE.DoubleSide,
    });
  }
}

/**
 * Dynamic three.js scene from IR. Loaded only in live3d mode.
 */
export async function createLive3dRenderer(
  ir: FloorplanIR,
  canvas: HTMLCanvasElement,
  initialCamera?: CameraIR,
  opts: Live3dOptions = {},
): Promise<Live3dHandle> {
  const gpu = opts.gpu ?? "webgpu";
  const { renderer, three: THREE, active: rendererBackend } = await createLive3dGpuRenderer(
    canvas,
    gpu,
  );

  const scene: Scene = new THREE.Scene();
  scene.background = new THREE.Color("#e6e6e4");

  const camera: PerspectiveCamera = new THREE.PerspectiveCamera(50, 1, 1, 100000);
  const lookTarget = new THREE.Vector3();

  const useSceneMesh = Boolean(opts.sceneGltfUrl);
  const fixtureLightScale = useSceneMesh ? 680 : 1400;
  // Blender GLB has no baked lighting; keep readable when HA lights are off.
  const amb = new THREE.AmbientLight(0xb8b4ac, useSceneMesh ? 0.58 : 0.22);
  scene.add(amb);

  const planCx = (ir.bounds.min.x + ir.bounds.max.x) / 2;
  const planCz = (ir.bounds.min.y + ir.bounds.max.y) / 2;
  const planW = Math.max(100, ir.bounds.max.x - ir.bounds.min.x);
  const planD = Math.max(100, ir.bounds.max.y - ir.bounds.min.y);
  const sunDist = Math.max(2500, Math.hypot(planW, planD) * 1.4);
  const shadowExtent = Math.max(planW, planD) * 0.88;

  const sun = new THREE.DirectionalLight(0xfff5ea, useSceneMesh ? 0.85 : 0.16);
  sun.position.set(planCx + 600, 1100, planCz + 500);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.8;
  sun.shadow.camera.left = -shadowExtent;
  sun.shadow.camera.right = shadowExtent;
  sun.shadow.camera.top = shadowExtent;
  sun.shadow.camera.bottom = -shadowExtent;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = sunDist * 2.2;
  sun.target.position.set(planCx, 0, planCz);
  scene.add(sun);
  scene.add(sun.target);

  const fill = new THREE.DirectionalLight(0xe8eef5, useSceneMesh ? 0.35 : 0.08);
  fill.position.set(planCx - 400, 600, planCz - 300);
  fill.castShadow = false;
  scene.add(fill);

  let lastSun: SunShading | null = null;
  let lastSunAzimuth: number | null = null;
  let lastSunElevation: number | null = null;
  const planNorthConfigDeg = opts.planNorthDeg ?? 0;
  const cameraBasis = new Float64Array(6);

  const applySun = (shading: SunShading): void => {
    lastSun = shading;
    // GLB scene: keep ambient low when sun is active so ceiling shadows read.
    const sceneAmbScale = useSceneMesh ? 0.38 : 0.38;
    const sceneFillScale = useSceneMesh ? 0.48 : 0.24;
    const sceneSunScale = useSceneMesh ? 1.12 : 0.22;

    if (!shading.enabled) {
      amb.color.setHex(0xb8b4ac);
      amb.intensity = useSceneMesh ? 0.58 : 0.22;
      sun.color.setHex(0xfff5ea);
      sun.intensity = useSceneMesh ? 0.72 : 0.16;
      sun.position.set(planCx + 600, 1100, planCz + 500);
      sun.castShadow = useSceneMesh;
      fill.color.setHex(0xe8eef5);
      fill.intensity = useSceneMesh ? 0.22 : 0.08;
      fill.position.set(planCx - 400, 600, planCz - 300);
      scene.background = new THREE.Color("#e6e6e4");
      renderer.setClearColor(0xe6e6e4, 1);
      sun.target.position.set(planCx, shading.targetElevationCm, planCz);
      return;
    }
    const d = shading.direction;
    const lift = Math.max(0.04, d.y);
    sun.position.set(planCx + d.x * sunDist, lift * sunDist, planCz + d.z * sunDist);
    sun.target.position.set(planCx, shading.targetElevationCm, planCz);
    sun.color.setRGB(shading.sunColor[0], shading.sunColor[1], shading.sunColor[2]);
    sun.intensity = shading.sunIntensity * sceneSunScale;
    sun.castShadow = useSceneMesh && shading.sunIntensity > 0.02;
    amb.color.setRGB(
      shading.ambientColor[0],
      shading.ambientColor[1],
      shading.ambientColor[2],
    );
    amb.intensity = shading.ambientIntensity * sceneAmbScale;
    fill.position.set(
      planCx - d.x * sunDist * 0.55,
      Math.max(400, Math.abs(d.y) * sunDist * 0.4),
      planCz - d.z * sunDist * 0.55,
    );
    fill.color.setRGB(shading.fillColor[0], shading.fillColor[1], shading.fillColor[2]);
    fill.intensity = shading.fillIntensity * sceneFillScale;
    const sky = new THREE.Color().setRGB(shading.sky[0], shading.sky[1], shading.sky[2]);
    scene.background = sky;
    renderer.setClearColor(sky, 1);
  };

  const texLoader = new THREE.TextureLoader();
  const texCache = new Map<string, import("three").Texture>();
  const loadTex = async (url: string | undefined) => {
    if (!url) {
      return null;
    }
    if (texCache.has(url)) {
      return texCache.get(url)!;
    }
    try {
      const tex = await texLoader.loadAsync(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      texCache.set(url, tex);
      return tex;
    } catch (err) {
      console.warn("[live3d] texture load failed", url, err);
      return null;
    }
  };

  // Full-plan slab so the stage is never an empty clear-color void.
  if (!useSceneMesh) {
    const minX = ir.bounds.min.x;
    const maxX = ir.bounds.max.x;
    const minZ = ir.bounds.min.y;
    const maxZ = ir.bounds.max.y;
    const w = Math.max(100, maxX - minX);
    const d = Math.max(100, maxZ - minZ);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 200, d + 200),
      new THREE.MeshStandardMaterial({ color: 0x3a3f48, roughness: 1, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((minX + maxX) / 2, (opts.levelElevation ?? 0) - 1, (minZ + maxZ) / 2);
    ground.receiveShadow = true;
    scene.add(ground);
  }

  if (!useSceneMesh) {
  for (const room of ir.rooms) {
    if (room.polygon.length < 3) {
      continue;
    }
    const shape = new THREE.Shape();
    room.polygon.forEach((p, i) => {
      if (i === 0) {
        shape.moveTo(p.x, p.y);
      } else {
        shape.lineTo(p.x, p.y);
      }
    });
    const geo = new THREE.ShapeGeometry(shape);
    const pos = geo.attributes.position!;
    // Planar UVs in cm for texture tiling.
    const uvs = new Float32Array(pos.count * 2);
    const tileW = Math.max(1, room.tileWidthCm ?? 100);
    const tileH = Math.max(1, room.tileHeightCm ?? 100);
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const py = pos.getY(i);
      pos.setXYZ(i, px, 0, py);
      uvs[i * 2] = px / tileW;
      uvs[i * 2 + 1] = py / tileH;
    }
    pos.needsUpdate = true;
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    const map = await loadTex(room.floorTexture);
    const color = room.color ? new THREE.Color(room.color) : new THREE.Color(0xb0aaa3);
    const mat = map
      ? new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map,
        roughness: 0.65,
        metalness: 0.02,
        side: THREE.DoubleSide,
      })
      : new THREE.MeshStandardMaterial({
        color,
        roughness: 0.9,
        metalness: 0.05,
        side: THREE.DoubleSide,
      });
    const elev = ir.levels.find((l) => l.id === room.levelId)?.elevation ?? 0;
    const mesh = new THREE.Mesh(geo, mat);
    // Lift textured surfaces above area fills so kitchen vinyl isn't buried.
    mesh.position.y = elev + (map ? 1.5 : 0);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  }

  // Interior: RAL 9010 (home photos). Exterior cladding: Floorplanner FML textures.
  // Dollhouse section caps: Floorplanner paints cut tops near-black.
  const RAL_9010 = 0xf2efe7;
  const defaultWallMat = new THREE.MeshStandardMaterial({
    color: RAL_9010,
    roughness: 0.88,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  const wallCapMat = new THREE.MeshStandardMaterial({
    color: 0x1c1c1c,
    roughness: 0.75,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  const isIndoorRoom = (name?: string) => {
    return !/balcony|balkon|terrace|patio/i.test(name ?? "");
  };
  const sideFacesIndoor = (
    midX: number,
    midY: number,
    nx: number,
    ny: number,
    probeDist: number,
    levelId?: string,
  ): boolean => {
    const p = { x: midX + nx * probeDist, y: midY + ny * probeDist };
    return ir.rooms.some((room) => {
      if (!isIndoorRoom(room.name)) {
        return false;
      }
      if (levelId && room.levelId && room.levelId !== levelId) {
        return false;
      }
      return pointInPolygon(p, room.polygon);
    });
  };
  const mkCladMat = (
    map: import("three").Texture | null,
    segLen: number,
    height: number,
    tileW: number,
    tileH: number,
  ) => {
    if (!map) {
      return defaultWallMat;
    }
    const tex = map.clone();
    tex.needsUpdate = true;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(Math.max(0.01, segLen / tileW), Math.max(0.01, height / tileH));
    return new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex,
      roughness: 0.92,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
  };
  const sectionCap =
    ir.environment.wallSectionHeight && ir.environment.wallSectionHeight > 0
      ? ir.environment.wallSectionHeight
      : undefined;
  // Openings aren't keyed by wall id in IR; match by proximity to wall segment.
  if (!useSceneMesh) {
  for (const wall of ir.walls) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const len = Math.hypot(dx, dy) || 1;
    const fullHeight = wall.height ?? 250;
    const height = sectionCap ? Math.min(fullHeight, sectionCap) : fullHeight;
    const elev = ir.levels.find((l) => l.id === wall.levelId)?.elevation ?? 0;
    const angle = -Math.atan2(dy, dx);

    const leftMap = await loadTex(wall.leftTexture);
    const rightMap = await loadTex(wall.rightTexture);
    const tileW = Math.max(1, wall.tileWidthCm ?? 100);
    const tileH = Math.max(1, wall.tileHeightCm ?? 100);
    // Any FML cladding can be used on true exterior; FML left/right is often swapped.
    const cladMap = leftMap ?? rightMap;

    const midX = (wall.start.x + wall.end.x) / 2;
    const midY = (wall.start.y + wall.end.y) / 2;
    // Floorplanner left = left-hand walking start→end → plan normal (-dy, dx).
    const leftNx = -dy / len;
    const leftNy = dx / len;
    const probeDist = Math.max(12, wall.thickness * 0.5 + 8);
    const leftIndoor = sideFacesIndoor(midX, midY, leftNx, leftNy, probeDist, wall.levelId);
    const rightIndoor = sideFacesIndoor(midX, midY, -leftNx, -leftNy, probeDist, wall.levelId);

    const nearOpenings = ir.openings.filter((o) => {
      if (o.levelId && wall.levelId && o.levelId !== wall.levelId) {
        return false;
      }
      // Project opening onto wall line; keep if within thickness band and segment.
      const wx = o.position.x - wall.start.x;
      const wy = o.position.y - wall.start.y;
      const t = (wx * dx + wy * dy) / (len * len);
      if (t < -0.02 || t > 1.02) {
        return false;
      }
      const px = wall.start.x + dx * t;
      const py = wall.start.y + dy * t;
      const dist = Math.hypot(o.position.x - px, o.position.y - py);
      return dist <= wall.thickness + 5;
    });

    // Build solid wall segments around openings (section-height cuts).
    type Span = { t0: number; t1: number };
    const cuts: Span[] = nearOpenings
      .map((o) => {
        const wx = o.position.x - wall.start.x;
        const wy = o.position.y - wall.start.y;
        const t = (wx * dx + wy * dy) / (len * len);
        const half = (o.width * 0.5) / len;
        return { t0: Math.max(0, t - half), t1: Math.min(1, t + half) };
      })
      .sort((a, b) => a.t0 - b.t0);
    const spans: Span[] = [];
    let cursor = 0;
    for (const cut of cuts) {
      if (cut.t0 > cursor + 0.001) {
        spans.push({ t0: cursor, t1: cut.t0 });
      }
      cursor = Math.max(cursor, cut.t1);
    }
    if (cursor < 0.999) {
      spans.push({ t0: cursor, t1: 1 });
    }
    if (spans.length === 0) {
      spans.push({ t0: 0, t1: 1 });
    }

    for (const span of spans) {
      const segLen = (span.t1 - span.t0) * len;
      if (segLen < 1) {
        continue;
      }
      const sx = wall.start.x + dx * span.t0;
      const sy = wall.start.y + dy * span.t0;
      const ex = wall.start.x + dx * span.t1;
      const ey = wall.start.y + dy * span.t1;
      const geo = new THREE.BoxGeometry(segLen, height, wall.thickness);
      // Prefer own-side texture; fall back so exterior still gets Floorplanner cladding.
      const leftMat = leftIndoor
        ? defaultWallMat
        : mkCladMat(leftMap ?? cladMap, segLen, height, tileW, tileH);
      const rightMat = rightIndoor
        ? defaultWallMat
        : mkCladMat(rightMap ?? cladMap, segLen, height, tileW, tileH);
      // Box face order: +x -x +y -y +z -z → ends, top/bottom, long sides.
      // Tops match Floorplanner dollhouse black caps; ends stay RAL 9010.
      const materials = [
        defaultWallMat,
        defaultWallMat,
        wallCapMat,
        defaultWallMat,
        leftMat,
        rightMat,
      ];
      const mesh = new THREE.Mesh(geo, materials);
      mesh.position.set((sx + ex) / 2, height / 2 + elev, (sy + ey) / 2);
      mesh.rotation.y = angle;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }
  }

  // Debug probe removed after verifying TextureLoader.

  const furnMat = new THREE.MeshStandardMaterial({ color: 0x6b5e52, roughness: 0.7 });
  // Matte black powder-coated aluminium (windows + hallway↔living glass door only).
  const blackFrameMat = new THREE.MeshStandardMaterial({
    color: 0x141414,
    roughness: 0.88,
    metalness: 0.15,
  });
  const whiteFrameMat = new THREE.MeshStandardMaterial({
    color: RAL_9010,
    roughness: 0.88,
    metalness: 0.02,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xd8e8f0,
    transparent: true,
    opacity: 0.35,
    roughness: 0.05,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  const flushDoorMat = new THREE.MeshStandardMaterial({
    color: RAL_9010,
    roughness: 0.85,
    metalness: 0.02,
  });

  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const loader = new GLTFLoader();
  const gltfCache = new Map<string, Object3D>();
  const loadGltf = async (url: string): Promise<Object3D | null> => {
    if (gltfCache.has(url)) {
      return gltfCache.get(url)!.clone(true);
    }
    try {
      const gltf = await loader.loadAsync(url);
      gltfCache.set(url, gltf.scene);
      return gltf.scene.clone(true);
    } catch {
      return null;
    }
  };

  if (opts.sceneGltfUrl) {
    const root = await loadGltf(opts.sceneGltfUrl);
    if (!root) {
      throw new Error(`Failed to load Blender scene GLB: ${opts.sceneGltfUrl}`);
    }
    const gltfScale = 100;
    root.scale.setScalar(gltfScale);
    root.traverse((obj) => {
      if (!(obj as Mesh).isMesh) {
        return;
      }
      prepareGltfMesh(obj as Mesh, THREE, {});
    });
    scene.add(root);
    sun.shadow.needsUpdate = true;
  }

  const fitPlanar = (
    root: Object3D,
    targetW: number,
    targetH: number,
  ): void => {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const sx = size.x > 1e-4 ? targetW / size.x : 1;
    const sy = size.y > 1e-4 ? targetH / size.y : 1;
    root.scale.x *= sx;
    root.scale.y *= sy;
    // Keep depth proportional to average planar scale so frames stay thin.
    root.scale.z *= (sx + sy) * 0.5;
  };

  const placeOpeningShell = (
    opening: (typeof ir.openings)[number],
    elev: number,
    drawH: number,
  ) => {
    const group = new THREE.Group();
    const depth = Math.max(8, 6);
    const glazed = opening.glazed ?? opening.kind === "window";
    const frameMat = glazed ? blackFrameMat : whiteFrameMat;
    const pane = new THREE.Mesh(
      new THREE.BoxGeometry(opening.width * 0.88, drawH * 0.88, glazed ? 2 : 4),
      glazed ? glassMat : flushDoorMat,
    );
    group.add(pane);
    // Frame thick enough to read from dollhouse / section view.
    const t = 8;
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(opening.width, t, depth),
      frameMat,
    );
    top.position.set(0, drawH / 2 - t / 2, 0);
    group.add(top);
    const bot = new THREE.Mesh(
      new THREE.BoxGeometry(opening.width, t, depth),
      frameMat,
    );
    bot.position.set(0, -drawH / 2 + t / 2, 0);
    group.add(bot);
    const left = new THREE.Mesh(
      new THREE.BoxGeometry(t, drawH, depth),
      frameMat,
    );
    left.position.set(-opening.width / 2 + t / 2, 0, 0);
    group.add(left);
    const right = new THREE.Mesh(
      new THREE.BoxGeometry(t, drawH, depth),
      frameMat,
    );
    right.position.set(opening.width / 2 - t / 2, 0, 0);
    group.add(right);
    group.position.set(
      opening.position.x,
      elev + opening.position.z + drawH / 2,
      opening.position.y,
    );
    group.rotation.y = -opening.angle;
    scene.add(group);
  };

  if (!useSceneMesh) {
  for (const opening of ir.openings) {
    const elev = ir.levels.find((l) => l.id === opening.levelId)?.elevation ?? 0;
    const drawH = sectionCap
      ? Math.min(opening.height, Math.max(20, sectionCap - opening.position.z))
      : opening.height;
    // Always add a readable frame + glass; overlay textured FP plane when available.
    placeOpeningShell(opening, elev, drawH);
    if (!opening.meshUrl) {
      continue;
    }
    const root = await loadGltf(opening.meshUrl);
    if (!root) {
      continue;
    }
    root.traverse((obj) => {
      if (!(obj as Mesh).isMesh) {
        return;
      }
      const mesh = obj as Mesh;
      prepareGltfMesh(mesh, THREE, {
        castShadow: false,
        receiveShadow: true,
      });
      const matList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of matList) {
        const lambert = m as import("three").MeshLambertMaterial;
        if (lambert.isMeshLambertMaterial) {
          lambert.transparent = true;
          lambert.opacity = opening.kind === "window" ? 0.85 : 1;
          lambert.side = THREE.DoubleSide;
          lambert.needsUpdate = true;
        }
      }
    });
    // FP opening slices are unit quads in XY (meters) facing +Z.
    root.scale.setScalar(100);
    fitPlanar(root, opening.width * 0.9, drawH * 0.9);
    root.position.set(
      opening.position.x,
      elev + opening.position.z + drawH / 2,
      opening.position.y,
    );
    root.rotation.y = -opening.angle;
    scene.add(root);
  }

  const hasMeshes = ir.furniture.some((f) => f.meshUrl);
  if (!hasMeshes) {
    for (const furn of ir.furniture) {
      const w = furn.width ?? 40;
      const d = furn.depth ?? 40;
      const h = furn.height ?? 40;
      const elev = ir.levels.find((l) => l.id === furn.levelId)?.elevation ?? 0;
      const geo = new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(geo, furnMat);
      mesh.position.set(furn.position.x, elev + h / 2, furn.position.y);
      if (furn.angle !== undefined) {
        // SweetHome3D piece angle is radians in plan XY
        mesh.rotation.y = -furn.angle;
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  } else {
    // Floorplanner GLBs are meters / Y-up; our plan scene is cm.
    const M_TO_CM = 100;
    for (const furn of ir.furniture) {
      if (!furn.meshUrl) {
        continue;
      }
      const root = await loadGltf(furn.meshUrl);
      if (!root) {
        continue;
      }
      root.traverse((obj) => {
        if (!(obj as Mesh).isMesh) {
          return;
        }
        prepareGltfMesh(obj as Mesh, THREE, {
          castShadow: false,
          receiveShadow: true,
        });
      });
      const elev = ir.levels.find((l) => l.id === furn.levelId)?.elevation ?? 0;
      root.scale.setScalar(M_TO_CM);
      // Fit footprint when FML width/depth known (avoids meter/cm mix-ups).
      if (furn.width && furn.width > 0) {
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        box.getSize(size);
        if (size.x > 1e-3) {
          const s = furn.width / size.x;
          root.scale.multiplyScalar(s);
        }
      }
      if (furn.mirrored?.[0]) {
        root.scale.x *= -1;
      }
      if (furn.mirrored?.[1]) {
        root.scale.z *= -1;
      }
      root.position.set(furn.position.x, elev + (furn.position.z ?? 0), furn.position.y);
      if (furn.angle !== undefined) {
        root.rotation.y = -furn.angle;
      }
      scene.add(root);
    }
  }
  }

  const lights = new Map<string, PointLight[]>();
  const stripEnds = new Map<string, Vec3>();
  const handles = new Map<string, Object3D>();
  // Edit markers sit just above the floor so dollhouse placement is easy to read.
  const handleFloorY = () => (opts.levelElevation ?? 0) + 6;
  const markerFillMat = new THREE.MeshBasicMaterial({
    color: 0xff2d55,
    depthTest: false,
  });
  const markerRimMat = new THREE.MeshBasicMaterial({
    color: 0x111111,
    depthTest: false,
  });
  const editable = opts.editableFixtureIds
    ? new Set(opts.editableFixtureIds)
    : null;
  const labels = opts.editableFixtureLabels ?? {};
  const rooms = opts.editableFixtureRooms ?? {};

  const roomFillColor = (roomId: string | undefined): number => {
    if (!roomId) {
      return 0xff2d55;
    }
    // Vivid HSL from stable room hue.
    const h = groupHue(roomId);
    const c = new THREE.Color();
    c.setHSL(h / 360, 0.78, 0.52);
    return c.getHex();
  };

  const placePointHandle = (handle: Object3D, planX: number, planY: number) => {
    handle.position.set(planX, handleFloorY(), planY);
  };

  const placeStripHandle = (
    handle: Object3D,
    start: Vec3,
    end: Vec3,
  ) => {
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    handle.position.set(midX, handleFloorY(), midY);
    const body = handle.userData.body as Object3D | undefined;
    if (body) {
      body.rotation.set(Math.PI / 2, 0, Math.atan2(end.y - start.y, end.x - start.x));
    }
  };

  const makeLabelSprite = (text: string): Object3D => {
    const label = text.trim() || "?";
    const padX = 28;
    const padY = 16;
    const fontPx = 42;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = `700 ${fontPx}px system-ui, -apple-system, sans-serif`;
    const textW = Math.ceil(ctx.measureText(label).width);
    canvas.width = textW + padX * 2;
    canvas.height = fontPx + padY * 2;
    ctx.font = `700 ${fontPx}px system-ui, -apple-system, sans-serif`;
    // Dark pill + pink edge so it reads on light PVC floors.
    const r = canvas.height / 2;
    ctx.fillStyle = "rgba(17, 17, 17, 0.92)";
    ctx.strokeStyle = "#ff2d55";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(canvas.width - r, 0);
    ctx.quadraticCurveTo(canvas.width, 0, canvas.width, r);
    ctx.lineTo(canvas.width, canvas.height - r);
    ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - r, canvas.height);
    ctx.lineTo(r, canvas.height);
    ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(label, canvas.width / 2, canvas.height / 2 + 1);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      depthTest: false,
      transparent: true,
    });
    const sprite = new THREE.Sprite(mat);
    // World size in cm — readable in top-down edit view.
    const worldH = 55;
    const worldW = worldH * (canvas.width / canvas.height);
    sprite.scale.set(worldW, worldH, 1);
    sprite.position.y = 48;
    sprite.center.set(0.5, 0);
    sprite.renderOrder = 20;
    return sprite;
  };

  const makePointMarker = (label: string, roomId?: string): Object3D => {
    const g = new THREE.Group();
    const body = new THREE.Group();
    const fillMat = markerFillMat.clone();
    fillMat.color.setHex(roomFillColor(roomId));
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(52, 52, 3, 32),
      markerRimMat.clone(),
    );
    const fill = new THREE.Mesh(
      new THREE.CylinderGeometry(38, 38, 6, 32),
      fillMat,
    );
    fill.position.y = 2;
    rim.renderOrder = 10;
    fill.renderOrder = 11;
    body.add(rim);
    body.add(fill);
    g.userData.body = body;
    g.add(body);
    g.add(makeLabelSprite(label));
    return g;
  };

  const makeStripMarker = (len: number, label: string, roomId?: string): Object3D => {
    const g = new THREE.Group();
    const body = new THREE.Group();
    const bodyLen = Math.max(24, len - 40);
    const fillMat = markerFillMat.clone();
    fillMat.color.setHex(roomFillColor(roomId));
    const rim = new THREE.Mesh(
      new THREE.CapsuleGeometry(22, bodyLen, 4, 8),
      markerRimMat.clone(),
    );
    const fill = new THREE.Mesh(
      new THREE.CapsuleGeometry(14, Math.max(16, bodyLen - 8), 4, 8),
      fillMat,
    );
    rim.scale.set(1.15, 1, 1.15);
    rim.renderOrder = 10;
    fill.renderOrder = 11;
    body.add(rim);
    body.add(fill);
    g.userData.body = body;
    g.add(body);
    g.add(makeLabelSprite(label));
    return g;
  };

  const labelForFixture = (fxId: string, fxName: string): string => {
    const fromMap = labels[fxId]?.trim();
    if (fromMap) {
      return fromMap;
    }
    return fxName.replace(/^light_/i, "").replace(/_/g, " ").slice(0, 28);
  };

  for (const fx of ir.fixtures) {
    const col = new THREE.Color(fx.color) as Color;
    const start = opts.poses?.[fx.id] ?? fx.position;
    const end = opts.stripEnds?.[fx.id] ?? fx.end;
    const kind = resolveFixtureKind(fx);
    const sampleCount = resolveStripSamples(fx);
    const positions =
      kind === "strip" && end
        ? stripSamplePositions(start, end, sampleCount)
        : [start];
    if (kind === "strip" && end) {
      stripEnds.set(fx.id, { ...end });
    }

    const group: PointLight[] = [];
    for (const pose of positions) {
      const pl = new THREE.PointLight(col, 0, fx.diameter ? fx.diameter * 20 : 400, 2);
      const r = planToRender(pose);
      pl.position.set(r.x, r.y, r.z);
      // Only the sun casts shadow maps; HA fixture lights would exceed WebGL texture units.
      pl.castShadow = false;
      scene.add(pl);
      group.push(pl);
    }
    lights.set(fx.id, group);

    if (editable && !editable.has(fx.id)) {
      continue;
    }
    const label = labelForFixture(fx.id, fx.name);
    const roomId = rooms[fx.id];
    let handle: Object3D;
    if (kind === "strip" && end && positions.length >= 2) {
      const len = Math.hypot(end.x - start.x, end.y - start.y) || 40;
      handle = makeStripMarker(len, label, roomId);
      placeStripHandle(handle, start, end);
    } else {
      handle = makePointMarker(label, roomId);
      placePointHandle(handle, start.x, start.y);
    }
    handle.userData.fixtureId = fx.id;
    handle.visible = false;
    handle.renderOrder = 10;
    scene.add(handle);
    handles.set(fx.id, handle);
  }

  const raycaster: Raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floorPlane: Plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();

  const setNdc = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    ndc.y = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
  };

  const applyDollhouseView = () => {
    // Fit the plan to the canvas. The Blender DollhouseCam sits ~35 m up for
    // Cycles plates; using that eye in live3d leaves the apartment as a dark
    // island in a gray void, so we keep only its look direction / FOV.
    const minX = ir.bounds.min.x;
    const maxX = ir.bounds.max.x;
    const minZ = ir.bounds.min.y;
    const maxZ = ir.bounds.max.y;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const spanX = Math.max(100, maxX - minX);
    const spanZ = Math.max(100, maxZ - minZ);
    const span = Math.max(spanX, spanZ) * 1.06;
    const aspect = Math.max(0.5, camera.aspect || 16 / 9);
    const view = ir.environment.dollhouseView;
    const bird = ir.cameras.find((c) => /bird\s*view/i.test(c.name ?? ""));
    const floorCam = ir.cameras.find((c) => /^floorplan$/i.test(c.name ?? ""));
    const fovDeg = view?.fovDeg ?? 42;
    const fovRad = view
      ? (fovDeg * Math.PI) / 180
      : bird?.fieldOfView ?? floorCam?.fieldOfView ?? (52 * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(fovRad / 2) * aspect);
    const fitDist = Math.max(
      span / 2 / Math.tan(fovRad / 2),
      spanX / 2 / Math.tan(hFov / 2),
      spanZ / 2 / Math.tan(fovRad / 2),
    );
    const elev = opts.levelElevation ?? 0;
    const height = Math.max(fitDist * 0.9, 400);
    const polar = 0.26;
    const baseX = view?.eye.x ?? bird?.x ?? floorCam?.x ?? cx;
    const baseZ = view?.eye.z ?? bird?.y ?? floorCam?.y ?? cz;
    const toCx = cx - baseX;
    const toCz = cz - baseZ;
    const az = Math.hypot(toCx, toCz) > 1 ? Math.atan2(toCz, toCx) : -Math.PI / 2;
    const horiz = Math.sin(polar) * height;
    const eye = {
      x: cx - Math.cos(az) * horiz,
      y: elev + Math.cos(polar) * height,
      z: cz - Math.sin(az) * horiz,
    };
    const target = { x: cx, y: elev + 40, z: cz };
    camera.fov = (fovRad * 180) / Math.PI;
    camera.up.set(0, 1, 0);
    camera.position.set(eye.x, eye.y, eye.z);
    lookTarget.set(target.x, target.y, target.z);
    camera.lookAt(lookTarget);
    camera.near = Math.max(10, height / 80);
    camera.far = Math.max(200000, height * 20);
    camera.updateProjectionMatrix();
  };

  const applyCamera = (_cam: CameraIR) => {
    applyDollhouseView();
  };

  let activeCamera: CameraIR | undefined = initialCamera ?? ir.cameras[0];

  if (activeCamera) {
    applyCamera(activeCamera);
  } else {
    applyDollhouseView();
  }

  const setStripPose = (fixtureId: string, start: Vec3, end: Vec3) => {
    const group = lights.get(fixtureId);
    if (!group || group.length === 0) {
      return;
    }
    stripEnds.set(fixtureId, { ...end });
    const positions = stripSamplePositions(start, end, group.length);
    for (let i = 0; i < group.length; i++) {
      const r = planToRender(positions[i]!);
      group[i]!.position.set(r.x, r.y, r.z);
    }
    const handle = handles.get(fixtureId);
    if (handle) {
      placeStripHandle(handle, start, end);
    }
  };

  return {
    canvas,
    rendererBackend,
    setLight(fixtureId, params) {
      const group = lights.get(fixtureId);
      if (!group) {
        return;
      }
      for (const pl of group) {
        pl.intensity = params.on ? params.intensity * fixtureLightScale : 0;
        pl.color.setRGB(params.color[0], params.color[1], params.color[2]);
      }
      // Floor markers stay a fixed high-contrast style while editing.
    },
    setLightSamples(fixtureId, paramsList) {
      const group = lights.get(fixtureId);
      if (!group) {
        return;
      }
      for (let i = 0; i < group.length; i++) {
        const pl = group[i]!;
        const params = paramsList[i] ?? paramsList[paramsList.length - 1];
        if (!params) {
          continue;
        }
        pl.intensity = params.on ? params.intensity * fixtureLightScale : 0;
        pl.color.setRGB(params.color[0], params.color[1], params.color[2]);
      }
    },
    setLightPosition(fixtureId, pos) {
      const group = lights.get(fixtureId);
      if (!group) {
        return;
      }
      const end = stripEnds.get(fixtureId);
      if (end && group.length > 1) {
        const oldStart = renderToPlan(
          group[0]!.position.x,
          group[0]!.position.y,
          group[0]!.position.z,
        );
        const dx = pos.x - oldStart.x;
        const dy = pos.y - oldStart.y;
        const dz = pos.z - oldStart.z;
        setStripPose(fixtureId, pos, {
          x: end.x + dx,
          y: end.y + dy,
          z: end.z + dz,
        });
        return;
      }
      const r = planToRender(pos);
      for (const pl of group) {
        pl.position.set(r.x, r.y, r.z);
      }
      const handle = handles.get(fixtureId);
      if (handle) {
        placePointHandle(handle, pos.x, pos.y);
      }
    },
    setStripPose,
    setCamera(cam) {
      activeCamera = cam;
      applyCamera(cam);
    },
    setEditTopDown(_enabled) {
      // Camera stays on the locked miniature dollhouse framing.
      applyDollhouseView();
    },
    setOrbitEnabled(_enabled) {
      // Orbit intentionally disabled — fixed dollhouse camera.
    },
    setHandlesVisible(visible) {
      for (const h of handles.values()) {
        h.visible = visible;
      }
    },
    raycastFloor(clientX, clientY, fixtureId) {
      setNdc(clientX, clientY);
      const elev = opts.levelElevation ?? 0;
      floorPlane.constant = -elev;
      const ok = raycaster.ray.intersectPlane(floorPlane, hitPoint);
      if (!ok) {
        return null;
      }
      const existing = fixtureId ? lights.get(fixtureId)?.[0] : undefined;
      const heightY = existing ? existing.position.y : elev + 180;
      return renderToPlan(hitPoint.x, heightY, hitPoint.z);
    },
    pickFixture(clientX, clientY, allowedIds) {
      setNdc(clientX, clientY);
      const objs: Object3D[] = [...handles.values()].filter((h) => {
        if (!h.visible) {
          return false;
        }
        const id = h.userData.fixtureId as string;
        return !allowedIds || allowedIds.has(id);
      });
      const hits = raycaster.intersectObjects(objs, true);
      if (hits.length === 0) {
        return null;
      }
      let obj: Object3D | null = hits[0]!.object;
      while (obj) {
        const id = obj.userData.fixtureId as string | undefined;
        if (id) {
          return id;
        }
        obj = obj.parent;
      }
      return null;
    },
    setSun(shading) {
      lastSunAzimuth = shading.sourceAzimuth ?? null;
      lastSunElevation = shading.sourceElevation ?? null;
      applySun(shading);
    },
    getCompassBearings(): CompassBearings {
      camera.updateMatrixWorld(true);
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      const forward = new THREE.Vector3();
      camera.matrixWorld.extractBasis(right, up, forward);
      cameraBasis[0] = right.x;
      cameraBasis[1] = right.y;
      cameraBasis[2] = right.z;
      cameraBasis[3] = up.x;
      cameraBasis[4] = up.y;
      cameraBasis[5] = up.z;

      const geo = geographicNorthRenderDir(planNorthConfigDeg);
      let sunScreenDeg: number | null = null;
      if (lastSun?.enabled && lastSun.sunIntensity > 0.02) {
        const d = lastSun.direction;
        sunScreenDeg = horizontalDirToScreenDeg(-d.x, -d.z, cameraBasis);
      }

      return {
        geographicNorthScreenDeg: horizontalDirToScreenDeg(geo.x, geo.z, cameraBasis),
        planNorthScreenDeg: horizontalDirToScreenDeg(
          PLAN_NORTH_RENDER_DIR.x,
          PLAN_NORTH_RENDER_DIR.z,
          cameraBasis,
        ),
        planNorthConfigDeg,
        sunScreenDeg,
        sunAzimuthDeg: lastSunAzimuth,
        sunElevationDeg: lastSunElevation,
      };
    },
    resize(width, height) {
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      // Re-frame dollhouse now that aspect is known.
      applyDollhouseView();
      if (lastSun) {
        applySun(lastSun);
      }
    },
    render() {
      // Ensure prior shadow/viewport passes cannot clip the main view.
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, canvas.width, canvas.height);
      renderer.render(scene, camera);
    },
    dispose() {
      renderer.dispose();
      scene.traverse((obj) => {
        const mesh = obj as Mesh;
        if (mesh.geometry) {
          mesh.geometry.dispose();
        }
        if (mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            m.dispose();
          }
        }
      });
      lights.clear();
      handles.clear();
      stripEnds.clear();
    },
  };
}
