import { describe, expect, it } from "vitest";
import {
  geographicNorthRenderDir,
  horizontalDirToScreenDeg,
  PLAN_NORTH_RENDER_DIR,
} from "../src/compass";

describe("compass bearings", () => {
  it("maps plan +Y to geographic north when config is 0", () => {
    const geo = geographicNorthRenderDir(0);
    expect(geo.x).toBeCloseTo(0, 5);
    expect(geo.z).toBeCloseTo(1, 5);
  });

  it("offsets geographic north when plan +Y points south (north 180)", () => {
    const geo = geographicNorthRenderDir(180);
    expect(geo.x).toBeCloseTo(0, 5);
    expect(geo.z).toBeCloseTo(-1, 5);
  });

  it("projects +Z as screen-up when camera looks straight down", () => {
    // Camera basis: right = +X, up = -Z (typical top-down), forward = -Y
    const basis = [1, 0, 0, 0, 0, -1];
    const deg = horizontalDirToScreenDeg(PLAN_NORTH_RENDER_DIR.x, PLAN_NORTH_RENDER_DIR.z, basis);
    expect(deg).toBeCloseTo(180, 0);
  });
});
