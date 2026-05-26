#!/usr/bin/env bash
# ============================================================================
#  deploy/zo/install.sh  ─  zo.computer 一键部署脚本
# ----------------------------------------------------------------------------
#  [INPUT]:    依赖 git / node>=18 / npm；从 GitHub IBaiKe/zo2api dev-zo
#              分支拉源码；交互式读取 PROXY_API_KEY 与 provider keys
#  [OUTPUT]:   写入 <target>/.env (mode 0600)；
#              写入 <target>/manifest.json (mode 0600，.gitignore 排除)；
#              stdout 打印 @register-user-service 话术供粘贴到 Zo AI
#  [POS]:      deploy/zo/ 的主入口；与 README.md 配对（README 是文档、本文件是执行体）；
#              被 package.json scripts.zo:install 调用
#  [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
#
#  在 zo.computer 内置终端中运行。完成 6 件事：
#    1. 环境自检（非 zo.computer 仅警告，继续执行）
#    2. 目标目录就绪（默认 /home/workspace/anthropic-proxy）
#    3. 拉源码 git clone -b dev-zo
#    4. npm ci --omit=dev
#    5. 交互式生成 .env（含 PROXY_API_KEY 自动生成 + provider key 隐藏录入）
#    6. 打印 register-user-service 话术 + 保存 manifest.json
#
#  之后用户在 Zo AI 对话框粘贴打印出的话术，触发服务注册。
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
#  常量（与 deploy/zo/manifest.example.json 保持一致）
# ----------------------------------------------------------------------------
readonly REPO_URL="https://github.com/IBaiKe/zo2api.git"
readonly REPO_BRANCH="dev-zo"
readonly DEFAULT_LABEL="anthropic-proxy"
readonly DEFAULT_PORT="8088"
readonly DEFAULT_WORKDIR_ROOT="/home/workspace"
readonly DEFAULT_TARGET="${DEFAULT_WORKDIR_ROOT}/${DEFAULT_LABEL}"
readonly PUBLIC_DOMAIN="${DEFAULT_LABEL}.zocomputer.io"

# ----------------------------------------------------------------------------
#  颜色（NO_COLOR 标准遵守）
# ----------------------------------------------------------------------------
if [[ -z "${NO_COLOR:-}" ]] && [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'
  C_CYN=$'\033[36m'; C_DIM=$'\033[2m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED= ; C_GRN= ; C_YLW= ; C_CYN= ; C_DIM= ; C_BLD= ; C_RST=
fi

log()  { printf '%s[zo-deploy]%s %s\n' "$C_CYN" "$C_RST" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GRN" "$C_RST" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YLW" "$C_RST" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$C_RED" "$*" "$C_RST" >&2; exit 1; }

# ============================================================================
#  Step 1: 环境自检
# ============================================================================
log "Step 1/6: 环境自检"
if [[ ! -d "$DEFAULT_WORKDIR_ROOT" ]]; then
  warn "未发现 $DEFAULT_WORKDIR_ROOT，可能不在 zo.computer 环境。继续执行（自负风险）。"
else
  ok "检测到 $DEFAULT_WORKDIR_ROOT，疑似 zo.computer 环境"
fi
command -v git  >/dev/null 2>&1 || die "缺少 git"
command -v node >/dev/null 2>&1 || die "缺少 node"
command -v npm  >/dev/null 2>&1 || die "缺少 npm"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[[ "$NODE_MAJOR" -ge 18 ]] || die "需要 Node >= 18（当前: $(node -v)）"
ok "git / node $(node -v) / npm $(npm -v) 就绪"

# ============================================================================
#  Step 2: 目标目录
# ============================================================================
log "Step 2/6: 准备目标目录"
read -r -p "目标目录 [${DEFAULT_TARGET}]: " TARGET
TARGET="${TARGET:-$DEFAULT_TARGET}"

if [[ -e "$TARGET" ]]; then
  if [[ -d "$TARGET/.git" ]]; then
    warn "目标已存在且为 git 仓库"
    read -r -p "动作: [p]ull / [o]verwrite / [a]bort (默认 p): " ACT
    ACT="${ACT:-p}"
    case "$ACT" in
      p|P) MODE="pull" ;;
      o|O) MODE="overwrite" ;;
      *)   die "用户取消" ;;
    esac
  else
    die "目标已存在但不是 git 仓库：$TARGET（请手动清理）"
  fi
