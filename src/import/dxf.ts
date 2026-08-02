/**
 * Defensive DXF importer for Floorplanner 2D exports.
 * Assumptions isolated here: we only extract LINE / LWPOLYLINE on common layers
 * as walls and closed polylines as room outlines. Units treated as cm when
 * $INSUNITS is metres we scale ×100.
 */

import { computeBounds, emptyIR, type FloorplanIR, type RoomIR, type WallIR } from "./ir";
import type { Vec2, Vec3 } from "../types";

export interface DxfImportOptions {
  /** Layer name substrings to keep (case-insensitive). Empty = all. */
  layerFilter?: string[];
  /** Force unit scale to cm (override $INSUNITS). */
  unitScale?: number;
}

interface DxfEntity {
  type: string;
  layer: string;
  points: Vec2[];
  closed?: boolean;
}

function parseDxfEntities(text: string): { entities: DxfEntity[]; unitScale: number } {
  const lines = text.split(/\r?\n/);
  const entities: DxfEntity[] = [];
  let unitScale = 1; // assume cm
  let i = 0;

  const readPair = (): { code: number; value: string } | null => {
    while (i < lines.length) {
      const codeLine = lines[i++]?.trim();
      if (codeLine === undefined) {
        return null;
      }
      const value = lines[i++] ?? "";
      const code = Number.parseInt(codeLine, 10);
      if (Number.isNaN(code)) {
        continue;
      }
      return { code, value: value.trim() };
    }
    return null;
  };

  // Scan for INSUNITS (group 70 in header TABLES — simplified scan)
  for (let j = 0; j < lines.length - 1; j++) {
    if (lines[j]?.trim() === "9" && lines[j + 1]?.trim() === "$INSUNITS") {
      const units = Number.parseInt(lines[j + 3]?.trim() ?? "0", 10);
      // 4 = mm, 5 = cm, 6 = m
      if (units === 6) {
        unitScale = 100;
      } else if (units === 4) {
        unitScale = 0.1;
      } else if (units === 5) {
        unitScale = 1;
      }
      break;
    }
  }

  while (i < lines.length) {
    const pair = readPair();
    if (!pair) {
      break;
    }
    if (pair.code !== 0) {
      continue;
    }
    const type = pair.value.toUpperCase();
    if (type === "LINE") {
      let layer = "0";
      let x1 = 0;
      let y1 = 0;
      let x2 = 0;
      let y2 = 0;
      while (i < lines.length) {
        const p = readPair();
        if (!p) {
          break;
        }
        if (p.code === 0) {
          i -= 2;
          break;
        }
        if (p.code === 8) {
          layer = p.value;
        }
        if (p.code === 10) {
          x1 = Number.parseFloat(p.value);
        }
        if (p.code === 20) {
          y1 = Number.parseFloat(p.value);
        }
        if (p.code === 11) {
          x2 = Number.parseFloat(p.value);
        }
        if (p.code === 21) {
          y2 = Number.parseFloat(p.value);
        }
      }
      entities.push({
        type: "LINE",
        layer,
        points: [
          { x: x1, y: y1 },
          { x: x2, y: y2 },
        ],
      });
    } else if (type === "LWPOLYLINE") {
      let layer = "0";
      let closed = false;
      const pts: Vec2[] = [];
      let pendingX: number | undefined;
      while (i < lines.length) {
        const p = readPair();
        if (!p) {
          break;
        }
        if (p.code === 0) {
          i -= 2;
          break;
        }
        if (p.code === 8) {
          layer = p.value;
        }
        if (p.code === 70) {
          closed = (Number.parseInt(p.value, 10) & 1) === 1;
        }
        if (p.code === 10) {
          pendingX = Number.parseFloat(p.value);
        }
        if (p.code === 20 && pendingX !== undefined) {
          pts.push({ x: pendingX, y: Number.parseFloat(p.value) });
          pendingX = undefined;
        }
      }
      if (pts.length >= 2) {
        entities.push({ type: "LWPOLYLINE", layer, points: pts, closed });
      }
    }
  }

  return { entities, unitScale };
}

function layerAllowed(layer: string, filter?: string[]): boolean {
  if (!filter || filter.length === 0) {
    return true;
  }
  const lower = layer.toLowerCase();
  return filter.some((f) => lower.includes(f.toLowerCase()));
}

export function importDxf(text: string, fileName = "plan.dxf", opts: DxfImportOptions = {}): FloorplanIR {
  const ir = emptyIR("floorplanner-dxf", fileName);
  const { entities, unitScale: detected } = parseDxfEntities(text);
  const scale = opts.unitScale ?? detected;

  const walls: WallIR[] = [];
  const rooms: RoomIR[] = [];
  const points: Vec3[] = [];

  for (const ent of entities) {
    if (!layerAllowed(ent.layer, opts.layerFilter)) {
      continue;
    }
    const scaled = ent.points.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    if (ent.type === "LINE" && scaled.length === 2) {
      walls.push({
        id: `wall_${walls.length}`,
        start: scaled[0]!,
        end: scaled[1]!,
        thickness: 10,
      });
      points.push({ x: scaled[0]!.x, y: scaled[0]!.y, z: 0 });
      points.push({ x: scaled[1]!.x, y: scaled[1]!.y, z: 250 });
    } else if (ent.type === "LWPOLYLINE" && ent.closed && scaled.length >= 3) {
      rooms.push({
        id: `room_${rooms.length}`,
        name: `Room ${rooms.length + 1}`,
        polygon: scaled,
        areaHint: `room_${rooms.length + 1}`,
      });
      for (const p of scaled) {
        points.push({ x: p.x, y: p.y, z: 0 });
      }
    } else if (ent.type === "LWPOLYLINE" && scaled.length >= 2) {
      for (let i = 0; i < scaled.length - 1; i++) {
        walls.push({
          id: `wall_${walls.length}`,
          start: scaled[i]!,
          end: scaled[i + 1]!,
          thickness: 10,
        });
      }
    }
  }

  ir.levels = [{ id: "ground", name: "Ground", elevation: 0, height: 250, visible: true }];
  ir.walls = walls;
  ir.rooms = rooms;
  ir.bounds = computeBounds(points);
  return ir;
}
