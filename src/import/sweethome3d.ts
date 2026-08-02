import { unzipSync, strFromU8 } from "fflate";
import {
  assertIR,
  computeBounds,
  emptyIR,
  findRoomForPoint,
  type CameraIR,
  type CameraLens,
  type CameraAttribute,
  type FloorplanIR,
  type LightFixtureIR,
  type OpeningIR,
  type RoomIR,
  type WallIR,
} from "./ir";
import { argbIntToHex } from "../color";
import type { Vec3 } from "../types";

const HOME_XML_NAMES = ["Home.xml", "home.xml"];

export class SweetHome3DImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SweetHome3DImportError";
  }
}

function attr(el: Element, name: string, fallback?: string): string | undefined {
  const v = el.getAttribute(name);
  if (v === null || v === "") {
    return fallback;
  }
  return v;
}

function num(el: Element, name: string, fallback = 0): number {
  const v = attr(el, name);
  if (v === undefined) {
    return fallback;
  }
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(el: Element, name: string, fallback = true): boolean {
  const v = attr(el, name);
  if (v === undefined) {
    return fallback;
  }
  return v === "true";
}

function parseXml(xml: string): Document {
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const err = doc.querySelector("parsererror");
    if (err) {
      throw new SweetHome3DImportError(`Home.xml parse error: ${err.textContent ?? "unknown"}`);
    }
    return doc;
  }
  // Node fallback via linkedom-like minimal: use regex-free path with @xmldom if needed.
  // Vitest/jsdom provides DOMParser; CLI uses linked polyfill below.
  throw new SweetHome3DImportError("DOMParser unavailable in this environment");
}

