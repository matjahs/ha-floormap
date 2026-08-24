import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  glassLambertOpacity,
  isGlassGltfMaterial,
  isTransparentGlassMaterial,
  simplifyGltfMaterial,
} from "../src/renderer/live3d/gltf-materials";

describe("gltf glass materials", () => {
  it("detects transmission-based glass from glTF", () => {
    const mat = new THREE.MeshPhysicalMaterial({ transmission: 1, transparent: false });
    mat.name = "SteelBlack";
    expect(isGlassGltfMaterial(mat.name, "door_glass_100_1", mat)).toBe(true);
  });

  it("maps transmission glass to transparent Lambert", () => {
    const mat = new THREE.MeshPhysicalMaterial({
      transmission: 1,
      transparent: false,
      color: 0x8899aa,
    });
    mat.name = "Glass.001";
    const out = simplifyGltfMaterial(mat, THREE, "V_75_window_2x1_with_slidersobj_9064_4");
    expect(out.transparent).toBe(true);
    expect(out.opacity).toBeGreaterThan(0.15);
    expect(out.opacity).toBeLessThan(0.5);
    expect(out.depthWrite).toBe(false);
    expect(isTransparentGlassMaterial(out)).toBe(true);
  });

  it("keeps opaque wall materials solid", () => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    mat.name = "WallPaint";
    const out = simplifyGltfMaterial(mat, THREE, "wall_45");
    expect(out.transparent).toBe(false);
    expect(out.opacity).toBe(1);
  });

  it("uses lower opacity for full transmission", () => {
    const mat = new THREE.MeshPhysicalMaterial({ transmission: 1 });
    expect(glassLambertOpacity(mat)).toBeCloseTo(0.25, 2);
  });
});
