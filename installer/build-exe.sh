#!/usr/bin/env bash
# build-exe.sh — assemble the portable Windows EXE bundle (Node SEA).
# Reproducible: node.exe is pulled from the npm registry (node-win-x64@<ver>),
# the SEA blob is built from control-center/sea/sea-bootstrap.js.
#
# Requirements: Node >= 22 (with --experimental-sea-config), network to
# registry.npmjs.org, npx postject.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_VER="$(node --version | sed 's/^v//')"          # keep EXE runtime == build runtime
OUT="${1:-$ROOT/dist}"
STAGE="$(mktemp -d)"

echo "[1/6] App layout → $STAGE/bundle"
mkdir -p "$STAGE/bundle/app"
cp -r "$ROOT/control-center/lib" "$ROOT/control-center/public" "$STAGE/bundle/app/"
cp "$ROOT/control-center/server.js" "$STAGE/bundle/app/"
cp "$ROOT/Cfg.ini" "$ROOT/VERSION.json" "$STAGE/bundle/"

echo "[2/6] SEA blob (bootstrap + loader)"
cd "$ROOT/control-center/sea"
node --experimental-sea-config sea-config.json

echo "[3/6] node.exe v$NODE_VER (win-x64) from npm registry"
mkdir -p "$STAGE/win"
cd "$STAGE/win"
npm pack "node-win-x64@$NODE_VER" --silent
tar xzf "node-win-x64-$NODE_VER.tgz"
cp package/bin/node.exe "$STAGE/bundle/EdgeControlCenter.exe"

echo "[4/6] Inject blob (postject)"
cd "$ROOT/control-center/sea"
npx -y postject@1.0.0-alpha.6 "$STAGE/bundle/EdgeControlCenter.exe" \
  NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite

echo "[5/6] README + fallback launcher"
cat > "$STAGE/bundle/Start-ECC.cmd" <<'EOF'
@echo off
title Edge Control Center (fallback)
where node >nul 2>nul
if %errorlevel%==0 (
  node "%~dp0app\server.js"
) else (
  echo Node.js not found. Install Node.js LTS from https://nodejs.org
  pause
)
EOF
[ -f "$ROOT/installer/README.win.txt" ] && cp "$ROOT/installer/README.win.txt" "$STAGE/bundle/README.txt"

echo "[6/6] Zip"
mkdir -p "$OUT"
cd "$STAGE/bundle"
zip -qr "$OUT/EdgeControlCenter-1.0.0-win64.zip" EdgeControlCenter.exe README.txt Start-ECC.cmd Cfg.ini VERSION.json app
echo "✓ $OUT/EdgeControlCenter-1.0.0-win64.zip"
echo "  (Linux smoke-test the same blob first: inject into \$(which node), run from bundle dir, GET /api/state)"