/** Stable fixture id from light id or content hash. */
export function fixtureId(
  lightId: string | undefined,
  name: string,
  levelId: string | undefined,
  sourceIndex: number,
  pos: Vec3,
): string {
  if (lightId) {
    return sourceIndex === 0 ? `light_${lightId}` : `light_${lightId}_src${sourceIndex}`;
  }
  const key = `${name}|${levelId ?? ""}|${pos.x.toFixed(2)}|${pos.y.toFixed(2)}|${pos.z.toFixed(2)}|${sourceIndex}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return `fixture_${(h >>> 0).toString(16)}`;
}

/**
 * lightSource x/y/z are percentages of width/depth/height.
 * Origin: left / front / bottom of the piece.
 * Piece angle rotates in plan XY (radians, SH3D convention).
 */
export function lightSourceWorldPosition(
  piece: {
    x: number;
    y: number;
    elevation: number;
    width: number;
    depth: number;
    height: number;
    angle: number;
  },
  source: { x: number; y: number; z: number },
): Vec3 {
  // Local offset from piece centre: percentages 0..1 from left/front/bottom
  const localX = (source.x - 0.5) * piece.width;
  const localY = (source.y - 0.5) * piece.depth;
  const localZ = source.z * piece.height;
  const cos = Math.cos(piece.angle);
  const sin = Math.sin(piece.angle);
  const rotX = localX * cos - localY * sin;
  const rotY = localX * sin + localY * cos;
  return {
    x: piece.x + rotX,
    y: piece.y + rotY,
    z: piece.elevation + localZ,
  };
}

function parseLens(v: string | undefined): CameraLens {
  if (v === "NORMAL" || v === "FISHEYE" || v === "SPHERICAL" || v === "PINHOLE") {
    return v;
  }
  return "PINHOLE";
}

function parseCameraAttribute(
  kind: "camera" | "observerCamera",
  v: string | undefined,
): CameraAttribute {
  if (
    v === "topCamera" ||
    v === "storedCamera" ||
    v === "cameraPath" ||
    v === "observerCamera"
  ) {
    return v;
  }
  return kind === "observerCamera" ? "observerCamera" : "topCamera";
}

export function parseHomeXml(xml: string, fileName = "Home.xml"): FloorplanIR {
  const doc = parseXml(xml);
  const home = doc.documentElement;
  if (!home || home.tagName.toLowerCase() !== "home") {
    throw new SweetHome3DImportError("Home.xml root element must be <home>");
  }

  const ir = emptyIR("sweethome3d", fileName);
  const points: Vec3[] = [];

  const env = home.querySelector(":scope > environment");
  if (env) {
    const lightColor = attr(env, "lightColor");
    const skyColor = attr(env, "skyColor");
    const groundColor = attr(env, "groundColor");
    ir.environment = {
      ambientColor: lightColor ? argbIntToHex(Number.parseInt(lightColor, 10)) : undefined,
      skyColor: skyColor ? argbIntToHex(Number.parseInt(skyColor, 10)) : undefined,
      groundColor: groundColor ? argbIntToHex(Number.parseInt(groundColor, 10)) : undefined,
      photoWidth: attr(env, "photoWidth") ? num(env, "photoWidth") : undefined,
      photoHeight: attr(env, "photoHeight") ? num(env, "photoHeight") : undefined,
      photoAspectRatio: attr(env, "photoAspectRatio"),
    };
  }

  for (const el of Array.from(home.querySelectorAll(":scope > level"))) {
    ir.levels.push({
      id: attr(el, "id") ?? `level_${ir.levels.length}`,
      name: attr(el, "name") ?? "Level",
      elevation: num(el, "elevation"),
      height: num(el, "height", 250),
      visible: bool(el, "visible", true),
    });
  }

  const parseCam = (el: Element, kind: "camera" | "observerCamera"): CameraIR => ({
    id: attr(el, "id") ?? `${kind}_${ir.cameras.length}`,
    name: attr(el, "name"),
    kind,
    attribute: parseCameraAttribute(kind, attr(el, "attribute")),
    lens: parseLens(attr(el, "lens")),
    x: num(el, "x"),
    y: num(el, "y"),
    z: num(el, "z"),
    yaw: num(el, "yaw"),
    pitch: num(el, "pitch"),
    fieldOfView: num(el, "fieldOfView", Math.PI / 3),
  });

  for (const el of Array.from(home.querySelectorAll(":scope > camera"))) {
    ir.cameras.push(parseCam(el, "camera"));
  }
  for (const el of Array.from(home.querySelectorAll(":scope > observerCamera"))) {
    ir.cameras.push(parseCam(el, "observerCamera"));
  }

  for (const el of Array.from(home.querySelectorAll(":scope > wall"))) {
    const wall: WallIR = {
      id: attr(el, "id") ?? `wall_${ir.walls.length}`,
      levelId: attr(el, "level"),
      start: { x: num(el, "xStart"), y: num(el, "yStart") },
      end: { x: num(el, "xEnd"), y: num(el, "yEnd") },
      height: attr(el, "height") ? num(el, "height") : undefined,
      thickness: num(el, "thickness", 10),
    };
    ir.walls.push(wall);
    points.push({ x: wall.start.x, y: wall.start.y, z: 0 });
    points.push({ x: wall.end.x, y: wall.end.y, z: wall.height ?? 250 });
  }

  for (const el of Array.from(home.querySelectorAll(":scope > room"))) {
    const polygon = Array.from(el.querySelectorAll(":scope > point")).map((p) => ({
      x: num(p, "x"),
      y: num(p, "y"),
    }));
    const room: RoomIR = {
      id: attr(el, "id") ?? `room_${ir.rooms.length}`,
      levelId: attr(el, "level"),
      name: attr(el, "name"),
      polygon,
      areaHint: attr(el, "name")?.toLowerCase().replace(/\s+/g, "_"),
    };
    ir.rooms.push(room);
    for (const p of polygon) {
      points.push({ x: p.x, y: p.y, z: 0 });
    }
  }

  for (const el of Array.from(home.querySelectorAll(":scope > doorOrWindow"))) {
    const opening: OpeningIR = {
      id: attr(el, "id") ?? `opening_${ir.openings.length}`,
      kind: (attr(el, "name") ?? "").toLowerCase().includes("window") ? "window" : "door",
      levelId: attr(el, "level"),
      position: {
        x: num(el, "x"),
        y: num(el, "y"),
        z: num(el, "elevation"),
      },
      width: num(el, "width"),
      height: num(el, "height"),
      angle: num(el, "angle"),
    };
    ir.openings.push(opening);
    points.push(opening.position);
  }

  for (const el of Array.from(home.querySelectorAll(":scope > pieceOfFurniture"))) {
    ir.furniture.push({
      id: attr(el, "id") ?? `furn_${ir.furniture.length}`,
      name: attr(el, "name") ?? "Furniture",
      levelId: attr(el, "level"),
      position: { x: num(el, "x"), y: num(el, "y"), z: num(el, "elevation") },
      width: num(el, "width"),
      depth: num(el, "depth"),
      height: num(el, "height"),
      angle: num(el, "angle"),
    });
  }

  for (const el of Array.from(home.querySelectorAll(":scope > light"))) {
    const piece = {
      x: num(el, "x"),
      y: num(el, "y"),
      elevation: num(el, "elevation"),
      width: num(el, "width", 10),
      depth: num(el, "depth", 10),
      height: num(el, "height", 10),
      angle: num(el, "angle"),
    };
    const name = attr(el, "name") ?? "Light";
    const levelId = attr(el, "level");
    const lightId = attr(el, "id");
    const power = num(el, "power", 0.5);
    const sources = Array.from(el.querySelectorAll(":scope > lightSource"));
    const list = sources.length > 0 ? sources : [null];

    list.forEach((src, sourceIndex) => {
      const sx = src ? num(src, "x", 0.5) : 0.5;
      const sy = src ? num(src, "y", 0.5) : 0.5;
      const sz = src ? num(src, "z", 0.5) : 0.5;
      const colorRaw = src ? attr(src, "color") : undefined;
      const color = colorRaw
        ? argbIntToHex(Number.parseInt(colorRaw, 10))
        : "#ffffff";
      const diameter = src && attr(src, "diameter") ? num(src, "diameter") : undefined;
      const position = lightSourceWorldPosition(piece, { x: sx, y: sy, z: sz });
      const room = findRoomForPoint(ir, { x: position.x, y: position.y }, levelId);
      const fixture: LightFixtureIR = {
        id: fixtureId(lightId, name, levelId, sourceIndex, position),
        name: sources.length > 1 ? `${name} #${sourceIndex + 1}` : name,
        levelId,
        roomId: room?.id,
        position,
        color,
        power,
        diameter,
      };
      ir.fixtures.push(fixture);
      points.push(position);
    });
  }

  ir.bounds = computeBounds(points);
  return assertIR(ir);
}

