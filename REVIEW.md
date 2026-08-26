# Code review — sun position/trajectory and lighting/shadows

**Date:** 2026-08-26 · **Base commit:** `69d8ca0` · **Reviewed:** working tree (uncommitted sun/lighting work)

**Scope:** `src/sun.ts`, `src/sun-horizon.ts`, `src/solar.ts`, `src/sun-probes.ts`,
`src/sun-probe-envelope.ts`, `src/compass.ts`, `src/renderer/live3d/**`

> **Note:** the working tree was being edited while this review was written. Several
> findings were fixed mid-review and are marked **✅ Fixed in working tree** with what
> still remains. Line numbers are from the tree as of 11:15; re-check before acting.

**Test status:** 157/157 passing after #8/#10–#13/#16 fallout fixes.

## Summary

| #   | Finding                                                    | Severity | Status                                                       |
| --- | ---------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| 1   | `sunDirection` was a shear, not a rotation                 | High     | ✅ Fixed (`mirror_x` + tests + example yaml)                 |
| 2   | Glass/ceiling shadow-caster exclusion is a complete no-op  | High     | ✅ Fixed (`includeDescendants: false`, skip `__root__`)      |
| 3   | Babylon compass basis inverted — all bearings 180° off     | High     | ✅ Fixed (`screenUp = +forward_xz`; prefer `rightB` on ties) |
| 4   | `ambient: "off"` left a stale shadow near plane            | High     | ✅ Fixed in working tree                                     |
| 5   | `sun-horizon.ts` was inert; `elevation_m` did nothing      | Medium   | ✅ Fixed in working tree                                     |
| 6   | Debug sun-probe markers render in production               | Medium   | ✅ Fixed (gated on `opts.inspector`)                         |
| 7   | `sunHorizontalFacade` "south" test inverted at `north = 0` | Medium   | ✅ Fixed (dot vs geographic south)                           |
| 8   | Shadow map ~2.25× coarser than needed                      | Medium   | ✅ Fixed (`diag3 * 1.3`)                                     |
| 9   | `classifyExteriorWallName` matches "ext" as a substring    | Medium   | ✅ Fixed (word-boundary / en-dash only)                      |
| 10  | Dead twilight sky-fill in both renderers                   | Low      | ✅ Fixed (removed unreachable skyFill)                       |
| 11  | Dead dedupe branch in probe collection                     | Low      | ✅ Fixed (side-agnostic `probeSpatialKey`)                   |
| 12  | Probe raycasting runs on every HA state update             | Low      | ✅ Fixed (cache on quantized sun direction)                  |
| 13  | `rayOccludedTowardSun` mutates its argument                | Low      | ✅ Fixed (`normalizeToNew`)                                  |
| 14  | `waalbandijkFloorSunContext` lies about its return type    | Low      | ✅ Fixed (throw + per-floor elevation)                       |
| 15  | `solar.ts` location JSDoc contradicts the coordinates      | Low      | ✅ Fixed (Nijmegen JSDoc)                                    |
| 16  | Ceiling shadow-clone only reparents the root               | Latent   | ✅ Fixed (apply mat/layerMask to descendants)                |

Suggested order for what remains: none — review fallout closed.

---

## Sun position / trajectory

### 1. `sunDirection` was a shear, not a rotation — elevation corrupted for most `north` values

`src/sun.ts:186-213` · **✅ Fixed in working tree**

The original form left the east component un-rotated:

```ts
const x = geoEast - geoNorth * Math.sin(nRad);
const z = geoNorth * Math.cos(nRad);
```

That transform has determinant ≠ 1 and does not preserve the horizontal magnitude
(`cos(elevation)`). Because the code then normalized the full 3-vector, the lost
horizontal length was silently converted into **elevation**.

Measured before the fix, with `elevation = 20°` in every case:

| azimuth | north | rendered elevation |
| ------- | ----- | ------------------ |
| 45°     | 90    | **90.0°** (zenith) |
| 225°    | 90    | **90.0°**          |
| 135°    | 270   | **90.0°**          |
| 45°     | 45    | 33.9°              |
| 135°    | 45    | 15.6°              |

At `north = ±90` with a diagonal azimuth the horizontal component collapsed to exactly
zero and the sun snapped straight overhead. `render.north` accepts any finite number
(`src/config.ts:33-36`) and is documented as a general compass heading, so any building
not aligned to 0/180 got a wrong sun.

The root cause was that `north` did double duty as *rotation* and *handedness flip*: only
`north ∈ {0, 180}` gave a correct elevation, and at 180 the transform was a **reflection**,
which happened to be right for the bundled asset only because the Blender export is
Y-mirrored (`-blender.y`). The conflict was visible in-code — `sun.ts` asserted
"Render +X stays geographic east" while `compass.ts:geographicNorthRenderDir` defined north
as a proper rotation `(−sin n, cos n)`. No orthonormal frame satisfies both at `n = 0` and
`n = 180`.

