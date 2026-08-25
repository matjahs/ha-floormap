#!/usr/bin/env bash
# Export ~/git/personal/appartement/appartement9.blend → playground live3d assets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLEND="${APPARTEMENT_BLEND:-$HOME/git/personal/appartement/appartement9.blend}"
SCRIPT="${APPARTEMENT_EXPORT:-$HOME/git/personal/appartement/export_live3d.py}"
OUT="$ROOT/dev/public/local/floorplan"
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"

if [[ ! -x "$BLENDER" ]]; then
  echo "Blender not found at $BLENDER" >&2
  exit 1
fi
if [[ ! -f "$BLEND" ]]; then
  echo "Missing blend file: $BLEND" >&2
  exit 1
fi

mkdir -p "$OUT"
echo "Exporting $BLEND → $OUT"
unset PYTHONHOME PYTHONPATH
"$BLENDER" -b "$BLEND" -P "$SCRIPT" -- "$OUT"
ls -lh "$OUT/appartement.glb" "$OUT/appartement.scene.json"
