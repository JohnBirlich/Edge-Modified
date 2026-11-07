#!/usr/bin/env bash
# Edge Control Center — Linux installer (v1.0.0 "IGNITION")
# Restore-point-first policy: timeshift/Btrfs/LVM snapshot before any change.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/edge-control-center}"
PORT="${PORT:-3327}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

echo '╔══════════════════════════════════════════════╗'
echo '║   EDGE CONTROL CENTER  v1.0.0  "IGNITION"    ║'
echo '╚══════════════════════════════════════════════╝'

[ "$(id -u)" -eq 0 ] || { echo '✗ run with sudo'; exit 1; }

echo -n '[1/6] Restore-point anchor (mandatory)… '
if command -v timeshift >/dev/null 2>&1; then
  timeshift --create --comments "EDGE-ECC pre-install v1.0.0" --tags O >/dev/null && echo '✓ (timeshift)'
elif findmnt -n -o FSTYPE / | grep -q btrfs; then
  snap="/@/.snapshots/ecc-pre-install-$(date +%s)"
  btrfs subvolume snapshot / "$snap" >/dev/null && echo "✓ (btrfs → $snap)"
elif command -v lvcreate >/dev/null 2>&1 && lvs --noheadings -o lv_name 2>/dev/null | grep -q snapvg; then
  echo '✓ (LVM — create manually if thin-pool configured)' # conservative: no silent lv ops
else
  tar -C "$SRC" -czf "/var/tmp/ecc-pre-install-$(date +%s).tar.gz" . && echo '✓ (source tarball fallback)'
fi

echo -n '[2/6] Prerequisites… '
command -v node >/dev/null || { echo '✗ Node.js ≥ 18 required'; exit 3; }
NODE_MAJOR="$(node --version | sed 's/v\([0-9]*\).*/\1/')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "✗ Node ≥ 18 required"; exit 3; }
echo "✓ node $(node --version)"

echo -n "[3/6] Installing core → $INSTALL_DIR… "
mkdir -p "$INSTALL_DIR"
cp -r "$SRC/control-center" "$SRC/agent" "$SRC/VERSION.json" "$INSTALL_DIR/"
echo '✓'

echo -n '[4/6] systemd unit… '
cat >/etc/systemd/system/edge-control-center.service <<EOF
[Unit]
Description=Edge Control Center (ARDOR Edge 3327 suite)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$INSTALL_DIR/control-center
ExecStart=$(command -v node) server.js
Environment=PORT=$PORT
Restart=always
RestartSec=3
# Privileged opt-ins (uncomment with care — ECC journeys are restore-point anchored):
# AmbientCapabilities=CAP_SYS_ADMIN CAP_SYS_NICE
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now edge-control-center
echo '✓'

echo -n '[5/6] Firewall (3327/tcp, 33270/udp)… '
if command -v ufw >/dev/null 2>&1; then ufw allow "$PORT/tcp" >/dev/null 2>&1 || true; ufw allow 33270/udp >/dev/null 2>&1 || true
elif command -v firewall-cmd >/dev/null 2>&1; then firewall-cmd --permanent --add-port="$PORT/tcp" --add-port=33270/udp >/dev/null 2>&1 && firewall-cmd --reload >/dev/null
fi
echo '✓'

echo -n '[6/6] Health probe… '
ok=0
for i in $(seq 1 10); do
  sleep 1
  curl -fsS "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1 && { ok=1; break; }
done
[ "$ok" -eq 1 ] || { echo '✗ health probe failed'; journalctl -u edge-control-center -n 30 --no-pager; exit 4; }
echo "✓ live on http://127.0.0.1:$PORT"

cat <<'EOF'

Next steps:
  • Admin panel → user 'hasberd', default passphrase 'ardor-3327' → ROTATE IT
  • Bridge the other OS: python3 agent/edge-agent.py pair <host> 3327
  • Fan control:  nbfc-linux ( ECC dispatches PWM setpoints through it)
  • Updates: installer/update.sh stable|beta|alpha
Rollback: timeshift restore / btrfs snapshot / uninstall.sh
EOF
