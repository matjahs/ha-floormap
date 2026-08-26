# Code review — sun position/trajectory and lighting/shadows

Round 2 done; round-2 follow-ups (N1–N3) fixed on `fix/sun-review-n1-n3`.

## All 16 findings resolved

`tsc --noEmit` clean, **157/157 tests** (up from 151). I re-verified the four highest-impact fixes empirically against `appartement.glb` rather than reading the diff:

| Fix | Evidence |
|---|---|
| `sunDirection` rotation | elevation round-trips to **9.9e-14°**, azimuth to **0°** across 7,776 `(north, mirror, azimuth, elevation)` combinations |
| Glass shadow casters | **680 casters, 0 glass, 0 ceilings** (was 701 including all 19 panes) |
| Compass basis | `rightB` matches the real camera basis to **0.00°** on all four cardinals |
| Frustum 2.5×→1.3× | **1.43 cm/texel**; full-day solstice sweep needs 2238 cm vs 2932 configured — **31% margin**, no clipping |

Also confirmed the horizon dip is physically sane now that it's actually wired (32 m → 0.18°, vs textbook 0.166°), and that `mirror_x` reached `examples/ground-floor.yaml` — the example/playground divergence from round 1 is closed.

## Round-2 follow-ups (from the fixes themselves)

**N1 — ceiling shadow-clone · ✅ Fixed.** `addShadowCaster(caster, true)` for ceiling clones so `_primitive*` children (already given the shadow-only material) enter the shadow `renderList`. Scene casters stay `includeDescendants: false` to avoid glass.

**N2 — `sunHorizontalFacade` · ✅ Deleted.** Zero production callers; east/west were still raw `d.x`. Day-cycle tests assert `sunDirection` components directly.

**N3 — probe dedupe · ✅ Fixed.** Same-cell tie-break prefers **interior** over exterior (room-sun question). Faces of one wall sit ~24 cm apart vs an 80 cm cell.
