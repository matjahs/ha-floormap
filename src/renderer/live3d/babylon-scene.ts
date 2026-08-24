/**
 * Babylon.js live3d spike — WebGPU-first, GLB from Blender export.
 * Implements Live3dHandle for scene_glb dashboards (no FML extrusion path yet).
 */
import {
  Engine,
  WebGPUEngine,
  Scene,
  ArcRotateCamera,
  Vector3,
  Color3,
  Color4,
  HemisphericLight,
  DirectionalLight,
  PointLight,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  AbstractMesh,
  Node,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import { ImportMeshAsync, SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import type { FloorplanIR, CameraIR } from "../../import/ir";
import type { Vec3 } from "../../types";
import type { SunShading } from "../../sun";
import {
  geographicNorthRenderDir,
  horizontalDirToScreenDeg,
  PLAN_NORTH_RENDER_DIR,
} from "../../compass";
import {
  resolveFixtureKind,
  resolveStripSamples,
  stripSamplePositions,
} from "../../strip";
import { CEILING_NAME_RE } from "./ceilings";
import type { Live3dGpuBackend } from "./renderer-backend";
import type { Live3dHandle, Live3dOptions } from "./handle";

const GLTF_SCALE = 100;

function splitModelUrl(url: string): { rootUrl: string; filename: string } {
  const slash = url.lastIndexOf("/");
  if (slash < 0) {
    return { rootUrl: "", filename: url };
  }
  return {
    rootUrl: url.slice(0, slash + 1),
    filename: url.slice(slash + 1),
  };
}

function planToRender(pos: Vec3): Vector3 {
  return new Vector3(pos.x, pos.z, pos.y);
}

function renderToPlan(x: number, y: number, z: number): Vec3 {
  return { x, y: z, z: y };
}

function isBabylonCeiling(node: Node): boolean {
  let cur: Node | null = node;
  while (cur) {
    if (CEILING_NAME_RE.test(cur.name)) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

function prepareShadowOnlyCeiling(mesh: AbstractMesh): void {
  let mat = mesh.material as StandardMaterial | null;
  if (!mat || !(mat instanceof StandardMaterial)) {
    mat = new StandardMaterial(`${mesh.name}_ceilingShadow`, mesh.getScene());
    mesh.material = mat;
  }
  mat.alpha = 0;
  mat.disableColorWrite = true;
  mat.disableDepthWrite = true;
  mat.backFaceCulling = false;
}

async function createBabylonEngine(
  canvas: HTMLCanvasElement,
  preferWebGpu: boolean,
): Promise<{ engine: Engine | WebGPUEngine; backend: Live3dGpuBackend }> {
  if (preferWebGpu && (await WebGPUEngine.IsSupportedAsync)) {
    try {
      const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
      await engine.initAsync();
      return { engine, backend: "webgpu" };
    } catch {
      // Fall back to WebGL when WebGPU init fails (e.g. canvas not ready).
    }
  }
  return {
    engine: new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true }),
    backend: "webgl",
  };
}

export async function createBabylonLive3dRenderer(
  ir: FloorplanIR,
  canvas: HTMLCanvasElement,
  _initialCamera?: CameraIR,
  opts: Live3dOptions = {},
): Promise<Live3dHandle> {
  if (!opts.sceneGltfUrl) {
    throw new Error("Babylon live3d spike requires scene_glb (Blender export)");
  }

  const { engine, backend: rendererBackend } = await createBabylonEngine(
    canvas,
    (opts.gpu ?? "webgpu") !== "webgl",
  );
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.9, 0.9, 0.89, 1);

  const planCx = (ir.bounds.min.x + ir.bounds.max.x) / 2;
  const planCz = (ir.bounds.min.y + ir.bounds.max.y) / 2;
  const planW = Math.max(100, ir.bounds.max.x - ir.bounds.min.x);
  const planD = Math.max(100, ir.bounds.max.y - ir.bounds.min.y);
  const elev = opts.levelElevation ?? 0;
  const target = new Vector3(planCx, elev + 40, planCz);
  const span = Math.max(planW, planD) * 1.2;

  const camera = new ArcRotateCamera(
    "dollhouse",
    -Math.PI * 0.72,
    0.26,
    span * 1.1,
    target,
    scene,
  );
  camera.lowerRadiusLimit = span * 0.35;
  camera.upperRadiusLimit = span * 4;
  camera.wheelPrecision = 12;
  camera.panningSensibility = 80;
  camera.attachControl(canvas, true);

  let orbitEnabled = opts.lockCamera === false;
  if (!orbitEnabled) {
    camera.detachControl();
  }

  const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  ambient.intensity = 0.55;
  ambient.groundColor = new Color3(0.45, 0.44, 0.42);

  const sunLight = new DirectionalLight("sun", new Vector3(-0.5, -0.8, -0.4), scene);
  sunLight.intensity = 0.85;
  sunLight.position = new Vector3(planCx + 600, 1100, planCz + 500);

  const sunShadow = new ShadowGenerator(2048, sunLight);
  sunShadow.useBlurExponentialShadowMap = true;
  sunShadow.blurKernel = 24;
  sunShadow.transparencyShadow = true;

  const fill = new DirectionalLight("fill", new Vector3(0.4, -0.5, 0.3), scene);
  fill.intensity = 0.25;

  const { rootUrl, filename } = splitModelUrl(opts.sceneGltfUrl);
  const loaded = rootUrl
    ? await SceneLoader.ImportMeshAsync("", rootUrl, filename, scene)
    : await ImportMeshAsync(filename, scene);
  if (loaded.meshes.length === 0) {
    throw new Error(`Babylon: no meshes loaded from ${opts.sceneGltfUrl}`);
  }

  const rootNode: TransformNode | null =
    loaded.transformNodes.find((n) => n.name === "__root__") ??
    (loaded.meshes[0]?.parent instanceof TransformNode ? loaded.meshes[0].parent : null);
  if (rootNode) {
    rootNode.scaling.setAll(GLTF_SCALE);
  } else {
    for (const mesh of loaded.meshes) {
      mesh.scaling.setAll(GLTF_SCALE);
    }
  }

  for (const mesh of loaded.meshes) {
    if (mesh.name === "skyBox") {
      continue;
    }
    mesh.receiveShadows = true;
    if (isBabylonCeiling(mesh)) {
      prepareShadowOnlyCeiling(mesh);
    }
    sunShadow.addShadowCaster(mesh);
  }

  const fixtureLightScale = 680;
  const lights = new Map<string, PointLight[]>();
  const stripEnds = new Map<string, Vec3>();
  const planNorthConfigDeg = opts.planNorthDeg ?? 0;
  let lastSun: SunShading | null = null;
  let lastSunAzimuth: number | null = null;
  let lastSunElevation: number | null = null;

  for (const fx of ir.fixtures) {
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
    const col = Color3.FromHexString(fx.color || "#fff2d6");
    const group: PointLight[] = [];
    for (const pose of positions) {
      const pl = new PointLight(`fx_${fx.id}_${group.length}`, planToRender(pose), scene);
      pl.diffuse = col;
      pl.intensity = 0;
      pl.range = fx.diameter ? fx.diameter * 20 : 400;
      group.push(pl);
    }
    lights.set(fx.id, group);
  }

  const frameDollhouse = (): void => {
    const view = ir.environment.dollhouseView;
    const minX = ir.bounds.min.x;
    const maxX = ir.bounds.max.x;
    const minZ = ir.bounds.min.y;
    const maxZ = ir.bounds.max.y;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const spanX = Math.max(100, maxX - minX);
    const spanZ = Math.max(100, maxZ - minZ);
    const fitSpan = Math.max(spanX, spanZ) * 1.06;
    const fovDeg = view?.fovDeg ?? 42;
    const fovRad = (fovDeg * Math.PI) / 180;
    const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
    const hFov = 2 * Math.atan(Math.tan(fovRad / 2) * aspect);
    const fitDist = Math.max(
      fitSpan / 2 / Math.tan(fovRad / 2),
      spanX / 2 / Math.tan(hFov / 2),
      spanZ / 2 / Math.tan(fovRad / 2),
    );
    const height = Math.max(fitDist * 0.9, 400);
    const polar = 0.26;
    const baseX = view?.eye.x ?? cx;
    const baseZ = view?.eye.z ?? cz;
    const toCx = cx - baseX;
    const toCz = cz - baseZ;
    const az = Math.hypot(toCx, toCz) > 1 ? Math.atan2(toCz, toCx) : -Math.PI / 2;
    camera.setTarget(new Vector3(cx, elev + 40, cz));
    camera.alpha = az + Math.PI;
    camera.beta = polar;
    camera.radius = height;
    camera.fov = fovRad;
  };

  frameDollhouse();

  const applySun = (shading: SunShading): void => {
    lastSun = shading;
    if (!shading.enabled) {
      ambient.intensity = 0.55;
      sunLight.intensity = 0.72;
      fill.intensity = 0.22;
      scene.clearColor = new Color4(0.9, 0.9, 0.89, 1);
      sunLight.direction = new Vector3(-0.5, -0.8, -0.4);
      return;
    }
    const d = shading.direction;
    const dir = new Vector3(d.x, d.y, d.z).normalize();
    sunLight.direction = dir.scale(-1);
    sunLight.position = target.add(dir.scale(Math.max(planW, planD) * 1.4));
    sunLight.intensity = shading.sunIntensity * 1.1;
    sunLight.diffuse = new Color3(shading.sunColor[0], shading.sunColor[1], shading.sunColor[2]);
    ambient.intensity = shading.ambientIntensity * 0.38;
    ambient.diffuse = new Color3(
      shading.ambientColor[0],
      shading.ambientColor[1],
      shading.ambientColor[2],
    );
    fill.intensity = shading.fillIntensity * 0.48;
    fill.diffuse = new Color3(shading.fillColor[0], shading.fillColor[1], shading.fillColor[2]);
    scene.clearColor = new Color4(shading.sky[0], shading.sky[1], shading.sky[2], 1);
    sunShadow.setDarkness(1 - Math.min(1, shading.sunIntensity));
  };

  const cameraBasis = new Float64Array(6);

  const setStripPose = (fixtureId: string, start: Vec3, end: Vec3): void => {
    const group = lights.get(fixtureId);
    if (!group || group.length === 0) {
      return;
    }
    stripEnds.set(fixtureId, { ...end });
    const positions = stripSamplePositions(start, end, group.length);
    for (let i = 0; i < group.length; i++) {
      group[i]!.position.copyFrom(planToRender(positions[i]!));
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
        pl.diffuse = new Color3(params.color[0], params.color[1], params.color[2]);
      }
    },
    setLightSamples(fixtureId, paramsList) {
      const group = lights.get(fixtureId);
      if (!group) {
        return;
      }
      for (let i = 0; i < group.length; i++) {
        const params = paramsList[i] ?? paramsList[paramsList.length - 1];
        if (!params) {
          continue;
        }
        group[i]!.intensity = params.on ? params.intensity * fixtureLightScale : 0;
        group[i]!.diffuse = new Color3(params.color[0], params.color[1], params.color[2]);
      }
    },
    setLightPosition(fixtureId, pos) {
      const group = lights.get(fixtureId);
      if (!group?.[0]) {
        return;
      }
      const end = stripEnds.get(fixtureId);
      if (end && group.length > 1) {
        const old = renderToPlan(group[0].position.x, group[0].position.y, group[0].position.z);
        setStripPose(fixtureId, pos, {
          x: end.x + (pos.x - old.x),
          y: end.y + (pos.y - old.y),
          z: end.z + (pos.z - old.z),
        });
        return;
      }
      group[0].position.copyFrom(planToRender(pos));
    },
    setStripPose,
    setCamera(_cam) {
      if (!orbitEnabled) {
        frameDollhouse();
      }
    },
    setEditTopDown(_enabled) {
      if (!orbitEnabled) {
        frameDollhouse();
      }
    },
    setOrbitEnabled(enabled) {
      orbitEnabled = enabled;
      if (enabled) {
        camera.attachControl(canvas, true);
      } else {
        camera.detachControl();
        frameDollhouse();
      }
    },
    setHandlesVisible(_visible) {
      // Edit handles not implemented in Babylon spike yet.
    },
    raycastFloor(clientX, clientY, fixtureId) {
      const planeY = elev;
      const ray = scene.createPickingRay(clientX, clientY, null, camera);
      const dy = ray.direction.y;
      if (Math.abs(dy) < 1e-6) {
        return null;
      }
      const t = (planeY - ray.origin.y) / dy;
      if (t < 0) {
        return null;
      }
      const p = ray.origin.add(ray.direction.scale(t));
      const existing = fixtureId ? lights.get(fixtureId)?.[0] : undefined;
      const heightY = existing ? existing.position.y : elev + 180;
      return renderToPlan(p.x, heightY, p.z);
    },
    pickFixture(_clientX, _clientY, _allowedIds) {
      return null;
    },
    setSun(shading) {
      lastSunAzimuth = shading.sourceAzimuth ?? null;
      lastSunElevation = shading.sourceElevation ?? null;
      applySun(shading);
    },
    getCompassBearings() {
      const forward = camera.getForwardRay().direction;
      const up = camera.upVector;
      const right = Vector3.Cross(up, forward).normalize();
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
        planNorthConfigDeg: planNorthConfigDeg,
        sunScreenDeg,
        sunAzimuthDeg: lastSunAzimuth,
        sunElevationDeg: lastSunElevation,
      };
    },
    resize(width, height) {
      engine.setSize(width, height);
      if (!orbitEnabled) {
        frameDollhouse();
      }
    },
    render() {
      scene.render();
    },
    dispose() {
      camera.detachControl();
      scene.dispose();
      engine.dispose();
      lights.clear();
      stripEnds.clear();
    },
  };
};
