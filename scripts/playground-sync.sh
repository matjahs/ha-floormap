#!/usr/bin/env bash
# Sync floorplan manifest + SunFlow overlays from HA into dev/public for offline playground use.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${HA_HOST:-root@homeassistant.local}"
DEST="$ROOT/dev/public/local"
mkdir -p "$DEST/floorplan" "$DEST/lighting_renders"

echo "Syncing from $HOST → $DEST"
scp -o BatchMode=yes -o ConnectTimeout=10 \
  "$HOST:/config/www/floorplan/manifest.json" \
  "$DEST/floorplan/manifest.json"

scp -o BatchMode=yes -o ConnectTimeout=10 \
  "$HOST:/config/www/lighting_renders/"*.png \
  "$DEST/lighting_renders/"

echo "Done."
ls -la "$DEST/floorplan" "$DEST/lighting_renders" | head -40
