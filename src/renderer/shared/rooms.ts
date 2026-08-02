import type { CameraIR, FloorplanIR, RoomIR } from "../../import/ir";
import { projectPolygon } from "../../projection";
import type { Vec2 } from "../../types";

export interface RoomHotspot {
  room: RoomIR;
  polygonUv: Vec2[];
  areaId?: string;
}

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
