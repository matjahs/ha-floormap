#!/usr/bin/env bash
# Compare TypeScript 7 (native tsc) vs TS 6 shim (tsc6) on this repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUNS="${1:-5}"
TSC7="${ROOT}/node_modules/.bin/tsc"
TSC6="${ROOT}/node_modules/.bin/tsc6"

time_one() {
  /usr/bin/time -p "$@" 2>&1 | awk '/^real/ { print $2; exit }'
}

avg_real() {
  local total=0
  local i t
  for ((i = 1; i <= RUNS; i++)); do
    t=$(time_one "$@")
    total=$(awk -v a="$total" -v b="$t" 'BEGIN { print a + b }')
  done
  awk -v sum="$total" -v n="$RUNS" 'BEGIN { printf "%.2f", sum / n }'
}

FILES=$(find src tests dev -name '*.ts' | wc -l | tr -d ' ')
LINES=$(find src tests dev -name '*.ts' -print0 | xargs -0 wc -l | tail -1 | awk '{print $1}')

echo "ha-floormap typecheck benchmark (${RUNS} runs, --noEmit, --incremental false)"
echo "  files: ${FILES}   lines: ${LINES}"
echo ""

rm -f tsconfig.tsbuildinfo .tsbuildinfo 2>/dev/null || true

TS7_AVG=$(avg_real "$TSC7" --noEmit --incremental false)
TS6_AVG=$(avg_real "$TSC6" --noEmit --incremental false)
RATIO=$(awk -v a="$TS6_AVG" -v b="$TS7_AVG" 'BEGIN { if (b > 0) printf "%.1f", a / b; else print "?" }')

echo "  TS 7 (tsc):  ${TS7_AVG}s avg"
echo "  TS 6 (tsc6): ${TS6_AVG}s avg"
echo "  speedup:     ${RATIO}x"
echo ""
echo "Note: npm run build is dominated by Vite (~18s), not tsc (~${TS7_AVG}s)."
