#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${1:-}"
ROOT="${2:-}"

if [[ -z "$ARCHIVE" || -z "$ROOT" ]]; then
  echo "Usage: $0 <release-archive> <absolute-deploy-root>" >&2
  exit 2
fi
if [[ "$ROOT" != /* || "$ROOT" == "/" || "$ROOT" == *".."* || "$ROOT" =~ [[:space:]] ]]; then
  echo "Deploy root must be a non-root absolute path without spaces or '..': $ROOT" >&2
  exit 2
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo "Release archive does not exist: $ARCHIVE" >&2
  exit 1
fi

cleanup_uploads() {
  rm -f -- "$ARCHIVE"
  if [[ "$0" == /tmp/techhaven-deploy-*.sh ]]; then
    rm -f -- "$0"
  fi
}
trap cleanup_uploads EXIT

for command_name in node npm tar curl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

while IFS= read -r entry; do
  case "$entry" in
    /*|../*|*/../*|*/..)
      echo "Unsafe path in release archive: $entry" >&2
      exit 1
      ;;
  esac
done < <(tar -tzf "$ARCHIVE")

RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RELEASES="$ROOT/releases"
SHARED="$ROOT/shared"
RELEASE="$RELEASES/$RELEASE_ID"
CURRENT="$ROOT/current"
ENV_FILE="$SHARED/gateway.env"
PREVIOUS=""

mkdir -p "$RELEASES" "$SHARED" "$RELEASE"
if [[ -L "$CURRENT" ]]; then
  PREVIOUS="$(readlink -f "$CURRENT" || true)"
  case "$PREVIOUS" in
    "$RELEASES"/*) ;;
    *) PREVIOUS="" ;;
  esac
fi

tar -xzf "$ARCHIVE" -C "$RELEASE"
[[ -f "$RELEASE/services/techhaven-gateway/dist/index.js" ]] || { echo "Release is missing Gateway dist/index.js" >&2; exit 1; }
[[ -f "$RELEASE/services/techhaven-bff/dist/index.js" ]] || { echo "Release is missing BFF dist/index.js" >&2; exit 1; }
[[ -f "$RELEASE/services/techhaven-agent-bridge/dist/index.js" ]] || { echo "Release is missing Bridge dist/index.js" >&2; exit 1; }
[[ -f "$RELEASE/services/techhaven-mcp/dist/index.js" ]] || { echo "Release is missing MCP dist/index.js" >&2; exit 1; }
[[ -f "$RELEASE/contracts/package.json" ]] || { echo "Release is missing contracts/package.json" >&2; exit 1; }

for service in techhaven-gateway techhaven-bff techhaven-agent-bridge techhaven-mcp; do
  cd "$RELEASE/services/$service"
  npm ci --omit=dev
done

if [[ ! -f "$ENV_FILE" ]]; then
  TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(36).toString('base64url'))")"
  AI_MASTER_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"
  umask 077
  cat > "$ENV_FILE" <<EOF
TECHHAVEN_GATEWAY_TOKEN=$TOKEN
TECHHAVEN_GATEWAY_PORT=3091
# 只监听回环：Gateway 由同机 Nginx 反向代理，不直接暴露公网
TECHHAVEN_GATEWAY_HOST=127.0.0.1
TECHHAVEN_ENGINE_DRIVER=mock
TECHHAVEN_GATEWAY_STORE=jsonl
TECHHAVEN_GATEWAY_DATA_DIR=$SHARED/data
TECHHAVEN_PROPOSALS_FILE=$SHARED/proposals.jsonl
# AI 配置主密钥：仅此一次生成；丢失=已存密钥不可解。请立即抄写备份到安全位置
TECHHAVEN_AI_CONFIG_MASTER_KEY=$AI_MASTER_KEY
EOF
  chmod 600 "$ENV_FILE"
  echo "Created secure mock configuration: $ENV_FILE"
  echo "IMPORTANT: back up TECHHAVEN_AI_CONFIG_MASTER_KEY now — losing it makes stored AI keys unrecoverable."
fi

BFF_ENV_FILE="$SHARED/bff.env"
if [[ ! -f "$BFF_ENV_FILE" ]]; then
  umask 077
  cat > "$BFF_ENV_FILE" <<EOF
TECHHAVEN_BFF_HOST=127.0.0.1
TECHHAVEN_BFF_PORT=3092
# 产品后端 base：BFF 用它调用 /api/v1/user/info 校验会话。请按实际环境确认
TECHHAVEN_API_BASE=https://techhaven.website:8080
TECHHAVEN_BFF_VERIFY_TIMEOUT_MS=3000
TECHHAVEN_BFF_CACHE_TTL_MS=60000
TECHHAVEN_BFF_CACHE_MAX_ENTRIES=5000
EOF
  chmod 600 "$BFF_ENV_FILE"
  echo "Created BFF configuration: $BFF_ENV_FILE"
  echo "ACTION REQUIRED: verify TECHHAVEN_API_BASE in $BFF_ENV_FILE points at your product backend."
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${TECHHAVEN_GATEWAY_TOKEN:?TECHHAVEN_GATEWAY_TOKEN is required in $ENV_FILE}"

if [[ "${TECHHAVEN_ENGINE_DRIVER:-mock}" == "dsh" ]]; then
  cd "$RELEASE/services/techhaven-gateway"
  npm install --no-save --omit=dev \
    @deepseek-ai/dsh@0.1.1-rc.2 \
    @deepseek-ai/dsh-sdk-client@0.1.1-rc.2
  node -e "Promise.all([import('@deepseek-ai/dsh'), import('@deepseek-ai/dsh-sdk-client')])"
fi

chmod +x "$RELEASE/scripts/agent-gateway-service.sh" "$RELEASE/scripts/install-agent-gateway-systemd.sh" "$RELEASE/scripts/bff-service.sh"
ln -sfn "$RELEASE" "$ROOT/current.next"
mv -Tf "$ROOT/current.next" "$CURRENT"

restart_gateway() {
  if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled techhaven-agent-gateway.service >/dev/null 2>&1; then
    sudo -n systemctl restart techhaven-agent-gateway.service
  else
    "$CURRENT/scripts/agent-gateway-service.sh" restart "$ROOT"
  fi
}

restart_bff() {
  "$CURRENT/scripts/bff-service.sh" restart "$ROOT"
}

wait_for_health() {
  local attempt=0
  until "$CURRENT/scripts/agent-gateway-service.sh" health "$ROOT" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [[ "$attempt" -ge 20 ]]; then
      return 1
    fi
    sleep 1
  done
}

wait_for_bff_health() {
  local attempt=0
  until "$CURRENT/scripts/bff-service.sh" health "$ROOT" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [[ "$attempt" -ge 20 ]]; then
      return 1
    fi
    sleep 1
  done
}

if ! restart_gateway || ! wait_for_health || ! restart_bff || ! wait_for_bff_health; then
  echo "Service failed health check; rolling back." >&2
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    ln -sfn "$PREVIOUS" "$ROOT/current.rollback"
    mv -Tf "$ROOT/current.rollback" "$CURRENT"
    restart_gateway || true
    wait_for_health || true
    restart_bff || true
    wait_for_bff_health || true
    echo "Restored previous release: $PREVIOUS" >&2
  else
    echo "No previous release is available for rollback." >&2
  fi
  tail -n 100 "$SHARED/gateway.log" "$SHARED/bff.log" 2>/dev/null || true
  exit 1
fi

ACTIVE="$(readlink -f "$CURRENT")"
mapfile -t OLD_RELEASES < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | tail -n +6 | cut -d' ' -f2-)
for old_release in "${OLD_RELEASES[@]:-}"; do
  case "$old_release" in
    "$RELEASES"/*)
      if [[ "$old_release" != "$ACTIVE" ]]; then
        rm -rf -- "$old_release"
      fi
      ;;
  esac
done

echo "TechHaven deployed successfully: $RELEASE_ID"
echo "Agent services root: $CURRENT/services"
echo "Gateway health: http://127.0.0.1:${TECHHAVEN_GATEWAY_PORT:-3091}/healthz"
