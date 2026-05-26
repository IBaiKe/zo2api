# ============================================================================
#  Dockerfile  ─ zo2api
# ----------------------------------------------------------------------------
#  多阶段构建：
#    Stage 1 (deps)   - 只装运行时依赖，剥离 cache
#    Stage 2 (runtime)- alpine + 非 root + busybox wget healthcheck
#
#  约束（来自代码审计）：
#    - index.mjs:36   PROXY_KEY_FILE 默认 CWD/.proxy-key  -> /tmp 覆写
#    - index.mjs:40   DEBUG_LOG 默认 $HOME/.anthropic-proxy/debug.log -> /tmp 覆写
#    - 默认 PORT=3000，/health 无鉴权可作 healthcheck
#    - engines.node >=18，依赖仅 undici@^6
# ============================================================================

# ----------------------------------------------------------------------------
#  Stage 1: 依赖层（保持瘦身，丢弃 npm cache）
# ----------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ----------------------------------------------------------------------------
#  Stage 2: 运行时层
# ----------------------------------------------------------------------------
FROM node:20-alpine AS runtime

# 镜像元信息
LABEL org.opencontainers.image.title="zo2api" \
      org.opencontainers.image.description="Multi-provider Anthropic Messages proxy" \
      org.opencontainers.image.source="https://github.com/ibaike/zo2api"

WORKDIR /app

# 非 root 运行（alpine node 镜像自带 node uid=1000）
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node index.mjs responses.mjs package.json ./

# 容器内可写路径覆写：默认 $HOME 与 CWD 对非 root 不友好
ENV NODE_ENV=production \
    PORT=3000 \
    PROXY_KEY_FILE=/tmp/.proxy-key \
    DEBUG_LOG=/tmp/zo2api.log

USER node
EXPOSE 3000

# busybox wget 自带，0 额外安装
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:3000/health || exit 1

CMD ["node", "index.mjs"]
