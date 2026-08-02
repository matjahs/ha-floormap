import { describe, expect, it } from "vitest";
import { applyToneMap } from "../src/color";

describe("tone mapping", () => {
  it("aces and reinhard compress highlights", () => {
    const c: [number, number, number] = [8, 2, 1];
    const a = applyToneMap(c, "aces", 1);
    const r = applyToneMap(c, "reinhard", 1);
    expect(a[0]).toBeLessThanOrEqual(1);
    expect(r[0]).toBeLessThan(1);
    expect(a[0]).toBeGreaterThan(a[2]);
  });

  it("exposure scales before map", () => {
    const c: [number, number, number] = [0.5, 0.5, 0.5];
    const dark = applyToneMap(c, "reinhard", 0.5);
    const bright = applyToneMap(c, "reinhard", 2);
    expect(bright[0]).toBeGreaterThan(dark[0]);
  });
});
