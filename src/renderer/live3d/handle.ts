import type { FloorplanIR, CameraIR } from "../../import/ir";
import type { LightParams, Live3dEngine, Vec3 } from "../../types";
import type { SunShading } from "../../sun";
import type { CompassBearings } from "../../compass";
import type { Live3dGpuBackend } from "./renderer-backend";

export interface Live3dHandle {
  canvas: HTMLCanvasElement;
  /** Active GPU API (Three WebGPU/WebGL2 or Babylon WebGPU/WebGL). */
  rendererBackend: Live3dGpuBackend;
  setLight(fixtureId: string, params: LightParams): void;
  setLightSamples(fixtureId: string, params: LightParams[]): void;
  setLightPosition(fixtureId: string, pos: Vec3): void;
  setStripPose(fixtureId: string, start: Vec3, end: Vec3): void;
  setCamera(cam: CameraIR): void;
  setEditTopDown(enabled: boolean): void;
  setOrbitEnabled(enabled: boolean): void;
  setHandlesVisible(visible: boolean): void;
  raycastFloor(clientX: number, clientY: number, fixtureId?: string): Vec3 | null;
  pickFixture(clientX: number, clientY: number, allowedIds?: Set<string>): string | null;
  setSun(shading: SunShading): void;
  getCompassBearings(): CompassBearings;
  resize(width: number, height: number): void;
  render(): void;
  dispose(): void;
}

export interface Live3dOptions {
  poses?: Record<string, Vec3>;
  stripEnds?: Record<string, Vec3>;
  levelElevation?: number;
  editableFixtureIds?: string[];
  editableFixtureLabels?: Record<string, string>;
  editableFixtureRooms?: Record<string, string>;
  sceneGltfUrl?: string;
  planNorthDeg?: number;
  gpu?: Live3dGpuBackend;
  lockCamera?: boolean;
  /** live3d backend — default three; babylon for WebGPU spike. */
  engine?: Live3dEngine;
}

export type Live3dFactory = (
  ir: FloorplanIR,
  canvas: HTMLCanvasElement,
  initialCamera?: CameraIR,
  opts?: Live3dOptions,
) => Promise<Live3dHandle>;

/** Playground / debug readout for active live3d GPU backend. */
export interface Live3dDebugInfo {
  ready: boolean;
  fallback: boolean;
  backend: Live3dGpuBackend | null;
  engine: Live3dEngine;
  requestedGpu: Live3dGpuBackend;
  error: string | null;
}
