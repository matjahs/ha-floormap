import type { BBox, Vec2, Vec3 } from "../types";

export const IR_SCHEMA_VERSION = 2 as const;

/** Accepted on load; v1 fixtures are treated as point lights. */
export type IrSchemaVersion = 1 | 2;

export interface LevelIR {
  id: string;
  name: string;
  elevation: number;
  height: number;
  visible: boolean;
}

export interface WallIR {
  id: string;
  levelId?: string;
  start: Vec2;
  end: Vec2;
  height?: number;
  thickness: number;
  /** Optional Floorplanner side finishes. */
  leftColor?: string;
  rightColor?: string;
  leftTexture?: string;
  rightTexture?: string;
  /** Texture tile size in plan cm. */
  tileWidthCm?: number;
  tileHeightCm?: number;
}

export interface RoomIR {
  id: string;
  levelId?: string;
  name?: string;
  polygon: Vec2[];
  areaHint?: string;
  color?: string;
  floorTexture?: string;
  tileWidthCm?: number;
  tileHeightCm?: number;
}

export interface OpeningIR {
  id: string;
  kind: "door" | "window";
  levelId?: string;
  position: Vec3;
  width: number;
  height: number;
  angle: number;
  /** Optional GLB for door/window frame (Floorplanner slice). */
  meshUrl?: string;
  /** Black aluminium + glass (windows, or specific interior glass door). */
  glazed?: boolean;
}

export interface FurnitureIR {
  id: string;
  name: string;
  levelId?: string;
  position: Vec3;
  width?: number;
  depth?: number;
  height?: number;
  angle?: number;
  /** Optional textured mesh (Floorplanner item GLB). */
  meshUrl?: string;
  /** Floorplanner mirror flags [x, y]. */
  mirrored?: [number, number];
}

export interface LightFixtureIR {
  id: string;
  name: string;
  levelId?: string;
  roomId?: string;
  position: Vec3;
  color: string;
  power: number;
  diameter?: number;
  /** Default point. Strip uses position→end with sampled lights in live3d. */
  kind?: "point" | "strip";
  /** Strip endpoint in plan cm (start = position). */
  end?: Vec3;
  /** live3d sample count along strip (default 8). */
  samples?: number;
}

export type CameraLens = "PINHOLE" | "NORMAL" | "FISHEYE" | "SPHERICAL";
export type CameraAttribute =
  | "topCamera"
  | "storedCamera"
  | "cameraPath"
  | "observerCamera";

export interface CameraIR {
  id: string;
  name?: string;
  kind: "camera" | "observerCamera";
  attribute: CameraAttribute;
  lens: CameraLens;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  fieldOfView: number;
}

export interface EnvironmentIR {
  ambientColor?: string;
  skyColor?: string;
  groundColor?: string;
  photoWidth?: number;
  photoHeight?: number;
  photoAspectRatio?: string;
  /**
   * Floorplanner-style 3D section wall height (cm). When set, live3d extrudes
   * walls to this height so side textures remain visible from above.
   */
  wallSectionHeight?: number;
  /**
   * Compass heading of plan +Y in degrees (0 = geographic north).
   * The Blender GLB may differ from Floorplanner 3D camera orientation.
   */
  planNorthDeg?: number;
  /** Building floor for sun horizon (e.g. 10 for Waalbandijk). */
  floorLevel?: number;
  /** Height above street level in metres (e.g. 32 for Waalbandijk L10). */
  floorElevationM?: number;
  /**
   * Locked dollhouse framing from the Blender camera (three.js cm, Y-up).
   * When set, live3d uses this instead of synthesizing a Bird View.
   */
  dollhouseView?: {
    eye: Vec3;
    target: Vec3;
    fovDeg: number;
  };
}

export type SourceKind =
  | "sweethome3d"
  | "floorplanner-dxf"
  | "floorplanner-fml"
  | "floorplanner-svg"
  | "gltf"
  | "obj"
  | "blender-glb";

export interface FloorplanIR {
  schemaVersion: IrSchemaVersion;
  source: {
    kind: SourceKind;
    file: string;
    importedAt: string;
  };
  units: "cm";
  levels: LevelIR[];
  walls: WallIR[];
  rooms: RoomIR[];
  openings: OpeningIR[];
  furniture: FurnitureIR[];
  fixtures: LightFixtureIR[];
  cameras: CameraIR[];
  environment: EnvironmentIR;
  bounds: BBox;
}

export function emptyIR(
  kind: SourceKind,
  file: string,
  importedAt = new Date().toISOString(),
): FloorplanIR {
  return {
    schemaVersion: IR_SCHEMA_VERSION,
    source: { kind, file, importedAt },
    units: "cm",
    levels: [],
    walls: [],
    rooms: [],
    openings: [],
    furniture: [],
    fixtures: [],
    cameras: [],
    environment: {},
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 0, y: 0, z: 0 },
    },
  };
}

export function assertIR(value: unknown): FloorplanIR {
  if (!value || typeof value !== "object") {
    throw new Error("FloorplanIR: expected an object");
  }
  const ir = value as FloorplanIR;
  const v = ir.schemaVersion as number;
  if (v !== 1 && v !== 2) {
    throw new Error(
      `FloorplanIR: unsupported schemaVersion ${String(ir.schemaVersion)} (expected 1|2)`,
    );
  }
  if (!ir.source?.kind || !ir.source?.file) {
    throw new Error("FloorplanIR: missing source.kind / source.file");
  }
  if (!Array.isArray(ir.fixtures) || !Array.isArray(ir.cameras)) {
    throw new Error("FloorplanIR: fixtures and cameras must be arrays");
  }
  // Normalize to current schema version; v1 fixtures remain point lights.
  return { ...ir, schemaVersion: IR_SCHEMA_VERSION };
}

export function computeBounds(points: Vec3[]): BBox {
  if (points.length === 0) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  }
  const min = { ...points[0]! };
  const max = { ...points[0]! };
  for (const p of points) {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
    max.z = Math.max(max.z, p.z);
  }
  return { min, max };
}

export function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
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

export function findRoomForPoint(ir: FloorplanIR, p: Vec2, levelId?: string): RoomIR | undefined {
  return ir.rooms.find((room) => {
    if (levelId && room.levelId && room.levelId !== levelId) {
      return false;
    }
    return pointInPolygon(p, room.polygon);
  });
}
