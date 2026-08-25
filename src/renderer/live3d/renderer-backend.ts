/** WebGPU-first live3d renderer factory (Three.js WebGPURenderer → WebGL2 fallback). */

export type Live3dGpuBackend = "webgpu" | "webgl";

/** Minimal renderer surface used by live3d/scene.ts (WebGL + WebGPU). */
export interface Live3dGpuRenderer {
  outputColorSpace: string;
  toneMapping: number;
  toneMappingExposure: number;
  shadowMap: { enabled: boolean; type: number | null };
  setClearColor(color: number | import("three").Color, alpha?: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  setScissorTest(enable: boolean): void;
  setViewport(x: number, y: number, width: number, height: number): void;
  render(scene: import("three").Scene, camera: import("three").Camera): void;
  dispose(): void;
}

type ThreeNamespace = typeof import("three");

export interface Live3dGpuContext {
  renderer: Live3dGpuRenderer;
  /** three or three/webgpu module namespace used to build the scene. */
  three: ThreeNamespace;
  /** Requested backend (`render.gpu`). */
  requested: Live3dGpuBackend;
  /** Active GPU API after init (WebGPURenderer may fall back to WebGL2). */
  active: Live3dGpuBackend;
}

function resolveActiveBackend(
  renderer: Live3dGpuRenderer & { backend?: { isWebGPUBackend?: boolean } },
  requested: Live3dGpuBackend,
): Live3dGpuBackend {
  if (requested === "webgl") {
    return "webgl";
  }
  if (renderer.backend?.isWebGPUBackend === true) {
    return "webgpu";
  }
  return "webgl";
}

function configureRenderer(renderer: Live3dGpuRenderer, THREE: ThreeNamespace): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0xe6e6e4, 1);
}

/** Create and initialize the live3d GPU renderer. Defaults to WebGPU with WebGL2 fallback. */
export async function createLive3dGpuRenderer(
  canvas: HTMLCanvasElement,
  requested: Live3dGpuBackend = "webgpu",
): Promise<Live3dGpuContext> {
  if (requested === "webgl") {
    const THREE = await import("three");
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    }) as unknown as Live3dGpuRenderer;
    configureRenderer(renderer, THREE);
    return { renderer, three: THREE, requested, active: "webgl" };
  }

  const webgpu = await import("three/webgpu");
  const THREE = webgpu as unknown as ThreeNamespace;
  const renderer = new webgpu.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
  }) as unknown as Live3dGpuRenderer & {
    init(): Promise<void>;
    backend?: { isWebGPUBackend?: boolean };
  };
  await renderer.init();
  configureRenderer(renderer, THREE);

  return {
    renderer,
    three: THREE,
    requested,
    active: resolveActiveBackend(renderer, requested),
  };
}
