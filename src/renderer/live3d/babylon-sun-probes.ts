/**
 * Build + sample exterior-wall sun probes for Babylon live3d.
 * Places sensors on interior and exterior faces of envelope walls.
 */
import {
  AbstractMesh,
  Color3,
  MeshBuilder,
  Node,
  Ray,
  StandardMaterial,
  Vector3,
  type Scene,
} from "@babylonjs/core";
import {
  classifyExteriorWallName,
  evaluateSunProbeReceive,
  ndotTowardSun,
  probeSpatialKey,
  probeStationsAlongLength,
  type SunProbeReading,
  type SunProbeSample,
  type SunProbeSide,
} from "../../sun-probes";
import {
  facadeFaceSignFromNormal,
  geographicFacadeNormal,
  geometricOutwardFromEnvelope,
  mergeWallEnvelope,
  meshXPointsEast,
  type EastWestPlanHint,
  type WallEnvelope,
} from "../../sun-probe-envelope";
import { isBabylonGlassMaterial } from "./babylon-gltf-materials";
import { isBabylonCeiling } from "./babylon-ceilings";

const PROBE_Y_CM = 140;
const RAY_ORIGIN_OUTSET_CM = 28;
const FACE_OUTSET_CM = 12;
const RAY_LENGTH_CM = 12000;
const MARKER_DIAMETER_CM = 18;
const PROBE_SPACING_CM = 120;
const PROBE_MARGIN_CM = 45;
/** Skip tiny envelope scraps; long walls carry the sampling. */
const MIN_WALL_LENGTH_CM = 70;

export interface SunProbeSampleExt extends SunProbeSample {
  /** Babylon mesh uniqueId — excluded from occlusion rays. */
  meshUniqueId: number;
}

function exteriorWallLabel(mesh: AbstractMesh): {
  wallName: string;
  preferredSide: SunProbeSide | null;
} | null {
  let cur: Node | null = mesh;
  while (cur) {
    const c = classifyExteriorWallName(cur.name);
    if (c.isExteriorWall) {
      return { wallName: cur.name, preferredSide: c.preferredSide };
    }
    cur = cur.parent;
  }
  return null;
}

function worldAabb(mesh: AbstractMesh): {
  min: Vector3;
  max: Vector3;
  center: Vector3;
  sx: number;
  sy: number;
  sz: number;
} | null {
  // After glTF reparent + scale×100, prefer hierarchy vectors (Babylon scene-graph API)
  // over a stale local boundingBox that can still be in meters near the origin.
  mesh.computeWorldMatrix(true);
  const { min, max } = mesh.getHierarchyBoundingVectors(true);
  const sx = max.x - min.x;
  const sy = max.y - min.y;
  const sz = max.z - min.z;
  if (!Number.isFinite(sx) || sx + sy + sz < 1) {
    return null;
  }
  // Reject still-unscaled meter-range envelopes for full walls (apartment ~15 m → ~1500 cm).
  if (sx < 40 && sz < 40 && sy < 40) {
    mesh.refreshBoundingInfo(true, true);
    const box = mesh.getBoundingInfo().boundingBox;
    const min2 = box.minimumWorld;
    const max2 = box.maximumWorld;
    const sx2 = max2.x - min2.x;
    const sy2 = max2.y - min2.y;
    const sz2 = max2.z - min2.z;
    if (sx2 + sy2 + sz2 < 1) {
      return null;
    }
    return {
      min: min2.clone(),
      max: max2.clone(),
      center: Vector3.Center(min2, max2),
      sx: sx2,
      sy: sy2,
      sz: sz2,
    };
  }
  return {
    min: min.clone(),
    max: max.clone(),
    center: Vector3.Center(min, max),
    sx,
    sy,
    sz,
  };
}

function faceProbesAlongWall(
  wallName: string,
  side: SunProbeSide,
  aabb: { min: Vector3; max: Vector3; center: Vector3; sx: number; sz: number },
  thinAxis: "x" | "z",
  faceSign: 1 | -1,
  facadeNormal: { x: number; y: number; z: number },
  meshUniqueId: number,
): SunProbeSampleExt[] {
  const midY = Math.min(
    Math.max(aabb.center.y, PROBE_Y_CM),
    Math.max(aabb.min.y + 20, aabb.max.y - 20),
  );
  const longLen = thinAxis === "x" ? aabb.sz : aabb.sx;
  const stations = probeStationsAlongLength(longLen, PROBE_SPACING_CM, PROBE_MARGIN_CM);
  const faceX = faceSign > 0 ? aabb.max.x : aabb.min.x;
  const faceZ = faceSign > 0 ? aabb.max.z : aabb.min.z;

  return stations.map((along, i) => {
    const pos =
      thinAxis === "x"
        ? new Vector3(faceX + faceSign * FACE_OUTSET_CM, midY, aabb.min.z + along)
        : new Vector3(aabb.min.x + along, midY, faceZ + faceSign * FACE_OUTSET_CM);
    return {
      id: `${wallName}::${side}::${i}`,
      wallName,
      side,
      position: { x: pos.x, y: pos.y, z: pos.z },
      normal: { x: facadeNormal.x, y: facadeNormal.y, z: facadeNormal.z },
      meshUniqueId,
    };
  });
}

