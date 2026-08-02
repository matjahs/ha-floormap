# Waalbandijk 2024 generated examples

Primary model: `waalbandijk_2024.sh3d`

## Files

- `waalbandijk_2024.yaml` — Lovelace card config (also copied to `examples/ground-floor.yaml`)
- `waalbandijk_2024.manifest.json` — IR + render paths for `/local/floorplan/manifest.json`
- `tests/fixtures/sweethome3d/waalbandijk_2024.ir.json` — IR snapshot for tests

## Install onto Home Assistant

1. Build and install the card (`npm run build`, copy `dist/` to `/config/www/`).
2. Copy `waalbandijk_2024.manifest.json` to `/config/www/floorplan/manifest.json`.
3. Keep overlays under `/local/lighting_renders/` (paths in the manifest already use that prefix).
4. Add a dashboard card using `waalbandijk_2024.yaml` (or edit in UI).

## Re-import after model changes

```bash
node dist/cli/import.js import /path/to/waalbandijk_2024.sh3d --out /tmp/floorplan \
  --base /path/to/selected_lights_on_SunFlow.png \
  --passes-dir /path/to/lighting_renders
```

Then regenerate this folder (or merge fixture IDs carefully so entity mapping stays stable).