**The fix taken** (correct): orthonormal rotation, with the mirror split out into an
explicit `render.mirror_x` flag.

```ts
let x = geoEast * cosN - geoNorth * sinN;
const z = geoEast * sinN + geoNorth * cosN;
if (mirrorX) { x = -x; }
```

`mirror_x` is plumbed through `src/types.ts:102`, `src/config.ts:38-40`,
`src/card.ts:779`, `src/sun.ts:117-134/186-213/227-241/291-300`, `dev/playground-config.ts:34`.

**Remaining:**

- Worth adding more regression coverage for elevation round-trip across north/azimuth
  (already partially covered in `tests/sun.test.ts`).
- `examples/ground-floor.yaml` and `dev/playground-config.ts` both use `north: 180` +
  `mirror_x: true`.

### 3. Babylon compass basis is inverted — every bearing is 180° off

`src/renderer/live3d/babylon-scene.ts` · **✅ Fixed**

Was:

```ts
let screenUp = new Vector3(-forward.x, 0, -forward.z);
```

Now `screenUp = +forward_xz`. Auto-winding prefers `rightB` on ties (verified behavior).
A 180° basis flip preserves `sun − north`, so winding pick alone cannot fix a wrong
`screenUp` sign.

### 7. `sunHorizontalFacade`'s "south" test is inverted at the default `north = 0`

`src/sun.ts:130` · **Open**

```ts
if (d.z > 0.25) { return "south"; }
```

`sunDirection` returns the *toward-sun* vector. At `north = 0`, plan `+Z` is geographic
north, so a due-south sun gives `z ≈ −1` → returns `"other"`, while a due-*north* sun gives
`z ≈ +1` → returns `"south"`. The east/west branches use `d.x` and are geographic; only the
south branch assumes `north = 180`.

The branch is only correct at `north = 180`, which is the sole value the tests exercise
(`tests/sun-day-cycle.test.ts`). Should be `d.z < -0.25`, or the signature/doc should state
the function is `north: 180`-only.

Note this function has **no production caller** — it is referenced only from
`tests/sun-day-cycle.test.ts`. Consider deleting it rather than fixing it.

### 5. `sun-horizon.ts` was inert and `elevation_m` did nothing

`src/sun-horizon.ts` · **✅ Fixed in working tree**

Previously `localHorizonElevationDeg` returned `0` unconditionally and
`effectiveSunElevation` returned its input unchanged, so `render.elevation_m: 32` —
validated in `config.ts`, set in `examples/ground-floor.yaml:26` and
`dev/playground-config.ts` — had **zero effect on rendering**. `observerHeightM` was
exported but never called.

