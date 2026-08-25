/** Screen compass bearings for the live3d dollhouse (playground / debug). */

export interface CompassBearings {
  /** Geographic north on screen; 0° = up, clockwise (CSS `rotate`). */
  geographicNorthScreenDeg: number;
  /** Plan +Y on screen, same convention. */
  planNorthScreenDeg: number;
  /** `render.north` — compass heading of plan +Y. */
  planNorthConfigDeg: number;
  /** Sun position on screen, same convention; null when below horizon. */
  sunScreenDeg: number | null;
  /** Geographic sun azimuth used for shading (degrees). */
  sunAzimuthDeg: number | null;
  sunElevationDeg: number | null;
}

/** Horizontal render-space unit vector for geographic north given plan +Y heading. */
export function geographicNorthRenderDir(planNorthConfigDeg: number): { x: number; z: number } {
  const rad = (-planNorthConfigDeg * Math.PI) / 180;
  return { x: Math.sin(rad), z: Math.cos(rad) };
}

/** Plan +Y in render space is always +Z. */
export const PLAN_NORTH_RENDER_DIR = { x: 0, z: 1 };

/**
 * Map a horizontal world direction to screen degrees (0 = up, clockwise).
 * `cameraBasis` is [right.x, right.y, right.z, up.x, up.y, up.z] from the camera.
 */
export function horizontalDirToScreenDeg(
  dx: number,
  dz: number,
  cameraBasis: Float64Array | number[],
): number {
  const len = Math.hypot(dx, dz) || 1;
  const x = dx / len;
  const z = dz / len;
  const rx = cameraBasis[0]!;
  const rz = cameraBasis[2]!;
  const ux = cameraBasis[3]!;
  const uz = cameraBasis[5]!;
  const sx = x * rx + z * rz;
  const sy = x * ux + z * uz;
  return (Math.atan2(sx, sy) * 180) / Math.PI;
}
