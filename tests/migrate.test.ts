import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

describe("migrate-picture-elements", () => {
  it("emits sunflow config from Waalbandijk picture-elements fixture", () => {
    const script = resolve(__dirname, "../scripts/migrate-picture-elements.mjs");
    const input = resolve(__dirname, "fixtures/../examples/picture-elements-waalbandijk.yaml");
    // examples path
    const example = resolve(__dirname, "../examples/picture-elements-waalbandijk.yaml");
    const out = execFileSync("node", [script, example], { encoding: "utf8" });
    expect(out).toContain("custom:sunflow-floorplan-card");
    expect(out).toContain("light.kitchen_ledstrip_2");
    expect(out).toContain("light.livingroom_light_2");
    expect(out).toContain("TODO");
    const doc = parseYaml(out.replace(/^#.*$/gm, ""));
    expect(doc.type).toBe("custom:sunflow-floorplan-card");
    expect(doc.entities["migrated_light_livingroom_light_1"].entity).toBe(
      "light.livingroom_light_1",
    );
    expect(doc.overrides["migrated_light_livingroom_light_1"].marker).toEqual([52, 58]);
    // Dead entities removed from entities map
    expect(doc.entities["migrated_light_kitchen_ledstrip_2"]).toBeUndefined();
    expect(doc._migration.dead_entities_todo).toContain("light.kitchen_ledstrip_2");
    void input;
  });
});
