import { describe, expect, it } from "vitest";
import type { HomeAssistant } from "custom-card-helpers";
import {
  effectiveEntityGroup,
  resolveEntityRoom,
} from "../src/ha-room";
import { discoverGroupIds, memberEntitiesForGroup } from "../src/groups";
import type { SunflowFloorplanCardConfig } from "../src/types";

function hassStub(opts: {
  labels?: string[];
  area_id?: string;
  areaName?: string;
}): HomeAssistant {
  return {
    entities: {
      "light.kitchen_1": {
        entity_id: "light.kitchen_1",
        labels: opts.labels,
        area_id: opts.area_id ?? null,
      },
    },
    areas: opts.area_id
      ? {
        [opts.area_id]: {
          area_id: opts.area_id,
          name: opts.areaName ?? opts.area_id,
        },
      }
      : {},
  } as unknown as HomeAssistant;
}

describe("ha-room tags", () => {
  it("prefers entity labels over area", () => {
    const room = resolveEntityRoom(
      hassStub({ labels: ["kitchen"], area_id: "living", areaName: "Living" }),
      "light.kitchen_1",
    );
    expect(room).toEqual({
      id: "kitchen",
      name: "Kitchen",
      source: "label",
    });
  });

  it("uses label registry name when present", () => {
    const hass = hassStub({ labels: ["kitchen_tag"] }) as HomeAssistant & {
      labels: Record<string, { name: string }>;
    };
    hass.labels = { kitchen_tag: { name: "Kitchen" } };
    const room = resolveEntityRoom(hass, "light.kitchen_1");
    expect(room?.id).toBe("kitchen_tag");
    expect(room?.name).toBe("Kitchen");
  });

  it("normalizes YAML group ids for discovery", () => {
    const cfg = {
      type: "custom:sunflow-floorplan-card",
      groups: { Kitchen: { tap_action: { action: "toggle" } } },
      entities: {
        a: { entity: "light.kitchen_1", group: "Kitchen" },
      },
    } as SunflowFloorplanCardConfig;
    expect(discoverGroupIds(cfg)).toEqual(["kitchen"]);
    expect(memberEntitiesForGroup(cfg, "kitchen")).toEqual(["light.kitchen_1"]);
  });

  it("falls back to area when no labels", () => {
    const room = resolveEntityRoom(
      hassStub({ area_id: "office", areaName: "Home Office" }),
      "light.kitchen_1",
    );
    expect(room?.id).toBe("office");
    expect(room?.name).toBe("Home Office");
    expect(room?.source).toBe("area");
  });

  it("YAML group wins over HA tags", () => {
    expect(
      effectiveEntityGroup("living", hassStub({ labels: ["kitchen"] }), "light.kitchen_1"),
    ).toBe("living");
  });

  it("discovers groups from HA labels", () => {
    const cfg = {
      type: "custom:sunflow-floorplan-card",
      entities: {
        a: { entity: "light.kitchen_1" },
      },
    } as SunflowFloorplanCardConfig;
    const ids = discoverGroupIds(cfg, hassStub({ labels: ["kitchen"] }));
    expect(ids).toContain("kitchen");
    expect(memberEntitiesForGroup(cfg, "kitchen", hassStub({ labels: ["kitchen"] }))).toEqual([
      "light.kitchen_1",
    ]);
  });
});
