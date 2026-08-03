import type { FloorplanIR } from "./import/ir";
import type { FixtureOverride, Vec3 } from "./types";

export interface PlacementEntry {
  position: [number, number, number];
}

export type PlacementsFile = Record<string, PlacementEntry>;

/** Plan-space pose: override.position wins over IR fixture.position. */
export function resolveFixturePose(
  ir: FloorplanIR | null | undefined,
  fixtureId: string,
  overrides?: Record<string, FixtureOverride>,
): Vec3 | undefined {
  const o = overrides?.[fixtureId]?.position;
  if (o && o.length === 3 && o.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { x: o[0], y: o[1], z: o[2] };
  }
  const fx = ir?.fixtures.find((f) => f.id === fixtureId);
  return fx?.position;
}

export function positionTuple(pos: Vec3): [number, number, number] {
  return [pos.x, pos.y, pos.z];
}

/** Merge placements.json entries into config overrides (positions only). */
export function mergePlacementsIntoOverrides(
  overrides: Record<string, FixtureOverride> | undefined,
  placements: PlacementsFile,
): Record<string, FixtureOverride> {
  const next: Record<string, FixtureOverride> = { ...(overrides ?? {}) };
  for (const [id, entry] of Object.entries(placements)) {
    if (!entry?.position || entry.position.length !== 3) {
      continue;
    }
    next[id] = {
      ...(next[id] ?? {}),
      position: [entry.position[0], entry.position[1], entry.position[2]],
    };
  }
  return next;
}

/** Extract position overrides as a placements.json payload. */
export function overridesToPlacements(
  overrides: Record<string, FixtureOverride> | undefined,
): PlacementsFile {
  const out: PlacementsFile = {};
  if (!overrides) {
    return out;
  }
  for (const [id, o] of Object.entries(overrides)) {
    if (o.position && o.position.length === 3) {
      out[id] = { position: [o.position[0], o.position[1], o.position[2]] };
    }
  }
  return out;
}
