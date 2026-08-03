import type { HomeAssistant } from "custom-card-helpers";

/** Minimal HA frontend registry shapes (not always typed in card-helpers). */
export interface HassEntityRegistryEntry {
  entity_id?: string;
  area_id?: string | null;
  labels?: string[];
}

export interface HassAreaRegistryEntry {
  area_id?: string;
  name?: string;
}

export interface HassLabelRegistryEntry {
  label_id?: string;
  name?: string;
}

export type HassWithRegistry = HomeAssistant & {
  entities?: Record<string, HassEntityRegistryEntry>;
  areas?: Record<string, HassAreaRegistryEntry>;
  labels?: Record<string, HassLabelRegistryEntry>;
};

export interface EntityRoom {
  /** Stable id for grouping / hue (label id or area_id). */
  id: string;
  /** Human-readable room name. */
  name: string;
  /** Where the room came from. */
  source: "label" | "area" | "config";
}

/**
 * Resolve a light's room from Home Assistant tags.
 * Prefers entity labels (user tags), then the assigned Area.
 */
export function resolveEntityRoom(
  hass: HomeAssistant | undefined,
  entityId: string,
): EntityRoom | undefined {
  if (!hass || !entityId) {
    return undefined;
  }
  const ext = hass as HassWithRegistry;
  const entry = ext.entities?.[entityId];
  const labels = entry?.labels?.filter((l) => !!l?.trim()) ?? [];
  if (labels.length > 0) {
    const raw = labels[0]!.trim();
    const id = normalizeRoomId(raw);
    const meta = ext.labels?.[raw] ?? ext.labels?.[id];
    return {
      id,
      name: meta?.name?.trim() || prettifyRoom(raw),
      source: "label",
    };
  }
  const areaId = entry?.area_id ?? undefined;
  if (areaId) {
    const area = ext.areas?.[areaId];
    return {
      id: normalizeRoomId(areaId),
      name: area?.name?.trim() || prettifyRoom(areaId),
      source: "area",
    };
  }
  return undefined;
}

export function normalizeRoomId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
}

export function prettifyRoom(raw: string): string {
  return raw
    .replace(/^room[_-]/i, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** YAML `group` wins; otherwise HA label/area room tag. */
export function effectiveEntityGroup(
  configuredGroup: string | undefined,
  hass: HomeAssistant | undefined,
  entityId: string,
): string | undefined {
  if (configuredGroup?.trim()) {
    return normalizeRoomId(configuredGroup);
  }
  return resolveEntityRoom(hass, entityId)?.id;
}
