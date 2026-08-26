import { hexToRgb, kelvinToRgb, linearToSrgb, type RGB } from "./color";
import {
  solarPosition,
  WAALBANDIJK_SUN_LOCATION,
  type SolarLocation,
} from "./solar";
import {
  effectiveSunElevation,
  resolveFloorSunContext,
  type FloorSunContext,
  type FloorSunSources,
} from "./sun-horizon";

export { solarPosition, WAALBANDIJK_SUN_LOCATION } from "./solar";
export type { SolarLocation, SolarPosition } from "./solar";
export {
  effectiveSunElevation,
  localHorizonElevationDeg,
  observerHeightM,
  resolveFloorSunContext,
  waalbandijkFloorSunContext,
} from "./sun-horizon";
export type { FloorSunContext, FloorSunSources } from "./sun-horizon";

export interface SunEntityLike {
  state: string;
  attributes: Record<string, unknown>;
}

export interface SunPose {
  azimuth: number;
  elevation: number;
}

export interface SunShading {
  enabled: boolean;
  /** Unit vector toward the sun in three.js Y-up (plan +X east, +Z plan +Y). */
  direction: { x: number; y: number; z: number };
  sunColor: RGB;
  sunIntensity: number;
  ambientColor: RGB;
  ambientIntensity: number;
  fillColor: RGB;
  fillIntensity: number;
  sky: RGB;
  /** three.js Y (plan elevation cm) — aim direct sun toward window height. */
  targetElevationCm: number;
  /** Geographic pose before floor-horizon adjustment (compass labels). */
  sourceAzimuth?: number;
  sourceElevation?: number;
}

function rgb01(hex: string): RGB {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function numAttr(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key];
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return null;
}

/** Playground demo poses — real Waalbandijk solar on the reference summer day. */
export function playgroundSunPresets(
  location: SolarLocation = WAALBANDIJK_SUN_LOCATION,
  referenceDay = "2026-08-24",
  tz = "+02:00",
) {
  const at = (hour: number, minute: number): SunPose =>
    solarPosition(
      new Date(
        `${referenceDay}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${tz}`,
      ),
      location.latitude,
      location.longitude,
    );
  return {
    /** First usable direct sun on floor 10 (~07:00). */
    dawn: at(7, 0),
    /** Near solar transit — south-facing facades. */
    noon: at(13, 0),
    /** Floorplanner reference: 24 Aug 2026 16:12 (~SW). */
    afternoon: at(16, 12),
    /** Low west sun into living (~20:00). */
    sunset: at(20, 0),
    night: at(23, 0),
  } as const;
}

/** Clock / playground stand-in when `sun.sun` is missing. Uses Waalbandijk by default. */
export function approximateSun(
  now: Date,
  location: SolarLocation = WAALBANDIJK_SUN_LOCATION,
): SunPose {
  return solarPosition(now, location.latitude, location.longitude);
}

export function parseSunEntity(state: SunEntityLike | undefined): SunPose | null {
  if (!state) {
    return null;
  }
  const azimuth = numAttr(state.attributes, "azimuth");
  const elevation = numAttr(state.attributes, "elevation");
  if (azimuth === null && elevation === null) {
    return null;
  }
  let el = elevation;
  if (el === null) {
    el = state.state === "below_horizon" ? -12 : 35;
  }
  return {
    azimuth: azimuth ?? 180,
    elevation: el,
  };
}

/** Prefer explicit card config; fall back to scene sidecar export. */
export function resolvePlanNorthDeg(
  renderNorth: number | undefined,
  sceneNorth: number | undefined,
): number {
  if (typeof renderNorth === "number" && Number.isFinite(renderNorth)) {
    return renderNorth;
  }
  if (typeof sceneNorth === "number" && Number.isFinite(sceneNorth)) {
    return sceneNorth;
  }
  return 0;
}

/**
 * Compass azimuth (0=N, 90=E) + elevation → unit vector toward the sun in render space.
 *
 * `northDeg` is the compass heading of plan +Y (degrees clockwise from geographic north),
 * applied as an orthonormal rotation of the horizontal (east, north) frame into
 * render (x, z). Optional `mirrorX` flips render +X afterward — needed when the plan
 * mesh is Y-mirrored (e.g. Blender `-blender.y` export) so geographic east stays +X
 * while plan +Y points south (`north: 180` + `mirror_x: true`).
 */
