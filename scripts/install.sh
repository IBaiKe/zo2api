#!/usr/bin/env bash
# ============================================================================
#  install.sh  ─  zo2api 一键部署脚本（POSIX：Linux / macOS / WSL / Git-Bash）
# ----------------------------------------------------------------------------
#  幂等 5 步：
#    1. 检查 docker + docker compose
#    2. 复制 .env.example -> .env（若不存在）
#    3. 生成 PROXY_API_KEY（若为空）
#    4. docker compose up -d --build
#    5. 轮询 /health 最多 30s，打印 base URL 与 key fingerprint
#
#  特性：
#    - set -euo pipefail，错误立即中止
#    - 颜色输出（可由 NO_COLOR=1 关闭）
#    - 重复执行不会覆盖已有 .env 或重新生成 key
# ============================================================================

set -euo pipefail

# ---- 颜色（NO_COLOR 标准遵守） ---------------------------------------------
if [[ -z "${NO_COLOR:-}" ]] && [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'
  C_CYN=$'\033[36m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_RED= ; C_GRN= ; C_YLW= ; C_CYN= ; C_DIM= ; C_RST=
fi

log()  { printf '%s[zo2api]%s %s\n' "$C_CYN" "$C_RST" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GRN" "$C_RST" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YLW" "$C_RST" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$C_RED" "$*" "$C_RST" >&2; exit 1; }

# ---- 切到脚本所在仓库根 -----------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ============================================================================
#  Step 1: 检查 docker + docker compose
# ============================================================================
log "Step 1/5: 检查 docker 与 docker compose"

command -v docker >/dev/null 2>&1 || die "未找到 docker。安装见 https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || die "docker daemon 未运行，请先启动 Docker Desktop / dockerd"

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
  warn "使用 legacy docker-compose v1，建议升级到 docker compose v2"
else
  die "未找到 docker compose。安装见 https://docs.docker.com/compose/install/"
fi
ok "docker + compose 可用"

# ============================================================================
#  Step 2: 准备 .env
# ============================================================================
log "Step 2/5: 准备 .env"

if [[ ! -f .env ]]; then
  [[ -f .env.example ]] || die ".env.example 缺失，仓库不完整"
  cp .env.example .env
  chmod 600 .env
  ok "已从 .env.example 复制到 .env"
else
  ok ".env 已存在，保留"
fi

# ============================================================================
#  Step 3: 生成 PROXY_API_KEY（若为空）
# ============================================================================
log "Step 3/5: 检查 PROXY_API_KEY"

CURRENT_KEY="$(grep -E '^PROXY_API_KEY=' .env | sed 's/^PROXY_API_KEY=//' || true)"

KEY_CREATED=0
if [[ -z "$CURRENT_KEY" ]]; then
  # openssl 优先，回退到 /dev/urandom
  if command -v openssl >/dev/null 2>&1; then
    HEX="$(openssl rand -hex 12)"
  else
    HEX="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  NEW_KEY="sk-ant-proxy-${HEX}"

  # 跨平台 sed -i（macOS BSD sed 需要 '' 参数）
  if sed --version >/dev/null 2>&1; then
    sed -i "s|^PROXY_API_KEY=.*|PROXY_API_KEY=${NEW_KEY}|" .env
  else
    sed -i '' "s|^PROXY_API_KEY=.*|PROXY_API_KEY=${NEW_KEY}|" .env
  fi
  CURRENT_KEY="$NEW_KEY"
  KEY_CREATED=1
  ok "生成新 PROXY_API_KEY"
else
  ok "PROXY_API_KEY 已存在，保留"
fi

# ============================================================================
#  Step 4: docker compose up
# ============================================================================
log "Step 4/5: 构建并启动容器"
$COMPOSE up -d --build
ok "容器已启动"

# ============================================================================
#  Step 5: 健康轮询
# ============================================================================
log "Step 5/5: 等待 /health 就绪"

HOST_PORT="$(grep -E '^HOST_PORT=' .env | sed 's/^HOST_PORT=//' || true)"
HOST_PORT="${HOST_PORT:-3000}"
HEALTH_URL="http://localhost:${HOST_PORT}/health"

READY=0
for i in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "$READY" -ne 1 ]]; then
  warn "30s 内未就绪，最近日志："
  $COMPOSE logs --tail 30 zo2api || true
  die "服务未通过 /health，请排查"
fi
ok "/health OK"

# ============================================================================
#  打印接入信息
# ============================================================================
echo
printf '%s==========================================%s\n' "$C_CYN" "$C_RST"
printf '%s  zo2api is up%s\n' "$C_GRN" "$C_RST"
printf '%s==========================================%s\n' "$C_CYN" "$C_RST"
printf '  Base URL : %shttp://localhost:%s%s\n' "$C_CYN" "$HOST_PORT" "$C_RST"
printf '  Endpoint : %shttp://localhost:%s/v1/messages%s\n' "$C_CYN" "$HOST_PORT" "$C_RST"
if [[ "$KEY_CREATED" -eq 1 ]]; then
  printf '  API Key  : %s%s%s   %s(刚生成，请妥善保管)%s\n' "$C_YLW" "$CURRENT_KEY" "$C_RST" "$C_DIM" "$C_RST"
else
  FP="${CURRENT_KEY:0:6}...${CURRENT_KEY: -4}"
  printf '  API Key  : %s%s%s   %s(fingerprint；全值在 .env)%s\n' "$C_YLW" "$FP" "$C_RST" "$C_DIM" "$C_RST"
fi
printf '%s==========================================%s\n' "$C_CYN" "$C_RST"
echo
echo "实时日志:  $COMPOSE logs -f zo2api"
echo "停止服务:  $COMPOSE down"
echo
