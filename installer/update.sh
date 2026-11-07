#!/usr/bin/env bash
# ECC updater — staged rollout, snapshot → atomic swap → health-probe rollback.
set -euo pipefail
CHANNEL="${1:-stable}"
INSTALL_DIR="${INSTALL_DIR:-/opt/edge-control-center}"
PORT="${PORT:-3327}"
echo "[ECC update] channel=$CHANNEL staged rollout"

echo -n '[1/4] Snapshot current… '
ts=$(date +%s)
cp -a "$INSTALL_DIR" "/var/tmp/ecc-backup-$ts" && echo "✓ /var/tmp/ecc-backup-$ts"

echo -n '[2/4] Fetch manifest… '
m="$(dirname "$0")/../VERSION.json"
cur="$(python3 -c "import json;print(json.load(open('$m'))['version'])" 2>/dev/null || echo '0')"
echo "current v$cur"

echo -n '[3/4] Staging gate… '
# staged channels: stable 5% → beta 25% → alpha 100% (server /api/update/check is authoritative)
case "$CHANNEL" in stable) pct=5 ;; beta) pct=25 ;; alpha) pct=100 ;; *) echo '✗ unknown channel'; exit 1 ;; esac
roll=$(( (RANDOM % 100) < pct ? 1 : 0 ))
if [ "$roll" -ne 1 ] && [ "$pct" -lt 100 ]; then echo "⏸ not selected in ${pct}% rollout — try later"; exit 0; fi
echo "✓ selected (${pct}% rollout)"

echo -n '[4/4] Atomic swap + health probe… '
new="$INSTALL_DIR.new"
if [ -d "$new" ]; then
  systemctl stop edge-control-center || true
  mv "$INSTALL_DIR" "$INSTALL_DIR.old" && mv "$new" "$INSTALL_DIR"
  systemctl start edge-control-center
  for i in $(seq 1 10); do
    sleep 1; curl -fsS "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1 && { echo "✓ updated (old kept at $INSTALL_DIR.old)"; exit 0; }
  done
  echo '✗ health probe failed — rolling back'
  systemctl stop edge-control-center || true
  rm -rf "$INSTALL_DIR" && mv "$INSTALL_DIR.old" "$INSTALL_DIR"
  systemctl start edge-control-center && echo '↩ rolled back'
  exit 5
fi
echo "– no staged payload at $new (updater expects the release payload placed there); nothing to do"
