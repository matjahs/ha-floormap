import type { SunflowFloorplanCardConfig } from "../src/types";

/**
 * Mirrors the HA floorplan dashboard mapping.
 * Playground mock Hass creates every entity_id listed here so the card
 * never shows "entities not found" unless you intentionally omit one.
 *
 * Geometry and fixture poses come from the appartement Blender model
 * (`scene_glb` + `appartement.scene.json`), not Floorplanner FML.
 */
export const playgroundConfig: SunflowFloorplanCardConfig = {
  type: "custom:sunflow-floorplan-card",
  title: "Waalbandijk 469 — Level 10 (playground)",
  scene_glb: "/local/floorplan/appartement.glb",
  scene: "/local/floorplan/appartement.scene.json",
  show_warning_badge: true,
  edit_mode: true,
  render: {
    mode: "live3d",
    engine: "babylon",
    gpu: "webgpu",
    tone_map: "aces",
    exposure: 1.0,
    gamma: 2.2,
    transition: 400,
    ambient: "sun",
    /**
     * Plan +Y → render +Z (via -blender.y). Blender +Y toward balcony (= north by site).
     * north: 180 + mirror_x: true keeps geographic east on +X after the Y flip.
     * Room centroids: bedroom/office high plan X, living low plan X.
     * Matches user sun path: morning +X, evening −X (see tests/sun.test.ts).
     */
    north: 180,
    mirror_x: true,
    floor_level: 10,
    floor_height_m: 3.05,
    elevation_m: 32,
    lock_camera: false,
    /** Off by default — turn on for Babylon mesh/light debugging. */
    inspector: false,
  },
  floors: [
    {
      level: "blender-main",
      camera: "DollhouseCam",
    },
  ],
  groups: {
    living: {
      tap_action: { action: "toggle" },
    },
    kitchen: {
      tap_action: { action: "toggle" },
    },
    bedroom: {
      tap_action: { action: "toggle" },
    },
    home_office: {
      tap_action: { action: "toggle" },
    },
    hallway: {
      tap_action: { action: "toggle" },
    },
    bathroom: {
      tap_action: { action: "toggle" },
    },
    toilet: {
      tap_action: { action: "toggle" },
    },
    utility: {
      tap_action: { action: "toggle" },
    },
  },
  entities: {
    L01: { entity: "light.livingroom_light_1", group: "living" },
    L02: { entity: "light.kajplats_e14_ws_globe_806lm", group: "living" },
    L03: { entity: "light.kajplats_e14_ws_globe_806lm_3", group: "living" },
    L04: { entity: "light.livingroom_light_3", group: "living" },
    L05: { entity: "light.livingroom_light_5", group: "living" },
    L06: { entity: "light.kitchen_light_1", group: "kitchen" },
    L07: { entity: "light.kitchen_island_nanoleaf_light_strip", group: "kitchen" },
    L08: { entity: "light.kitchen_led_strip_pantry", group: "kitchen" },
    L09: { entity: "light.kitchen_led_strip_fridge_kitchen_ledstrip_2", group: "kitchen" },
    L10: { entity: "light.bedroom_1_light", group: "bedroom" },
    L11: { entity: "light.bedroom_light_2_light_2", group: "bedroom" },
    L12: { entity: "light.ikea_of_sweden_tradfri_bulb_e27_ws_globe_1055lm", group: "home_office" },
    L13: { entity: "light.office_light_b", group: "home_office" },
    L14: { entity: "light.hallway_1_light", group: "hallway" },
    L15: { entity: "light.hallway_2_light", group: "hallway" },
    L16: { entity: "light.toilet_light", group: "toilet" },
    L17: { entity: "light.bathroom", group: "bathroom" },
    L18: { entity: "light.utility_room_shelly", group: "utility" },
  },
  overrides: {},
};

export function entityIdsFromConfig(cfg: SunflowFloorplanCardConfig): string[] {
  return Object.values(cfg.entities ?? {}).map((e) => e.entity);
}
