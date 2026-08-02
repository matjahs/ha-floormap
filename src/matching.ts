import type { LightFixtureIR, FloorplanIR } from "./import/ir";

export interface HaLightEntity {
  entity_id: string;
  friendly_name?: string;
  area_id?: string;
  area_name?: string;
}

export interface MatchCandidate {
  entity_id: string;
  score: number;
  reason: string;
}

export interface FixtureMatch {
  fixtureId: string;
  fixtureName: string;
  roomName?: string;
  candidates: MatchCandidate[];
  best?: MatchCandidate;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(normalize(s).split(/\s+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) {
      inter++;
    }
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function scoreFixture(
  fixture: LightFixtureIR,
  roomName: string | undefined,
  entity: HaLightEntity,
): MatchCandidate {
  const fname = entity.friendly_name ?? entity.entity_id.replace(/^light\./, "").replace(/_/g, " ");
  const fTokens = tokens(fixture.name);
  const eTokens = tokens(fname);
  const idTokens = tokens(entity.entity_id.replace(/^light\./, ""));
  let score = Math.max(jaccard(fTokens, eTokens), jaccard(fTokens, idTokens)) * 0.7;
  let reason = "name";

  if (roomName && entity.area_name) {
    const areaScore = jaccard(tokens(roomName), tokens(entity.area_name));
    if (areaScore > 0.3) {
      score += areaScore * 0.3;
      reason = "name+area";
    }
  } else if (roomName && entity.area_id) {
    const areaScore = jaccard(tokens(roomName), tokens(entity.area_id));
    if (areaScore > 0.3) {
      score += areaScore * 0.25;
      reason = "name+area_id";
    }
  }

  // Boost exact substring
  const fn = normalize(fixture.name);
  const en = normalize(fname);
  if (fn && en && (fn.includes(en) || en.includes(fn))) {
    score = Math.max(score, 0.85);
    reason = "substring";
  }

  return {
    entity_id: entity.entity_id,
    score: Math.min(1, score),
    reason,
  };
}

export function matchFixtures(
  ir: FloorplanIR,
  entities: HaLightEntity[],
): FixtureMatch[] {
  const lights = entities.filter((e) => e.entity_id.startsWith("light."));
  return ir.fixtures.map((fixture) => {
    const room = ir.rooms.find((r) => r.id === fixture.roomId);
    const candidates = lights
      .map((e) => scoreFixture(fixture, room?.name, e))
      .filter((c) => c.score >= 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return {
      fixtureId: fixture.id,
      fixtureName: fixture.name,
      roomName: room?.name,
      candidates,
      best: candidates[0]?.score >= 0.45 ? candidates[0] : undefined,
    };
  });
}
