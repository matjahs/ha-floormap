import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { FreeCamera, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import { Material } from "@babylonjs/core/Materials/material";
import { describe, expect, it } from "vitest";
import {
  isBabylonCeiling,
  isCeilingShadowCaster,
  LIVE3D_CEILING_LAYER,
  prepareShadowOnlyCeiling,
  shadowOnlyCeilingMaterialFlags,
} from "../src/renderer/live3d/babylon-ceilings";

describe("Babylon shadow-only ceilings", () => {
  it("matches sfCeiling_ meshes and parents", () => {
    expect(isBabylonCeiling({ name: "sfCeiling_Ceilings", parent: null })).toBe(true);
    expect(
      isBabylonCeiling({
        name: "RoomFace",
        parent: { name: "sfCeiling_Living", parent: null },
      }),
    ).toBe(true);
    expect(isBabylonCeiling({ name: "P131 L01 Living ceiling 4", parent: null })).toBe(false);
  });

  it("uses Roland-style invisible caster flags (color write off, depth on)", () => {
    const flags = shadowOnlyCeilingMaterialFlags();
    expect(flags.alpha).toBe(1);
    expect(flags.transparencyMode).toBe(Material.MATERIAL_OPAQUE);
    expect(flags.disableColorWrite).toBe(true);
    expect(flags.disableDepthWrite).toBe(false);
    expect(flags.backFaceCulling).toBe(false);
    expect(LIVE3D_CEILING_LAYER & 0x0fffffff).toBe(0);
  });

  it("hides the visible ceiling and leaves a shadow-only clone", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.activeCamera = new FreeCamera("c", new Vector3(0, 0, 0), scene);
    const visible = MeshBuilder.CreateGround("sfCeiling_ceiling", { width: 2, height: 2 }, scene);
    visible.receiveShadows = true;

    const caster = prepareShadowOnlyCeiling(visible);

    expect(visible.isEnabled()).toBe(false);
    expect(caster.isEnabled()).toBe(true);
    expect(isCeilingShadowCaster(caster)).toBe(true);
    expect(caster.material?.disableColorWrite).toBe(true);
    expect(caster.material?.disableDepthWrite).toBe(false);
    expect(caster.layerMask).toBe(LIVE3D_CEILING_LAYER);
    expect(caster.receiveShadows).toBe(false);
    expect(visible.receiveShadows).toBe(false);

    engine.dispose();
  });

  it("applies shadow-only material and layerMask to cloned descendants", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.activeCamera = new FreeCamera("c", new Vector3(0, 0, 0), scene);
    const parent = MeshBuilder.CreateBox("sfCeiling_multi", { size: 1 }, scene);
    const child = MeshBuilder.CreateBox("sfCeiling_multi_primitive0", { size: 0.5 }, scene);
    child.parent = parent;

    const caster = prepareShadowOnlyCeiling(parent);
    const casterChildren = caster.getChildMeshes();
    expect(casterChildren.length).toBeGreaterThanOrEqual(1);
    for (const node of [caster, ...casterChildren]) {
      expect(node.layerMask).toBe(LIVE3D_CEILING_LAYER);
      expect(node.material?.disableColorWrite).toBe(true);
      expect(node.receiveShadows).toBe(false);
    }

    engine.dispose();
  });
});
