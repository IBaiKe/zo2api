# zo2api - 多 Provider Anthropic Messages 代理（dev-zo / zo.computer 部署形态）

Node.js 18+ · undici 6 · 零额外依赖

<directory>
deploy/zo/ - zo.computer 部署资产 (5 文件: install.sh, README.md, manifest.example.json, CLAUDE.md, HISTORY.md)
</directory>

<config>
CLAUDE.md - 本文件，L1 项目宪法 + 全局地图（GEB 分形文档协议）
index.mjs - HTTP 服务主体；4 套 provider 协议双向翻译；监听 PORT（zo 注入）；零代码改动支持 zo
responses.mjs - OpenAI Responses API 桥接器（当前未挂载路由，预留模块）
package.json - undici@^6 单依赖；scripts: start / zo:install / zo:test
package-lock.json - 锁版本
test-conversion.mjs - Anthropic↔OpenAI 工具调用 e2e 测试（mock 上游）
test-injection-guard.mjs - Zo 自研工具标记 nonce 防伪测试
.gitignore - 排除 node_modules / .env / .proxy-key / manifest.json
</config>

<branch_topology>
main           v0.0.5  稳定快照（仅源码 + .gitignore）
dev            Docker Compose 部署路径（本地 / VPS）
dev-zo         本分支 — zo.computer User Service 部署路径
</branch_topology>

法则: 极简·稳定·导航·版本精确

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
