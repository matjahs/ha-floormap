/** Debug probes: does this wall face receive direct sunlight? */

export type SunProbeSide = "interior" | "exterior";

export interface SunProbeSample {
  /** Stable id: `${wallName}::${side}` */
  id: string;
  wallName: string;
  side: SunProbeSide;
  /** World / render-space position (cm). */
  position: { x: number; y: number; z: number };
  /** Unit normal: horizontal facade direction (outward from plan center). */
  normal: { x: number; y: number; z: number };
}

export interface SunProbeReading extends SunProbeSample {
  /** Cosine of angle between face normal and direction toward the sun. */
  ndotL: number;
  facingSun: boolean;
  /** True when a ray toward the sun hits opaque geometry. */
  occluded: boolean;
  /** facingSun && !occluded */
  receivesSun: boolean;
}

export function classifyExteriorWallName(name: string): {
  isExteriorWall: boolean;
  preferredSide: SunProbeSide | null;
} {
  const n = name.toLowerCase();
  if (!/wall/i.test(name)) {
    return { isExteriorWall: false, preferredSide: null };
  }
  if (n.includes("buitenblad")) {
    return { isExteriorWall: true, preferredSide: "exterior" };
  }
  if (n.includes("binnenblad")) {
    return { isExteriorWall: true, preferredSide: "interior" };
  }
  if (/\bext\b|ext–|ext-/.test(n) || n.includes("ext–") || n.includes("ext-")) {
    return { isExteriorWall: true, preferredSide: null };
  }
  return { isExteriorWall: false, preferredSide: null };
}

/** Face receives direct sun when it looks toward the sun and nothing blocks the ray. */
export function evaluateSunProbeReceive(opts: {
  ndotL: number;
  occluded: boolean;
  facingThreshold?: number;
  /** Buitenblad: outward facade facing is sufficient (skip cavity self-hits). */
  trustFacingOnly?: boolean;
}): Pick<SunProbeReading, "ndotL" | "facingSun" | "occluded" | "receivesSun"> {
  const facingThreshold = opts.facingThreshold ?? 0.02;
  const facingSun = opts.ndotL > facingThreshold;
  const blocked = opts.trustFacingOnly ? false : opts.occluded;
  return {
    ndotL: opts.ndotL,
    facingSun,
    occluded: opts.trustFacingOnly ? false : opts.occluded,
    receivesSun: facingSun && !blocked,
  };
}

/** Horizontal unit normal pointing from plan center toward a facade. */
export function horizontalFacadeNormalFromCenter(
  centerX: number,
  centerZ: number,
  planCx: number,
  planCz: number,
): { x: number; y: number; z: number } {
  const dx = centerX - planCx;
  const dz = centerZ - planCz;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, y: 0, z: dz / len };
}

/** Whether a facade with this normal receives direct sun (ignoring occlusion). */
export function facadeReceivesDirectSun(
  facadeNormal: { x: number; y: number; z: number },
  towardSun: { x: number; y: number; z: number },
): boolean {
  return ndotTowardSun(facadeNormal, towardSun) > 0.02;
}

export function ndotTowardSun(
  normal: { x: number; y: number; z: number },
  towardSun: { x: number; y: number; z: number },
): number {
  return normal.x * towardSun.x + normal.y * towardSun.y + normal.z * towardSun.z;
}

/**
 * Evenly spaced stations along a wall length (cm), inset from both ends.
 * Returns positions in [0, length] along the long axis.
 */
export function probeStationsAlongLength(
  lengthCm: number,
  spacingCm = 120,
  marginCm = 50,
): number[] {
  if (!Number.isFinite(lengthCm) || lengthCm <= 0) {
    return [];
  }
  if (lengthCm < marginCm * 2) {
    return [lengthCm / 2];
  }
  const usable = lengthCm - 2 * marginCm;
  const count = Math.max(1, Math.round(usable / spacingCm));
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(marginCm + (usable * (i + 0.5)) / count);
  }
  return out;
}

/** Quantize world cm for spatial dedupe of nearby fragment probes (side-agnostic). */
export function probeSpatialKey(x: number, z: number, cellCm = 80): string {
  const qx = Math.round(x / cellCm);
  const qz = Math.round(z / cellCm);
  return `${qx}:${qz}`;
}
