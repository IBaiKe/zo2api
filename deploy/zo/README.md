<!--
[INPUT]:    依赖读者具备 zo.computer 账号 + 内置终端访问；依赖 IBaiKe/zo2api dev-zo 分支可达
[OUTPUT]:   提供 zo.computer 部署的完整操作流程；可读、可手动执行的等价步骤；故障排查清单
[POS]:      deploy/zo/ 的文档面；与 install.sh 配对（脚本是执行体、本文件是操作手册）；
            HISTORY.md 是演化日志，与本文件互不重复
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
-->

# zo.computer 一键部署指南

> 把 `zo2api` 作为 **User Service** 部署到 zo.computer。
> 服务上线后通过 `https://anthropic-proxy-<your-workspace-id>.zocomputer.io` 对外暴露
> （workspace-id 是你 zo 空间主页 URL 的子域名，例如 `qgtrn35e97`）。

---

## 1. TL;DR（90 秒上线）

在 zo.computer 的内置终端里跑：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/IBaiKe/zo2api/dev-zo/deploy/zo/install.sh)
```

或先 clone 再跑：

```bash
git clone -b dev-zo https://github.com/IBaiKe/zo2api.git /home/workspace/anthropic-proxy
cd /home/workspace/anthropic-proxy
bash deploy/zo/install.sh
```

脚本结束时会打印一段 `@register-user-service` 话术——**复制粘贴到 Zo AI 对话框**，AI 会调用工具完成服务注册。

---

## 2. 前置要求

- 一个 zo.computer 账号
- 能进入 zo 网页应用的内置终端 / 文件管理器
- Node ≥ 18（zo.computer 默认环境已满足）

---

## 3. 快速部署流程

### Step 1 — 在 zo 终端跑脚本

脚本会依次询问：

1. **目标目录**（默认 `/home/workspace/anthropic-proxy`，直接回车即可）
2. **PROXY_API_KEY**（留空自动生成 `sk-ant-proxy-<24hex>`）
3. **要启用的 provider**（多选，比如 `1 2 5` 表示 Anthropic + OpenAI + Zo fallback）
4. 每个 provider 的 **API key**（输入隐藏不回显）

### Step 2 — 复制脚本最后打印的话术，粘贴到 Zo AI

形如：

```
@register-user-service
{
  "label": "anthropic-proxy",
  "mode": "http",
  "local_port": 8088,
  "entrypoint": "node index.mjs",
  "workdir": "/home/workspace/anthropic-proxy",
  "env_vars": {
    "PROXY_API_KEY": "<your-proxy-key>",
    "ANTHROPIC_API_KEY": "<your-anthropic-key>",
    "OPENAI_API_KEY": "<your-openai-key>",
    "PUBLIC_DOMAIN": "anthropic-proxy-<your-workspace-id>.zocomputer.io",
    ...
  },
  "public": "true"
}
```

Zo AI 解析后会调用 `register-user-service` 工具。

### Step 3 — 验证

```bash
curl -fsS https://anthropic-proxy-<your-workspace-id>.zocomputer.io/health

curl -fsS https://anthropic-proxy-<your-workspace-id>.zocomputer.io/v1/models \
  -H "x-api-key: $PROXY_API_KEY"
```

期望：第一条返回 `{"ok":true,...}`；第二条返回模型清单。

---

## 4. 详细步骤（手动等价）

如果你不想用脚本，等价的 7 步手动流程：

```bash
# 1. 准备目录
mkdir -p /home/workspace/anthropic-proxy
cd /home/workspace/anthropic-proxy

# 2. 拉源码
git clone -b dev-zo https://github.com/IBaiKe/zo2api.git .

# 3. 装依赖
npm ci --omit=dev

# 4. 生成 PROXY_API_KEY
node -e 'console.log("sk-ant-proxy-" + require("crypto").randomBytes(12).toString("hex"))'

# 5. 写 .env（mode 0600）
cat > .env <<'EOF'
PROXY_API_KEY=sk-ant-proxy-<上一步生成的>
ANTHROPIC_API_KEY=<your key>
PUBLIC_DOMAIN=anthropic-proxy-<your-workspace-id>.zocomputer.io
PROXY_KEY_FILE=/home/workspace/anthropic-proxy/.proxy-key
DEBUG_LOG_ENABLED=0
NODE_ENV=production
EOF
chmod 600 .env

# 6. 拷贝 manifest 模板，填入真实 env_vars
cp deploy/zo/manifest.example.json manifest.json
# 编辑 manifest.json 把 <...> 占位符换成真实值

# 7. 在 Zo AI 粘贴
#    @register-user-service
#    <manifest.json 的全部内容>
```

---

## 5. 更新部署

代码有新版本时，在 zo 终端跑：

```bash
cd /home/workspace/anthropic-proxy
bash deploy/zo/install.sh
# 选 [p]ull 模式，env 选保留
```

之后告诉 Zo AI：

```
@update-user-service label=anthropic-proxy
```

Zo 会拉起新的进程（**每次 update 都会重启服务**，符合 zo 平台语义）。

要只改环境变量（不动代码）：编辑 `.env` → 重跑脚本生成新 `manifest.json` → 粘贴：

```
@update-user-service
<manifest.json 内容>
```

---

## 6. 故障排查

| 症状 | 原因 | 解法 |
|---|---|---|
| 脚本报 `缺少 git/node/npm` | zo 环境异常 | 联系 zo 支持，或切换到另一台 zo |
| `npm ci` 失败 | 网络问题 | 重跑脚本（脚本会 npm cache 复用） |
| 注册后服务状态 `failed` | env_vars 缺 PROXY_API_KEY 或 provider key | `@service-doctor label=anthropic-proxy` 看错误，对应改 .env 后重跑 |
| `/health` 200 但 `/v1/messages` 报 401 | x-api-key 不匹配 .env 的 PROXY_API_KEY | 用 `grep PROXY_API_KEY .env` 拿正确值 |
| `/v1/messages` 报 `configuration_error` | 请求的 provider 没 key 且没 Zo fallback | 加对应 provider key 或 `ZO_CLIENT_IDENTITY_TOKEN` |
| 改 .env 后服务没变化 | zo 缓存 env_vars | 重新 `@update-user-service` 触发重启 |

诊断命令：

```
@list-user-services             # 看所有服务
@service-doctor label=anthropic-proxy   # 看健康细节
tail -f /home/workspace/anthropic-proxy/.logs/debug.log    # 看应用日志（如果 DEBUG_LOG_ENABLED=1）
```

---

## 7. 不在范围内

- **HTTPS / TLS 终结**——zo 自带，`*.zocomputer.io` 自动 HTTPS
- **多实例 / 负载均衡**——本方案单服务部署
- **自定义域名**——可在 zo 控制台后续接入，本脚本不处理
- **Docker / Compose**——dev 分支的方案，不适用 zo.computer
- **CI/CD 自动部署**——本脚本是人工触发的一次性部署
- **Ask-Zo API 自动注册**——zo.computer 无服务管理 REST，需要人工粘贴话术触发 AI 工具调用

---

## 8. 相关分支

| 分支 | 用途 |
|---|---|
| `main` | v0.0.5 稳定快照 |
| `dev` | Docker Compose 容器化方案（本地 / VPS） |
| **`dev-zo`** | **本文档对应的 zo.computer 部署方案** |

三条路径独立演化，互不依赖。
