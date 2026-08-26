/** Exterior-wall envelope + geographic east/west for sun probes (plan/render X). */

import type { RoomIR } from "./import/ir";

export interface WallEnvelope {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface EastWestPlanHint {
  /** Geographic west side (living) — plan X from room polygons. */
  westX: number;
  /** Geographic east side (bedroom / office) — plan X from room polygons. */
  eastX: number;
}

function polygonCentroidX(polygon: Array<{ x: number; y: number }>): number {
  if (polygon.length === 0) {
    return 0;
  }
  return polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length;
}

/** Room centroids — not wall mesh names — to orient envelope ±X. */
export function eastWestPlanHintFromRooms(rooms: RoomIR[]): EastWestPlanHint | undefined {
  const living = rooms.find((r) => r.id === "living");
  const bedroom = rooms.find((r) => r.id === "bedroom");
  const office = rooms.find((r) => r.id === "home_office");
  if (!living?.polygon.length) {
    return undefined;
  }
  const eastRooms = [bedroom, office].filter(
    (r): r is RoomIR => !!r?.polygon.length,
  );
  if (eastRooms.length === 0) {
    return undefined;
  }
  const eastX =
    eastRooms.reduce((sum, r) => sum + polygonCentroidX(r.polygon), 0) /
    eastRooms.length;
  return {
    westX: polygonCentroidX(living.polygon),
    eastX,
  };
}

export function mergeWallEnvelope(
  env: WallEnvelope | null,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): WallEnvelope {
  if (!env) {
    return { minX, maxX, minZ, maxZ };
  }
  return {
    minX: Math.min(env.minX, minX),
    maxX: Math.max(env.maxX, maxX),
    minZ: Math.min(env.minZ, minZ),
    maxZ: Math.max(env.maxZ, maxZ),
  };
}

/**
 * Whether mesh +X aligns with geographic east.
 * Compares living vs office/bedroom wall centers in *mesh* space to plan ordering.
 * Never compares plan coordinates to mesh coordinates directly.
 */
export function meshXPointsEast(
  livingMeshX: number,
  eastMeshX: number,
  hint: EastWestPlanHint,
): boolean {
  const planEastHigher = hint.eastX > hint.westX;
  const meshEastHigher = eastMeshX > livingMeshX;
  return planEastHigher === meshEastHigher;
}

/** @deprecated Use meshXPointsEast — plan vs mesh AABB comparison is invalid. */
export function envelopeXPointsEast(
  env: WallEnvelope,
  hint: EastWestPlanHint,
): boolean {
  return Math.abs(env.maxX - hint.eastX) <= Math.abs(env.maxX - hint.westX);
}

/** Closest envelope face → geometric outward (mesh axes; maxX always +X). */
export function geometricOutwardFromEnvelope(
  centerX: number,
  centerZ: number,
  env: WallEnvelope,
): { x: number; y: number; z: number } {
  const dMaxX = env.maxX - centerX;
  const dMinX = centerX - env.minX;
  const dMaxZ = env.maxZ - centerZ;
  const dMinZ = centerZ - env.minZ;
  const minD = Math.min(dMaxX, dMinX, dMaxZ, dMinZ);
  if (minD === dMaxX) {
    return { x: 1, y: 0, z: 0 };
  }
  if (minD === dMinX) {
    return { x: -1, y: 0, z: 0 };
  }
  if (minD === dMaxZ) {
    return { x: 0, y: 0, z: 1 };
  }
  return { x: 0, y: 0, z: -1 };
}

/**
 * Geographic facade normal for sun math (east facade → +X when north=180).
 * Flips mesh X when the glTF is mirrored vs plan.
 */
export function geographicFacadeNormal(
  geometric: { x: number; y: number; z: number },
  xPointsEast: boolean,
): { x: number; y: number; z: number } {
  if (xPointsEast) {
    return geometric;
  }
  return { x: -geometric.x, y: geometric.y, z: geometric.z };
}

/**
 * Closest envelope face → geographic outward facade normal (cardinal).
 * Placement must use geometricOutwardFromEnvelope, not this, when mirrored.
 */
export function facadeNormalFromEnvelope(
  centerX: number,
  centerZ: number,
  env: WallEnvelope,
  xPointsEast: boolean,
): { x: number; y: number; z: number } {
  return geographicFacadeNormal(
    geometricOutwardFromEnvelope(centerX, centerZ, env),
    xPointsEast,
  );
}

/** AABB face sign for *geometric* outward (probe placement). */
export function facadeFaceSignFromNormal(facade: { x: number; z: number }): {
  thinAxis: "x" | "z";
  sign: 1 | -1;
} {
  if (Math.abs(facade.x) >= Math.abs(facade.z)) {
    return { thinAxis: "x", sign: facade.x >= 0 ? 1 : -1 };
  }
  return { thinAxis: "z", sign: facade.z >= 0 ? 1 : -1 };
}