else
  MODE="clone"
fi
ok "动作模式: $MODE"

# ============================================================================
#  Step 3: 拉源码
# ============================================================================
log "Step 3/6: 同步源码"
case "$MODE" in
  clone)
    mkdir -p "$(dirname "$TARGET")"
    git clone -b "$REPO_BRANCH" --single-branch "$REPO_URL" "$TARGET"
    ;;
  pull)
    cd "$TARGET"
    git fetch origin "$REPO_BRANCH"
    git checkout "$REPO_BRANCH"
    git pull --ff-only origin "$REPO_BRANCH"
    ;;
  overwrite)
    rm -rf "$TARGET"
    mkdir -p "$(dirname "$TARGET")"
    git clone -b "$REPO_BRANCH" --single-branch "$REPO_URL" "$TARGET"
    ;;
esac
cd "$TARGET"
ok "源码就绪: $TARGET ($(git rev-parse --short HEAD))"

# ============================================================================
#  Step 4: 安装依赖
# ============================================================================
log "Step 4/6: 安装依赖 (npm ci --omit=dev)"
if ! npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -30; then
  die "npm ci 失败，请检查上面 30 行输出"
fi
ok "依赖安装完毕 ($(du -sh node_modules 2>/dev/null | cut -f1) on disk)"

# ============================================================================
#  Step 5: 交互式 .env 生成
# ============================================================================
log "Step 5/6: 配置环境变量"

ENV_FILE="$TARGET/.env"
if [[ -f "$ENV_FILE" ]]; then
  read -r -p ".env 已存在。覆盖? [y/N]: " OW
  if [[ "${OW,,}" != "y" ]]; then
    warn "保留现有 .env，跳过本步"
    SKIP_ENV=1
  fi
fi

