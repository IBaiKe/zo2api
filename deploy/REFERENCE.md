# Production Reference — main / v0.0.5

> **状态**：仅为参考记录。本文档不修改 Dockerfile / compose / 脚本，不固化任何凭据进仓库。
> **来源**：用户提供的现网部署参数快照。
> **关联版本**：`main` 分支，tag `v0.0.5`，commit `88c2e2a`。

---

## 1. 参数全集

| 字段 | 值 | 备注 |
|---|---|---|
| Service label | `anthropic-proxy` | 与本仓库 `zo2api` 命名不一致 |
| Local port | `8088` | 宿主侧端口，容器 / 进程内仍是 `PORT=3000` |
| Entrypoint | `bash -c 'cd /home/workspace/anthropic-proxy && exec node index.mjs'` | bash 显式 cd + exec 替换进程 |
| Working directory | `/home/workspace/anthropic-proxy` | 典型 Replit / Coder / Gitpod / Codespaces 路径模板 |
| PROXY_API_KEY | *已收到，未入仓* | 见第 4 节"凭据处理" |

## 2. 部署形态判断

该参数组合 **不是 Docker** 风格，是 **裸机 / PaaS workspace** 风格。证据：

- `/home/workspace/<service>` 是 Replit / Coder.com / Gitpod 标准布局
- `bash -c 'cd ... && exec node ...'` 是这些平台的 supervisor / service-manager 期望的入口语法
- 没有镜像名、没有端口映射、没有卷声明——典型的 "PM/systemd-style spawn"

因此本仓库的 dev 分支容器化方案（Docker Compose）与该生产形态是**两套互不相干的部署路径**，可以共存：

```
部署矩阵
├── Docker Compose 路径   (dev 分支已实现)
│     entrypoint: node index.mjs
│     workdir  : /app
│     port     : ${HOST_PORT:-3000} -> 3000
└── 裸机 / PaaS 路径       (本文档记录的生产现状)
      entrypoint: bash -c 'cd /home/workspace/anthropic-proxy && exec node index.mjs'
      workdir  : /home/workspace/anthropic-proxy
      port     : 8088
```

## 3. 代码侧兼容性核查

针对该 entrypoint 与 workdir，对 `index.mjs` 做了一次依赖扫描：

| 关注点 | 结论 |
|---|---|
| `process.cwd()` 调用 | **无** |
| `__dirname` / `import.meta.url` 路径推导 | **无** |
| `.proxy-key` 默认 CWD 相对 | 受影响——会落到 `/home/workspace/anthropic-proxy/.proxy-key`。可由 `PROXY_KEY_FILE` 环境变量覆写 |
| `~/.anthropic-proxy/debug.log` 默认 | 落到运行用户 home，可由 `DEBUG_LOG` 覆写 |
| 端口 | 受 `PORT` 控制（生产应设 `PORT=3000`，宿主侧 8088→3000 由外部 supervisor 处理；或直接 `PORT=8088` 让 Node 监听 8088） |

**结论**：代码本身无任何硬编码假设需要"为这个生产形态修改"。所有差异均可通过环境变量声明，零代码改动可适配。

## 4. 凭据处理（PROXY_API_KEY）

收到的具体 KEY 值**不在本文档中出现**，原因：

- 一旦写入任何被 Git 跟踪的文件，即进入提交历史，永久无法擦除
- 公开仓库 push 后等同凭据泄漏
- 即便仓库私有，git log 仍可被任何后续 collaborator 读到

**合规获取路径**（任选其一）：

1. **本地 .env**（被 `.gitignore` 排除）：
   ```bash
   echo "PROXY_API_KEY=<the-actual-key>" >> .env
   ```
2. **运行时环境变量**：
   ```bash
   PROXY_API_KEY=<the-actual-key> docker compose up -d
   ```
3. **PaaS Secret Manager**：在 Replit / Coder 控制台的 Secrets 面板填入

KEY 值由人持有，不由代码持有。

## 5. 若未来想为该生产形态出 deliverable

下一步可做（**当前不做**）：

- `deploy/native/start.sh` — 复刻 `bash -c 'cd ... && exec node ...'` 入口
- `deploy/native/systemd-unit.example` — systemd 服务单元样本
- `deploy/native/replit.nix` 或等价的 PaaS 描述文件
- `docker-compose.override.yml` 样本：宿主端口默认改 8088、container_name 改 anthropic-proxy

这些都不写入 `dev` 分支主线，避免与 Docker 化路径混淆。

## 6. 对照表 — 字段差异速查

| 维度 | 生产参考 | 本仓库 dev 分支 Docker | 差异性质 |
|---|---|---|---|
| 服务标识 | `anthropic-proxy` | `zo2api` (container_name + image) | 命名 |
| 宿主端口 | 8088 | `${HOST_PORT:-3000}` | 默认值 |
| 容器端口 | n/a（裸跑） | 3000 | 形态差异 |
| WORKDIR | `/home/workspace/anthropic-proxy` | `/app` | 路径 |
| Entrypoint | bash -c '... && exec node ...' | `["node", "index.mjs"]` | shell vs exec form |
| 运行用户 | 未指明（PaaS 默认） | `node` (uid 1000) | 安全姿态 |
| 状态持久化 | CWD 内 `.proxy-key` | `/tmp` tmpfs | 持久 vs 易失 |
| 健康检查 | 未指明 | BusyBox wget `/health` | 容器特性 |

## 7. 记录元数据

- 记录时间：2026-05-26
- 记录人：Claude（代用户操作）
- 触发：用户在 dev 分支上提供生产参数请求"分析下是否可以加入"
- 决议：**仅记录，不修改任何文件之外的现有代码 / 配置**