/** Samples for one exterior wall mesh (spaced along length). */
export function samplesForExteriorWallMesh(
  mesh: AbstractMesh,
  env: WallEnvelope,
  xPointsEast: boolean,
): SunProbeSampleExt[] {
  if (mesh.getTotalVertices() < 3) {
    return [];
  }
  const label = exteriorWallLabel(mesh);
  if (!label) {
    return [];
  }
  const aabb = worldAabb(mesh);
  if (!aabb) {
    return [];
  }
  // Placement uses geometric envelope outward (true outside of building).
  // Sun n·L uses geographic normal (east facade → +X for north=180).
  const geometric = geometricOutwardFromEnvelope(aabb.center.x, aabb.center.z, env);
  const geographic = geographicFacadeNormal(geometric, xPointsEast);
  const { thinAxis: faceAxis, sign: outwardSign } = facadeFaceSignFromNormal(geometric);
  const longLen = faceAxis === "x" ? aabb.sz : aabb.sx;
  if (longLen < MIN_WALL_LENGTH_CM) {
    return [];
  }
  const inwardSign = (outwardSign === 1 ? -1 : 1) as 1 | -1;

  if (label.preferredSide === "exterior") {
    return faceProbesAlongWall(
      label.wallName,
      "exterior",
      aabb,
      faceAxis,
      outwardSign,
      geographic,
      mesh.uniqueId,
    );
  }
  if (label.preferredSide === "interior") {
    return faceProbesAlongWall(
      label.wallName,
      "interior",
      aabb,
      faceAxis,
      inwardSign,
      geographic,
      mesh.uniqueId,
    );
  }
  return [
    ...faceProbesAlongWall(
      label.wallName,
      "exterior",
      aabb,
      faceAxis,
      outwardSign,
      geographic,
      mesh.uniqueId,
    ),
    ...faceProbesAlongWall(
      label.wallName,
      "interior",
      aabb,
      faceAxis,
      inwardSign,
      geographic,
      mesh.uniqueId,
    ),
  ];
}

export function collectExteriorWallSamples(
  meshes: AbstractMesh[],
  geoHint?: EastWestPlanHint,
): SunProbeSampleExt[] {
  type WallEntry = {
    mesh: AbstractMesh;
    aabb: NonNullable<ReturnType<typeof worldAabb>>;
    label: NonNullable<ReturnType<typeof exteriorWallLabel>>;
  };
  const walls: WallEntry[] = [];
  let env: WallEnvelope | null = null;

  for (const mesh of meshes) {
    if (!mesh.name || mesh.name === "skyBox" || isBabylonCeiling(mesh)) {
      continue;
    }
    const label = exteriorWallLabel(mesh);
    if (!label) {
      continue;
    }
    const aabb = worldAabb(mesh);
    if (!aabb) {
      continue;
    }
    env = mergeWallEnvelope(env, aabb.min.x, aabb.max.x, aabb.min.z, aabb.max.z);
    walls.push({ mesh, aabb, label });
  }

  if (!env || walls.length === 0) {
    return [];
  }

  let xPointsEast = true;
  if (geoHint) {
    const livingXs = walls
      .filter((w) => /living/i.test(w.label.wallName))
      .map((w) => w.aabb.center.x);
    const eastXs = walls
      .filter((w) => /office|bedroom/i.test(w.label.wallName))
      .map((w) => w.aabb.center.x);
    if (livingXs.length > 0 && eastXs.length > 0) {
      const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      xPointsEast = meshXPointsEast(avg(livingXs), avg(eastXs), geoHint);
    }
  }
  const candidates: SunProbeSampleExt[] = [];
  for (const { mesh } of walls) {
    candidates.push(...samplesForExteriorWallMesh(mesh, env, xPointsEast));
  }

  // Spatial dedupe: prefer exterior over interior in the same facade cell.
  const best = new Map<string, SunProbeSampleExt>();
  for (const sample of candidates) {
    const key = probeSpatialKey(sample.side, sample.position.x, sample.position.z);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, sample);
      continue;
    }
    if (sample.side === "exterior" && prev.side === "interior") {
      best.set(key, sample);
    }
  }
  const out = [...best.values()];
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function isOpaqueOccluder(mesh: AbstractMesh | undefined, skipUniqueId: number): boolean {
  if (!mesh || mesh.name === "skyBox") {
    return false;
  }
  if (mesh.uniqueId === skipUniqueId) {
    return false;
  }
  if (mesh.name.startsWith("sunProbeMarker_")) {
    return false;
  }
  if (isBabylonCeiling(mesh)) {
    return true;
  }
  if (isBabylonGlassMaterial(mesh.name, mesh.material)) {
    return false;
  }
  return true;
}

