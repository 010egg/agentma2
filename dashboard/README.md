# AgentMa Dashboard

当前 `dashboard/` 是一个前后端合一的单机部署项目：

- 前端：React + Vite
- 后端：Express
- 持久化：SQLite
- 线上地址：`https://dandelion.skin`

## 目录

- 接口文档：[`docs/api.md`](./docs/api.md)

## 本地运行

安装依赖：

```bash
npm install
```

启动后端：

```bash
npm run server
```

启动前端开发环境：

```bash
npm run dev
```

默认端口：

- 前端：`5173`
- 后端：`3001`

## Agent 运行隔离开关

租户 agent run 默认启用 SDK sandbox，并只传入最小环境变量白名单。可用以下环境变量临时调整：

- `AGENTMA_SANDBOX_ENABLED`：默认开启；设为 `0` 可临时关闭 sandbox 排障。
- `AGENTMA_SANDBOX_FAIL_IF_UNAVAILABLE`：默认开启；sandbox 不可用时报错退出。设为 `0` 会允许降级裸跑，仅用于排障。
- `AGENTMA_SANDBOX_NETWORK_MANAGED_ONLY`：默认关闭；设为 `1` 后只允许 managed domains 网络策略，需先验证 WebFetch/远程 MCP/npx。
- `AGENTMA_RUN_ENV_ALLOWLIST`：逗号分隔追加传入 agent run 的环境变量名。默认仅传 `PATH,LANG,LC_ALL,LC_CTYPE,TZ,TERM,TMPDIR,SHELL`，再注入本次 provider 的 `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`。

## A2A 远程凭据主密钥

A2A 远程 Agent 的 Bearer 凭据使用 AES-256-GCM 加密后写入 SQLite。主密钥按以下顺序加载：

- `AGENTMA_A2A_CREDENTIAL_KEY`：base64 编码的 32 字节密钥。
- 未配置环境变量时，自动创建 `~/Library/Application Support/agentma2/a2a-credential-key`，权限为 `0600`。

备份数据库时必须同时备份该主密钥文件。主密钥丢失后，已有远程凭据无法恢复；密钥和数据库也不应存放在同一个公开备份中。

## 构建

仅构建前端静态资源：

```bash
npx vite build
```

说明：

- 仓库当前 `npm run build` 仍会受到现存 TypeScript 问题影响
- 线上部署实际依赖 `dashboard/dist/` 和本地常驻的 `server.ts`

## 数据位置

- SQLite：`~/Library/Application Support/agentma2/dashboard.sqlite`
- JWT Secret：`~/Library/Application Support/agentma2/jwt-secret`

## 聊天历史

聊天历史现在已落到 SQLite，不再以浏览器 `localStorage` 作为主存。

对应接口见：

- [`docs/api.md#4-聊天历史`](./docs/api.md)