if [[ -z "${SKIP_ENV:-}" ]]; then
  # ---- PROXY_API_KEY ------------------------------------------------------
  echo
  printf '%sPROXY_API_KEY%s (留空自动生成): ' "$C_BLD" "$C_RST"
  read -r INPUT_KEY
  if [[ -z "$INPUT_KEY" ]]; then
    HEX=$(node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))')
    PROXY_API_KEY="sk-ant-proxy-${HEX}"
    ok "已生成新 PROXY_API_KEY"
  else
    PROXY_API_KEY="$INPUT_KEY"
    ok "使用用户提供的 PROXY_API_KEY"
  fi

  # ---- providers (多选) ---------------------------------------------------
  echo
  echo "选择要启用的 provider（用空格分隔，可全留空只用 Zo fallback）:"
  echo "  1) anthropic    2) openai    3) openrouter    4) gemini    5) zo-fallback"
  read -r -p "选择 [例如 1 2 5]: " PICKS

  declare -A KEYS=()
  for p in $PICKS; do
    case "$p" in
      1) name="ANTHROPIC_API_KEY"        ; label="Anthropic" ;;
      2) name="OPENAI_API_KEY"           ; label="OpenAI" ;;
      3) name="OPENROUTER_API_KEY"       ; label="OpenRouter" ;;
      4) name="GEMINI_API_KEY"           ; label="Gemini" ;;
      5) name="ZO_CLIENT_IDENTITY_TOKEN" ; label="Zo fallback token" ;;
      *) warn "忽略未知选项: $p"; continue ;;
    esac
    printf '  %s%s key%s (输入隐藏): ' "$C_BLD" "$label" "$C_RST"
    read -r -s val
    echo
    [[ -n "$val" ]] && KEYS["$name"]="$val"
  done

  # ---- 写 .env -----------------------------------------------------------
  umask 077
  {
    echo "# === Generated by deploy/zo/install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    echo "PROXY_API_KEY=${PROXY_API_KEY}"
    echo "PUBLIC_DOMAIN=${PUBLIC_DOMAIN}"
    echo "PROXY_KEY_FILE=${TARGET}/.proxy-key"
    echo "DEBUG_LOG_ENABLED=0"
    echo "FETCH_TIMEOUT_MS=120000"
    echo "MAX_BODY_BYTES=10485760"
    echo "NODE_ENV=production"
    echo ""
    echo "# === Providers ==="
    for k in "${!KEYS[@]}"; do
      echo "${k}=${KEYS[$k]}"
    done
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok ".env 已写入 (权限 0600)"
fi

# ============================================================================
#  Step 6: 生成 manifest + 打印注册话术
# ============================================================================
log "Step 6/6: 生成 register-user-service payload"

MANIFEST="$TARGET/manifest.json"

# 用 node 解析 .env 生成 JSON，避免 bash 转义地狱
node --input-type=module -e "
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
const raw = readFileSync('${ENV_FILE}', 'utf8');
const env = {};
for (const line of raw.split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!m) continue;
  const [, k, v] = m;
  if (v !== '') env[k] = v;
}
const payload = {
  label: '${DEFAULT_LABEL}',
  mode: 'http',
  local_port: ${DEFAULT_PORT},
  entrypoint: 'node index.mjs',
  workdir: '${TARGET}',
  env_vars: env,
  public: 'true',
};
writeFileSync('${MANIFEST}', JSON.stringify(payload, null, 2));
chmodSync('${MANIFEST}', 0o600);
console.log(JSON.stringify(payload, null, 2));
" > "$MANIFEST.stdout"

ok "manifest.json 已生成 (权限 0600): $MANIFEST"

# 读 PROXY_API_KEY 用于打印（不解析整个 env，避免回显 KEY）
PROXY_API_KEY_DISPLAY=$(grep -E '^PROXY_API_KEY=' "$ENV_FILE" | sed 's/^PROXY_API_KEY=//')

# ============================================================================
#  打印接入信息 + 话术
# ============================================================================
echo
printf '%s==========================================%s\n' "$C_CYN" "$C_RST"
printf '%s  zo2api 准备就绪 — 下一步：注册服务%s\n' "$C_GRN" "$C_RST"
printf '%s==========================================%s\n' "$C_CYN" "$C_RST"
echo
echo "在 Zo AI 对话框 粘贴下面这段话（含 @ 工具调用）："
echo
printf '%s--- COPY START ---%s\n' "$C_DIM" "$C_RST"
echo "@register-user-service"
cat "$MANIFEST.stdout"
printf '%s--- COPY END ---%s\n' "$C_DIM" "$C_RST"
echo
echo "Zo AI 解析后会调用 register-user-service 创建并启动服务。"
echo
printf '部署完成后 URL : %shttps://%s%s\n' "$C_CYN" "$PUBLIC_DOMAIN" "$C_RST"
printf 'PROXY_API_KEY  : %s%s%s\n' "$C_YLW" "${PROXY_API_KEY_DISPLAY:-(missing)}" "$C_RST"
echo
echo "验证（注册并启动后）："
echo "  curl -fsS https://${PUBLIC_DOMAIN}/health"
echo "  curl -fsS https://${PUBLIC_DOMAIN}/v1/models \\"
echo "    -H \"x-api-key: \$PROXY_API_KEY\""
echo
echo "若日后要修改 env_vars：编辑 .env 后重跑本脚本，再用 @update-user-service 粘贴新 manifest.json"
echo

rm -f "$MANIFEST.stdout"