export function sunDirection(
  azimuthDeg: number,
  elevationDeg: number,
  northDeg = 0,
  mirrorX = false,
): { x: number; y: number; z: number } {
  const el = (elevationDeg * Math.PI) / 180;
  const cosEl = Math.cos(el);
  const geoAz = (azimuthDeg * Math.PI) / 180;
  const geoEast = Math.sin(geoAz) * cosEl;
  const geoNorth = Math.cos(geoAz) * cosEl;
  const nRad = (northDeg * Math.PI) / 180;
  const cosN = Math.cos(nRad);
  const sinN = Math.sin(nRad);
  // Rotate geographic (east, north) → plan (x, z) with plan +Y at compass heading northDeg.
  let x = geoEast * cosN - geoNorth * sinN;
  const z = geoEast * sinN + geoNorth * cosN;
  if (mirrorX) {
    x = -x;
  }
  const y = Math.sin(el);
  const hLen = Math.hypot(x, z);
  if (hLen < 1e-9 && Math.abs(y) < 1e-9) {
    return { x: 0, y: 0, z: 0 };
  }
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

export function resolveCardFloorSun(sources: {
  render?: FloorSunSources & { floor_level?: number; floor_height_m?: number; elevation_m?: number };
  environment?: { floorLevel?: number; floorElevationM?: number };
}): FloorSunContext | undefined {
  const render = sources.render;
  return resolveFloorSunContext({
    floorLevel: render?.floor_level ?? sources.environment?.floorLevel,
    floorHeightM: render?.floor_height_m,
    elevationM: render?.elevation_m ?? sources.environment?.floorElevationM,
  });
}

export function shadeSun(opts: {
  azimuth: number;
  elevation: number;
  north?: number;
  /** Flip render +X after north rotation (Blender Y-mirrored plans). */
  mirrorX?: boolean;
  floor?: FloorSunContext;
  enabled?: boolean;
}): SunShading {
  const enabled = opts.enabled !== false;
  const geometricEl = opts.elevation;
  const el = opts.floor
    ? effectiveSunElevation(geometricEl, opts.floor, opts.azimuth)
    : geometricEl;
  const dir = sunDirection(opts.azimuth, Math.max(el, 0), opts.north ?? 0, opts.mirrorX === true);
  const day = smoothstep(-4, 18, el);
  const golden = smoothstep(2, 14, el) * (1 - smoothstep(22, 38, el));
  const kelvin = lerp(2200, 5800, smoothstep(0, 42, Math.max(el, 0)));
  const sunColor = linearToSrgb(kelvinToRgb(kelvin));
  const sunUp = el > 0;
  // Direct sun dies at the horizon. When up, it must dominate over ambient — hemisphere/IBL
  // are not occluded by ceilings, so high ambient reads as "every room lit from above".
  const sunIntensity =
    el <= 0
      ? 0
      : (0.16 + 0.74 * smoothstep(0.5, 30, el)) * (1 + golden * 0.22);
  const ambientColor = lerpRgb(rgb01("#6a7388"), rgb01("#cfc8bc"), day);
  const floorSkyBoost = opts.floor
    ? smoothstep(2, 10, opts.floor.floorLevel) * 0.06 * smoothstep(-6, 0, el)
    : 0;
  const ambientIntensity = sunUp
    ? lerp(0.04, 0.11, day)
    : lerp(0.14, 0.38, smoothstep(-14, 2, el)) + floorSkyBoost;
  const fillColor = lerpRgb(rgb01("#8a96b0"), rgb01("#e8eef5"), day);
  const fillIntensity = sunUp
    ? lerp(0.02, 0.06, day)
    : lerp(0.05, 0.26, day) + golden * 0.08 + floorSkyBoost * 0.35;
  const sky = lerpRgb(
    lerpRgb(rgb01("#12141c"), rgb01("#3d3558"), smoothstep(-8, 0, el)),
    lerpRgb(rgb01("#e0b07a"), rgb01("#c5d0de"), smoothstep(4, 22, el)),
    day,
  );
  return {
    enabled,
    direction: dir,
    sunColor,
    sunIntensity,
    ambientColor,
    ambientIntensity,
    fillColor,
    fillIntensity,
    sky,
    targetElevationCm: 150,
    sourceAzimuth: opts.azimuth,
    sourceElevation: geometricEl,
  };
}

export function sunShadingFromHass(
  hass: { states?: Record<string, SunEntityLike> } | undefined,
  ambient: string | undefined,
  north = 0,
  now = new Date(),
  floor?: FloorSunContext,
  mirrorX = false,
): SunShading {
  const mode = ambient ?? "sun";
  if (mode === "off") {
    return shadeSun({ azimuth: 180, elevation: 45, north, mirrorX, floor, enabled: false });
  }
  const entityId = mode === "sun" ? "sun.sun" : mode;
  const parsed = parseSunEntity(hass?.states?.[entityId]);
  const pose = parsed ?? approximateSun(now);
  return shadeSun({ ...pose, north, mirrorX, floor, enabled: true });
}
