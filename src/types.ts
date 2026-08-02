import type { ActionConfig, LovelaceCardConfig } from "custom-card-helpers";

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BBox {
  min: Vec3;
  max: Vec3;
}

export type RenderMode = "baked" | "live3d";
export type ToneMap = "aces" | "reinhard" | "none";
export type AmbientMode = "off" | "sun" | string;

export interface FixtureEntityConfig {
  entity: string;
  overlay?: string;
  tap_action?: ActionConfig;
  hold_action?: ActionConfig;
  double_tap_action?: ActionConfig;
}

export interface FixtureOverride {
  gain?: number;
  curve?: "gamma" | "linear";
  /** Manual nudge as [left%, top%] */
  marker?: [number, number];
  color?: string;
}

export interface FloorConfig {
  level: string;
  camera?: string;
  base_image?: string;
}

export interface RenderConfig {
  mode?: RenderMode;
  tone_map?: ToneMap;
  exposure?: number;
  gamma?: number;
  transition?: number;
  ambient?: AmbientMode;
}

export interface SunflowFloorplanCardConfig extends LovelaceCardConfig {
  type: string;
  title?: string;
  manifest?: string;
  render?: RenderConfig;
  floors?: FloorConfig[];
  entities?: Record<string, FixtureEntityConfig>;
  overrides?: Record<string, FixtureOverride>;
  /** Inline IR for editor preview / tests */
  ir?: import("./import/ir").FloorplanIR;
  /** Inline render manifest when not loading from URL */
  renders?: RenderManifest;
  show_warning_badge?: boolean;
  effects?: boolean;
}

export interface RenderPass {
  fixtureId: string;
  path: string;
}

export interface RenderManifest {
  base: string;
  passes: RenderPass[];
  resolution?: { width: number; height: number };
  differenceBaked?: boolean;
}

export interface FloorplanManifest {
  ir: import("./import/ir").FloorplanIR;
  renders: RenderManifest;
  mapping?: Record<string, string>;
}

export interface LightParams {
  intensity: number;
  color: [number, number, number];
  on: boolean;
  unavailable: boolean;
  unknown: boolean;
  effect?: string;
}

export interface MarkerState {
  fixtureId: string;
  entity: string;
  left: number;
  top: number;
  params: LightParams;
  friendlyName?: string;
}

declare global {
  interface Window {
    customCards?: Array<{
      type: string;
      name: string;
      description: string;
      preview?: boolean;
      documentationURL?: string;
    }>;
  }
}
