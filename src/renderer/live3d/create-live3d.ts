import type { FloorplanIR, CameraIR } from "../../import/ir";
import type { Live3dEngine } from "../../types";
import type { Live3dHandle, Live3dOptions } from "./handle";

/** Create the live3d dollhouse renderer (Three.js or Babylon.js). */
export async function createLive3dRenderer(
  ir: FloorplanIR,
  canvas: HTMLCanvasElement,
  initialCamera?: CameraIR,
  opts: Live3dOptions = {},
): Promise<Live3dHandle> {
  const engine: Live3dEngine = opts.engine ?? "three";
  if (engine === "babylon") {
    const { createBabylonLive3dRenderer } = await import("./babylon-scene");
    return createBabylonLive3dRenderer(ir, canvas, initialCamera, opts);
  }
  const { createThreeLive3dRenderer } = await import("./scene-three");
  return createThreeLive3dRenderer(ir, canvas, initialCamera, opts);
}
