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
export type FixtureKind = "point" | "strip";

/** WLED-style segment along a strip fixture (fractions 0..1). */
export interface StripSegmentConfig {
  entity: string;
  /** Start fraction along strip [0, 1]. */
  start: number;
  /** End fraction along strip [0, 1]. */
  end: number;
  tap_action?: ActionConfig;
  hold_action?: ActionConfig;
  double_tap_action?: ActionConfig;
}

export interface FixtureEntityConfig {
  entity: string;
  overlay?: string;
  /** Membership id for joint control chips / tap areas. */
  group?: string;
  tap_action?: ActionConfig;
  hold_action?: ActionConfig;
  double_tap_action?: ActionConfig;
  /** Strip segments (each gets its own marker). */
  segments?: StripSegmentConfig[];
}

/**
 * Optional HA light group / master plus actions and a stage tap polygon.
 * tap_area is a list of [left%, top%] points (stage percent, same as markers).
 */
export interface LightGroupConfig {
  entity?: string;
  tap_action?: ActionConfig;
  hold_action?: ActionConfig;
  double_tap_action?: ActionConfig;
  /** Polygon in stage % — tap toggles the group (or runs tap_action). */
  tap_area?: [number, number][];
}

export interface FixtureOverride {
  gain?: number;
  curve?: "gamma" | "linear";
  /** Manual nudge as [left%, top%] (baked plate icons) */
  marker?: [number, number];
  /** Plan-space pose in cm (SH3D X/Y floor, Z elevation). Wins over IR. */
  position?: [number, number, number];
  /** Strip endpoint override [x, y, z] plan cm. */
  end?: [number, number, number];
  kind?: FixtureKind;
  samples?: number;
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
  /** off | sun | entity_id with azimuth/elevation attributes */
  ambient?: AmbientMode;
  /**
   * Compass heading of plan +Y in degrees (0 = north).
   * Waalbandijk Blender export: 180 (appartement9 +Y north; plan Y flip via -blender.y).
   */
  north?: number;
  /** Building floor (1 = street). Waalbandijk apartment is 10. */
  floor_level?: number;
  /** Floor-to-floor height in metres (default 3.05). */
  floor_height_m?: number;
  /** Local skyline obstructions for sun visibility (matters most on upper floors). */
  sun_obstruction?: import("./sun-horizon").SunObstructionConfig;
}

export interface SunflowFloorplanCardConfig extends LovelaceCardConfig {
  type: string;
  title?: string;
  manifest?: string;
  /**
   * Optional URL to placements.json: { [fixtureId]: { position: [x,y,z] } }.
   * Merged into overrides.position at load (YAML dashboards cannot persist config-changed).
   */
  placements?: string;
  /**
   * Full-scene GLB from the appartement Blender model. When set, live3d loads
   * this mesh instead of extruding FML / SH3D walls and furniture.
   */
  scene_glb?: string;
  /**
   * Sidecar JSON for `scene_glb` (camera, bounds, L01–L18 fixtures).
   * Defaults to the GLB URL with `.glb` replaced by `.scene.json`.
   */
  scene?: string;
  /**
   * Floorplanner FML JSON URL (project `*.json.fml` or design document).
   * When set in live3d, replaces extruded walls/rooms/furniture with FML + GLBs.
   * Ignored when `scene_glb` is set.
   */
  fml?: string;
  /** Directory of local GLBs named `{refid}.glb` / `opening-{id}.glb`. */
  fml_assets?: string;
  /** Optional refid→URL map (CDN or local). */
  fml_glb_map?: string;
  /** Optional Floorplanner materials map (`rs-…` / numeric id → texture URLs). */
  fml_materials?: string;
  /**
   * Default floor texture for FML rooms (real-home PVC etc.).
   * Applied to every room except bath/toilet unless exclude_name_includes is set.
   */
  fml_default_floor?: {
    texture: string;
    tile_width_cm?: number;
    tile_height_cm?: number;
    exclude_name_includes?: string[];
  };
  /** Named room floor overrides (matched by name substring). */
  fml_room_floors?: Array<{
    name_includes: string[];
    texture: string;
    tile_width_cm?: number;
    tile_height_cm?: number;
  }>;
  render?: RenderConfig;
  floors?: FloorConfig[];
  entities?: Record<string, FixtureEntityConfig>;
  /** Named groups for bulk control + optional stage tap polygons. */
  groups?: Record<string, LightGroupConfig>;
  overrides?: Record<string, FixtureOverride>;
  /** When true, show Edit lights control (drag only while editing). */
  edit_mode?: boolean;
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
  /** Optional group membership for visual cue. */
  group?: string;
  /** When set, marker is a strip segment (action target = segment entity). */
  segmentIndex?: number;
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
