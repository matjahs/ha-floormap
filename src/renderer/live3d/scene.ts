import type { FloorplanIR, CameraIR } from "../../import/ir";
import { pointInPolygon } from "../../import/ir";
import type { LightParams, Vec3 } from "../../types";
import { cameraEyeTarget } from "../../projection";
import {
  resolveFixtureKind,
  resolveStripSamples,
  stripSamplePositions,
} from "../../strip";
import type {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  PointLight,
  Color,
  Mesh,
  Raycaster,
  Plane,
  Object3D,
} from "three";

export interface Live3dHandle {
  canvas: HTMLCanvasElement;
  setLight(fixtureId: string, params: LightParams): void;
  /** Per-sample params for strip fixtures (length = sample count). */
  setLightSamples(fixtureId: string, params: LightParams[]): void;
  setLightPosition(fixtureId: string, pos: Vec3): void;
  /** Move strip while preserving start→end vector (translate by delta from old start). */
  setStripPose(fixtureId: string, start: Vec3, end: Vec3): void;
  setCamera(cam: CameraIR): void;
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
}

function planToRender(pos: Vec3): { x: number; y: number; z: number } {
  // SH3D plan X/Y, Z elevation → three.js Y-up
  return { x: pos.x, y: pos.z, z: pos.y };
}

