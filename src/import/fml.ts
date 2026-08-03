/**
 * Floorplanner FML (JSON) importer.
 *
 * Accepts either:
 * - Project export: `{ floors: [{ designs: [ design ] }] }` (e.g. `*.json.fml`)
 * - Design document: `{ items, walls, areas, ... }` (API `data_url` payload)
 *
 * Furniture `refid` hashes map to GLB URLs via `glbMap` or `assetsBase/{refid}.glb`.
 */

import {
  computeBounds,
  emptyIR,
  type CameraIR,
  type FloorplanIR,
  type FurnitureIR,
  type OpeningIR,
  type RoomIR,
  type WallIR,
} from "./ir";
import type { Vec2, Vec3 } from "../types";

export const FML_FEATURE_FLAG = "SUNFLOW_FML";

export function isFmlEnabled(): boolean {
  // Parser is real now; flag kept for backwards-compat callers.
  return true;
}

interface FmlPoint {
  x: number;
  y: number;
  z?: number;
}

interface FmlWall {
  guid?: string;
  a: FmlPoint;
  b: FmlPoint;
  thickness?: number;
  az?: { h?: number; z?: number };
  bz?: { h?: number; z?: number };
  openings?: FmlOpening[];
  decor?: {
    left?: { refid?: string; color?: string };
    right?: { refid?: string; color?: string };
    top?: { refid?: string; color?: string };
  };
}

interface FmlOpening {
  guid?: string;
  refid?: string;
  type?: string;
  t?: number;
  width?: number;
  z?: number;
  z_height?: number;
}

interface FmlItem {
  guid?: string;
  refid: string;
  x: number;
  y: number;
  z?: number;
  width?: number;
  height?: number;
  z_height?: number;
  rotation?: number;
  mirrored?: [number, number] | number[];
}

interface FmlArea {
  guid?: string;
  name?: string;
  poly?: FmlPoint[];
  color?: string;
}

interface FmlSurface {
  guid?: string;
  name?: string;
  refid?: string;
  color?: string;
  poly?: FmlPoint[];
  sx?: number;
  sy?: number;
  hideIn3D?: boolean;
}

interface FmlCamera {
  name?: string;
  x: number;
  y: number;
  z: number;
  dx?: number;
  dy?: number;
  dz?: number;
  fov?: number;
  type_name?: string;
}

interface FmlDesign {
  name?: string;
  id?: number;
  items?: FmlItem[];
  walls?: FmlWall[];
  areas?: FmlArea[];
  surfaces?: FmlSurface[];
  cameras?: FmlCamera[];
}

export interface FmlMaterial {
  name?: string;
  color?: string;
  widthCm?: number;
  heightCm?: number;
  texture?: string | null;
  className?: string;
}

export type FmlMaterialMap = Record<string, FmlMaterial>;

/** Default floor finish applied to rooms unless excluded by name. */
export interface FmlDefaultFloor {
  texture: string;
  tileWidthCm?: number;
  tileHeightCm?: number;
  /** Room-name substrings to skip (case-insensitive). Defaults to bath/toilet. */
  excludeNameIncludes?: string[];
}

/** Named room floor override (e.g. balcony concrete). */
export interface FmlRoomFloor {
  nameIncludes: string[];
  texture: string;
  tileWidthCm?: number;
  tileHeightCm?: number;
}

export interface ImportFmlOptions {
  /** refid → absolute or site-relative GLB URL */
  glbMap?: Record<string, string>;
  /** Directory prefix for local copies: `{assetsBase}/{refid}.glb` */
  assetsBase?: string;
  /** Opening slice GLBs: `{assetsBase}/opening-{refid}.glb` */
  openingAssets?: boolean;
  /** Roomstyle / material id → texture metadata (`rs-13821` or `13821`). */
  materials?: FmlMaterialMap;
  /** Override/fill floor textures (e.g. real PVC for all rooms but bath/toilet). */
  defaultFloor?: FmlDefaultFloor;
  /** Per-area floor finishes matched by room name substring. */
  roomFloors?: FmlRoomFloor[];
}

function materialOf(
  refid: string | undefined,
  materials: FmlMaterialMap | undefined,
): FmlMaterial | undefined {
  if (!refid || !materials) {
    return undefined;
  }
  return materials[refid] ?? materials[refid.replace(/^rs-/, "")] ?? materials[`rs-${refid}`];
}

const DEFAULT_FLOOR_EXCLUDE = ["toilet", "badkamer", "bathroom", "bath"];

function roomExcludedFromDefaultFloor(
  name: string | undefined,
  exclude: string[],
): boolean {
  const n = (name ?? "").toLowerCase();
  if (!n) {
    return false;
  }
  return exclude.some((part) => n.includes(part.toLowerCase()));
}

