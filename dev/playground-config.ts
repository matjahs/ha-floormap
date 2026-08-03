import type { SunflowFloorplanCardConfig } from "../src/types";

/**
 * Mirrors the HA floorplan dashboard mapping.
 * Playground mock Hass creates every entity_id listed here so the card
 * never shows "entities not found" unless you intentionally omit one.
 */
export const playgroundConfig: SunflowFloorplanCardConfig = {
  type: "custom:sunflow-floorplan-card",
  title: "Waalbandijk 469 — Level 10 (playground)",
  manifest: "/local/floorplan/manifest.json",
  placements: "/local/floorplan/placements.json?v=2",
  show_warning_badge: true,
  edit_mode: true,
  render: {
    mode: "live3d",
    tone_map: "aces",
    exposure: 1.0,
    gamma: 2.2,
    transition: 400,
    ambient: "sun",
  },
  floors: [
    {
      level: "level-4fe4dcaf-d703-4406-a96f-c61e37dc9774",
      camera: "Bird View",
      base_image: "/local/lighting_renders/selected_lights_on_SunFlow.png",
    },
  ],
  fml: "/local/floorplan/waalbandijk.fml.json",
  fml_assets: "/local/floorplan/glb",
  fml_glb_map: "/local/floorplan/waalbandijk.glb-map.json",
  fml_materials: "/local/floorplan/waalbandijk.materials.json",
  fml_default_floor: {
    // Seamless tile inspired by home PVC photo (not the photo itself).
    texture: "/local/floorplan/textures/pvc-laminaat.jpg",
    tile_width_cm: 100,
    tile_height_cm: 100,
    exclude_name_includes: ["toilet", "badkamer", "bathroom", "bath", "balcony", "balkon"],
  },
  fml_room_floors: [
    {
      name_includes: ["balcony", "balkon"],
      texture: "/local/floorplan/textures/balcony-concrete.jpg",
      tile_width_cm: 100,
      tile_height_cm: 100,
    },
  ],
  groups: {
    kitchen: {
      tap_action: { action: "toggle" },
    },
    living: {
      tap_action: { action: "toggle" },
    },
  },
  entities: {
    "light_light-bb6f3724-d66f-4ed3-96c0-5c58b291f010": {
      entity: "light.hallway_1_light",
      overlay: "3_light_hallway_1_on_SunFlow.png",
    },
    "light_light-09aa8e87-fd5a-4a69-9a7c-6f307e5bf016": {
      entity: "light.hallway_2_light",
      overlay: "4_light_hallway_2_on_SunFlow.png",
    },
    "light_light-61dde89b-428f-4267-afce-8b74ca5805d7": {
      entity: "light.kitchen_light_1",
      overlay: "5_light_kitchen_1_on_SunFlow.png",
    },
    "light_light-82daac96-955d-481f-a387-80dad1df596e": {
      entity: "light.kitchen_ledstrip_2",
      overlay: "6_light_kitchen_3_on_SunFlow.png",
    },
    "light_light-b49f096c-5f12-403a-ac35-85992a5dfcec": {
      entity: "light.livingroom_light_2",
      overlay: "7_light_living_room_2_on_SunFlow.png",
    },
    "light_light-0132dd10-e80e-4d30-af07-a924d762af8e": {
      entity: "light.livingroom_light_3",
      overlay: "8_light_living_room_3_on_SunFlow.png",
    },
    "light_light-bd58bf5c-2f47-4635-9c62-9bf0bb5bfb2c": {
      entity: "light.livingroom_light_5",
      overlay: "9_light_living_room_4_on_SunFlow.png",
    },
    "light_light-6c843e68-6d03-4eb4-8989-0503a0c98294": {
      entity: "light.shelly_toilet_output_0",
      overlay: "10_light_toilet_1_on_SunFlow.png",
    },
    "light_light-f0faa71c-51bc-4e18-b4b9-4df94e30b994": {
      entity: "light.utility_room_1_light_3",
      overlay: "11_light_utility_room_1_on_SunFlow.png",
    },
    "light_light-0db573a3-ff6d-4dd2-86ff-dc079dfd45db": {
      entity: "light.bedroom_1_light",
      overlay: "12_lights_bedroom_on_SunFlow.png",
    },
    "light_light-713e3443-e82b-4124-8d2a-a06ce6bee094": {
      entity: "light.office_light_1",
      overlay: "13_lights_office_on_SunFlow.png",
    },
  },
  overrides: {},
};

export function entityIdsFromConfig(cfg: SunflowFloorplanCardConfig): string[] {
  return Object.values(cfg.entities ?? {}).map((e) => e.entity);
}
