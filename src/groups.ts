import type {
  LightGroupConfig,
  SunflowFloorplanCardConfig,
  Vec2,
} from "./types";

export interface GroupTapHotspot {
  groupId: string;
  /** UV polygon in 0..1 stage space (left/100, top/100). */
  polygonUv: Vec2[];
}

/** Union of explicit `groups` keys and `entities.*.group` membership. */
export function discoverGroupIds(cfg: SunflowFloorplanCardConfig): string[] {
  const ids = new Set<string>();
  for (const id of Object.keys(cfg.groups ?? {})) {
    ids.add(id);
  }
  for (const ent of Object.values(cfg.entities ?? {})) {
    if (ent.group) {
      ids.add(ent.group);
    }
  }
  return [...ids].sort();
}

export function memberEntitiesForGroup(
  cfg: SunflowFloorplanCardConfig,
  groupId: string,
): string[] {
  const out: string[] = [];
  for (const ent of Object.values(cfg.entities ?? {})) {
    if (ent.group === groupId) {
      out.push(ent.entity);
      for (const seg of ent.segments ?? []) {
        out.push(seg.entity);
      }
    }
  }
  const master = cfg.groups?.[groupId]?.entity;
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
      groupId,
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
