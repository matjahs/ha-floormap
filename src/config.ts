import type { SunflowFloorplanCardConfig } from "./types";

export function validateConfig(config: unknown): SunflowFloorplanCardConfig {
  if (!config || typeof config !== "object") {
    throw new Error("Invalid configuration: expected an object");
  }
  const cfg = config as SunflowFloorplanCardConfig;
  if (!cfg.type) {
    throw new Error("Invalid configuration: missing type");
  }
  if (
    !cfg.manifest &&
    !cfg.ir &&
    !cfg.renders &&
    !cfg.entities &&
    !cfg.fml &&
    !cfg.scene_glb &&
    !cfg.scene
  ) {
    throw new Error(
      "Invalid configuration: provide manifest, scene_glb, fml, or inline ir/renders/entities",
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
  if (cfg.render?.north !== undefined) {
    if (typeof cfg.render.north !== "number" || !Number.isFinite(cfg.render.north)) {
      throw new Error("render.north must be a finite number of degrees");
    }
  }
  if (cfg.render?.mirror_x !== undefined && typeof cfg.render.mirror_x !== "boolean") {
    throw new Error("render.mirror_x must be a boolean");
  }
  if (cfg.render?.floor_level !== undefined) {
    if (typeof cfg.render.floor_level !== "number" || cfg.render.floor_level < 1) {
      throw new Error("render.floor_level must be a number >= 1");
    }
  }
  if (cfg.render?.floor_height_m !== undefined) {
    if (typeof cfg.render.floor_height_m !== "number" || cfg.render.floor_height_m <= 0) {
      throw new Error("render.floor_height_m must be a positive number");
    }
  }
  if (cfg.render?.elevation_m !== undefined) {
    if (typeof cfg.render.elevation_m !== "number" || cfg.render.elevation_m < 0) {
      throw new Error("render.elevation_m must be a number >= 0");
    }
  }
  if (cfg.render?.gpu !== undefined) {
    if (cfg.render.gpu !== "webgpu" && cfg.render.gpu !== "webgl") {
      throw new Error("render.gpu must be webgpu or webgl");
    }
  }
  if (cfg.render?.engine !== undefined) {
    if (cfg.render.engine !== "three" && cfg.render.engine !== "babylon") {
      throw new Error("render.engine must be three or babylon");
    }
  }
  if (cfg.render?.lock_camera !== undefined && typeof cfg.render.lock_camera !== "boolean") {
    throw new Error("render.lock_camera must be a boolean");
  }
  if (cfg.render?.inspector !== undefined && typeof cfg.render.inspector !== "boolean") {
    throw new Error("render.inspector must be a boolean");
  }
  if (cfg.entities) {
    for (const [id, ent] of Object.entries(cfg.entities)) {
      if (!ent?.entity) {
        throw new Error(`entities.${id}: missing entity`);
      }
      if (ent.segments) {
        if (!Array.isArray(ent.segments)) {
          throw new Error(`entities.${id}.segments must be an array`);
        }
        for (let i = 0; i < ent.segments.length; i++) {
          const seg = ent.segments[i]!;
          if (!seg?.entity) {
            throw new Error(`entities.${id}.segments[${i}]: missing entity`);
          }
          if (typeof seg.start !== "number" || typeof seg.end !== "number") {
            throw new Error(`entities.${id}.segments[${i}]: start/end must be numbers`);
          }
          if (seg.start < 0 || seg.start > 1 || seg.end < 0 || seg.end > 1) {
            throw new Error(`entities.${id}.segments[${i}]: start/end must be in [0,1]`);
          }
        }
      }
    }
  }
  if (cfg.groups) {
    for (const [id, g] of Object.entries(cfg.groups)) {
      if (g.tap_area !== undefined) {
        if (!Array.isArray(g.tap_area) || g.tap_area.length < 3) {
          throw new Error(`groups.${id}.tap_area must be a polygon of ≥3 [left%, top%] points`);
        }
        for (const pt of g.tap_area) {
          if (!Array.isArray(pt) || pt.length !== 2 || pt.some((n) => typeof n !== "number")) {
            throw new Error(`groups.${id}.tap_area points must be [left%, top%]`);
          }
        }
      }
    }
  }
  if (cfg.overrides) {
    for (const [id, o] of Object.entries(cfg.overrides)) {
      if (o.marker && (!Array.isArray(o.marker) || o.marker.length !== 2)) {
        throw new Error(`overrides.${id}.marker must be [left%, top%]`);
      }
      if (o.position) {
        if (
          !Array.isArray(o.position) ||
          o.position.length !== 3 ||
          o.position.some((n) => typeof n !== "number" || !Number.isFinite(n))
        ) {
          throw new Error(`overrides.${id}.position must be [x, y, z] plan cm`);
        }
      }
      if (o.end) {
        if (
          !Array.isArray(o.end) ||
          o.end.length !== 3 ||
          o.end.some((n) => typeof n !== "number" || !Number.isFinite(n))
        ) {
          throw new Error(`overrides.${id}.end must be [x, y, z] plan cm`);
        }
      }
      if (o.kind && o.kind !== "point" && o.kind !== "strip" && o.kind !== "spot" && o.kind !== "area") {
        throw new Error(`overrides.${id}.kind must be point|strip|spot|area`);
      }
    }
  }
  if (cfg.placements !== undefined && typeof cfg.placements !== "string") {
    throw new Error("placements must be a URL string");
  }
  return cfg;
}

export function stubConfig(): SunflowFloorplanCardConfig {
  return {
    type: "custom:sunflow-floorplan-card",
    title: "Floorplan",
    render: {
      mode: "live3d",
      tone_map: "aces",
      exposure: 1,
      gamma: 2.2,
      transition: 400,
      ambient: "sun",
    },
    edit_mode: false,
    entities: {},
  };
}
