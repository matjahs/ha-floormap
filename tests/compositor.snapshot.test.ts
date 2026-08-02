import { describe, expect, it } from "vitest";
import {
  applyToneMap,
  srgbToLinear,
  linearToSrgb,
  type RGB,
} from "../src/color";

/** CPU reference for baked accumulation (mirrors shader maths). */
export function accumulate(
  baseSrgb: RGB[],
  contributionsSrgb: RGB[][],
  intensities: number[],
  colors: RGB[],
  exposure: number,
  toneMap: "aces" | "reinhard" | "none",
): RGB[] {
  return baseSrgb.map((base, i) => {
    let L = srgbToLinear(base);
    for (let li = 0; li < contributionsSrgb.length; li++) {
      const overlay = contributionsSrgb[li]![i]!;
      const Ci: RGB = [
        Math.max(0, srgbToLinear(overlay)[0] - L[0]),
        Math.max(0, srgbToLinear(overlay)[1] - L[1]),
        Math.max(0, srgbToLinear(overlay)[2] - L[2]),
      ];
      // Correct: Ci = max(0, lin(overlay) - lin(base))
      const baseLin = srgbToLinear(base);
      const ovLin = srgbToLinear(overlay);
      const c: RGB = [
        Math.max(0, ovLin[0] - baseLin[0]),
        Math.max(0, ovLin[1] - baseLin[1]),
        Math.max(0, ovLin[2] - baseLin[2]),
      ];
      void Ci;
      L = [
        L[0] + c[0] * intensities[li]! * colors[li]![0],
        L[1] + c[1] * intensities[li]! * colors[li]![1],
        L[2] + c[2] * intensities[li]! * colors[li]![2],
      ];
    }
    const mapped = applyToneMap(L, toneMap, exposure);
    return linearToSrgb(mapped);
  });
}

describe("compositor accumulation", () => {
  it("all lights off ≈ base", () => {
    const base: RGB[] = [[0.2, 0.2, 0.2]];
    const out = accumulate(base, [[[0.8, 0.8, 0.8]]], [0], [[1, 1, 1]], 1, "none");
    expect(out[0]![0]).toBeCloseTo(0.2, 2);
  });

  it("two overlapping lights are brighter than one", () => {
    const base: RGB[] = [[0.1, 0.1, 0.1]];
    const pass: RGB[] = [[0.6, 0.6, 0.6]];
    const one = accumulate(base, [pass], [1], [[1, 1, 1]], 1, "aces");
    const two = accumulate(base, [pass, pass], [1, 1], [[1, 1, 1], [1, 1, 1]], 1, "aces");
    expect(two[0]![0]).toBeGreaterThan(one[0]![0]);
    expect(two[0]![0]).toBeLessThan(1.01);
  });

  it("colour tint affects only that contribution", () => {
    const base: RGB[] = [[0.1, 0.1, 0.1]];
    const pass: RGB[] = [[0.8, 0.8, 0.8]];
    const warm = accumulate(base, [pass], [1], [[1.5, 0.8, 0.4]], 1, "none");
    expect(warm[0]![0]).toBeGreaterThan(warm[0]![2]);
  });
});
