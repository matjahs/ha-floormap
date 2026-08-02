import type { SunflowFloorplanCardConfig } from "./types";

export function validateConfig(config: unknown): SunflowFloorplanCardConfig {
  if (!config || typeof config !== "object") {
    throw new Error("Invalid configuration: expected an object");
  }
  const cfg = config as SunflowFloorplanCardConfig;
  if (!cfg.type) {
    throw new Error("Invalid configuration: missing type");
  }
  if (!cfg.manifest && !cfg.ir && !cfg.renders && !cfg.entities) {
    throw new Error(
      "Invalid configuration: provide manifest, or inline ir/renders/entities",
    );
  }
  if (cfg.render?.mode && cfg.render.mode !== "baked" && cfg.render.mode !== "live3d") {
    throw new Error(`Invalid render.mode: ${String(cfg.render.mode)} (expected baked|live3d)`);
  }
  if (cfg.render?.tone_map) {
    const tm = cfg.render.tone_map;
    if (tm !== "aces" && tm !== "reinhard" && tm !== "none") {
      throw new Error(`Invalid render.tone_map: ${tm}`);
    }
  }
  if (cfg.entities) {
    for (const [id, ent] of Object.entries(cfg.entities)) {
      if (!ent?.entity) {
        throw new Error(`entities.${id}: missing entity`);
      }
    }
  }
  if (cfg.overrides) {
    for (const [id, o] of Object.entries(cfg.overrides)) {
      if (o.marker && (!Array.isArray(o.marker) || o.marker.length !== 2)) {
        throw new Error(`overrides.${id}.marker must be [left%, top%]`);
      }
    }
  }
  return cfg;
}

export function stubConfig(): SunflowFloorplanCardConfig {
  return {
    type: "custom:sunflow-floorplan-card",
    title: "Floorplan",
    render: {
      mode: "baked",
      tone_map: "aces",
      exposure: 1,
      gamma: 2.2,
      transition: 400,
      ambient: "off",
    },
    entities: {},
  };
}
