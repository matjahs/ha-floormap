# Waalbandijk 2024 generated examples

Primary model: `waalbandijk_2024.sh3d`

## Files

- `waalbandijk_2024.yaml` — live3d Lovelace card (also [`examples/ground-floor.yaml`](../ground-floor.yaml))
- `waalbandijk_2024.baked.yaml` / [`examples/baked-sunflow.yaml`](../baked-sunflow.yaml) — previous baked overlays path
- `waalbandijk_2024.manifest.json` — IR + render paths for `/local/floorplan/manifest.json`
- Deploy empty or edited `placements.json` to `/local/floorplan/placements.json` for pose overrides

## Install onto Home Assistant

1. Build and install the card (`npm run build`, copy `dist/` to `/config/www/`).
2. Copy `waalbandijk_2024.manifest.json` to `/config/www/floorplan/manifest.json`.
3. Add `placements.json` (start with `{}`) under `/config/www/floorplan/`.
4. Use live3d card YAML from `waalbandijk_2024.yaml` / `ground-floor.yaml`.
5. Optional: playground `Edit lights` → Export placements → copy to HA.

## Re-import after model changes

```bash
node dist/cli/import.js import /path/to/waalbandijk_2024.sh3d --out /tmp/floorplan \
  --base /path/to/selected_lights_on_SunFlow.png \
  --passes-dir /path/to/lighting_renders
```
