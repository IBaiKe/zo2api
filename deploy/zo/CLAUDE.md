# deploy/zo/
> L2 | 父级: ../../CLAUDE.md

zo.computer User Service 部署路径的全部资产。本目录是 dev-zo 分支独有，main / dev 上不存在。

成员清单

install.sh: 一键部署脚本（zo 终端 bash 执行），6 步幂等流：环境自检 → 目标目录 → git clone -b dev-zo → npm ci → 交互式 .env → 生成 manifest.json 并打印 @register-user-service 话术。常量集中在文件头部（REPO_URL / DEFAULT_LABEL=anthropic-proxy / DEFAULT_PORT=8088）。

README.md: 7 节部署指南。TL;DR 一条命令上线 → 前置 → 快速 → 手动等价 → 更新 → 故障排查 → 范围外。包含三分支拓扑对照表。

manifest.example.json: register-user-service payload 模板，占位符版（不含真实凭据）。install.sh 运行时在目标目录生成同结构的 manifest.json（含真实 env_vars，.gitignore 排除）。**JSON 本体保持纯 schema 形态——L3 契约承载于本 L2 文件**：
  - INPUT: 依赖 zo.computer register-user-service schema (label/mode/local_port/entrypoint/workdir/env_vars/public)
  - OUTPUT: 提供 zo.computer 服务注册 payload 的占位符版本，给审查者看完整结构
  - POS: deploy/zo/ 的契约固化文件；install.sh 运行时按本结构生成 manifest.json

HISTORY.md: dev-zo 部署路径的演化记录与设计决策日志（会话级，非 schema）。

法则: 成员完整·一行一文件·父级链接·技术词前置

<exposed_contract>
对外行为:
  install.sh stdout      → 包含 @register-user-service 话术，复制到 Zo AI 对话框触发服务注册
  生成 manifest.json     → 与 manifest.example.json 同结构，env_vars 含真实值，.gitignore 排除
  生成 .env              → mode 0600，由 index.mjs 读取（实际 zo 部署不依赖 .env，env_vars 在 register-user-service 时注入）

依赖契约:
  GitHub 仓库 IBaiKe/zo2api 的 dev-zo 分支可访问
  zo.computer 终端可用 git / node>=18 / npm
  Zo AI 助手支持 @register-user-service 工具调用
</exposed_contract>

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
