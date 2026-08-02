import {
  brightnessToIntensity,
  kelvinToRgb,
  normalizeLuminance,
  rgb255ToLinear,
  type RGB,
} from "../../color";
import type { FixtureOverride, LightParams } from "../../types";

export interface HassStateLike {
  state: string;
  attributes: Record<string, unknown>;
}

export interface TransitioningLight {
  current: LightParams;
  target: LightParams;
  start: LightParams;
  startTime: number;
  duration: number;
}

export function entityToLightParams(
  state: HassStateLike | undefined,
  opts: {
    power?: number;
    gain?: number;
    gamma?: number;
    curve?: "gamma" | "linear";
    overrideColor?: string;
  } = {},
): LightParams {
  if (!state) {
    return {
      intensity: 0,
      color: [1, 1, 1],
      on: false,
      unavailable: true,
      unknown: false,
    };
  }
  const s = state.state;
  const unavailable = s === "unavailable";
  const unknown = s === "unknown";
  const on = s === "on";
  const attrs = state.attributes as Record<string, unknown>;
  const brightness = attrs.brightness as number | undefined;
  const intensity = brightnessToIntensity(
    brightness,
    on ? "on" : s,
    opts.gamma ?? 2.2,
    opts.power ?? 1,
    opts.gain ?? 1,
    opts.curve ?? "gamma",
  );

  let color: RGB = [1, 1, 1];
  if (opts.overrideColor) {
    const hex = opts.overrideColor.replace("#", "");
    const n = Number.parseInt(hex, 16);
    color = normalizeLuminance(
      rgb255ToLinear([(n >> 16) & 255, (n >> 8) & 255, n & 255]),
    );
  } else if (Array.isArray(attrs.rgb_color)) {
    const rgb = attrs.rgb_color as number[];
    color = normalizeLuminance(rgb255ToLinear([rgb[0] ?? 255, rgb[1] ?? 255, rgb[2] ?? 255]));
  } else if (typeof attrs.color_temp_kelvin === "number") {
    color = kelvinToRgb(attrs.color_temp_kelvin as number);
  } else if (typeof attrs.color_temp === "number") {
    // mireds → kelvin
    const mireds = attrs.color_temp as number;
    if (mireds > 0) {
      color = kelvinToRgb(1_000_000 / mireds);
    }
  }

  return {
    intensity,
    color,
    on,
    unavailable,
    unknown,
    effect: typeof attrs.effect === "string" ? attrs.effect : undefined,
  };
}

export function lerpParams(a: LightParams, b: LightParams, t: number): LightParams {
  const u = Math.min(1, Math.max(0, t));
  const ease = 1 - Math.pow(1 - u, 3); // ease-out cubic
  return {
    intensity: a.intensity + (b.intensity - a.intensity) * ease,
    color: [
      a.color[0] + (b.color[0] - a.color[0]) * ease,
      a.color[1] + (b.color[1] - a.color[1]) * ease,
      a.color[2] + (b.color[2] - a.color[2]) * ease,
    ],
    on: b.on,
    unavailable: b.unavailable,
    unknown: b.unknown,
    effect: b.effect,
  };
}

export class LightStateAnimator {
  private lights = new Map<string, TransitioningLight>();
  private raf = 0;
  private onFrame: (() => void) | null = null;

  setOnFrame(cb: (() => void) | null): void {
    this.onFrame = cb;
  }

  get(id: string): LightParams | undefined {
    return this.lights.get(id)?.current;
  }

  getAll(): Map<string, LightParams> {
    const out = new Map<string, LightParams>();
    for (const [id, t] of this.lights) {
      out.set(id, t.current);
    }
    return out;
  }

  setTarget(
    id: string,
    target: LightParams,
    durationMs: number,
    now = performance.now(),
  ): void {
    const existing = this.lights.get(id);
    const start = existing?.current ?? { ...target, intensity: 0 };
    this.lights.set(id, {
      current: start,
      target,
      start,
      startTime: now,
      duration: Math.max(0, durationMs),
    });
    this.ensureRaf();
  }

  /** Snap without animation (initial load). */
  snap(id: string, params: LightParams): void {
    this.lights.set(id, {
      current: params,
      target: params,
      start: params,
      startTime: performance.now(),
      duration: 0,
    });
  }

  isAnimating(): boolean {
    const now = performance.now();
    for (const t of this.lights.values()) {
      if (t.duration > 0 && now - t.startTime < t.duration) {
        return true;
      }
    }
    return false;
  }

  tick(now = performance.now()): boolean {
    let dirty = false;
    for (const t of this.lights.values()) {
      if (t.duration <= 0) {
        if (t.current !== t.target) {
          t.current = t.target;
          dirty = true;
        }
        continue;
      }
      const u = (now - t.startTime) / t.duration;
      if (u >= 1) {
        if (t.current.intensity !== t.target.intensity) {
          dirty = true;
        }
        t.current = t.target;
        t.duration = 0;
      } else {
        t.current = lerpParams(t.start, t.target, u);
        dirty = true;
      }
    }
    return dirty;
  }

  private ensureRaf(): void {
    if (this.raf) {
      return;
    }
    const loop = () => {
      this.raf = 0;
      const dirty = this.tick();
      if (dirty && this.onFrame) {
        this.onFrame();
      }
      if (this.isAnimating()) {
        this.raf = requestAnimationFrame(loop);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.lights.clear();
    this.onFrame = null;
  }
}

export function mergeOverride(
  base: { power?: number },
  override?: FixtureOverride,
): { power: number; gain: number; curve: "gamma" | "linear"; color?: string } {
  return {
    power: base.power ?? 1,
    gain: override?.gain ?? 1,
    curve: override?.curve ?? "gamma",
    color: override?.color,
  };
}
