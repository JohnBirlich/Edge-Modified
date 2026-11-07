#!/usr/bin/env bash
# build-native.sh — ONE self-contained NATIVE Windows exe (v2.1.0 "NATIVE"):
#   [EdgeControlCenter.exe][engine blob][u64 len][ECCNATIVE1]
# The GUI is pure Win32/GDI (no browser). First run extracts the engine to
# %LOCALAPPDATA%\EdgeControlCenter and starts it hidden.
#
# Toolchain: zig (pip ziglang) + resedit (npm) + node SEA + postject + node.exe
# from the npm registry. The engine keeps its own embedded VFS (app/**+Cfg.ini).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
ZIG="${ZIG:-/tmp/venv/bin/python -m ziglang}"
NODE_VER="$(node --version | sed 's/^v//')"
STAGE="$(mktemp -d)"

echo "[1/6] Native GUI (Win32 C → PE, subsystem:windows)"
$ZIG cc -target x86_64-windows-gnu -municode -O2 \
  "$ROOT/launcher/edge-native.c" -o "$STAGE/app.exe" \
  -luser32 -lgdi32 -lshell32 -lws2_32 -lcomctl32 -lshfolder -Wl,--subsystem,windows

echo "[2/6] Icon + version resources (resedit)"
mkdir -p "$STAGE/resedit" && cd "$STAGE/resedit"
[ -d node_modules/resedit ] || { npm init -y >/dev/null 2>&1; npm i resedit --silent >/dev/null 2>&1; }
node - "$STAGE/app.exe" "$ROOT/appico.ico" <<'EOF'
const fs = require('fs');
const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit');
const [p, icoPath] = process.argv.slice(2);
const exe = NtExecutable.from(fs.readFileSync(p));
const res = NtExecutableResource.from(exe);
const ico = Data.IconFile.from(fs.readFileSync(icoPath));
Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map(i => i.data));
const vi = Resource.VersionInfo.createEmpty();
const S = (k, v) => vi.setStringValue({ lang: 1033, codePage: 1200 }, k, v);
S('ProductName', 'Edge Control Center');
S('FileDescription', 'EDGE Control Center - native Win32 app for ARDOR GAMING Edge 3327 (v2.1.1)');
S('FileVersion', '2.1.2.0'); S('ProductVersion', '2.1.2.0');
S('CompanyName', 'hasberd / ARDOR GAMING mod');
S('LegalCopyright', '(c) 2026 hasberd');
S('OriginalFilename', 'EdgeControlCenter.exe');
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
fs.writeFileSync(p, Buffer.from(exe.generate()));
console.log('resources embedded');
EOF

echo "[3/6] SEA blob (engine loader v2, embedded VFS)"
cd "$ROOT/control-center/sea"
node --experimental-sea-config sea-config.json

echo "[4/6] Engine: node.exe v$NODE_VER (npm) + blob + app VFS payload"
B="$STAGE/bundle"; mkdir -p "$B/app"
cp -r "$ROOT/control-center/lib" "$ROOT/control-center/public" "$B/app/"
cp "$ROOT/control-center/server.js" "$B/app/"
cp "$ROOT/Cfg.ini" "$ROOT/VERSION.json" "$B/"
mkdir -p "$STAGE/engine" && cd "$STAGE/engine"
npm pack "node-win-x64@$NODE_VER" --silent >/dev/null
tar xzf "node-win-x64-$NODE_VER.tgz"
cp package/bin/node.exe "$STAGE/ecc-engine.exe"
npx -y postject@1.0.0-alpha.6 "$STAGE/ecc-engine.exe" NODE_SEA_BLOB "$ROOT/control-center/sea/sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite >/dev/null
python3 "$ROOT/tools/make-payload.py" "$STAGE/ecc-engine.exe" "$STAGE/ecc-engine.exe" \
  --root "$B" $(find "$B" -type f | sort)

echo "[5/6] Native app + engine blob → single exe"
python3 "$ROOT/tools/make-payload.py" "$STAGE/app.exe" "$STAGE/EdgeControlCenter-2.1.2.exe" \
  --native "$STAGE/ecc-engine.exe"

echo "[6/6] Ship"
mkdir -p "$OUT"
cp "$STAGE/EdgeControlCenter-2.1.2.exe" "$OUT/"
echo "✓ $OUT/EdgeControlCenter-2.1.2.exe"
echo "  Layout: [native GUI][engine blob][u64 len][ECCNATIVE1]"
echo "  First run extracts engine → %LOCALAPPDATA%\\EdgeControlCenter\\ecc-engine.exe (hidden)"
