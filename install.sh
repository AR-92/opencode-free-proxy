#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"

sed "s|__DIR__|$DIR|g" "$DIR/deploy/opencode-free-proxy.service" \
  > "$UNIT_DIR/opencode-free-proxy.service"

systemctl --user daemon-reload
systemctl --user enable --now opencode-free-proxy.service

echo "Installed and started."
echo "Check status: systemctl --user status opencode-free-proxy"
echo "Health:       curl http://127.0.0.1:8787/health"
