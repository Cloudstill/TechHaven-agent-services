#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-}"
RUN_USER="${2:-${SUDO_USER:-}}"
SERVICE_NAME="techhaven-agent-gateway.service"

if [[ -z "$ROOT" || -z "$RUN_USER" ]]; then
  echo "Usage: sudo $0 <absolute-deploy-root-without-spaces> <run-user>" >&2
  exit 2
fi
if [[ "$EUID" -ne 0 ]]; then
  echo "This one-time installer must run as root (use sudo)." >&2
  exit 1
fi
if [[ "$ROOT" != /* || "$ROOT" == "/" || "$ROOT" == *[[:space:]]* ]]; then
  echo "Deploy root must be a non-root absolute path without spaces: $ROOT" >&2
  exit 2
fi
if ! id "$RUN_USER" >/dev/null 2>&1; then
  echo "Unknown service user: $RUN_USER" >&2
  exit 2
fi

CURRENT="$ROOT/current/services/techhaven-gateway"
ENTRY="$CURRENT/dist/index.js"
ENV_FILE="$ROOT/shared/gateway.env"
MANAGER="$ROOT/current/scripts/agent-gateway-service.sh"
NODE_BIN="$(command -v node)"
RUN_GROUP="$(id -gn "$RUN_USER")"

[[ -f "$ENTRY" ]] || { echo "Deploy a release before installing systemd: $ENTRY is missing" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Missing server-only environment file: $ENV_FILE" >&2; exit 1; }
chmod 600 "$ENV_FILE"
chown "$RUN_USER:$RUN_GROUP" "$ENV_FILE"

# Stop the no-root fallback if it was used before systemd was installed.
if [[ -x "$MANAGER" && -f "$ROOT/shared/gateway.pid" ]]; then
  sudo -u "$RUN_USER" "$MANAGER" stop "$ROOT"
fi

UNIT_TMP="$(mktemp)"
trap 'rm -f "$UNIT_TMP"' EXIT
cat > "$UNIT_TMP" <<EOF
[Unit]
Description=TechHaven Agent Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$CURRENT
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $ENTRY
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF

install -m 0644 "$UNIT_TMP" "/etc/systemd/system/$SERVICE_NAME"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME"
