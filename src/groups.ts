import type { HomeAssistant } from "custom-card-helpers";
import type {
  LightGroupConfig,
  SunflowFloorplanCardConfig,
  Vec2,
} from "./types";
import { effectiveEntityGroup, normalizeRoomId } from "./ha-room";

export interface GroupTapHotspot {
  groupId: string;
  /** UV polygon in 0..1 stage space (left/100, top/100). */
  polygonUv: Vec2[];
}

/** Look up groups.* by normalized id (YAML keys may differ in casing/spacing). */
export function findGroupConfig(
  cfg: SunflowFloorplanCardConfig,
  groupId: string,
): LightGroupConfig | undefined {
  const groups = cfg.groups ?? {};
  if (groups[groupId]) {
    return groups[groupId];
  }
  const want = normalizeRoomId(groupId);
  for (const [key, value] of Object.entries(groups)) {
    if (normalizeRoomId(key) === want) {
      return value;
    }
  }
  return undefined;
}

/** Union of explicit `groups` keys, YAML membership, and HA room tags. */
export function discoverGroupIds(
  cfg: SunflowFloorplanCardConfig,
  hass?: HomeAssistant,
): string[] {
  const ids = new Set<string>();
  for (const id of Object.keys(cfg.groups ?? {})) {
    const n = normalizeRoomId(id);
    if (n) {
      ids.add(n);
    }
  }
  for (const ent of Object.values(cfg.entities ?? {})) {
    const g = effectiveEntityGroup(ent.group, hass, ent.entity);
    if (g) {
      ids.add(g);
    }
  }
  return [...ids].sort();
}

export function memberEntitiesForGroup(
  cfg: SunflowFloorplanCardConfig,
  groupId: string,
  hass?: HomeAssistant,
): string[] {
  const want = normalizeRoomId(groupId);
  const out: string[] = [];
  for (const ent of Object.values(cfg.entities ?? {})) {
    if (effectiveEntityGroup(ent.group, hass, ent.entity) === want) {
      out.push(ent.entity);
      for (const seg of ent.segments ?? []) {
        out.push(seg.entity);
      }
    }
  }
  const master = findGroupConfig(cfg, want)?.entity;
  if (master && !out.includes(master)) {
    out.unshift(master);
  }
  return out;
}

/** Build stage UV hotspots from groups.*.tap_area ([left%, top%] polygons). */
export function buildGroupTapHotspots(
  groups: Record<string, LightGroupConfig> | undefined,
): GroupTapHotspot[] {
  if (!groups) {
    return [];
  }
  const out: GroupTapHotspot[] = [];
  for (const [groupId, g] of Object.entries(groups)) {
    const area = g.tap_area;
    if (!area || area.length < 3) {
      continue;
    }
    out.push({
      groupId: normalizeRoomId(groupId) || groupId,
      polygonUv: area.map(([left, top]) => ({ x: left / 100, y: top / 100 })),
    });
  }
  return out;
}

export function hitTestGroupTap(
  hotspots: GroupTapHotspot[],
  u: number,
  v: number,
): GroupTapHotspot | undefined {
  for (const h of hotspots) {
    if (pointInPoly({ x: u, y: v }, h.polygonUv)) {
      return h;
    }
  }
  return undefined;
}

function pointInPoly(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    const intersect =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y + Number.EPSILON) + pi.x;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

/** Stable hue for group ring styling (0..360). */
export function groupHue(groupId: string): number {
  let h = 0;
  for (let i = 0; i < groupId.length; i++) {
    h = (h * 31 + groupId.charCodeAt(i)) % 360;
  }
  return h;
}
