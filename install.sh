#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"

if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
  echo "Bun is required. Install it with:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

# Create a client API key on first install.
if [ ! -f "$DIR/.env" ]; then
  if command -v openssl >/dev/null 2>&1; then
    KEY="sk-oc-$(openssl rand -hex 24)"
  else
    KEY="sk-oc-$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')"
  fi
  printf 'PROXY_API_KEY=%s\n' "$KEY" > "$DIR/.env"
  chmod 600 "$DIR/.env"
  echo "Generated API key: $KEY"
fi

sed "s|__DIR__|$DIR|g" "$DIR/deploy/opencode-free-proxy.service" \
  > "$UNIT_DIR/opencode-free-proxy.service"

systemctl --user daemon-reload
systemctl --user enable --now opencode-free-proxy.service

echo "Installed and started."
echo "API key:      $(grep -oP '(?<=PROXY_API_KEY=).*' "$DIR/.env")"
echo "Check status: systemctl --user status opencode-free-proxy"
echo "Health:       curl http://127.0.0.1:8787/health"
