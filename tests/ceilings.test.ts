import { describe, expect, it } from "vitest";
import { isCeilingObject } from "../src/renderer/live3d/ceilings";

describe("isCeilingObject", () => {
  it("matches sfCeiling_ prefix on the mesh", () => {
    expect(isCeilingObject({ name: "sfCeiling_Ceilings", parent: null })).toBe(true);
  });

  it("matches sfCeiling_ on a parent", () => {
    expect(
      isCeilingObject({
        name: "RoomCeilingFace",
        parent: { name: "sfCeiling_Living", parent: null },
      }),
    ).toBe(true);
  });

  it("does not match fixture names containing ceiling", () => {
    expect(isCeilingObject({ name: "P131 L01 Living ceiling 4", parent: null })).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isCeilingObject({ name: "SFCEILING_test", parent: null })).toBe(true);
  });
});
