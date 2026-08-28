import type { HomeAssistant } from "custom-card-helpers";
import type {
  LightGroupConfig,
  SunflowFloorplanCardConfig,
  Vec2,
} from "./types";
import type { FloorplanIR } from "./import/ir";
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

/** Union of Blender floor rooms, explicit `groups` keys, YAML membership, and HA room tags. */
export function discoverGroupIds(
  cfg: SunflowFloorplanCardConfig,
  hass?: HomeAssistant,
  ir?: FloorplanIR | null,
): string[] {
  const ids = new Set<string>();
  if (ir?.rooms?.length) {
    for (const room of ir.rooms) {
      const n = normalizeRoomId(room.id);
      if (n) {
        ids.add(n);
      }
    }
    return [...ids].sort();
  }
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
  ir?: FloorplanIR | null,
): string[] {
  const want = normalizeRoomId(groupId);
  const out: string[] = [];
  if (ir?.rooms?.length) {
    for (const fx of ir.fixtures) {
      if (normalizeRoomId(fx.roomId ?? "") !== want) {
        continue;
      }
      const ent = cfg.entities?.[fx.id];
      if (!ent?.entity) {
        continue;
      }
      out.push(ent.entity);
      for (const seg of ent.segments ?? []) {
        out.push(seg.entity);
      }
    }
    const master = findGroupConfig(cfg, want)?.entity;
    if (master && !out.includes(master)) {
      out.unshift(master);
    }
    return out;
  }
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

/** Map a pointer into stage percent ([left%, top%], 0..100). */
export function clientToStagePercent(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): [number, number] {
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  const left = Math.round(((clientX - rect.left) / w) * 1000) / 10;
  const top = Math.round(((clientY - rect.top) / h) * 1000) / 10;
  return [
    Math.min(100, Math.max(0, left)),
    Math.min(100, Math.max(0, top)),
  ];
}

export interface TapEdgeHit {
  /** Insert the new vertex at this index. */
  insertAt: number;
  point: [number, number];
}

/** Index of the nearest tap vertex, or -1 if none is within `threshold` percent. */
export function hitTapVertex(
  pts: [number, number][],
  point: [number, number],
  threshold: number,
): number {
  let best = -1;
  let bestD = threshold;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const d = Math.hypot(p[0] - point[0], p[1] - point[1]);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function closestOnSegment(
  point: [number, number],
  a: [number, number],
  b: [number, number],
): { d: number; point: [number, number] } {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  let t = 0;
  if (len2 > 0) {
    t = ((point[0] - a[0]) * vx + (point[1] - a[1]) * vy) / len2;
    t = Math.min(1, Math.max(0, t));
  }
  const x = Math.round((a[0] + t * vx) * 10) / 10;
  const y = Math.round((a[1] + t * vy) * 10) / 10;
  return { d: Math.hypot(point[0] - x, point[1] - y), point: [x, y] };
}

/**
 * Nearest polygon edge within `threshold` percent.
 * Closed when there are ≥3 vertices (includes last→first).
 */
export function hitTapEdge(
  pts: [number, number][],
  point: [number, number],
  threshold: number,
): TapEdgeHit | null {
  if (pts.length < 2) {
    return null;
  }
  const closed = pts.length >= 3;
  const edgeCount = closed ? pts.length : pts.length - 1;
  let best: TapEdgeHit | null = null;
  let bestD = threshold;
  for (let i = 0; i < edgeCount; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const hit = closestOnSegment(point, a, b);
    if (hit.d <= bestD) {
      bestD = hit.d;
      best = { insertAt: i + 1, point: hit.point };
    }
  }
  return best;
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
