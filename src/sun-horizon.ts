/** Observer height and local skyline for sun visibility on upper floors. */

export interface SunObstructionConfig {
  /** Obstacle height above street level (m), e.g. opposite roofline. */
  height_m?: number;
  /** Horizontal distance to that obstacle (m). */
  distance_m?: number;
  /** Lower skyline on west-facing facades (canal / open side). */
  west_height_m?: number;
  west_distance_m?: number;
}

export interface FloorSunContext {
  floorLevel: number;
  floorHeightM: number;
  obstructionHeightM: number;
  obstructionDistanceM: number;
  westObstructionHeightM?: number;
  westObstructionDistanceM?: number;
}

/** Typical Dutch floor height (m). */
export const DEFAULT_FLOOR_HEIGHT_M = 3.05;

/** Default roofline used when no `sun_obstruction` is configured (m). */
export const DEFAULT_OBSTRUCTION_HEIGHT_M = 22;

/** Default distance to that roofline (m). */
export const DEFAULT_OBSTRUCTION_DISTANCE_M = 40;

/** Waalbandijk: quay / low trees west over the canal (m). */
export const WAALBANDIJK_WEST_OBSTRUCTION_HEIGHT_M = 5;

export const WAALBANDIJK_WEST_OBSTRUCTION_DISTANCE_M = 70;

export interface FloorSunSources {
  floorLevel?: number;
  floorHeightM?: number;
  obstruction?: SunObstructionConfig;
}

export function observerHeightM(ctx: Pick<FloorSunContext, "floorLevel" | "floorHeightM">): number {
  return Math.max(0, (ctx.floorLevel - 1) * ctx.floorHeightM);
}

function horizonForObstacle(
  eyeM: number,
  obstacleHeightM: number,
  distanceM: number,
): number {
  const rel = obstacleHeightM - eyeM;
  if (rel <= 0) {
    return 0;
  }
  return (Math.atan2(rel, distanceM) * 180) / Math.PI;
}

/** Minimum geometric sun elevation (°) to clear local obstructions at this floor. */
export function localHorizonElevationDeg(
  ctx: FloorSunContext,
  sunAzimuthDeg: number,
): number {
  const eye = observerHeightM(ctx);
  let horizon = horizonForObstacle(
    eye,
    ctx.obstructionHeightM,
    ctx.obstructionDistanceM,
  );

  if (ctx.westObstructionHeightM != null) {
    const az = ((sunAzimuthDeg % 360) + 360) % 360;
    // Afternoon / west arc — balcony and canal-side windows.
    if (az >= 200 && az <= 320) {
      const westHorizon = horizonForObstacle(
        eye,
        ctx.westObstructionHeightM,
        ctx.westObstructionDistanceM ?? ctx.obstructionDistanceM,
      );
      horizon = Math.max(horizon, westHorizon);
    }
  }

  return horizon;
}

/** Elevation relative to the local skyline (negative = still blocked). */
export function effectiveSunElevation(
  geometricDeg: number,
  ctx: FloorSunContext,
  sunAzimuthDeg: number,
): number {
  return geometricDeg - localHorizonElevationDeg(ctx, sunAzimuthDeg);
}

export function resolveFloorSunContext(sources: FloorSunSources): FloorSunContext | undefined {
  const floorLevel = sources.floorLevel;
  if (typeof floorLevel !== "number" || !Number.isFinite(floorLevel) || floorLevel < 1) {
    return undefined;
  }
  const obs = sources.obstruction ?? {};
  return {
    floorLevel: Math.round(floorLevel),
    floorHeightM: sources.floorHeightM ?? DEFAULT_FLOOR_HEIGHT_M,
    obstructionHeightM: obs.height_m ?? DEFAULT_OBSTRUCTION_HEIGHT_M,
    obstructionDistanceM: obs.distance_m ?? DEFAULT_OBSTRUCTION_DISTANCE_M,
    westObstructionHeightM: obs.west_height_m,
    westObstructionDistanceM: obs.west_distance_m,
  };
}

/** Waalbandijk 469 level 10 — west over canal, other sides typical mid-rise. */
export function waalbandijkFloorSunContext(floorLevel = 10): FloorSunContext {
  return {
    floorLevel,
    floorHeightM: DEFAULT_FLOOR_HEIGHT_M,
    obstructionHeightM: DEFAULT_OBSTRUCTION_HEIGHT_M,
    obstructionDistanceM: DEFAULT_OBSTRUCTION_DISTANCE_M,
    westObstructionHeightM: WAALBANDIJK_WEST_OBSTRUCTION_HEIGHT_M,
    westObstructionDistanceM: WAALBANDIJK_WEST_OBSTRUCTION_DISTANCE_M,
  };
}