function applyDefaultFloor(rooms: RoomIR[], floor: FmlDefaultFloor | undefined): void {
  if (!floor?.texture) {
    return;
  }
  const exclude = floor.excludeNameIncludes?.length
    ? floor.excludeNameIncludes
    : DEFAULT_FLOOR_EXCLUDE;
  const tileW = floor.tileWidthCm ?? 100;
  const tileH = floor.tileHeightCm ?? 140;
  for (const room of rooms) {
    if (roomExcludedFromDefaultFloor(room.name, exclude)) {
      continue;
    }
    room.floorTexture = floor.texture;
    room.tileWidthCm = tileW;
    room.tileHeightCm = tileH;
  }
}

function applyRoomFloors(rooms: RoomIR[], floors: FmlRoomFloor[] | undefined): void {
  if (!floors?.length) {
    return;
  }
  for (const room of rooms) {
    const name = (room.name ?? "").toLowerCase();
    if (!name) {
      continue;
    }
    const hit = floors.find((f) =>
      f.nameIncludes.some((part) => name.includes(part.toLowerCase())),
    );
    if (!hit) {
      continue;
    }
    room.floorTexture = hit.texture;
    room.tileWidthCm = hit.tileWidthCm ?? 100;
    room.tileHeightCm = hit.tileHeightCm ?? 100;
  }
}

function asDesign(raw: unknown): FmlDesign {
  if (!raw || typeof raw !== "object") {
    throw new Error("FML: expected a JSON object");
  }
  const root = raw as Record<string, unknown>;
  if (Array.isArray(root.floors)) {
    const floor = root.floors[0] as Record<string, unknown> | undefined;
    const designs = floor?.designs;
    if (Array.isArray(designs) && designs[0]) {
      return designs[0] as FmlDesign;
    }
    throw new Error("FML project export has no floors[0].designs[0]");
  }
  if (Array.isArray(root.items) || Array.isArray(root.walls)) {
    return root as FmlDesign;
  }
  throw new Error("FML: unrecognized shape (need project floors[].designs[] or design items/walls)");
}

function meshUrlFor(
  refid: string,
  opts: ImportFmlOptions,
): string | undefined {
  if (opts.glbMap?.[refid]) {
    return opts.glbMap[refid];
  }
  if (opts.assetsBase && /^[a-f0-9]{40}$/i.test(refid)) {
    const base = opts.assetsBase.replace(/\/$/, "");
    return `${base}/${refid}.glb`;
  }
  return undefined;
}

function openingMeshUrl(refid: string, opts: ImportFmlOptions): string | undefined {
  if (!opts.openingAssets || !opts.assetsBase) {
    return undefined;
  }
  const base = opts.assetsBase.replace(/\/$/, "");
  return `${base}/opening-${refid}.glb`;
}

function wallHeight(w: FmlWall, fallback: number): number {
  const h = w.az?.h ?? w.bz?.h ?? fallback;
  return h > 0 ? h : fallback;
}

