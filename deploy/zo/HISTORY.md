<!--
[INPUT]:    依赖会话上下文（用户与 Claude 在 2026-05-26 的部署演化讨论）
[OUTPUT]:   提供 dev-zo 分支从无到有的设计决策日志；解释为何当前形态是当前形态
[POS]:      deploy/zo/ 的演化记录面；与 README.md（操作）/ install.sh（执行）/
            manifest.example.json（schema）四件套互补，承载"为什么"的语义
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
-->

# dev-zo 分支演化历史

> 本文档不是 changelog，是**设计决策日志**——记录每一次方向选择的理由，让未来维护者能复原当时的思考路径。

---

## 时间线

| 时间 | 节点 | commit |
|---|---|---|
| 2026-05-26 | 仓库 git 初始化，main + v0.0.5 | `88c2e2a` |
| 2026-05-26 | dev 分支：Docker Compose 路径落地 | `796fe86` / `8a480ae` |
| 2026-05-26 | dev 分支：记录生产参考参数到 deploy/REFERENCE.md | `70d2158` |
| 2026-05-26 | push main / dev / v0.0.5 到 github.com/IBaiKe/zo2api | — |
| 2026-05-26 | **dev-zo 分支：zo.computer 部署路径落地** | `39d2f93` / `fbd5fbf` |
| 2026-05-26 | dev-zo：补 GEB 分形文档 L1/L2/L3 + 本 HISTORY | （本次提交） |

---

## 三个核心决策

### 决策 1：为什么独立分支 dev-zo，而不是合进 dev？

**问题语境**：用户在 zo.computer 终端跑 `docker compose up -d --build`，报错 `command not found: docker`。

**根因诊断**：zo.computer 是 conversational PaaS（managed Linux VM + AI 助手 + 工具调用），不是容器宿主。Docker 路径完全不适用——zo 没装 docker，也不该装。

**两条平行路径的本质差异**：

| 维度 | Docker (dev) | zo.computer (dev-zo) |
|---|---|---|
| 运行形态 | 容器 (`node:20-alpine`) | 裸 Node 进程在 zo VM |
| 入口 | `CMD ["node", "index.mjs"]` | `entrypoint: "node index.mjs"` |
| workdir | `/app` | `/home/workspace/anthropic-proxy` |
| 状态 | tmpfs `/tmp` | 工作目录可写 |
| 端口 | 容器 3000 → 宿主 `HOST_PORT` | PaaS 注入 `PORT=8088` |
| 公开 URL | 用户自己接反代 | `*.zocomputer.io` 自动 HTTPS |
| 部署单元 | `docker-compose.yml` | `register-user-service` payload |
| 启动方式 | `docker compose up -d` | Zo AI 工具调用 |

**为什么 dev-zo 从 main 切，不从 dev 切**：

如果从 dev 切，会带入 `Dockerfile / docker-compose.yml / scripts/install.{sh,ps1} / .dockerignore / deploy/REFERENCE.md` 等 Docker 资产——它们对 zo.computer 部署完全无关，反而污染分支语义。**分支语义纯粹原则**：dev-zo 上看到的每个文件都应直接服务 zo.computer 路径。

**反对意见与回应**：
- 反对："不就是部署工件吗，合一个分支管理简单"
- 回应：合一起 = 用户拉到一个分支后必须自己判断"哪些资产对我有用"。分离 = `git checkout` 一次就拿到该路径的全集。**职责分离 > 仓库扁平**

### 决策 2：为什么主部署路径是"zo 终端跑本地脚本"，不是 SSH 推送或 Ask-Zo API？

**候选 4 方案对比**：

| 方案 | 部署位置 | 服务注册 | 用户成本 | 自动化程度 | 否决理由 |
|---|---|---|---|---|---|
| A. SSH-Push | 用户本地 | 用户在 zo 应用手动注册 | SSH key + 一次手动 | 代码自动同步、服务自动重启 | 要求 zo 上先有 SSH 服务，鸡生蛋 |
| B. **Zo-内置脚本** | zo 终端 | 复制脚本输出的话术给 Zo AI | 一次粘贴 | 半自动 | **采用** |
| C. Ask-Zo API | 用户本地 → `/zo/ask` | Zo AI 解析自然语言并调工具 | 仅需 ZO token | 全自动 | LLM 解析不可重现，调试地狱 |
| D. 双脚本组合 | A + B | 看场景 | 灵活 | 看场景 | 范围爆炸，先做 B |

