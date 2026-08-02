#!/usr/bin/env bash
# Convert a render folder to WebP/AVIF and optionally pre-bake (overlay - base) difference passes.
set -euo pipefail

ROOT="${1:-.}"
WIDTH="${WIDTH:-1440}"
HEIGHT="${HEIGHT:-810}"
BASE_NAME="${BASE_NAME:-selected_lights_on_SunFlow.png}"
BAKE_DIFF="${BAKE_DIFF:-0}"

cd "$ROOT"
BASE="$BASE_NAME"

if [[ ! -f "$BASE" ]]; then
  echo "Base image $BASE not found in $ROOT" >&2
  exit 1
fi

have_cwebp=0
have_avif=0
have_magick=0
command -v cwebp >/dev/null && have_cwebp=1
command -v avifenc >/dev/null && have_avif=1
command -v magick >/dev/null && have_magick=1

scale() {
  local src="$1" dst="$2"
  if [[ "$have_magick" -eq 1 ]]; then
    magick "$src" -resize "${WIDTH}x${HEIGHT}" "$dst"
  else
    cp "$src" "$dst"
  fi
}

mkdir -p optimized
scale "$BASE" "optimized/base.png"

if [[ "$have_cwebp" -eq 1 ]]; then
  cwebp -q 85 "optimized/base.png" -o "optimized/base.webp"
fi
if [[ "$have_avif" -eq 1 ]]; then
  avifenc --min 0 --max 63 "optimized/base.png" "optimized/base.avif" || true
fi

shopt -s nullglob
for f in *.png; do
  [[ "$f" == "$BASE" ]] && continue
  stem="${f%.png}"
  if [[ "$BAKE_DIFF" -eq 1 && "$have_magick" -eq 1 ]]; then
    magick "$f" "$BASE" -compose minus_src -composite -resize "${WIDTH}x${HEIGHT}" "optimized/${stem}_diff.png"
  else
    scale "$f" "optimized/${stem}.png"
  fi
  if [[ "$have_cwebp" -eq 1 ]]; then
    src="optimized/${stem}.png"
    [[ -f "optimized/${stem}_diff.png" ]] && src="optimized/${stem}_diff.png"
    cwebp -q 85 "$src" -o "optimized/${stem}.webp"
  fi
done

echo "Wrote optimized assets under $ROOT/optimized"
echo "Update manifest paths to optimized/*.webp (differenceBaked: $BAKE_DIFF)"
