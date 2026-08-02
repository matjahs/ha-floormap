/**
 * SVG 2D plan import: treat closed <path> / <polygon> as room hotspots.
 * Does not provide light fixtures — pair with manual placement or baked passes.
 */

import { computeBounds, emptyIR, type FloorplanIR, type RoomIR } from "./ir";
import type { Vec2, Vec3 } from "../types";

function parsePolygonPoints(attr: string): Vec2[] {
  const nums = attr.trim().split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  const pts: Vec2[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push({ x: nums[i]!, y: nums[i + 1]! });
  }
  return pts;
}

/** Very small path parser for M/L/Z absolute commands only. */
function parseSimplePath(d: string): Vec2[] {
  const pts: Vec2[] = [];
  const re = /([MLZmlz])([^MLZmlz]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(d)) !== null) {
    const cmd = match[1]!;
    const args = match[2]!
      .trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    if (cmd === "M" || cmd === "L") {
      for (let i = 0; i + 1 < args.length; i += 2) {
        pts.push({ x: args[i]!, y: args[i + 1]! });
      }
    } else if (cmd === "Z" || cmd === "z") {
      // closed
    }
  }
  return pts;
}

export function importSvg(svgText: string, fileName = "plan.svg"): FloorplanIR {
  const ir = emptyIR("floorplanner-svg", fileName);
  ir.levels = [{ id: "ground", name: "Ground", elevation: 0, height: 250, visible: true }];

  if (typeof DOMParser === "undefined") {
    throw new Error("DOMParser required for SVG import");
  }
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const rooms: RoomIR[] = [];
  const points: Vec3[] = [];

  for (const poly of Array.from(doc.querySelectorAll("polygon"))) {
    const pts = parsePolygonPoints(poly.getAttribute("points") ?? "");
    if (pts.length >= 3) {
      rooms.push({
        id: poly.getAttribute("id") ?? `room_${rooms.length}`,
        name: poly.getAttribute("data-name") ?? poly.getAttribute("id") ?? `Room ${rooms.length + 1}`,
        polygon: pts,
        areaHint: (poly.getAttribute("data-area") ?? poly.getAttribute("id") ?? "").toLowerCase(),
      });
      for (const p of pts) {
        points.push({ x: p.x, y: p.y, z: 0 });
      }
    }
  }

  for (const path of Array.from(doc.querySelectorAll("path"))) {
    const pts = parseSimplePath(path.getAttribute("d") ?? "");
    if (pts.length >= 3) {
      rooms.push({
        id: path.getAttribute("id") ?? `room_${rooms.length}`,
        name: path.getAttribute("data-name") ?? `Room ${rooms.length + 1}`,
        polygon: pts,
        areaHint: (path.getAttribute("data-area") ?? "").toLowerCase(),
      });
      for (const p of pts) {
        points.push({ x: p.x, y: p.y, z: 0 });
      }
    }
  }

  ir.rooms = rooms;
  ir.bounds = computeBounds(points);
  return ir;
}
