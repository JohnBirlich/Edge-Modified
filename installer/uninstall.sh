#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="${INSTALL_DIR:-/opt/edge-control-center}"
[ "$(id -u)" -eq 0 ] || { echo 'run with sudo'; exit 1; }
systemctl disable --now edge-control-center 2>/dev/null || true
rm -f /etc/systemd/system/edge-control-center.service
systemctl daemon-reload
rm -rf "$INSTALL_DIR"
echo '✓ ECC removed (pre-install snapshot kept for rollback).'
