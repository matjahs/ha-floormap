/** Floor height / elevation for apparent-horizon twilight tuning. */

export interface FloorSunContext {
  floorLevel: number;
  floorHeightM: number;
  /** Height above street level (m). When set, overrides (floorLevel − 1) × floorHeightM. */
  elevationM?: number;
}

/** Typical Dutch floor-to-floor height (m). */
export const DEFAULT_FLOOR_HEIGHT_M = 3.05;

/** Waalbandijk 469 level 10 — height above street (m). */
export const WAALBANDIJK_ELEVATION_M = 32;

/** Mean Earth radius (m) for geometric horizon dip. */
const EARTH_RADIUS_M = 6_371_000;

export interface FloorSunSources {
  floorLevel?: number;
  floorHeightM?: number;
  elevationM?: number;
}

export function observerHeightM(ctx: Pick<FloorSunContext, "floorLevel" | "floorHeightM" | "elevationM">): number {
  if (typeof ctx.elevationM === "number" && Number.isFinite(ctx.elevationM) && ctx.elevationM >= 0) {
    return ctx.elevationM;
  }
  return Math.max(0, (ctx.floorLevel - 1) * ctx.floorHeightM);
}

/**
 * Geometric horizon elevation (degrees) for a flat Earth limb from observer height.
 * Negative = sun is still visible slightly below geometric elevation 0.
 * Surroundings are not modeled; azimuth is unused.
 */
export function localHorizonElevationDeg(
  ctx: FloorSunContext,
  _sunAzimuthDeg: number,
): number {
  const h = observerHeightM(ctx);
  if (h <= 0) {
    return 0;
  }
  const dipRad = Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + h));
  return -(dipRad * 180) / Math.PI;
}

/**
 * Elevation used for shading intensity / direction after local horizon dip.
 * `render.elevation_m` (via observer height) advances dawn/dusk slightly on high floors.
 */
export function effectiveSunElevation(
  geometricDeg: number,
  ctx?: FloorSunContext,
  sunAzimuthDeg?: number,
): number {
  if (!ctx) {
    return geometricDeg;
  }
  return geometricDeg - localHorizonElevationDeg(ctx, sunAzimuthDeg ?? 0);
}

export function resolveFloorSunContext(sources: FloorSunSources): FloorSunContext | undefined {
  const floorLevel = sources.floorLevel;
  if (typeof floorLevel !== "number" || !Number.isFinite(floorLevel) || floorLevel < 1) {
    return undefined;
  }
  return {
    floorLevel: Math.round(floorLevel),
    floorHeightM: sources.floorHeightM ?? DEFAULT_FLOOR_HEIGHT_M,
    ...(typeof sources.elevationM === "number" && Number.isFinite(sources.elevationM) && sources.elevationM >= 0
      ? { elevationM: sources.elevationM }
      : {}),
  };
}

/** Convenience for Waalbandijk tests and playground. */
export function waalbandijkFloorSunContext(floorLevel = 10): FloorSunContext {
  const level = Math.round(floorLevel);
  if (!Number.isFinite(floorLevel) || level < 1) {
    throw new Error(`waalbandijkFloorSunContext: floorLevel must be >= 1 (got ${floorLevel})`);
  }
  // L10 has a measured site elevation; other floors estimate from storey height.
  const elevationM =
    level === 10 ? WAALBANDIJK_ELEVATION_M : (level - 1) * DEFAULT_FLOOR_HEIGHT_M;
  return {
    floorLevel: level,
    floorHeightM: DEFAULT_FLOOR_HEIGHT_M,
    elevationM,
  };
}
