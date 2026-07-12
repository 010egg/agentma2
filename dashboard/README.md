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

## A2A 1.0 互操作

Agent 模板可在编辑器中显式开启 A2A 发布。每个已发布模板提供公开 Agent Card 和需要 API Key 的 JSON-RPC 入口：

- Agent Card：`GET /a2a/agents/:templateId/.well-known/agent-card.json`
- JSON-RPC：`POST /a2a/agents/:templateId/rpc`

RPC 请求必须同时发送 `Authorization: Bearer <AgentMa API Key>`、`A2A-Version: 1.0` 和 `Content-Type: application/json`。网页登录 JWT 不可用于该入口。支持发送/流式发送消息、任务查询与列表、任务事件重连和取消；权限或问题交互会进入 `TASK_STATE_INPUT_REQUIRED`，通过同一 `taskId` 与 `contextId` 再次发送消息后恢复。

模板也可配置最多 16 个远程 A2A Agent。运行时它们会作为受限 MCP 工具注入，远程 Card/RPC 只支持 A2A 1.0 JSON-RPC，并统一经过下述出站 URL 防护。

在 Agent 编辑器中添加远程 Agent 时只需填写 Card URL；系统会安全读取 Card 名称并自动填充。名称是可选的本地别名，支持中文，并会转换为稳定、符合工具协议限制的内部名称。

部署相关环境变量：

- `AGENTMA_PUBLIC_URL`：对外可访问的站点根 URL，用于生成 Card 中的绝对 RPC URL。
- `AGENTMA_A2A_INPUT_TIMEOUT_MS`：input-required 等待时间，默认 30 分钟，限制为 1 分钟至 24 小时。
- `AGENTMA_A2A_ALLOW_LOOPBACK_HTTP=1`：仅允许开发环境访问 loopback HTTP Card/RPC；不会放宽任何非 loopback 地址。
- `AGENTMA_A2A_CREDENTIAL_KEY`：可选的 base64 32 字节远程凭据主密钥；未设置时使用本机密钥文件。

完整接口、配置示例和限制见 [`docs/api.md#a2a-10机器接口`](./docs/api.md)。完整 A2A 回归套件：

```bash
npm run smoke:a2a
```

## A2A 出站 URL 安全

远程 Agent Card 和 RPC 请求必须通过独立的出站 URL 防护客户端。生产请求仅允许 HTTPS，并会校验全部 A/AAAA 解析结果、固定已校验的连接地址、保留原始 TLS SNI/Host、逐跳重新验证重定向，同时限制重定向次数、响应大小和连接、响应、总时长。

仅本地开发可由调用方显式传入 `allowLoopbackHttp: true` 允许 loopback HTTP。系统不会根据 `NODE_ENV` 或入站请求自动放宽限制；私有地址、链路本地、CGNAT、组播、文档/测试网段和云元数据地址均会被阻止。

## A2A 远程凭据主密钥

A2A 远程 Agent 的 Bearer 凭据使用 AES-256-GCM 加密后写入 SQLite。主密钥按以下顺序加载：

- `AGENTMA_A2A_CREDENTIAL_KEY`：base64 编码的 32 字节密钥。
- 未配置环境变量时，自动创建 `~/Library/Application Support/agentma2/a2a-credential-key`，权限为 `0600`。

备份数据库时必须同时备份该主密钥文件。主密钥丢失后，已有远程凭据无法恢复；密钥和数据库也不应存放在同一个公开备份中。

## 抖音受控浏览器

内部工具 `media.douyin_resolve` 使用 dashboard 主进程中的 `playwright-core` 驱动宿主 Chrome。租户 agent 只会看到窄 MCP 工具 `mcp__media__douyin_resolve`，不会获得 page/browser 句柄或任意网页访问能力。

- `AGENTMA_BROWSER_CONCURRENCY`：全平台同时解析数，默认 `2`，范围 `1-16`。
- `AGENTMA_BROWSER_IDLE_MS`：浏览器空闲自动关闭时间，默认 `300000` 毫秒。
- `AGENTMA_DOUYIN_RESOLVE_TIMEOUT_MS`：单次解析总超时，默认 `30000` 毫秒。
- `AGENTMA_TRANSCRIBE_TIMEOUT_MS`：单个转写任务执行超时，默认 `600000` 毫秒。
- `AGENTMA_TRANSCRIBE_URL_HOSTS`：逗号分隔，追加允许转写的媒体 CDN host 后缀。
- `AGENTMA_TRANSCRIBE_VENV`：固定转写虚拟环境，默认 `/opt/agentma/transcribe-venv`。
- `AGENTMA_HF_CACHE`：离线模型缓存，默认 `/opt/agentma/hf-cache`。

部署机必须安装 Google Chrome 与 ffmpeg。macOS Apple Silicon 使用固定 venv 中的 mlx-whisper；运行时强制 `HF_HUB_OFFLINE=1`，不会下载模型。首次部署执行：

```bash
./scripts/setup-transcribe-host.sh
```

该脚本创建 `/opt/agentma/transcribe-venv`、预下载 `mlx-community/whisper-large-v3-turbo` 到 `/opt/agentma/hf-cache`，并将模型缓存设为只读。Linux 部署需要将 worker 实现替换为 faster-whisper 或 whisper.cpp。

本地安全与生命周期 smoke：

```bash
npm run smoke:douyin-resolve
npm run smoke:transcribe
```

如需额外执行真实链接验证，可设置 `AGENTMA_SMOKE_DOUYIN_URL`。设置 `AGENTMA_SMOKE_TRANSCRIBE_LIVE=1` 会用本地短音频加载离线模型并跑通真实 worker。

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
