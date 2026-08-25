import { describe, expect, it } from "vitest";
import { GLTF_SCENE_SCALE } from "../src/renderer/live3d/babylon-gltf-scene";

describe("babylon gltf scene scale", () => {
  it("uses cm scale factor for Blender meter exports", () => {
    expect(GLTF_SCENE_SCALE).toBe(100);
  });
});