function lerp(a: FmlPoint, b: FmlPoint, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function cameraFromFml(c: FmlCamera, index: number): CameraIR {
  // Floorplanner look direction (dx,dy,dz) in plan X/Y + up Z → SH3D-like yaw/pitch.
  const dx = c.dx ?? 0;
  const dy = c.dy ?? 0;
  const dz = c.dz ?? -1;
  const yaw = Math.atan2(dx, -dy);
  const horiz = Math.hypot(dx, dy) || 1e-6;
  const pitch = Math.atan2(-dz, horiz);
  const fov = ((c.fov ?? 50) * Math.PI) / 180;
  const isTop = Math.abs(pitch) > 1.2 || /bird|top|ortho/i.test(c.name ?? "");
  return {
    id: `fml_cam_${index}`,
    name: c.name ?? `Camera ${index}`,
    kind: "camera",
    attribute: isTop ? "topCamera" : "storedCamera",
    lens: "PINHOLE",
    x: c.x,
    y: c.y,
    z: c.z,
    yaw,
    pitch,
    fieldOfView: fov,
  };
}

export function importFml(
  raw: unknown | string,
  fileName = "project.fml",
  opts: ImportFmlOptions = {},
): FloorplanIR {
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  const design = asDesign(parsed);
  const root = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
  const wallHeightDefault =
    (root.settings as { wallHeight?: number } | undefined)?.wallHeight ?? 260;
  const settings = root.settings as
    | { wallSectionHeight?: number; useSection3D?: boolean }
    | undefined;
  const wallSectionHeight =
    settings?.useSection3D === false
      ? undefined
      : (settings?.wallSectionHeight ?? 151);

  const levelId = "fml-main";
  const ir = emptyIR("floorplanner-fml", fileName);
  ir.levels = [
    {
      id: levelId,
      name: (root.name as string) || design.name || "Main",
      elevation: 0,
      height: wallHeightDefault,
      visible: true,
    },
  ];

  const walls: WallIR[] = [];
  const openings: OpeningIR[] = [];
  for (const w of design.walls ?? []) {
    const id = w.guid ?? `wall_${walls.length}`;
    const thickness = Math.max(1, w.thickness ?? 10);
    const leftMat = materialOf(w.decor?.left?.refid, opts.materials);
    const rightMat = materialOf(w.decor?.right?.refid, opts.materials);
    walls.push({
      id,
      levelId,
      start: { x: w.a.x, y: w.a.y },
      end: { x: w.b.x, y: w.b.y },
      height: wallHeight(w, wallHeightDefault),
      thickness,
      leftColor: w.decor?.left?.color ?? leftMat?.color,
      rightColor: w.decor?.right?.color ?? rightMat?.color,
      leftTexture: leftMat?.texture ?? undefined,
      rightTexture: rightMat?.texture ?? undefined,
      tileWidthCm: leftMat?.widthCm ?? rightMat?.widthCm,
      tileHeightCm: leftMat?.heightCm ?? rightMat?.heightCm,
    });
    for (const o of w.openings ?? []) {
      const t = o.t ?? 0.5;
      const mid = lerp(w.a, w.b, t);
      const angle = Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x);
      const kind = /door/i.test(o.type ?? "") ? "door" : "window";
      // Floorplanner refid 202 = hallway↔living black glass door; other doors are flush white.
      const glazed = kind === "window" || String(o.refid) === "202";
      const opening: OpeningIR = {
        id: o.guid ?? `open_${openings.length}`,
        kind,
        levelId,
        position: { x: mid.x, y: mid.y, z: o.z ?? 0 },
        width: o.width ?? 90,
        height: o.z_height ?? 210,
        angle,
        meshUrl: o.refid ? openingMeshUrl(String(o.refid), opts) : undefined,
        glazed,
      };
      openings.push(opening);
    }
  }
  ir.walls = walls;
  ir.openings = openings;

  const rooms: RoomIR[] = [];
  for (const a of design.areas ?? []) {
    if (!a.poly || a.poly.length < 3) {
      continue;
    }
    rooms.push({
      id: a.guid ?? `room_${rooms.length}`,
      levelId,
      name: a.name,
      polygon: a.poly.map((p) => ({ x: p.x, y: p.y })),
      color: a.color,
    });
  }
  for (const s of design.surfaces ?? []) {
    if (s.hideIn3D || !s.poly || s.poly.length < 3) {
      continue;
    }
    const mat = materialOf(s.refid, opts.materials);
    rooms.push({
      id: s.guid ?? `surface_${rooms.length}`,
      levelId,
      name: s.name,
      polygon: s.poly.map((p) => ({ x: p.x, y: p.y })),
      color: s.color ?? mat?.color,
      floorTexture: mat?.texture ?? undefined,
      // Surface sx/sy is the intended tile size in cm when present.
      tileWidthCm: s.sx ?? mat?.widthCm ?? 100,
      tileHeightCm: s.sy ?? mat?.heightCm ?? 100,
    });
  }
  ir.rooms = rooms;
  applyDefaultFloor(ir.rooms, opts.defaultFloor);
  applyRoomFloors(ir.rooms, opts.roomFloors);

  const furniture: FurnitureIR[] = [];
  for (const item of design.items ?? []) {
    if (!item.refid || String(item.refid).startsWith("sym-")) {
      continue;
    }
    const furn: FurnitureIR = {
      id: item.guid ?? `item_${furniture.length}`,
      name: item.refid.slice(0, 8),
      levelId,
      position: { x: item.x, y: item.y, z: item.z ?? 0 },
      width: item.width,
      depth: item.height,
      height: item.z_height,
      angle: ((item.rotation ?? 0) * Math.PI) / 180,
      meshUrl: meshUrlFor(item.refid, opts),
      mirrored: item.mirrored ? [item.mirrored[0] ?? 0, item.mirrored[1] ?? 0] : undefined,
    };
    furniture.push(furn);
  }
  ir.furniture = furniture;

  ir.cameras = (design.cameras ?? []).map((c, i) => cameraFromFml(c, i));
  if (ir.cameras.length === 0) {
    // Synthetic top camera over design bounds
    const pts: Vec3[] = [];
    for (const w of walls) {
      pts.push({ x: w.start.x, y: w.start.y, z: 0 }, { x: w.end.x, y: w.end.y, z: 0 });
    }
    const b = computeBounds(pts);
    const cx = (b.min.x + b.max.x) / 2;
    const cy = (b.min.y + b.max.y) / 2;
    ir.cameras = [
      {
        id: "fml_top",
        name: "top",
        kind: "camera",
        attribute: "topCamera",
        lens: "PINHOLE",
        x: cx,
        y: cy,
        z: Math.max(b.max.x - b.min.x, b.max.y - b.min.y) * 1.2,
        yaw: 0,
        pitch: -Math.PI / 2,
        fieldOfView: Math.PI / 3,
      },
    ];
  }

  const boundPts: Vec3[] = [];
  for (const w of walls) {
    boundPts.push({ x: w.start.x, y: w.start.y, z: 0 }, { x: w.end.x, y: w.end.y, z: wallHeightDefault });
  }
  for (const f of furniture) {
    boundPts.push(f.position);
  }
  ir.bounds = computeBounds(boundPts);
  ir.environment = {
    skyColor: "#1a1d24",
    groundColor: "#3a3f48",
    wallSectionHeight,
  };
  // Fixtures stay empty — lights come from SH3D/mapping overlay when merged.
  ir.fixtures = [];
  return ir;
}
