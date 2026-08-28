import type { CameraIR, FloorplanIR, RoomIR } from "../../import/ir";
import { normalizeRoomId } from "../../ha-room";
import { projectPolygon } from "../../projection";
import type { Vec2, Vec3 } from "../../types";

export interface RoomHotspot {
  room: RoomIR;
  polygonUv: Vec2[];
  areaId?: string;
}

export type PlanProjectFn = (
  planPos: Vec3,
) => { left: number; top: number; behind?: boolean } | null;

export function buildRoomHotspots(
  ir: FloorplanIR,
  camera: CameraIR,
  aspect: number,
  levelId?: string,
): RoomHotspot[] {
  const elevation =
    ir.levels.find((l) => l.id === levelId)?.elevation ?? ir.levels[0]?.elevation ?? 0;
  return ir.rooms
    .filter((r) => !levelId || !r.levelId || r.levelId === levelId)
    .map((room) => ({
      room,
      polygonUv: projectPolygon(camera, room.polygon, elevation + 1, { aspect }),
      areaId: room.areaHint,
    }));
}

/** Project Blender floor polygons through the live3d dollhouse camera (stage UV 0..1). */
export function buildRoomHotspotsLive3d(
  ir: FloorplanIR,
  project: PlanProjectFn,
  levelId?: string,
): RoomHotspot[] {
  const elevation =
    ir.levels.find((l) => l.id === levelId)?.elevation ?? ir.levels[0]?.elevation ?? 0;
  const floorZ = elevation + 1;
  const out: RoomHotspot[] = [];
  for (const room of ir.rooms) {
    if (levelId && room.levelId && room.levelId !== levelId) {
      continue;
    }
    const polygonUv: Vec2[] = [];
    let skip = false;
    for (const p of room.polygon) {
      const pct = project({ x: p.x, y: p.y, z: floorZ });
      if (!pct || pct.behind) {
        skip = true;
        break;
      }
      polygonUv.push({ x: pct.left / 100, y: pct.top / 100 });
    }
    if (skip || polygonUv.length < 3) {
      continue;
    }
    out.push({ room, polygonUv, areaId: room.areaHint });
  }
  return out;
}

export function roomDisplayName(ir: FloorplanIR | null | undefined, roomId: string): string {
  const want = normalizeRoomId(roomId);
  const room = ir?.rooms?.find((r) => normalizeRoomId(r.id) === want);
  return room?.name ?? roomId;
}

export function hitTestRoom(hotspots: RoomHotspot[], u: number, v: number): RoomHotspot | undefined {
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