function renderToPlan(x: number, y: number, z: number): Vec3 {
  return { x, y: z, z: y };
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
  const THREE = await import("three");
  const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");

  const renderer: WebGLRenderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  // Top-down plan view: shadows add little and some three.js versions leave a
  // tiny SCISSOR_BOX after the shadow pass, so the plan never fills the canvas.
  renderer.shadowMap.enabled = false;
  renderer.setClearColor(0xe6e6e4, 1);

  const scene: Scene = new THREE.Scene();
  // Floorplanner dollhouse void is light grey; keep it for top/bird cameras.
  const isTopCamera = (cam?: CameraIR) =>
    !!cam && (Math.abs(Math.sin(cam.pitch)) > 0.95 || /bird|top|dollhouse|floorplan/i.test(cam.name ?? ""));
  scene.background = new THREE.Color(
    isTopCamera(initialCamera ?? ir.cameras[0])
      ? "#e6e6e4"
      : (ir.environment.skyColor === "#000000" || ir.environment.skyColor === "#000"
        ? "#1a1d24"
        : (ir.environment.skyColor ?? "#1a1d24")),
  );

  const camera: PerspectiveCamera = new THREE.PerspectiveCamera(50, 1, 1, 100000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enableRotate = true;
  controls.screenSpacePanning = true;
  // Allow a near-horizon tilt so exterior cladding stays readable while orbiting.
  controls.maxPolarAngle = Math.PI * 0.72;
  controls.minPolarAngle = 0.15;
  controls.minDistance = 200;
  controls.maxDistance = 20000;

  // Neutral plan lighting (SH3D ambient is often a dark blue tint).
  const amb = new THREE.AmbientLight(0xc8c4bc, 0.9);
  scene.add(amb);

  const sun = new THREE.DirectionalLight(0xfff5ea, 0.7);
  sun.position.set(600, 1100, 500);
  sun.castShadow = true;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0xe8eef5, 0.35);
  fill.position.set(-400, 600, -300);
  scene.add(fill);

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
  {
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
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const std = m as import("three").MeshStandardMaterial;
        if (std?.map) {
          std.map.colorSpace = THREE.SRGBColorSpace;
        }
        if (std) {
          std.transparent = true;
          std.opacity = opening.kind === "window" ? 0.85 : 1;
          std.side = THREE.DoubleSide;
          std.needsUpdate = true;
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
        const mesh = obj as Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const std = m as import("three").MeshStandardMaterial;
          if (std?.map) {
            std.map.colorSpace = THREE.SRGBColorSpace;
          }
          if (std) {
            std.needsUpdate = true;
          }
        }
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

  const lights = new Map<string, PointLight[]>();
  const stripEnds = new Map<string, Vec3>();
  const handles = new Map<string, Mesh>();
  const handleMat = new THREE.MeshBasicMaterial({
    color: 0xffe08a,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
  });
  const editable = opts.editableFixtureIds
    ? new Set(opts.editableFixtureIds)
    : null;

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
      pl.castShadow = true;
      scene.add(pl);
      group.push(pl);
    }
    lights.set(fx.id, group);

    if (editable && !editable.has(fx.id)) {
      continue;
    }
    let handle: Mesh;
    if (kind === "strip" && end && positions.length >= 2) {
      const len = Math.hypot(end.x - start.x, end.y - start.y) || 40;
      handle = new THREE.Mesh(
        new THREE.CapsuleGeometry(18, Math.max(20, len - 36), 4, 8),
        handleMat.clone(),
      );
      const mid = planToRender({
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
        z: (start.z + end.z) / 2,
      });
      handle.position.set(mid.x, mid.y, mid.z);
      handle.rotation.z = Math.atan2(end.y - start.y, end.x - start.x);
      // Capsule default is Y-aligned; lay along XZ strip.
      handle.rotation.x = Math.PI / 2;
    } else {
      handle = new THREE.Mesh(new THREE.SphereGeometry(45, 16, 16), handleMat.clone());
      const r = planToRender(start);
      handle.position.set(r.x, r.y, r.z);
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

  const applyCamera = (cam: CameraIR) => {
    // cameraEyeTarget already stabilizes top-down SH3D cameras (floor aim + nudge).
    let { eye, target } = cameraEyeTarget(cam);
    let fovRad = cam.fieldOfView;
    // Match Floorplanner Bird View → Dollhouse (height 685 cm, FOV 52°).
    if (isTopCamera(cam)) {
      const minX = ir.bounds.min.x;
      const maxX = ir.bounds.max.x;
      const minZ = ir.bounds.min.y;
      const maxZ = ir.bounds.max.y;
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const span = Math.max(maxX - minX, maxZ - minZ) * 1.06;
      const aspect = Math.max(0.5, camera.aspect || 16 / 9);
      fovRad = (52 * Math.PI) / 180;
      // ~36° from vertical — Floorplanner dollhouse, not a side elevation.
      const polar = 0.63;
      const azimuth = -0.75;
      const elev = opts.levelElevation ?? 0;
      const preferredHeight = 685;
      const hFov = 2 * Math.atan(Math.tan(fovRad / 2) * aspect);
      const fitDist = Math.max(
        span / 2 / Math.tan(fovRad / 2),
        span / 2 / Math.tan(hFov / 2),
      );
      // Prefer FP height; raise only when the full plan would not fit.
      const dist = Math.max(preferredHeight / Math.cos(polar), fitDist * 0.95);
      target = { x: cx, y: elev + 40, z: cz };
      eye = {
        x: cx + Math.sin(polar) * Math.cos(azimuth) * dist,
        y: elev + Math.cos(polar) * dist,
        z: cz + Math.sin(polar) * Math.sin(azimuth) * dist,
      };
      scene.background = new THREE.Color("#e6e6e4");
      renderer.setClearColor(0xe6e6e4, 1);
    }
    camera.fov = (fovRad * 180) / Math.PI;
    camera.up.set(0, 1, 0);
    camera.position.set(eye.x, eye.y, eye.z);
    controls.target.set(target.x, target.y, target.z);
    camera.lookAt(target.x, target.y, target.z);
    camera.updateProjectionMatrix();
    controls.update();
  };

  let activeCamera: CameraIR | undefined = initialCamera ?? ir.cameras[0];
  if (activeCamera) {
    applyCamera(activeCamera);
  }

  let idleTimer = 0;
  controls.addEventListener("start", () => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1) * 0.5);
  });
  controls.addEventListener("end", () => {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.render(scene, camera);
    }, 150);
  });

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
      const mid = planToRender({
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
        z: (start.z + end.z) / 2,
      });
      handle.position.set(mid.x, mid.y, mid.z);
    }
  };

  return {
    canvas,
    setLight(fixtureId, params) {
      const group = lights.get(fixtureId);
      if (!group) {
        return;
      }
      for (const pl of group) {
        pl.intensity = params.on ? params.intensity * 800 : 0;
        pl.color.setRGB(params.color[0], params.color[1], params.color[2]);
      }
      const handle = handles.get(fixtureId);
      if (handle) {
        const mat = handle.material as import("three").MeshBasicMaterial;
        mat.color.setRGB(params.color[0], params.color[1], params.color[2]);
        mat.opacity = params.on ? 0.95 : 0.45;
      }
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
        pl.intensity = params.on ? params.intensity * 800 : 0;
        pl.color.setRGB(params.color[0], params.color[1], params.color[2]);
      }
      const anyOn = paramsList.some((p) => p.on);
      const first = paramsList.find((p) => p.on) ?? paramsList[0];
      const handle = handles.get(fixtureId);
      if (handle && first) {
        const mat = handle.material as import("three").MeshBasicMaterial;
        mat.color.setRGB(first.color[0], first.color[1], first.color[2]);
        mat.opacity = anyOn ? 0.95 : 0.45;
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
        handle.position.set(r.x, r.y, r.z);
      }
    },
    setStripPose,
    setCamera(cam) {
      activeCamera = cam;
      applyCamera(cam);
    },
    setOrbitEnabled(enabled) {
      controls.enabled = enabled;
      if (!enabled) {
        // Freeze any in-flight damping so a cancelled orbit cannot drift the view.
        controls.enableDamping = false;
        controls.update();
      } else {
        controls.enableDamping = true;
      }
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
      // Enlarge pick tolerance for top-down views
      raycaster.params.Points = { threshold: 40 };
      const hits = raycaster.intersectObjects(objs, false);
      if (hits.length === 0) {
        return null;
      }
      return (hits[0]!.object.userData.fixtureId as string) ?? null;
    },
    resize(width, height) {
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      // Re-frame top cameras now that aspect is known.
      if (activeCamera) {
        applyCamera(activeCamera);
      }
    },
    render() {
      // Skip orbit update while dragging lights — damping must not shift the view.
      if (controls.enabled) {
        controls.update();
      }
      // Ensure prior shadow/viewport passes cannot clip the main view.
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, canvas.width, canvas.height);
      renderer.render(scene, camera);
    },
    dispose() {
      window.clearTimeout(idleTimer);
      controls.dispose();
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
