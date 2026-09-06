#!/usr/bin/env bash
set -euo pipefail

SERVICE="${1:-}"
shift || true
ACTION="${1:-}"
ROOT="${2:-}"
case "$SERVICE" in
  gateway) SERVICE_DIR=techhaven-gateway; DISPLAY_NAME="Agent Gateway"; PORT_VAR=TECHHAVEN_GATEWAY_PORT; DEFAULT_PORT=3091 ;;
  bff) SERVICE_DIR=techhaven-bff; DISPLAY_NAME=BFF; PORT_VAR=TECHHAVEN_BFF_PORT; DEFAULT_PORT=3092 ;;
  *) echo "Unknown service: $SERVICE" >&2; exit 2 ;;
esac

if [[ -z "$ACTION" || -z "$ROOT" ]]; then
  echo "Usage: $0 <start|stop|restart|status|health> <absolute-deploy-root>" >&2
  exit 2
fi

if [[ "$ROOT" != /* || "$ROOT" == "/" ]]; then
  echo "Deploy root must be a non-root absolute path: $ROOT" >&2
  exit 2
fi

CURRENT="$ROOT/current/services/$SERVICE_DIR"
SHARED="$ROOT/shared"
ENV_FILE="$SHARED/$SERVICE.env"
PID_FILE="$SHARED/$SERVICE.pid"
LOG_FILE="$SHARED/$SERVICE.log"
ENTRY="$CURRENT/dist/index.js"

mkdir -p "$SHARED"

read_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s' "$pid"
}

is_expected_process() {
  local pid="$1"
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  local command_line
  command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
  [[ "$command_line" == *"$ENTRY"* ]]
}

start_service() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing server-only environment file: $ENV_FILE" >&2
    echo "Create it from services/$SERVICE_DIR/.env.example and chmod 600 it." >&2
    exit 1
  fi
  if [[ ! -f "$ENTRY" ]]; then
    echo "Missing deployed Gateway entry: $ENTRY" >&2
    exit 1
  fi
  local existing
  if existing="$(read_pid)" && kill -0 "$existing" 2>/dev/null; then
    if is_expected_process "$existing"; then
      echo "${DISPLAY_NAME} is already running (pid=$existing)"
      return
    fi
    echo "Refusing to reuse pid $existing: it is not this ${DISPLAY_NAME}" >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  case "$SERVICE" in
    gateway) : "${TECHHAVEN_GATEWAY_TOKEN:?TECHHAVEN_GATEWAY_TOKEN is required in $ENV_FILE}" ;;
    bff) : "${TECHHAVEN_API_BASE:?TECHHAVEN_API_BASE is required in $ENV_FILE}" ;;
  esac

  local node_bin
  node_bin="$(command -v node)"
  cd "$CURRENT"
  nohup "$node_bin" "$ENTRY" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" > "$PID_FILE"
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null || ! is_expected_process "$pid"; then
    echo "${DISPLAY_NAME} failed to stay running; inspect $LOG_FILE" >&2
    exit 1
  fi
  echo "${DISPLAY_NAME} started (pid=$pid)"
}

stop_service() {
  local pid
  if ! pid="$(read_pid)"; then
    echo "${DISPLAY_NAME} is not running (no valid pid file)"
    return
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "Removed stale pid file"
    return
  fi
  if ! is_expected_process "$pid"; then
    echo "Refusing to stop pid $pid: it is not this ${DISPLAY_NAME}" >&2
    exit 1
  fi
  kill "$pid"
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "${DISPLAY_NAME} stopped"
      return
    fi
    sleep 0.5
  done
  echo "${DISPLAY_NAME} did not stop within 10 seconds" >&2
  exit 1
}

service_port() {
  local port="$DEFAULT_PORT"
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
    port="${!PORT_VAR:-$DEFAULT_PORT}"
  fi
  printf '%s' "$port"
}

health_service() {
  local port
  port="$(service_port)"
  curl --fail --silent --show-error "http://127.0.0.1:$port/healthz"
  printf '\n'
}

case "$ACTION" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    start_service
    ;;
  status)
    pid="$(read_pid || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && is_expected_process "$pid"; then
      echo "${DISPLAY_NAME} is running (pid=$pid)"
    else
      echo "${DISPLAY_NAME} is not running"
      exit 1
    fi
    ;;
  health)
    health_service
    ;;
  *)
    echo "Unknown action: $ACTION" >&2
    exit 2
    ;;
esac
