#!/usr/bin/env bash
# build-singlefile.sh — ONE self-contained EdgeControlCenter-2.0.0.exe:
#   [node.exe][SEA blob: v2 loader][VFS payload: app/** + Cfg.ini + VERSION.json]
# Download → run → browser opens. Data lives in %APPDATA%\EdgeControlCenter.
# The SAME mechanics are smoke-tested on the host platform (linux) first.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
NODE_VER="$(node --version | sed 's/^v//')"
STAGE="$(mktemp -d)"

echo "[1/6] Bundle layout (payload root == future EXE dir)"
B="$STAGE/bundle"; mkdir -p "$B/app"
cp -r "$ROOT/control-center/lib" "$ROOT/control-center/public" "$B/app/"
cp "$ROOT/control-center/server.js" "$B/app/"
cp "$ROOT/Cfg.ini" "$ROOT/VERSION.json" "$B/"
PAYLOAD_ARGS=()
while IFS= read -r f; do PAYLOAD_ARGS+=("$f"); done < <(find "$B" -type f | sort)

echo "[2/6] SEA blob (loader v2 with embedded VFS)"
cd "$ROOT/control-center/sea"
node --experimental-sea-config sea-config.json

echo "[3/6] Host-platform smoke test (same mechanics, \$(node))"
TESTDIR="$STAGE/test" && mkdir -p "$TESTDIR"
cp "$(command -v node)" "$TESTDIR/ecc-test"
npx -y postject@1.0.0-alpha.6 "$TESTDIR/ecc-test" NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite >/dev/null
python3 "$ROOT/tools/make-payload.py" "$TESTDIR/ecc-test" "$TESTDIR/ecc-test" \
  --root "$B" "${PAYLOAD_ARGS[@]}" >/dev/null
PORT=3399 ECC_DATA="$TESTDIR/data" "$TESTDIR/ecc-test" >"$TESTDIR/log" 2>&1 &
TPID=$!
ok=0
for i in $(seq 1 15); do
  sleep 1
  if curl -fsS "http://127.0.0.1:3399/api/state" >/dev/null 2>&1; then ok=1; break; fi
done
if [ "$ok" -ne 1 ]; then echo "✗ smoke test failed:"; cat "$TESTDIR/log"; kill $TPID 2>/dev/null; exit 5; fi
curl -fsS "http://127.0.0.1:3399/" >/dev/null            # UI (embedded)
curl -fsS "http://127.0.0.1:3399/css/app.css" >/dev/null # static (embedded)
curl -fsS "http://127.0.0.1:3399/api/device/config" >/dev/null  # Cfg.ini (embedded)
kill $TPID 2>/dev/null || true
echo "✓ smoke test passed (state/UI/static/config served from embedded payload)"

echo "[4/6] Windows exe: node.exe v$NODE_VER (npm registry)"
mkdir -p "$STAGE/win" && cd "$STAGE/win"
npm pack "node-win-x64@$NODE_VER" --silent >/dev/null
tar xzf "node-win-x64-$NODE_VER.tgz"
cp package/bin/node.exe "$STAGE/EdgeControlCenter.exe"

echo "[5/6] Inject blob + append payload"
cd "$ROOT/control-center/sea"
npx -y postject@1.0.0-alpha.6 "$STAGE/EdgeControlCenter.exe" NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite >/dev/null
python3 "$ROOT/tools/make-payload.py" "$STAGE/EdgeControlCenter.exe" "$STAGE/EdgeControlCenter.exe" \
  --root "$B" "${PAYLOAD_ARGS[@]}"

echo "[6/6] Ship"
mkdir -p "$OUT"
cp "$STAGE/EdgeControlCenter.exe" "$OUT/EdgeControlCenter-2.0.0.exe"
echo "✓ $OUT/EdgeControlCenter-2.0.0.exe (single file)"
echo "  Data: %APPDATA%\\EdgeControlCenter · PORT=… · ECC_NO_BROWSER=1"
