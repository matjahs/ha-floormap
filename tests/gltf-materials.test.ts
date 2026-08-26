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

  it("does not treat Glasscherm window frames as glass", () => {
    const mat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    mat.name = "KozijnAntraciet";
    expect(isGlassGltfMaterial(mat.name, "P055 Glasscherm balkon 1510x2409 - 1 delig", mat)).toBe(false);
  });

  it("detects kozijn pane material KozijnGlas as glass", () => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    mat.name = "KozijnGlas";
    expect(isGlassGltfMaterial(mat.name, "P000 Kozijn 1536x2429 westgevel - 2 delig draai-vast", mat)).toBe(true);
  });

  it("still detects legacy flltgrey pane material as glass", () => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    mat.name = "flltgrey";
    expect(isGlassGltfMaterial(mat.name, "P000 Kozijn 1536x2429 westgevel - 2 delig draai-vast", mat)).toBe(true);
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

describe("babylon WebGPU unlit keep rules", () => {
  it("keeps glass unlit and leaves opaque walls lit", async () => {
    const { shouldKeepUnlitOnWebGpu } = await import("../src/renderer/live3d/babylon-gltf-materials");
    expect(shouldKeepUnlitOnWebGpu("KozijnGlas", "P000 Kozijn")).toBe(true);
    expect(shouldKeepUnlitOnWebGpu("flltgrey", "window")).toBe(true);
    expect(shouldKeepUnlitOnWebGpu("WallWhite", "wall_45")).toBe(false);
    expect(shouldKeepUnlitOnWebGpu("WallExteriorBrick", "wall_0 buitenblad")).toBe(false);
    expect(shouldKeepUnlitOnWebGpu("WallTopBlack", "wall_0")).toBe(false);
    expect(shouldKeepUnlitOnWebGpu("Ceiling", "ceiling_0", true)).toBe(true);
  });
});
