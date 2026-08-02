import { describe, expect, it } from "vitest";
import { validateConfig, stubConfig } from "../src/config";

describe("config validation", () => {
  it("accepts stub config", () => {
    const cfg = validateConfig(stubConfig());
    expect(cfg.type).toContain("sunflow");
  });

  it("rejects empty object", () => {
    expect(() => validateConfig({})).toThrow(/missing type|manifest|ir|renders|entities/);
  });

  it("rejects config without data sources", () => {
    expect(() => validateConfig({ type: "custom:sunflow-floorplan-card" })).toThrow(
      /manifest|ir|renders|entities/,
    );
  });

  it("rejects bad render.mode", () => {
    expect(() =>
      validateConfig({
        type: "custom:sunflow-floorplan-card",
        entities: { a: { entity: "light.x" } },
        render: { mode: "nope" },
      }),
    ).toThrow(/render.mode/);
  });

  it("rejects marker override that is not a pair", () => {
    expect(() =>
      validateConfig({
        type: "custom:sunflow-floorplan-card",
        entities: { a: { entity: "light.x" } },
        overrides: { a: { marker: [1] } },
      }),
    ).toThrow(/marker/);
  });
});
