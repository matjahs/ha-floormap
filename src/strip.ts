import type { FloorplanIR, LightFixtureIR } from "./import/ir";
import type { FixtureOverride, LightParams, StripSegmentConfig, Vec3 } from "./types";

export const DEFAULT_STRIP_SAMPLES = 8;

export function resolveFixtureKind(
  fx: LightFixtureIR | undefined,
  override?: FixtureOverride,
): "point" | "strip" {
  if (override?.kind) {
    return override.kind;
  }
  return fx?.kind ?? "point";
}

export function resolveStripEnd(
  ir: FloorplanIR | null | undefined,
  fixtureId: string,
  overrides?: Record<string, FixtureOverride>,
): Vec3 | undefined {
  const o = overrides?.[fixtureId]?.end;
  if (o && o.length === 3 && o.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { x: o[0], y: o[1], z: o[2] };
  }
  return ir?.fixtures.find((f) => f.id === fixtureId)?.end;
}

export function resolveStripSamples(
  fx: LightFixtureIR | undefined,
  override?: FixtureOverride,
): number {
  const n = override?.samples ?? fx?.samples ?? DEFAULT_STRIP_SAMPLES;
  return Math.max(2, Math.min(32, Math.round(n)));
}

/** Interpolate along strip start→end at fraction t ∈ [0,1]. */
export function lerpStrip(start: Vec3, end: Vec3, t: number): Vec3 {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    z: start.z + (end.z - start.z) * t,
  };
}

export function stripSamplePositions(start: Vec3, end: Vec3, samples: number): Vec3[] {
  const n = Math.max(2, samples);
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    out.push(lerpStrip(start, end, i / (n - 1)));
  }
  return out;
}

export function segmentMidpoint(
  start: Vec3,
  end: Vec3,
  seg: StripSegmentConfig,
): Vec3 {
  const t = (clamp01(seg.start) + clamp01(seg.end)) / 2;
  return lerpStrip(start, end, t);
}

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/**
 * Map each sample index to LightParams from segments (or master fallback).
 * Sample i is at fraction i/(n-1).
 */
export function paramsForStripSamples(
  sampleCount: number,
  segments: StripSegmentConfig[] | undefined,
  segmentParams: Map<number, LightParams>,
  master: LightParams,
): LightParams[] {
  const n = Math.max(2, sampleCount);
  const out: LightParams[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let chosen: LightParams | undefined;
    if (segments) {
      for (let s = 0; s < segments.length; s++) {
        const seg = segments[s]!;
        const a = clamp01(seg.start);
        const b = clamp01(seg.end);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        if (t >= lo - 1e-6 && t <= hi + 1e-6) {
          chosen = segmentParams.get(s) ?? master;
          break;
        }
      }
    }
    out.push(chosen ?? master);
  }
  return out;
}

/** Average segment/master params for baked single-overlay intensity. */
export function averageStripParams(params: LightParams[]): LightParams {
  if (params.length === 0) {
    return {
      intensity: 0,
      color: [1, 1, 1],
      on: false,
      unavailable: false,
      unknown: false,
    };
  }
  let onCount = 0;
  let inten = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let unavailable = false;
  let unknown = false;
  for (const p of params) {
    if (p.on) {
      onCount++;
      inten += p.intensity;
      r += p.color[0];
      g += p.color[1];
      b += p.color[2];
    }
    unavailable = unavailable || p.unavailable;
    unknown = unknown || p.unknown;
  }
  if (onCount === 0) {
    return {
      intensity: 0,
      color: params[0]!.color,
      on: false,
      unavailable,
      unknown,
    };
  }
  return {
    intensity: inten / onCount,
    color: [r / onCount, g / onCount, b / onCount],
    on: true,
    unavailable,
    unknown,
  };
}