/** Ray toward the sun; skip glass + source wall; opaque hit = occlusion. */
export function rayOccludedTowardSun(
  scene: Scene,
  origin: Vector3,
  towardSun: Vector3,
  skipMeshUniqueId: number,
  maxDistance = RAY_LENGTH_CM,
): boolean {
  const dir = towardSun.normalize();
  let cursor = origin.clone();
  let remaining = maxDistance;
  for (let hop = 0; hop < 8; hop++) {
    const ray = new Ray(cursor, dir, remaining);
    const hit = scene.pickWithRay(ray, (mesh) => {
      if (mesh.uniqueId === skipMeshUniqueId || mesh.name.startsWith("sunProbeMarker_")) {
        return false;
      }
      return (
        isOpaqueOccluder(mesh, skipMeshUniqueId) ||
        isBabylonGlassMaterial(mesh.name, mesh.material)
      );
    });
    if (!hit?.hit || hit.pickedMesh == null || hit.distance <= 0) {
      return false;
    }
    if (isOpaqueOccluder(hit.pickedMesh, skipMeshUniqueId)) {
      return true;
    }
    const step = Math.max(hit.distance + 2, 3);
    cursor = cursor.add(dir.scale(step));
    remaining -= step;
    if (remaining <= 0) {
      return false;
    }
  }
  return false;
}

export function readSunProbes(
  scene: Scene,
  samples: SunProbeSampleExt[],
  towardSun: { x: number; y: number; z: number } | null,
  sunUp: boolean,
): SunProbeReading[] {
  if (!sunUp || towardSun == null) {
    return samples.map((s) => ({
      ...s,
      ndotL: 0,
      facingSun: false,
      occluded: false,
      receivesSun: false,
    }));
  }
  const toward = new Vector3(towardSun.x, towardSun.y, towardSun.z).normalize();
  return samples.map((s) => {
    const ndotL = ndotTowardSun(s.normal, toward);
    const facing = ndotL > 0.02;
    const trustFacingOnly = s.side === "exterior";
    let occluded = false;
    if (facing && !trustFacingOnly) {
      const origin = new Vector3(s.position.x, s.position.y, s.position.z).add(
        toward.scale(RAY_ORIGIN_OUTSET_CM),
      );
      occluded = rayOccludedTowardSun(scene, origin, toward, s.meshUniqueId);
    }
    return {
      ...s,
      ...evaluateSunProbeReceive({ ndotL, occluded, trustFacingOnly }),
    };
  });
}

export function createSunProbeMarkers(
  scene: Scene,
  samples: SunProbeSample[],
): Map<string, AbstractMesh> {
  const matLit = new StandardMaterial("sunProbeMatLit", scene);
  matLit.emissiveColor = new Color3(0.15, 0.85, 0.25);
  matLit.disableLighting = true;
  const matDark = new StandardMaterial("sunProbeMatDark", scene);
  matDark.emissiveColor = new Color3(0.55, 0.18, 0.18);
  matDark.disableLighting = true;
  const matOff = new StandardMaterial("sunProbeMatOff", scene);
  matOff.emissiveColor = new Color3(0.25, 0.28, 0.32);
  matOff.disableLighting = true;

  const markers = new Map<string, AbstractMesh>();
  for (const s of samples) {
    const sphere = MeshBuilder.CreateSphere(
      `sunProbeMarker_${s.id}`,
      { diameter: MARKER_DIAMETER_CM, segments: 6 },
      scene,
    );
    sphere.position.set(s.position.x, s.position.y, s.position.z);
    sphere.isPickable = false;
    sphere.alwaysSelectAsActiveMesh = true;
    sphere.material = matOff;
    sphere.metadata = { lit: matLit, dark: matDark, off: matOff };
    markers.set(s.id, sphere);
  }
  return markers;
}

export function updateSunProbeMarkers(
  markers: Map<string, AbstractMesh>,
  readings: SunProbeReading[],
  sunUp: boolean,
): void {
  for (const r of readings) {
    const mesh = markers.get(r.id);
    if (!mesh) {
      continue;
    }
    const mats = mesh.metadata as {
      lit: StandardMaterial;
      dark: StandardMaterial;
      off: StandardMaterial;
    };
    if (!sunUp) {
      mesh.material = mats.off;
    } else if (r.receivesSun) {
      mesh.material = mats.lit;
    } else {
      mesh.material = mats.dark;
    }
  }
}
