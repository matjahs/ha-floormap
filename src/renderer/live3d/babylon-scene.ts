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
  ShadowGenerator,
  StandardMaterial,
  AbstractMesh,
  Node,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import "@babylonjs/core/Helpers/sceneHelpers";
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
import { setupBabylonGltfLighting, prepareBabylonGltfMaterials, prepareBabylonGltfLoaderForWebGpu } from "./babylon-gltf-materials";
import { dollhouseBoundsFromMeshes } from "./babylon-bounds";
import { applyGltfSceneScale, listLoadedSceneMeshes } from "./babylon-gltf-scene";
import { computeDollhouseFrame } from "./dollhouse-view";
import { createFixtureLightSystem, type FixtureLightHandle } from "./babylon-fixture-lights";
import type { Live3dGpuBackend } from "./renderer-backend";
import type { Live3dHandle, Live3dOptions } from "./handle";

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
  mat.backFaceCulling = false;
}

async function createBabylonEngine(
  canvas: HTMLCanvasElement,
  preferWebGpu: boolean,
): Promise<{ engine: Engine | WebGPUEngine; backend: Live3dGpuBackend }> {
  if (preferWebGpu && (await WebGPUEngine.IsSupportedAsync)) {
    try {
      const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: false });
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
  if (rendererBackend === "webgpu") {
    engine.renderEvenInBackground = true;
  }
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.9, 0.9, 0.89, 1);
  setupBabylonGltfLighting(scene);

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
  ambient.intensity = 0.72;
  ambient.groundColor = new Color3(0.52, 0.5, 0.48);
  ambient.specular = Color3.Black();

  const sunLight = new DirectionalLight("sun", new Vector3(-0.5, -0.8, -0.4), scene);
  sunLight.intensity = 1.05;
  sunLight.position = new Vector3(planCx + 600, 1100, planCz + 500);

  const shadowExtent = Math.max(planW, planD) * 0.88;
  sunLight.shadowMinZ = 0.1;
  sunLight.shadowMaxZ = shadowExtent * 4;
  if ("shadowFrustumSize" in sunLight) {
    (sunLight as DirectionalLight & { shadowFrustumSize: number }).shadowFrustumSize =
      shadowExtent;
  }

  const sunShadow = new ShadowGenerator(2048, sunLight);
  sunShadow.useBlurExponentialShadowMap = true;
  sunShadow.blurKernel = 24;
  sunShadow.transparencyShadow = true;
  sunShadow.bias = 0.0008;
  sunShadow.normalBias = 0.02;
  sunShadow.darkness = 0.42;

  const fill = new DirectionalLight("fill", new Vector3(0.4, -0.5, 0.3), scene);
  fill.intensity = 0.38;

  if (rendererBackend === "webgpu") {
    prepareBabylonGltfLoaderForWebGpu();
  }

  const { rootUrl, filename } = splitModelUrl(opts.sceneGltfUrl);
  const loaded = rootUrl
    ? await SceneLoader.ImportMeshAsync("", rootUrl, filename, scene)
    : await ImportMeshAsync(filename, scene);
  if (loaded.meshes.length === 0) {
    throw new Error(`Babylon: no meshes loaded from ${opts.sceneGltfUrl}`);
  }

  applyGltfSceneScale(scene, loaded);

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

  prepareBabylonGltfMaterials(scene, rendererBackend === "webgpu");

  const sceneMeshes = listLoadedSceneMeshes(loaded.meshes);
  const meshBounds = dollhouseBoundsFromMeshes(sceneMeshes);

  const fixtureLightScale = 680;
  const fixtureLightSystem = await createFixtureLightSystem(scene, fixtureLightScale);
  const lights = new Map<string, FixtureLightHandle>();
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
    const col = fx.color || "#fff2d6";
    const group = fixtureLightSystem.createGroup(
      fx.id,
      positions,
      col,
      fx.diameter ? fx.diameter * 20 : 400,
      planToRender,
    );
    lights.set(fx.id, group);
  }

  fixtureLightSystem.finalize();

  const frameDollhouse = (): void => {
    const aspect =
      engine.getRenderWidth() / Math.max(1, engine.getRenderHeight()) || canvas.width / Math.max(1, canvas.height);
    const frame = computeDollhouseFrame(ir, {
      levelElevation: elev,
      aspect,
      bounds: meshBounds ?? undefined,
    });
    const look = new Vector3(frame.target.x, frame.target.y, frame.target.z);
    camera.setTarget(look);
    camera.setPosition(new Vector3(frame.eye.x, frame.eye.y, frame.eye.z));
    camera.fov = (frame.fovDeg * Math.PI) / 180;
    camera.minZ = frame.near;
    camera.maxZ = frame.far;
    const fitSpan = meshBounds
      ? Math.max(meshBounds.maxX - meshBounds.minX, meshBounds.maxY - meshBounds.minY)
      : Math.max(planW, planD);
    camera.lowerRadiusLimit = Math.max(120, fitSpan * 0.22);
    camera.upperRadiusLimit = Math.max(120000, fitSpan * 4);
  };

  frameDollhouse();

  const applySun = (shading: SunShading): void => {
    lastSun = shading;
    const sceneAmbScale = 0.38;
    if (!shading.enabled) {
      ambient.intensity = 0.62;
      sunLight.intensity = 0.85;
      fill.intensity = 0.28;
      scene.clearColor = new Color4(0.9, 0.9, 0.89, 1);
      sunLight.direction = new Vector3(-0.5, -0.8, -0.4);
      scene.environmentIntensity = 0.4;
      return;
    }
    const d = shading.direction;
    const dir = new Vector3(d.x, d.y, d.z).normalize();
    sunLight.direction = dir.scale(-1);
    sunLight.position = target.add(dir.scale(Math.max(planW, planD) * 1.4));
    sunLight.intensity = shading.sunIntensity * 1.25;
    sunLight.diffuse = new Color3(shading.sunColor[0], shading.sunColor[1], shading.sunColor[2]);
    ambient.intensity = Math.max(0.28, shading.ambientIntensity * sceneAmbScale);
    ambient.diffuse = new Color3(
      shading.ambientColor[0],
      shading.ambientColor[1],
      shading.ambientColor[2],
    );
    fill.intensity = Math.max(0.14, shading.fillIntensity * sceneAmbScale);
    fill.diffuse = new Color3(shading.fillColor[0], shading.fillColor[1], shading.fillColor[2]);
    scene.clearColor = new Color4(shading.sky[0], shading.sky[1], shading.sky[2], 1);
    scene.environmentIntensity = Math.max(0.25, 0.3 + shading.sunIntensity * 0.25);
    sunShadow.darkness = 0.28 + (1 - Math.min(1, shading.sunIntensity)) * 0.35;
  };

  const cameraBasis = new Float64Array(6);

  const setStripPose = (fixtureId: string, start: Vec3, end: Vec3): void => {
    const group = lights.get(fixtureId);
    if (!group) {
      return;
    }
    stripEnds.set(fixtureId, { ...end });
    const positions = stripSamplePositions(start, end, group.sampleCount);
    for (let i = 0; i < positions.length; i++) {
      group.setPosition(i, positions[i]!, planToRender);
    }
  };

  const renderFrame = (): void => {
    scene.render();
  };

  // Wait one frame so Lit finishes adopting the stable canvas host before first submit.
  requestAnimationFrame(() => {
    engine.runRenderLoop(renderFrame);
  });

  return {
    canvas,
    rendererBackend,
    setLight(fixtureId, params) {
      const group = lights.get(fixtureId);
      if (!group) {
        return;
      }
      group.setIntensity(params.on, params.intensity, params.color);
    },
    setLightSamples(fixtureId, paramsList) {
      const group = lights.get(fixtureId);
      if (!group) {
        return;
      }
      for (let i = 0; i < group.sampleCount; i++) {
        const params = paramsList[i] ?? paramsList[paramsList.length - 1];
        if (!params) {
          continue;
        }
        group.setSampleIntensity(i, params.on, params.intensity, params.color);
      }
    },
    setLightPosition(fixtureId, pos) {
      const group = lights.get(fixtureId);
      const first = group?.getRenderPosition(0);
      if (!group || !first) {
        return;
      }
      const end = stripEnds.get(fixtureId);
      if (end && group.sampleCount > 1) {
        const old = renderToPlan(first.x, first.y, first.z);
        setStripPose(fixtureId, pos, {
          x: end.x + (pos.x - old.x),
          y: end.y + (pos.y - old.y),
          z: end.z + (pos.z - old.z),
        });
        return;
      }
      group.setPosition(0, pos, planToRender);
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
      const existing = fixtureId ? lights.get(fixtureId)?.getRenderPosition(0) : undefined;
      const heightY = existing ? existing.y : elev + 180;
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
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      if (engine.getRenderWidth() === w && engine.getRenderHeight() === h) {
        return;
      }
      engine.setSize(w, h, true);
      if (!orbitEnabled) {
        frameDollhouse();
      }
    },
    render() {
      // runRenderLoop drives WebGPU presentation; keep for API compat with card paint hooks.
    },
    dispose() {
      engine.stopRenderLoop();
      camera.detachControl();
      fixtureLightSystem.dispose();
      scene.dispose();
      engine.dispose();
      lights.clear();
      stripEnds.clear();
    },
  };
};
