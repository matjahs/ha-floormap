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
  Matrix,
  Color3,
  Color4,
  HemisphericLight,
  DirectionalLight,
  ShadowGenerator,
  MultiMaterial,
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
  resolveCompassScreenBearings,
} from "../../compass";
import {
  resolveFixtureKind,
  resolveStripSamples,
  stripSamplePositions,
} from "../../strip";
import {
  isBabylonCeiling,
  isCeilingShadowCaster,
  prepareShadowOnlyCeiling,
  applyCeilingLayerMaskToCamera,
} from "./babylon-ceilings";
import {
  setupBabylonGltfLighting,
  prepareBabylonGltfMaterials,
  prepareBabylonGltfLoaderForWebGpu,
  isBabylonGlassMaterial,
} from "./babylon-gltf-materials";
import { dollhouseBoundsFromMeshes } from "./babylon-bounds";
import {
  applyGltfSceneScale,
  listLoadedSceneMeshes,
  listSunShadowCasterMeshes,
} from "./babylon-gltf-scene";
import { computeDollhouseFrame } from "./dollhouse-view";
import { createFixtureLightSystem, type FixtureLightHandle } from "./babylon-fixture-lights";
import {
  collectExteriorWallSamples,
  createSunProbeMarkers,
  readSunProbes,
  updateSunProbeMarkers,
} from "./babylon-sun-probes";
import { eastWestPlanHintFromRooms } from "../../sun-probe-envelope";
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
    // WebGPU shadow maps: compile depth shaders via GLSL→WGSL (more reliable
    // across sun direction quadrants than the native WGSL path on some GPUs).
    ShadowGenerator.ForceGLSL = true;
  }
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true; // before camera / lights / glTF (skip __root__ z-flip)
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
  applyCeilingLayerMaskToCamera(camera);
  camera.lowerRadiusLimit = span * 0.35;
  camera.upperRadiusLimit = span * 4;
  camera.wheelPrecision = 12;
  camera.panningSensibility = 80;
  camera.attachControl(canvas, true);

  let orbitEnabled = opts.lockCamera === false;
  if (!orbitEnabled) {
    camera.detachControl();
  }

  // Hemisphere is never shadow-occluded — keep low; ceilings only block the directional sun.
  const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  ambient.intensity = 0.08;
  ambient.groundColor = new Color3(0.22, 0.21, 0.2);
  ambient.specular = Color3.Black();

  const sunLight = new DirectionalLight("sun", new Vector3(-0.5, -0.8, -0.4), scene);
  sunLight.intensity = 0.78;
  sunLight.position = new Vector3(planCx + 600, 1100, planCz + 500);

  // Fixed ortho (shadowFrustumSize > 0). autoUpdateExtends fits a tight light-space
  // AABB that rotates with azimuth — its edges cut through rooms and walls outside
  // the box pop to full sun (no shadow). Size is set after mesh bounds below.
  const planDiagonal = Math.hypot(planW, planD);
  sunLight.autoUpdateExtends = false;
  sunLight.autoCalcShadowZBounds = false;

  const sunShadow = new ShadowGenerator(2048, sunLight);
  // PCF: less light-bleed through thin wardrobe shells than blur ESM.
  sunShadow.usePercentageCloserFiltering = true;
  sunShadow.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  sunShadow.transparencyShadow = true;
  sunShadow.bias = 0.001;
  sunShadow.normalBias = 0.02;
  sunShadow.darkness = 0.78;

  // No second DirectionalLight — a shadowless "fill" reads as another sun and lights every room.

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

  const meshIsGlassOnly = (mesh: (typeof loaded.meshes)[number]): boolean => {
    const mat = mesh.material;
    if (!mat) {
      return isBabylonGlassMaterial(mesh.name, null);
    }
    if (mat instanceof MultiMaterial) {
      const subs = mat.subMaterials.filter((m): m is NonNullable<typeof m> => m != null);
      return subs.length > 0 && subs.every((m) => isBabylonGlassMaterial(mesh.name, m));
    }
    return isBabylonGlassMaterial(mesh.name, mat);
  };

  for (const mesh of loaded.meshes) {
    if (mesh.name === "skyBox" || mesh.name === "__root__") {
      continue;
    }
    mesh.receiveShadows = true;
    // Glass must not cast — otherwise window panes block morning beams onto walls
    // (Three live3d already skips glass casters).
    // Ceilings: visible mesh is hidden; a shadow-only clone is registered below.
    if (meshIsGlassOnly(mesh) || isBabylonCeiling(mesh)) {
      mesh.receiveShadows = false;
    }
  }
  // includeDescendants=false: never walk from a parent into glass/ceiling children.
  // (Registering `__root__` with the default true would add all ~700 meshes first.)
  for (const mesh of listSunShadowCasterMeshes(loaded.meshes, {
    isGlass: meshIsGlassOnly,
    isCeiling: isBabylonCeiling,
  })) {
    sunShadow.addShadowCaster(mesh, false);
  }

  prepareBabylonGltfMaterials(scene, rendererBackend === "webgpu");

  // Roland pattern: hide visible ceiling, keep an invisible clone as caster.
  // includeDescendants=true: glTF multi-material ceilings clone into `_primitive*`
  // children that already have the shadow-only material from prepareShadowOnlyCeiling.
  // (Unlike scene casters, where false avoids walking into glass.)
  for (const mesh of [...loaded.meshes]) {
    if (!isBabylonCeiling(mesh) || isCeilingShadowCaster(mesh) || !mesh.isEnabled()) {
      continue;
    }
    const caster = prepareShadowOnlyCeiling(mesh);
    sunShadow.addShadowCaster(caster, true);
  }
  const sceneMeshes = listLoadedSceneMeshes(loaded.meshes);
  const meshBounds = dollhouseBoundsFromMeshes(sceneMeshes);

  // Aim the light-camera through the mesh AABB center (not floor) so the fixed
  // ortho box stays centered on the building in view space.
  let sunAim = target.clone();
  let meshHeight = 270;
  {
    let ymin = Number.POSITIVE_INFINITY;
    let ymax = Number.NEGATIVE_INFINITY;
    for (const mesh of sceneMeshes) {
      if (mesh.name === "skyBox") {
        continue;
      }
      mesh.computeWorldMatrix(true);
      const { min: bmin, max: bmax } = mesh.getHierarchyBoundingVectors(true);
      ymin = Math.min(ymin, bmin.y);
      ymax = Math.max(ymax, bmax.y);
    }
    if (Number.isFinite(ymin) && Number.isFinite(ymax)) {
      const cx = meshBounds ? (meshBounds.minX + meshBounds.maxX) / 2 : planCx;
      const cz = meshBounds ? (meshBounds.minY + meshBounds.maxY) / 2 : planCz;
      sunAim = new Vector3(cx, (ymin + ymax) / 2, cz);
      meshHeight = Math.max(50, ymax - ymin);
    }
  }
  // Mesh span is authoritative after m→cm scale; IR alone drifts if scale is wrong.
  const meshDiagonal = meshBounds
    ? Math.hypot(meshBounds.maxX - meshBounds.minX, meshBounds.maxY - meshBounds.minY)
    : planDiagonal;
  const shadowSpan = Math.max(planDiagonal, meshDiagonal);
  // OrthoLH must cover the building AABB under every sun azimuth. Light-space
  // footprint is bounded by the 3D diagonal (azimuth-independent); ~1.3× leaves
  // margin without the old 2.5× texel waste (~2.75 cm/texel → ~1.4 cm/texel).
  const diag3 = Math.hypot(shadowSpan, meshHeight);
  const shadowFrustumSize = diag3 * 1.3;
  sunLight.shadowFrustumSize = shadowFrustumSize;
  sunLight.autoUpdateExtends = false;
  sunLight.autoCalcShadowZBounds = false;
  const sunPull = shadowSpan * 1.5;
  // Depth pad through the building along the light axis (wider at low sun).
  const shadowDepthPad = shadowSpan * 0.85;

  // Higher ambient below; keep fixtures strong enough to still read on walls/floors.
  const fixtureLightScale = 1600;
  const fixtureLightSystem = await createFixtureLightSystem(scene, fixtureLightScale);
  const lights = new Map<string, FixtureLightHandle>();
  const stripEnds = new Map<string, Vec3>();
  const planNorthConfigDeg = opts.planNorthDeg ?? 0;
  let lastSun: SunShading | null = null;
  let lastSunAzimuth: number | null = null;
  let lastSunElevation: number | null = null;
  /** Playground slider: scales hemisphere + IBL only (not directional sun). */
  let ambientFillScale = 1;

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
      fx.diameter ? Math.max(600, fx.diameter * 28) : 800,
      planToRender,
    );
    lights.set(fx.id, group);
  }

  fixtureLightSystem.finalize();

  // Envelope + room centroids orient ±X (living west, bedroom/office east).
  const geoHint = eastWestPlanHintFromRooms(ir.rooms);
  const sunProbeSamples = collectExteriorWallSamples(sceneMeshes, geoHint);
  // Markers are playground/debug only (gated like the inspector). Sampling still runs for getSunProbes().
  const sunProbeMarkers = opts.inspector
    ? createSunProbeMarkers(scene, sunProbeSamples)
    : new Map();
  /** Skip CPU pickWithRay when the sun direction has not moved meaningfully. */
  let cachedSunProbeKey: string | null = null;
  let cachedSunProbeReadings: ReturnType<typeof readSunProbes> | null = null;

  const sunProbeCacheKey = (
    toward: { x: number; y: number; z: number } | null,
    sunUp: boolean,
  ): string => {
    if (!sunUp || toward == null) {
      return "off";
    }
    return `${toward.x.toFixed(3)}:${toward.y.toFixed(3)}:${toward.z.toFixed(3)}`;
  };

  const resolveSunProbes = (
    toward: { x: number; y: number; z: number } | null,
    sunUp: boolean,
  ): ReturnType<typeof readSunProbes> => {
    const key = sunProbeCacheKey(toward, sunUp);
    if (key === cachedSunProbeKey && cachedSunProbeReadings) {
      return cachedSunProbeReadings;
    }
    cachedSunProbeKey = key;
    cachedSunProbeReadings = readSunProbes(scene, sunProbeSamples, toward, sunUp);
    return cachedSunProbeReadings;
  };

  const frameDollhouse = (): void => {
    const aspect =
      engine.getRenderWidth() / Math.max(1, engine.getRenderHeight()) || canvas.width / Math.max(1, canvas.height);
    const frame = computeDollhouseFrame(ir, {
      levelElevation: elev,
      aspect,
      bounds: meshBounds ?? undefined,
      homeView: opts.homeView,
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

  const cameraBasis = new Float64Array(6);

  /**
   * Ground-plane compass basis: screen-up = camera forward projected on XZ
   * (toward the dollhouse / top of the view). Forward is camera→target, so
   * use +forward_xz — not −forward_xz (that put every bearing 180° off).
   * Pick right-handed winding so projected sun−N matches geographic azimuth
   * (CW = CSS rotate). Verified: production ArcRotateCamera selects rightB.
   * Note: a 180° basis flip preserves sun−N, so winding auto-pick cannot
   * rescue a wrong screenUp sign.
   */
  const fillCameraBasis = (sunDirXZ: { x: number; z: number } | null, azDeg: number | null): void => {
    const forward = camera.getForwardRay().direction;
    let screenUp = new Vector3(forward.x, 0, forward.z);
    if (screenUp.lengthSquared() < 1e-10) {
      const invView = Matrix.Invert(camera.getViewMatrix());
      const camUp = Vector3.TransformNormal(new Vector3(0, 1, 0), invView);
      screenUp = new Vector3(camUp.x, 0, camUp.z);
    }
    screenUp.normalize();
    const rightA = new Vector3(screenUp.z, 0, -screenUp.x);
    const rightB = rightA.scale(-1);

    const write = (right: Vector3) => {
      cameraBasis[0] = right.x;
      cameraBasis[1] = 0;
      cameraBasis[2] = right.z;
      cameraBasis[3] = screenUp.x;
      cameraBasis[4] = 0;
      cameraBasis[5] = screenUp.z;
    };

    write(rightA);
    if (sunDirXZ == null || azDeg == null || !Number.isFinite(azDeg)) {
      return;
    }
    const geo = geographicNorthRenderDir(planNorthConfigDeg);
    const errFor = (right: Vector3): number => {
      write(right);
      const n = horizontalDirToScreenDeg(geo.x, geo.z, cameraBasis);
      const s = horizontalDirToScreenDeg(sunDirXZ.x, sunDirXZ.z, cameraBasis);
      const delta = ((s - n + 540) % 360) - 180;
      return Math.abs((((delta - azDeg + 540) % 360) - 180));
    };
    const errA = errFor(rightA);
    const errB = errFor(rightB);
    // Prefer rightB on ties: verified against camera view basis for dollhouse.
    write(errB <= errA ? rightB : rightA);
  };

  const applySun = (shading: SunShading): void => {
    lastSun = shading;
    const sunOn = shading.enabled && shading.sunIntensity > 0.04;
    const sceneSunScale = sunOn ? 1.75 : 0.88;
    const sceneAmbScale = sunOn ? 0.22 : 0.42;
    const sceneFillScale = sunOn ? 0 : 0.55;
    if (!shading.enabled) {
      ambient.intensity = 0.35 * ambientFillScale;
      ambient.direction = new Vector3(0, 1, 0);
      const idleTowardSun = new Vector3(0.5, 0.8, 0.4).normalize();
      sunLight.direction = idleTowardSun.scale(-1);
      sunLight.position = sunAim.add(idleTowardSun.scale(sunPull));
      sunLight.shadowFrustumSize = shadowFrustumSize;
      sunLight.autoUpdateExtends = false;
      sunLight.autoCalcShadowZBounds = false;
      sunLight.shadowMinZ = Math.max(20, sunPull - shadowDepthPad);
      sunLight.shadowMaxZ = sunPull + shadowDepthPad;
      sunLight.intensity = 0.58;
      sunLight.setEnabled(true);
      scene.clearColor = new Color4(0.9, 0.9, 0.89, 1);
      scene.environmentIntensity = 0.28 * ambientFillScale;
      sunShadow.darkness = 0.32;
      updateSunProbeMarkers(sunProbeMarkers, resolveSunProbes(null, false), false);
      return;
    }
    const d = shading.direction;
    const dir = new Vector3(d.x, d.y, d.z).normalize();
    const geomEl = shading.sourceElevation ?? 35;
    const lowSun = geomEl > 0 && geomEl < 18;
    sunLight.direction = dir.scale(-1);
    sunLight.position = sunAim.add(dir.scale(sunPull));
    // Re-assert fixed ortho every update — inspector / auto-extend must not shrink it.
    sunLight.shadowFrustumSize = shadowFrustumSize;
    sunLight.autoUpdateExtends = false;
    sunLight.autoCalcShadowZBounds = false;
    // Tight Z around the building (not 0→65 m). Keeps depth precision without
    // auto-fit XY, which paints a rotating frustum edge on the floor.
    const depthPad = shadowDepthPad * (lowSun ? 1.25 : 1);
    sunLight.shadowMinZ = Math.max(20, sunPull - depthPad);
    sunLight.shadowMaxZ = sunPull + depthPad;
    // Keep bias modest — large normalBias punches light through thin closet shells.
    sunShadow.bias = lowSun ? 0.0008 : 0.001;
    sunShadow.normalBias = lowSun ? 0.012 : 0.02;
    sunLight.intensity = shading.sunIntensity * sceneSunScale * (lowSun ? 1.08 : 1);
    sunLight.diffuse = new Color3(shading.sunColor[0], shading.sunColor[1], shading.sunColor[2]);
    // Do not fold fill into hemisphere while the sun is up — that bypasses ceiling shadows.
    ambient.intensity =
      Math.max(
        sunOn ? 0.04 : 0.06,
        shading.ambientIntensity * sceneAmbScale + shading.fillIntensity * sceneFillScale * 0.55,
      ) * ambientFillScale;
    ambient.diffuse = new Color3(
      shading.ambientColor[0],
      shading.ambientColor[1],
      shading.ambientColor[2],
    );
    ambient.groundColor = new Color3(
      shading.fillColor[0] * (sunOn ? 0.28 : 0.55),
      shading.fillColor[1] * (sunOn ? 0.28 : 0.55),
      shading.fillColor[2] * (sunOn ? 0.28 : 0.55),
    );
    ambient.direction = sunOn
      ? new Vector3(dir.x, Math.max(0.25, dir.y), dir.z).normalize()
      : new Vector3(0, 1, 0);
    scene.clearColor = new Color4(shading.sky[0], shading.sky[1], shading.sky[2], 1);
    scene.environmentIntensity =
      (sunOn ? 0.04 : Math.max(0.05, shading.ambientIntensity * 0.22)) * ambientFillScale;
    // Hard umbra for sealed shells; keep lit wall patches readable (not 0.9+ crush).
    sunShadow.darkness = sunOn ? (lowSun ? 0.82 : 0.76) : 0.28 + (1 - Math.min(1, shading.sunIntensity)) * 0.2;
    sunLight.setEnabled(sunOn);
    updateSunProbeMarkers(
      sunProbeMarkers,
      resolveSunProbes(sunOn ? d : null, sunOn),
      sunOn,
    );
  };

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

  let inspectorVisible = false;
  let inspectorToggleSeq = 0;

  const showInspector = async (): Promise<void> => {
    const seq = ++inspectorToggleSeq;
    await import("@babylonjs/core/Debug/debugLayer");
    await import("@babylonjs/inspector");
    if (seq !== inspectorToggleSeq) {
      return;
    }
    await scene.debugLayer.show({
      embedMode: true,
      overlay: true,
      handleResize: true,
      enablePopup: false,
    });
    if (seq !== inspectorToggleSeq) {
      scene.debugLayer.hide();
      return;
    }
    inspectorVisible = true;
  };

  const hideInspector = (): void => {
    inspectorToggleSeq += 1;
    if (scene.debugLayer.isVisible()) {
      scene.debugLayer.hide();
    }
    inspectorVisible = false;
  };

  const setInspector = (enabled: boolean): void => {
    if (enabled === inspectorVisible && (!enabled || scene.debugLayer.isVisible())) {
      return;
    }
    if (!enabled) {
      hideInspector();
      return;
    }
    void showInspector().catch((err: unknown) => {
      console.warn("Babylon inspector failed to open", err);
      inspectorVisible = false;
    });
  };

  if (opts.inspector) {
    setInspector(true);
  }

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
    setInspector,
    resetHomeView() {
      frameDollhouse();
    },
    projectPlanToScreenPercent(planPos) {
      const world = planToRender(planPos);
      const engineW = Math.max(1, engine.getRenderWidth());
      const engineH = Math.max(1, engine.getRenderHeight());
      const projected = Vector3.Project(
        world,
        Matrix.Identity(),
        scene.getTransformMatrix(),
        camera.viewport.toGlobal(engineW, engineH),
      );
      const behind = projected.z < 0 || projected.z > 1;
      if (behind) {
        return { left: 0, top: 0, behind: true };
      }
      return {
        left: (projected.x / engineW) * 100,
        top: (projected.y / engineH) * 100,
      };
    },
    getHomeView() {
      const eye = camera.position;
      const target = camera.getTarget();
      return {
        eye: [eye.x, eye.y, eye.z],
        target: [target.x, target.y, target.z],
        fovDeg: (camera.fov * 180) / Math.PI,
      };
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
    setAmbientFillScale(scale) {
      ambientFillScale = Math.max(0, Math.min(4, scale));
      if (lastSun) {
        applySun(lastSun);
      }
    },
    getCompassBearings() {
      // Project toward-sun; N = sunScreen − azimuth. Basis winding chosen to match az.
      const geo = geographicNorthRenderDir(planNorthConfigDeg);
      const sunOk =
        !!lastSun?.enabled &&
        lastSun.sunIntensity > 0.02 &&
        lastSunAzimuth != null &&
        Number.isFinite(lastSunAzimuth);
      fillCameraBasis(
        sunOk ? { x: lastSun!.direction.x, z: lastSun!.direction.z } : null,
        sunOk ? lastSunAzimuth : null,
      );
      const sunScreenDeg = sunOk
        ? horizontalDirToScreenDeg(lastSun!.direction.x, lastSun!.direction.z, cameraBasis)
        : null;
      const screen = resolveCompassScreenBearings({
        planNorthConfigDeg,
        planNorthScreenDeg: horizontalDirToScreenDeg(
          PLAN_NORTH_RENDER_DIR.x,
          PLAN_NORTH_RENDER_DIR.z,
          cameraBasis,
        ),
        sunScreenDeg,
        sunAzimuthDeg: sunOk ? lastSunAzimuth : null,
        geographicNorthScreenDegFallback: horizontalDirToScreenDeg(geo.x, geo.z, cameraBasis),
      });

      return {
        ...screen,
        sunAzimuthDeg: lastSunAzimuth,
        sunElevationDeg: lastSunElevation,
      };
    },
    getSunProbes() {
      const sunOn =
        !!lastSun?.enabled &&
        lastSun.sunIntensity > 0.02 &&
        lastSun.direction != null;
      return resolveSunProbes(sunOn ? lastSun!.direction : null, sunOn);
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
      hideInspector();
      fixtureLightSystem.dispose();
      scene.dispose();
      engine.dispose();
      lights.clear();
      stripEnds.clear();
    },
  };
};
