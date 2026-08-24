# Future: Babylon.js live3d backend

**Status: spike in progress.** The card uses **Lit** for the Lovelace shell. live3d supports **Three.js** (default) and an experimental **Babylon.js** backend via `render.engine: babylon` (playground default).

## Why Babylon was considered

- **Ceiling shadows:** Three.js `WebGLShadowMap` tests casters against the main camera layer mask. Hiding ceilings on a separate layer breaks sun occlusion. Babylon supports invisible shadow casters via `material.disableColorWrite` / `disableDepthWrite` plus `ShadowGenerator` without this limitation.
- **Lighting API:** Directional sun + shadow generator + point lights map cleanly to our `SunShading` and HA fixture model.
- **Optional WebGPU later:** Babylon can target WebGPU with WebGL fallback; not required for HA tablets.

## Why it is deferred

- Working HA card with a large live3d scene module (~1.2k lines in `src/renderer/live3d/scene.ts`).
- Migration is a full rewrite of the live3d chunk, not a drop-in swap.
- Bundle size similar to Three (~800kb–1.5mb gzipped lazy chunk).
- Current stack fixes (Lambert materials, sun-only shadows, ceiling `colorWrite` hack) address immediate blockers.

## Migration sketch (when revisited)

1. **Keep** Lit card (`src/card.ts`), editor, baked compositor, import pipeline, `src/sun.ts`.
2. **Replace** `src/renderer/live3d/scene.ts` with Babylon `Engine` + `Scene`.
3. **Preserve** `Live3dHandle` interface so `card.ts` changes stay minimal.
4. **Dependencies:** `@babylonjs/core`, `@babylonjs/loaders`; remove `three`.
5. **GLB:** `SceneLoader.ImportMeshAsync`, scale ×100, tag `sfCeiling_*` meshes.
6. **Ceilings:** shadow-only material + `shadowGenerator.addShadowCaster(ceilingMesh)`.
7. **HA fixtures:** `PointLight` per sample, **no shadows** (avoid WebGL texture limits).
8. **Sun:** `DirectionalLight` + `ShadowGenerator` driven by `setSun(SunShading)`.

## Out of scope for that migration

- React / `@react-three/fiber` (Lovelace needs a custom element, not a React root).
- Replacing Lit or the baked WebGL2 compositor.
- Dual Three+Babylon runtime unless explicitly needed for A/B testing.

## References

- [Babylon shadow-only mesh (forum)](https://forum.babylonjs.com/t/hide-the-mesh-but-still-display-the-shadow/49341)
- Sidecar ceiling metadata: `ceilings.namePrefix` in `appartement.scene.json`
- Export script: `appartement/export_live3d.py`
