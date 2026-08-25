/**
 * Blender appartement sidecar → FloorplanIR.
 *
 * Coordinates are already plan cm (X / Y plan, Z elevation) matching live3d
 * `planToRender`. The matching GLB is meters Y-up and is scaled ×100 on load.
 */

import {
  emptyIR,
  type CameraIR,
  type FloorplanIR,
  type LightFixtureIR,
} from "./ir";
import type { Vec3 } from "../types";

export interface BlenderSceneCamera {
  name: string;
  eye: [number, number, number];
  target: [number, number, number];
  fovDeg: number;
}

export interface BlenderSceneFixture {
  id: string;
  name: string;
  kind: "point" | "strip";
  position: [number, number, number];
  end?: [number, number, number];
  samples?: number;
  color: string;
  power: number;
}

export interface BlenderSceneFile {
  source: string;
  units: "cm";
  gltfScale: number;
  /** Compass heading of plan +Y (degrees). Matches `render.north` on the card. */
  planNorthDeg?: number;
  /** Building floor (e.g. 10). */
  floorLevel?: number;
  camera: BlenderSceneCamera;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
  fixtures: BlenderSceneFixture[];
}

function tripleToVec3(t: [number, number, number]): Vec3 {
  return { x: t[0], y: t[1], z: t[2] };
}

export function isBlenderSceneFile(raw: unknown): raw is BlenderSceneFile {
  if (!raw || typeof raw !== "object") {
    return false;
  }
  const v = raw as Partial<BlenderSceneFile>;
  return (
    typeof v.source === "string" &&
    v.units === "cm" &&
    Array.isArray(v.fixtures) &&
    !!v.camera &&
    !!v.bounds
  );
}

export function importBlenderScene(
  raw: unknown,
  fileName = "appartement.scene.json",
): FloorplanIR {
  if (!isBlenderSceneFile(raw)) {
    throw new Error("Blender scene: expected { source, units: cm, camera, bounds, fixtures }");
  }
  const ir = emptyIR("blender-glb", raw.source || fileName);
  ir.levels = [
    {
      id: "blender-main",
      name: "Appartement",
      elevation: 0,
      height: Math.max(250, raw.bounds.max[2] - raw.bounds.min[2]),
      visible: true,
    },
  ];
  ir.fixtures = raw.fixtures.map((fx): LightFixtureIR => {
    const item: LightFixtureIR = {
      id: fx.id,
      name: fx.name,
      levelId: "blender-main",
      position: tripleToVec3(fx.position),
      color: fx.color,
      power: fx.power,
      kind: fx.kind,
    };
    if (fx.kind === "strip" && fx.end) {
      item.end = tripleToVec3(fx.end);
      item.samples = fx.samples ?? 8;
    }
    return item;
  });
  const fovRad = (raw.camera.fovDeg * Math.PI) / 180;
  const cam: CameraIR = {
    id: raw.camera.name,
    name: raw.camera.name,
    kind: "camera",
    attribute: "storedCamera",
    lens: "PINHOLE",
    x: raw.camera.eye[0],
    y: raw.camera.eye[2],
    z: raw.camera.eye[1],
    yaw: 0,
    pitch: 0,
    fieldOfView: fovRad,
  };
  ir.cameras = [cam];
  ir.environment = {
    photoWidth: 1920,
    photoHeight: 1352,
    ...(typeof raw.planNorthDeg === "number" && Number.isFinite(raw.planNorthDeg)
      ? { planNorthDeg: raw.planNorthDeg }
      : {}),
    ...(typeof raw.floorLevel === "number" && Number.isFinite(raw.floorLevel)
      ? { floorLevel: raw.floorLevel }
      : {}),
    dollhouseView: {
      eye: {
        x: raw.camera.eye[0],
        y: raw.camera.eye[1],
        z: raw.camera.eye[2],
      },
      target: {
        x: raw.camera.target[0],
        y: raw.camera.target[1],
        z: raw.camera.target[2],
      },
      fovDeg: raw.camera.fovDeg,
    },
  };
  ir.bounds = {
    min: tripleToVec3(raw.bounds.min),
    max: tripleToVec3(raw.bounds.max),
  };
  return ir;
}
