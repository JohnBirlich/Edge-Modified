#!/usr/bin/env bash
# build-app.sh — native Windows DESKTOP APP bundle:
#   EdgeControlCenterApp.exe  (GUI launcher: own window, tray, no console)
#   ecc-engine.exe            (Node SEA engine, hidden, spawned by launcher)
#
# Toolchain (all installable in a sandbox, no Windows required):
#   * pip install ziglang            → zig cc (C → x86_64-windows-gnu, mingw CRT bundled)
#   * npm i resedit                  → pure-JS PE resource editor (icon + version info)
#   * node.exe 22.x from npm registry (node-win-x64) + Node SEA + postject
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
ZIG="${ZIG:-python3 -m ziglang}"
STAGE="$(mktemp -d)"

echo "[1/6] GUI launcher (Win32 C → PE, subsystem:windows)"
"$ZIG" cc -target x86_64-windows-gnu -municode -O2 \
  "$ROOT/launcher/edge-launcher.c" -o "$STAGE/EdgeControlCenterApp.exe" \
  -luser32 -lgdi32 -lshell32 -lws2_32 -Wl,--subsystem,windows

echo "[2/6] Icon + version resources (resedit)"
mkdir -p "$STAGE/resedit" && cd "$STAGE/resedit"
npm init -y >/dev/null 2>&1 && npm i resedit --silent >/dev/null 2>&1
node - <<EOF
const fs = require('fs');
const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit');
const p = '$STAGE/EdgeControlCenterApp.exe';
const exe = NtExecutable.from(fs.readFileSync(p));
const res = NtExecutableResource.from(exe);
const ico = Data.IconFile.from(fs.readFileSync('$ROOT/appico.ico'));
Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map(i => i.data));
const vi = Resource.VersionInfo.createEmpty();
const S = (k, v) => vi.setStringValue({ lang: 1033, codePage: 1200 }, k, v);
S('ProductName', 'Edge Control Center');
S('FileDescription', 'EDGE Control Center - ARDOR GAMING Edge 3327 desktop app');
S('FileVersion', '1.0.0.0'); S('ProductVersion', '1.0.0.0');
S('CompanyName', 'hasberd / ARDOR GAMING mod');
S('LegalCopyright', '(c) 2026 hasberd');
S('OriginalFilename', 'EdgeControlCenterApp.exe');
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
fs.writeFileSync(p, Buffer.from(exe.generate()));
console.log('resources embedded');
EOF

echo "[3/6] SEA blob (engine entry)"
cd "$ROOT/control-center/sea"
node --experimental-sea-config sea-config.json

echo "[4/6] Engine: node.exe (win-x64) from npm + blob injection"
NODE_VER="$(node --version | sed 's/^v//')"
mkdir -p "$STAGE/engine" && cd "$STAGE/engine"
npm pack "node-win-x64@$NODE_VER" --silent >/dev/null
tar xzf "node-win-x64-$NODE_VER.tgz"
cp package/bin/node.exe "$STAGE/ecc-engine.exe"
npx -y postject@1.0.0-alpha.6 "$STAGE/ecc-engine.exe" NODE_SEA_BLOB \
  "$ROOT/control-center/sea/sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite

echo "[5/6] Assemble bundle"
mkdir -p "$STAGE/bundle"
cp "$STAGE/EdgeControlCenterApp.exe" "$STAGE/ecc-engine.exe" "$STAGE/bundle/"
cp -r "$ROOT/control-center/lib" "$ROOT/control-center/public" "$STAGE/bundle/"
mkdir -p "$STAGE/bundle/app" && cp "$ROOT/control-center/server.js" "$STAGE/bundle/app/"
cp "$ROOT/Cfg.ini" "$ROOT/VERSION.json" "$ROOT/appico.ico" "$STAGE/bundle/"
cp "$ROOT/installer/README.win.txt" "$STAGE/bundle/README.txt"
cat > "$STAGE/bundle/Start-ECC.cmd" <<'EOF'
@echo off
title Edge Control Center (fallback, browser mode)
where node >nul 2>nul
if %errorlevel%==0 (
  start "" http://127.0.0.1:3327/
  node "%~dp0app\server.js"
) else (
  echo Node.js not found. Install Node.js LTS from https://nodejs.org
  pause
)
EOF

echo "[6/6] Zip → $OUT"
mkdir -p "$OUT"
cd "$STAGE/bundle"
rm -f "$OUT/EdgeControlCenter-1.0.0-win64-APP.zip"
zip -qr "$OUT/EdgeControlCenter-1.0.0-win64-APP.zip" \
  EdgeControlCenterApp.exe ecc-engine.exe app appico.ico Cfg.ini VERSION.json README.txt Start-ECC.cmd
echo "✓ $OUT/EdgeControlCenter-1.0.0-win64-APP.zip"
echo "  PE check: launcher must be subsystem 2 (GUI); engine blob marker present."