Now `localHorizonElevationDeg` computes real horizon dip from observer height
(`acos(R / (R + h))`) and `effectiveSunElevation` subtracts it. `tests/sun-horizon.test.ts`
still asserts the old open-horizon behavior and fails (counted in #1's 8).

### 14. `waalbandijkFloorSunContext` lies about its return type

`src/sun-horizon.ts` · **Open**

```ts
export function waalbandijkFloorSunContext(floorLevel = 10): FloorSunContext {
  return resolveFloorSunContext({ … })!;
}
```

`resolveFloorSunContext` returns `undefined` for `floorLevel < 1`, so
`waalbandijkFloorSunContext(0)` hands the caller `undefined` typed as `FloorSunContext` and
the next property access throws.

Separately, `elevationM` is pinned to `WAALBANDIJK_ELEVATION_M` (32 m) regardless of the
`floorLevel` argument — so `waalbandijkFloorSunContext(1)` claims level-10 height.
`tests/sun.test.ts` does exactly that when comparing floor 1 vs floor 10. This is now
load-bearing given #5 made `elevationM` actually affect output.

### 15. `solar.ts` location JSDoc contradicts the coordinates

`src/solar.ts:102-107` · **✅ Coords fixed — JSDoc stale**

Coordinates were corrected from Amsterdam (`52.362, 4.904`) to Nijmegen
(`51.845, 5.863`), but the JSDoc one line above still reads
*"Waalbandijk 469, Amsterdam (Floorplanner reference location)"* and now contradicts the
inline comment directly beneath it. `tests/solar.test.ts` still asserts the
Amsterdam-derived reference pose and fails.

The Meeus/SunCalc port itself is correct: azimuth's `+540 % 360` properly converts
SunCalc's south-based angle to HA's north-based one, and ΔT is correctly applied to
`sunCoords` but not to sidereal time.

---

## Lighting / shadows

### 2. Glass and ceiling shadow-caster exclusion is a complete no-op — every mesh casts

`src/renderer/live3d/babylon-scene.ts` · **✅ Fixed**

Root cause: `loaded.meshes[0]` is `__root__`, and `addShadowCaster` defaults to
`includeDescendants = true`, so the first iteration registered every mesh (including
glass). Later `continue` for glass never removed them.

Fix: skip `__root__`, register via `listSunShadowCasterMeshes`, and call
`addShadowCaster(mesh, false)`. Regression in `tests/babylon-gltf-scene.test.ts`.

### 4. `ambient: "off"` left a stale shadow near plane

`src/renderer/live3d/babylon-scene.ts:394-404` · **✅ Fixed in working tree**

The disabled branch previously reset `sunLight.direction` and `position` to a hardcoded
close-in pose but left `shadowMinZ`/`shadowMaxZ` from the last live sun update. Babylon
uses whatever was last written
(`@babylonjs/core/Lights/directionalLight.pure.js:177` — `shadowMinZ !== undefined ? … : activeCamera.minZ`),
and with `autoUpdateExtends = false` / `autoCalcShadowZBounds = false` nothing recomputes them.

For the bundled scene (plan 1524 × 1635 cm, diagonal 2235 cm), a live sun update left
`shadowMinZ ≈ 1453 cm` while the plan center sat at depth ≈ 1215 cm along the static light
axis — in front of the near plane, so roughly the near half of the building dropped out of
the shadow map. It worked on the first frame only because the properties were still
`undefined`.

The branch now sets `position`, `shadowFrustumSize`, `shadowMinZ` and `shadowMaxZ`
consistently from a normalized `idleTowardSun`.

### 8. Shadow map is ~2.25× coarser than it needs to be

`src/renderer/live3d/babylon-scene.ts` · **✅ Fixed**

Frustum is now `diag3 * 1.3` (was `max(span, diag3) * 2.5`). Dead pre-load
`planDiagonal * 3` assignment removed.

### 6. Debug sun-probe markers render in production

`src/renderer/live3d/babylon-scene.ts` · **✅ Fixed** (gated on `opts.inspector`)

### 10. Dead twilight sky-fill in both renderers

Babylon + Three · **✅ Fixed** — removed unreachable `skyFill` (`!sunOn && elev > 8`).

### 11. Dead dedupe branch in probe collection

`probeSpatialKey` · **✅ Fixed** — side dropped from the key so exterior wins over interior
in the same facade cell.

### 9. `classifyExteriorWallName` matches "ext" as a substring

`src/sun-probes.ts` · **✅ Fixed** (word-boundary / en-dash only)

### 12. Probe raycasting runs on every HA state update

`babylon-scene.ts` · **✅ Fixed** — `resolveSunProbes` caches on quantized sun direction.

### 13. `rayOccludedTowardSun` mutates its argument

`babylon-sun-probes.ts` · **✅ Fixed** — uses `normalizeToNew()`.

### 16. Ceiling shadow-clone only reparents the root

`babylon-ceilings.ts` · **✅ Fixed** — material + `LIVE3D_CEILING_LAYER` applied to clone
descendants (`_primitive*` children).

---

## Minor

- `babylon-scene.ts` — `ShadowGenerator.ForceGLSL = true` is a static global set only on
  the WebGPU path; it persists across engine swaps within a page.

---

## Verified-correct (no action)

Checked and found sound — recorded so these are not re-litigated:

- **`src/solar.ts` Meeus/SunCalc port** — azimuth convention conversion (`+540 % 360`),
  ΔT applied to `sunCoords` but correctly *not* to sidereal time, and `astroRefraction` all
  match the reference implementation.
- **Shadow depth range** — `[0.65, 2.35] × shadowSpan` comfortably covers the building's
  ±0.5 × shadowSpan extent along the light axis.
- **Shadow frustum height at low sun** — needed ~205 cm at 3° elevation vs ~2813 cm
  half-extent available. No clipping.
- **Probe occlusion against disabled ceilings** — `scene.pickWithRay` with a predicate
  bypasses Babylon's `isEnabled`/`isVisible`/`isPickable` checks
  (`@babylonjs/core/Culling/ray.core.js:696-702`), so the `setEnabled(false)` ceiling meshes
  **do** still occlude sun probes as `isOpaqueOccluder` intends. (My first read of this was
  wrong — the predicate path is the exception, not the rule.)
- **Ceiling shadow-clone material flags** — `disableColorWrite` with depth write retained,
  and `layerMask` correctly excluded from the dollhouse camera via
  `applyCeilingLayerMaskToCamera`. Sound at the root level; see #16 for descendants.
- **Plan/mesh alignment on the Z axis** — mesh Z centroids match plan Y for every room
  (living plan 249–895 / mesh 435–788; office plan 1350–917 / mesh 1350–883), so
  `planToRender` aligns with the GLB under `useRightHandedSystem = true`.