**关键事实**（来自 Phase 1 探索）：

- `https://docs.zocomputer.com/openapi.json` 公开 API 只有 3 个端点：`/zo/ask`、`/models/available`、`/personas/available`
- **没有任何远程服务管理 REST**——`register-user-service` 只能通过 Zo AI 的工具调用触发
- SSH 入口存在但需要先手动注册一个 SSH 服务（label=ssh / port=2222 / entrypoint=/usr/sbin/sshd -D -p 2222），同样要走 Zo AI

**最终设计选 B 的根本理由**：
- 路径最短：clone → npm ci → 交互问 KEY → 打印话术
- 凭据本地化：用户在自己的 zo 终端输入 KEY，不经过 LLM 上下文
- 可重现：脚本是确定性的；只有最后一步（粘贴话术给 AI）一次性人工

### 决策 3：为什么 manifest.json 进 `.gitignore` 而 manifest.example.json 入仓？

**安全本质**：`manifest.json` 是 `install.sh` 运行时生成的**实例**，包含真实 PROXY_API_KEY 与各 provider 凭据（在 `env_vars` 里）。`manifest.example.json` 是**模板**，仅含占位符。

**两个文件并存的设计**：
- `manifest.example.json` 给审查者看完整 schema 形态，**契约固化**
- `manifest.json` 给 Zo AI 工具调用喂数据，**运行时产物**

类比：`tsconfig.json` vs `tsconfig.example.json`、`.env` vs `.env.example`——同一模式。

---

## 代码侧的零改动原则

dev-zo 分支**没有动一行 `index.mjs` / `responses.mjs`**。这不是疏忽，是设计：

- `index.mjs:35` 早已是 `process.env.PORT || "3000"`——zo 注入 `PORT=8088`，代码无感
- `index.mjs:36` `PROXY_KEY_FILE` env 可覆写
- `index.mjs:40` `DEBUG_LOG` env 可覆写
- `index.mjs:1748` `PUBLIC_DOMAIN` env 控制启动 banner

**结论**：原代码已经是平台无关的，部署路径变化全部由 env 与外部 manifest 承载。这是 Twelve-Factor App 的**配置外置原则**在起作用——验证了原始作者的设计远见。

---

## 安全护栏

**入仓白名单**（每次 commit 前扫一遍）：
- `.gitignore` 排除：`.env`、`.proxy-key*`、`manifest.json`、`deploy/**/manifest.json`、`node_modules/`、`.claude/`
- 凭据正则扫描覆盖：Anthropic API key 前缀、自生成 proxy key 前缀、OpenAI 风格短 key、Google AIza 前缀、HTTP 鉴权 `Bearer` 头部
- 文档示例占位符**禁止使用真实形状**——README 里曾有真实 KEY 前缀的字面量被正则扫到，已改为 `<your-anthropic-key>` 形式

**对 v0.0.5 的承诺**：
- main 永远停在 `88c2e2a`（v0.0.5 tag）
- dev / dev-zo 任何向 main 的合并必须打新 tag

---

## 已知遗留 & follow-up

- **未做 Ask-Zo 自动化**：手动粘贴话术那一步对 CI/CD 不友好。等 zo.computer 出 admin REST API 再做
- **未对 dev-zo 写 e2e 测试**：现有 `test-conversion.mjs` / `test-injection-guard.mjs` 是 mock 上游单测，未覆盖"真去 zo 部署一次"
- **未覆盖自定义域名**：当前依赖 `*.zocomputer.io` 默认子域
- **未做日志聚合**：`DEBUG_LOG_ENABLED=0` 默认关，开了之后日志在 zo VM 本地，没接出去
- **未挂载 `/v1/responses` 路由**：`responses.mjs` 仍是死代码（与 dev 分支同病）

---

## 给未来维护者的话

如果你接手 dev-zo 而本仓库已经有 v0.1.x / v0.2.x：

1. **先读** `CLAUDE.md`（根）→ `deploy/zo/CLAUDE.md`（L2）→ 各文件头 [INPUT]/[OUTPUT]/[POS]
2. **再读本 HISTORY**，了解为什么是现在这个形态
3. **改之前问自己**：这个改动是 zo.computer 路径专属吗？如果是，留在 dev-zo；如果是通用代码改进，应当先去 main 或 dev
4. **决策变更**要在本 HISTORY 追一节，不要让"为什么"丢失

文档不是装饰，是给后人的电报。
