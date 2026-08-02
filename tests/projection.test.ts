import { describe, expect, it } from "vitest";
import {
  cameraEyeTarget,
  lookAt,
  planToRender,
  projectPoint,
  projectToPercent,
} from "../src/projection";
import type { CameraIR } from "../src/import/ir";

const cam: CameraIR = {
  id: "c1",
  kind: "camera",
  attribute: "storedCamera",
  lens: "PINHOLE",
  x: 0,
  y: 0,
  z: 100,
  yaw: 0,
  pitch: 0,
  fieldOfView: Math.PI / 3,
};

describe("projection", () => {
  it("maps plan to render Y-up", () => {
    expect(planToRender({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 3, z: 2 });
  });

  it("look-at with yaw=0 pitch=0 looks toward +Y plan (+Z render)", () => {
    const { eye, target } = cameraEyeTarget(cam);
    expect(eye).toEqual({ x: 0, y: 100, z: 0 });
    expect(target.z).toBeGreaterThan(eye.z);
    const V = lookAt(eye, target, { x: 0, y: 1, z: 0 });
    expect(V.m[15]).toBe(1);
  });

  it("projects a point along the view axis near image center", () => {
    const { target } = cameraEyeTarget(cam);
    // Point far along look direction in plan space: render Z increases with plan Y
    const along = { x: 0, y: 500, z: 100 };
    const uv = projectPoint(cam, along, { aspect: 16 / 9 });
    expect(uv.behind).toBe(false);
    expect(uv.u).toBeGreaterThan(0.4);
    expect(uv.u).toBeLessThan(0.6);
    expect(uv.v).toBeGreaterThan(0.35);
    expect(uv.v).toBeLessThan(0.65);
    void target;
  });

  it("returns percent markers matching HA top/left convention", () => {
    const pct = projectToPercent(cam, { x: 0, y: 500, z: 100 }, { aspect: 720 / 405 });
    expect(pct.left).toBeGreaterThan(0);
    expect(pct.left).toBeLessThan(100);
    expect(pct.top).toBeGreaterThan(0);
    expect(pct.top).toBeLessThan(100);
  });
});
