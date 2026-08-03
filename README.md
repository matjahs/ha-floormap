# Sunflow Floorplan Card

Home Assistant Lovelace card that replaces `picture-elements` floorplan lighting with
**additive, physically-plausible compositing** (and optional live 3D), generated from a
SweetHome3D model rather than hand-tuned YAML.

**License: MIT.** The SweetHome3D `Home.xml` parser is an independent implementation against
the published [DTD](https://www.sweethome3d.com/SweetHome3D.dtd). This project does **not**
depend on SweetHome3DJS (GPL).

*(Demo GIF placeholder: add a short clip of lights toggling on the floorplan here.)*

## Install

### HACS (recommended)

1. Add this repository as a custom repository (type: **Dashboard**), or wait for HACS default listing.
2. Install **Sunflow Floorplan Card**.
3. Add the resource if needed: `/hacsfiles/ha-floormap/sunflow-floorplan-card.js` (type: module).
4. Restart Home Assistant / refresh cache.

### Manual

1. Download **all** release assets: `sunflow-floorplan-card.js` **and** the `chunks/` folder
   (three.js is loaded only when `live3d` is enabled).
2. Copy them together under `/config/www/` (or HACS path) so relative imports resolve.
3. Add the resource: `/local/sunflow-floorplan-card.js` — type **JavaScript Module**.

This repository never writes to your HA `/config`. You copy assets yourself.

## Local playground (debug without HA)

Run the card in the browser with a mock `hass` and your SunFlow overlays / IR:

```bash
npm run playground:sync   # once: copy overlays + manifest from HA into dev/public
npm run playground         # http://localhost:5173
```

- Default playground mode is **live3d** with **Edit lights** enabled.
- Drag yellow handles, then **Export placements** → deploy `placements.json` to `/config/www/floorplan/`.
- Overlays load from `dev/public/local/…` when synced; otherwise Vite proxies `/local` to
  `HA_PROXY` (default `http://homeassistant.local:8123`).

## SweetHome3D export

1. Open your apartment in SweetHome3D **6+** and **Save** (ensures `Home.xml` inside the `.sh3d` ZIP).
2. Note the **stored camera** used for your SunFlow / photo renders (same pose for every pass).
3. Render passes (manual — see also `scripts/render-passes.mjs`):
   - Fixed exposure, identical camera.
   - **Base:** all lights off → `base.png`.
   - **Per fixture:** only that light on → `passes/<name>.png`.
4. Import:

```bash
npx sunflow-floorplan import ~/Home.sh3d \
  --out /path/to/www/floorplan \
  --base /path/to/base.png \
  --passes-dir /path/to/passes
```

Copy the output folder to `/config/www/floorplan/` on your HA host.

Optional optimize:

```bash
WIDTH=1440 HEIGHT=810 BAKE_DIFF=1 ./scripts/optimize-renders.sh /path/to/renders
```

## Floorplanner — what works / what does not

| Export | Supported | Lighting |
|--------|-----------|----------|
| 3D camera JPG/PNG (4K/8K) | Yes as **base plate** | Static plate only |
| DXF | Walls + room polylines → hotspots | No per-light model |
| SVG 2D plan | Room paths → hotspots | No per-light model |
| FML API | Stub behind `SUNFLOW_FML=1` | Not available without a real sample |
| Light & Scene panel | Unavailable in consumer accounts | — |

For Floorplanner-only projects: import DXF/SVG + drop a 3D camera export as base, then
**click to place fixtures** in the card editor and bind HA entities. Dynamic per-light
pools require SweetHome3D (or a hand-authored overlay pass set).

## Additive lighting model (`baked`)

```
Ci = max(0, overlay_i − base)     # light contribution
L  = linear(base) + Σ Ci · intensity_i · color_i
out = sRGB(tonemap(L · exposure))
```

Author overlays with the **same camera**, **fixed exposure**, **one light per pass**, and an
**ambient-only base**. Do not use `mix-blend-mode: screen` layers as the source of truth.

`live3d` builds extruded geometry from the IR and drives three.js punctual lights from HA
state (three.js is loaded only when `render.mode: live3d`).

## Config reference

```yaml
type: custom:sunflow-floorplan-card
title: Ground Floor
manifest: /local/floorplan/manifest.json
render:
  mode: baked            # baked | live3d
  tone_map: aces         # aces | reinhard | none
  exposure: 1.0
  gamma: 2.2
  transition: 400
  ambient: sun           # off | sun | sensor.xxx
floors:
  - level: ground
    camera: stored_1
    base_image: /local/lighting_renders/selected_lights_on_SunFlow.png
groups:
  living:
    entity: light.livingroom_group   # optional master for bulk toggle
    tap_action: { action: toggle }
    tap_area: [[40, 45], [70, 45], [70, 75], [40, 75]]  # stage % polygon
entities:
  fixture_dining_table:
    entity: light.livingroom_light_1
    group: living
    overlay: 1_Dining_Table_on_SunFlow.png
    tap_action: { action: toggle }   # also hold_action / double_tap_action
  fixture_kitchen_led:
    entity: light.kitchen_ledstrip_1
    group: kitchen
    segments:                        # LED bar ranges along strip 0..1
      - entity: light.kitchen_led_a
        start: 0
        end: 0.5
overrides:
  fixture_dining_table:
    gain: 1.2
    marker: [52, 58]     # optional nudge (left%, top%)
  fixture_kitchen_led:
    kind: strip
    position: [1.2, 0.1, 3.0]
    end: [2.8, 0.1, 3.0]
    samples: 8
```

See `examples/` for minimal, Waalbandijk ground floor (`examples/ground-floor.yaml` /
`examples/generated/`), and two-floor stubs. The generated Waalbandijk config is derived
from **`waalbandijk_2024.sh3d`** (stable fixture IDs + hand-placed markers).

With `edit_mode: true`, the card offers **Draw tap area** (pick a group chip, click the
stage to place polygon vertices, Finish).

### Floorplanner FML (live3d dollhouse)

Export from Floorplanner (project **Download** / ZIP includes `.fml`, or `*.json.fml`).
Point the card at the FML and a folder of furniture GLBs:

```yaml
fml: /local/floorplan/waalbandijk.fml.json
fml_assets: /local/floorplan/glb          # {refid}.glb + opening-{id}.glb
fml_glb_map: /local/floorplan/waalbandijk.glb-map.json  # optional refid→URL
```

live3d then uses FML walls/rooms/furniture meshes (textured GLBs) while keeping light
fixtures from the SweetHome3D `manifest` IR. DXF export is supported via the existing
importer; the ZIP package is FML + preview JPG (not a single scene GLB).
### Migration

```bash
node scripts/migrate-picture-elements.mjs examples/picture-elements-waalbandijk.yaml
```

Dead entities `light.kitchen_ledstrip_2` and `light.livingroom_light_2` are listed as TODOs
and omitted from the live `entities` map.

## IR schema

Versioned JSON (`schemaVersion: 2`) documented in code: `src/import/ir.ts` (accepts 1|2).
Adapters: SweetHome3D (primary; long multi-source lights become `kind: strip`), DXF, SVG,
glTF/OBJ (geometry + manual fixtures), FML (stub).

## Development

```bash
npm install
npm test
npm run build
```

Outputs `dist/sunflow-floorplan-card.js`.

### Projection regression

Drop your real model at `tests/fixtures/sweethome3d/Home.waalbandijk.xml` or `Home.sh3d`.
Tests compare projected fixture UVs to `tests/fixtures/markers-expected.json` within 2%.

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Card missing | Resource URL type = module; hard refresh |
| White / washed image | Lower `exposure`; ensure overlays are single-light passes |
| Markers wrong | Re-import `.sh3d`; verify stored camera; use `overrides.marker` nudge |
| `Home.xml` missing | Re-save in SweetHome3D 6+ |
| WebGL unavailable | CSS fallback activates (incorrect blending) |
| Entities badge | Fix dead IDs; unavailable entities stay dimmed |

## Companion upload integration (stretch)

A future Python custom integration could accept `.sh3d` uploads into `/config/www/floorplan`.
Design only for now — CLI + editor export cover the flow without HA writes from this repo.

## Trade-offs: baked vs live3d

| | baked | live3d |
|--|-------|--------|
| Look | Matches your SunFlow plates | Approximate PBR scene |
| Cost | N overlay textures | three.js + geometry |
| Authoring | Render passes | Model import |
| Blending | Exact additive in linear space | Native lights |