export function extractHomeXmlFromSh3d(data: Uint8Array): string {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(data);
  } catch {
    throw new SweetHome3DImportError("File is not a valid ZIP/.sh3d archive");
  }

  for (const name of HOME_XML_NAMES) {
    const entry = unzipped[name];
    if (entry) {
      return strFromU8(entry);
    }
  }

  const keys = Object.keys(unzipped);
  const hasHome = keys.some((k) => k === "Home" || k.endsWith("/Home"));
  if (hasHome) {
    throw new SweetHome3DImportError(
      "This .sh3d contains a serialized Java Home entry but no Home.xml. " +
        "Re-save the project in SweetHome3D 6+ (File → Save) or use its XML export, then retry.",
    );
  }

  throw new SweetHome3DImportError(
    `No Home.xml found in archive. Entries: ${keys.slice(0, 20).join(", ") || "(empty)"}`,
  );
}

export async function importSweetHome3D(
  input: ArrayBuffer | Uint8Array | string,
  fileName = "home.sh3d",
): Promise<FloorplanIR> {
  if (typeof input === "string") {
    return parseHomeXml(input, fileName);
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  // Heuristic: XML starts with < or BOM
  const head = String.fromCharCode(...bytes.slice(0, 64));
  if (head.trimStart().startsWith("<") || head.includes("<?xml")) {
    return parseHomeXml(new TextDecoder().decode(bytes), fileName);
  }
  const xml = extractHomeXmlFromSh3d(bytes);
  return parseHomeXml(xml, fileName);
}
