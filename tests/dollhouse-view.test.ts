import { describe, expect, it } from "vitest";
import { importBlenderScene } from "../src/import/blender";
import { computeDollhouseFrame } from "../src/renderer/live3d/dollhouse-view";
import sceneJson from "./fixtures/blender/appartement.scene.json";

describe("computeDollhouseFrame", () => {
  it("frames the apartment from above with Blender look direction", () => {
    const ir = importBlenderScene(sceneJson);
    const frame = computeDollhouseFrame(ir, { aspect: 16 / 9, levelElevation: 0 });

    expect(frame.eye.y).toBeGreaterThan(frame.target.y);
    expect(frame.distance).toBeGreaterThan(400);
    expect(frame.fovDeg).toBeCloseTo(39.598, 1);
    expect(Math.abs(frame.target.x - 746)).toBeLessThan(10);
    expect(Math.abs(frame.target.z - 653)).toBeLessThan(10);
  });
});
