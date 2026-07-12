# Dashboard API 文档

本文档描述 `dashboard/server.ts` 当前暴露的 HTTP 接口，重点覆盖鉴权、聊天、会话历史和租户侧管理接口。

Base URL：

- 本地：`http://127.0.0.1:3001`
- 线上：`https://dandelion.skin`

## 鉴权

受保护接口统一使用：

```http
Authorization: Bearer <jwt-or-api-key>
```

- 密码登录后拿到的是 JWT
- API Key 登录时可直接把 API Key 作为 Bearer Token

## 1. 健康检查

### `GET /api/health`

返回服务健康状态。

响应示例：

```json
{
  "status": "ok"
}
```

## 2. 认证

### `POST /api/auth/register`

注册租户和首个管理员账号。

请求体：

```json
{
  "name": "Admin",
  "email": "admin@example.com",
  "password": "secret123"
}
```

响应示例：

```json
{
  "token": "<jwt>",
  "email": "admin@example.com",
  "name": "Admin",
  "tenantId": "tenant-uuid"
}
```

### `POST /api/auth/login`

密码登录。

请求体：

```json
{
  "email": "admin@example.com",
  "password": "secret123"
}
```

响应示例：

```json
{
  "token": "<jwt>",
  "email": "admin@example.com",
  "name": "Admin",
  "tenantId": "tenant-uuid"
}
```

### `GET /api/auth/me`

读取当前登录身份。

响应示例：

```json
{
  "email": "admin@example.com",
  "tenantId": "tenant-uuid",
  "name": "Admin",
  "role": "tenant_admin",
  "plan": "free",
  "region": "us"
}
```

## 3. 聊天

### `POST /api/chat`

把前端消息转发到上游 Anthropic 兼容模型接口，并以 SSE 流返回结果。

请求体：

```json
{
  "messages": [
    { "role": "user", "content": "你好" }
  ],
  "systemPrompt": "你是一个助手",
  "model": "deepseek-v4-pro",
  "provider": {
    "ANTHROPIC_AUTH_TOKEN": "sk-xxx",
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic"
  }
}
```

`model` 表示本次运行使用的 Agent 模型；账户管理只维护供应商 API 凭据和可用模型清单，不再配置供应商默认模型。`provider.ANTHROPIC_MODEL` 仅作为旧客户端兼容兜底。

返回格式：

- `Content-Type: text/event-stream`
- 事件体统一为 `data: {...}\n\n`

常见事件：

```json
{ "type": "system", "subtype": "init", "model": "..." }
{ "type": "delta", "text": "partial text" }
{ "type": "delta", "text": "thinking text", "thinking": true }
{ "type": "result", "subtype": "success", "text": "final text" }
{ "type": "error", "message": "API 404: ..." }
```

说明：

- 该接口本身不保存聊天历史
- 聊天历史持久化通过下文的 `chat-sessions` 接口完成

## 4. 聊天历史

当前聊天历史已持久化到 SQLite：

- 数据库：`~/Library/Application Support/agentma2/dashboard.sqlite`
- 表：`chat_sessions`、`chat_messages`

隔离规则：

- 默认按 `tenant_id + owner_sub` 隔离
- 开启协作后，同租户内已加入该会话的成员也可见
- 不同租户、未加入的登录身份互相不可见

### `GET /api/chat-sessions`

返回当前登录用户可见的全部会话，包括自己创建的会话和已加入的协作会话，按 `pinned DESC, updatedAt DESC` 排序。

响应示例：

```json
[
  {
    "id": "chat-123",
    "ownerSub": "admin@example.com",
    "templateId": "agent-1",
    "title": "帮我看一下日志",
    "messages": [
      { "role": "user", "content": "帮我看一下日志", "timestamp": 1780081794000 },
      { "role": "assistant", "content": "可以，把日志贴出来。", "timestamp": 1780081795000 }
    ],
    "model": "deepseek-v4-pro",
    "pinned": false,
    "collaborationEnabled": true,
    "collaborationRole": "owner",
    "collaborationUpdatedAt": 1780081795000,
    "createdAt": 1780081794000,
    "updatedAt": 1780081795000
  }
]
```

### `GET /api/chat-sessions/:id`

读取单个会话全文。

成功响应与列表中的单项结构一致。

### `POST /api/chat-sessions`

创建会话，或按 `id` 对现有会话做整段覆盖保存。

请求体：

```json
{
  "id": "chat-123",
  "templateId": "agent-1",
  "title": "帮我看一下日志",
  "messages": [
    { "role": "user", "content": "帮我看一下日志", "timestamp": 1780081794000 },
    { "role": "assistant", "content": "可以，把日志贴出来。", "timestamp": 1780081795000 }
  ],
  "model": "deepseek-v4-pro",
  "pinned": false,
  "createdAt": 1780081794000,
  "updatedAt": 1780081795000
}
```

说明：

- `templateId` 必填
- `messages` 会整体替换，不是增量追加
- 若 `id` 不存在则创建，存在则更新
- 已加入协作会话的成员可保存共享消息，但不能通过该接口改标题、置顶等 owner 元数据

### `PATCH /api/chat-sessions/:id`

Owner 更新会话元数据，不改消息正文。

当前支持字段：

```json
{
  "title": "新标题",
  "pinned": true,
  "templateId": "agent-2",
  "model": "claude-sonnet"
}
```

### `PATCH /api/chat-sessions/:id/collaboration`

Owner 开启或关闭协作。

请求体：

```json
{
  "enabled": true
}
```

说明：

- 开启后，同租户用户可通过分享链接加入
- 关闭后，会移除成员访问权限

### `POST /api/chat-sessions/:id/join`

当前 JWT 用户加入已开启协作的同租户会话。

说明：

- API Key 身份不能加入协作会话
- 未开启协作、跨租户、或不存在的会话返回 404
- 成功后该会话会出现在 `GET /api/chat-sessions` 列表中

### `GET /api/chat-sessions/:id/events`

订阅协作会话变更事件。

返回格式：

- `Content-Type: text/event-stream`
- 事件体统一为 `data: {...}\n\n`

常见事件：

```json
{ "type": "connected", "sessionId": "chat-123" }
{ "type": "session_updated", "sessionId": "chat-123", "updatedAt": 1780081795000 }
{ "type": "session_deleted", "sessionId": "chat-123", "deletedAt": 1780081796000 }
```

客户端收到 `session_updated` 后应重新读取 `GET /api/chat-sessions/:id`，不要把事件体当作完整状态。

### `POST /api/chat-sessions/:id/fork`

复制当前可访问会话为自己的私有会话。Owner 和协作成员都可使用。

### `DELETE /api/chat-sessions/:id`

Owner 删除会话及其全部消息。

响应示例：

```json
{
  "ok": true
}
```

### 当前限制

- `GET /api/chat-sessions` 会直接返回完整消息数组，数据量大时会偏重
- `POST /api/chat-sessions` 采用整段覆盖写入，不是 append-only
- 协作会话同时保存时仍是后完成的请求覆盖前一个完整消息数组
- 暂未提供分页、搜索、摘要列表、单独消息追加接口

如果后续要给外部系统正式接入，建议下一版拆成：

- `GET /api/chat-sessions` 只返回摘要
- `GET /api/chat-sessions/:id/messages`
- `POST /api/chat-sessions/:id/messages`
- 分页和过滤参数

## 5. 租户与账号

### `GET /api/tenant`

读取当前租户信息。

### `PATCH /api/tenant`

管理员更新租户字段。

请求体示例：

```json
{
  "name": "New Workspace Name",
  "plan": "pro"
}
```

### `GET /api/users`

列出当前租户用户。

### `POST /api/users`

管理员在当前租户内创建用户。

请求体示例：

```json
{
  "name": "Member",
  "email": "member@example.com",
  "password": "secret123",
  "role": "member"
}
```

### `PATCH /api/users/:email`

管理员更新用户角色。

请求体示例：

```json
{
  "role": "team_admin"
}
```

可选值：

- `tenant_admin`
- `team_admin`
- `member`

### `DELETE /api/users/:email`

管理员删除指定用户。

## 6. API Key

### `GET /api/api-keys`

列出当前租户有效 API Key。

### `POST /api/api-keys`

管理员创建 API Key。

请求体示例：

```json
{
  "name": "CI Key",
  "scopes": ["chat", "sessions:read", "sessions:write"]
}
```

### `DELETE /api/api-keys/:id`

管理员吊销 API Key。A2A RPC 使用的 API Key 也通过此接口撤销。

## A2A 1.0（机器接口）

A2A Agent Card 可匿名读取；JSON-RPC 只接受租户 API Key，不接受网页登录 JWT。调用方必须为每个 RPC 请求发送：

```http
Authorization: Bearer <AgentMa API Key>
A2A-Version: 1.0
Content-Type: application/json
```

所有任务查询都在服务端按 `tenantId + templateId + API Key 调用者` 隔离。不存在和无权访问的任务返回相同的 task-not-found 错误。

### `GET /a2a/agents/:templateId/.well-known/agent-card.json`

返回已显式启用 `a2aPublished` 的模板 Card。Card 只包含公开名称、描述、能力和安全方案，不包含 system prompt、模型、工具路径、租户 ID、远程 Agent 配置或凭据。未发布、已归档、已删除、缺失或跨租户同 ID 冲突的模板返回 `404`。

生产部署应设置 `AGENTMA_PUBLIC_URL=https://example.com`，确保 Card 中的 RPC URL 是外部客户端可访问的绝对地址。

### `POST /a2a/agents/:templateId/rpc`

使用 A2A 1.0 JSON-RPC binding。支持：

- `SendMessage` 与流式发送消息
- `GetTask`
- `ListTasks`
- `SubscribeToTask`，重放已持久化事件后继续接收实时事件
- `CancelTask`

不支持 push notification、extended Agent Card、A2A 0.3、gRPC、HTTP+JSON binding、文件或二进制 Part。

发送消息示例：

```json
{
  "jsonrpc": "2.0",
  "id": "request-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "client-generated-uuid",
      "role": "ROLE_USER",
      "parts": [{ "text": "请总结本周进展" }]
    },
    "configuration": {
      "acceptedOutputModes": ["text/plain", "application/json"],
      "returnImmediately": false
    }
  }
}
```

相同 API Key 使用相同 `messageId` 重试时返回原任务，不会重复执行。流式事件会先写入 SQLite 再发送，客户端断线后可通过任务订阅重放。

当任务进入 `TASK_STATE_INPUT_REQUIRED` 时，使用返回的 `taskId` 和 `contextId` 继续：

```json
{
  "jsonrpc": "2.0",
  "id": "request-2",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "new-client-generated-uuid",
      "taskId": "task-id",
      "contextId": "context-id",
      "role": "ROLE_USER",
      "parts": [{ "data": { "decision": "allow" } }]
    }
  }
}
```

权限回复使用 `{ "decision": "allow" | "deny" }`；问题回复使用 `{ "answers": { "问题": "回答" } }`。等待时间默认 30 分钟，可用 `AGENTMA_A2A_INPUT_TIMEOUT_MS` 配置为 1 分钟至 24 小时。进程重启会把仍处于 submitted、working 或 input-required 的任务标记为失败；历史任务和事件仍可查询。

### A2A 模板配置

`PUT /api/agents` 中每个模板可包含：

```json
{
  "a2aPublished": true,
  "a2aRemoteAgents": [
    {
      "name": "researcher",
      "agentCardUrl": "https://remote.example/.well-known/agent-card.json",
      "credentialRef": "tenant-credential-id"
    }
  ]
}
```

每个模板最多配置 16 个远程 Agent。`name` 是可选的本地别名：编辑器会通过 `GET /api/a2a/discover?url=...` 安全读取 Card 名称并自动填充；留空保存时服务端会根据 URL 生成稳定名称。别名支持中文，在模板内不区分大小写唯一，运行时会转换为符合工具协议限制的稳定 ASCII 工具名。生产 Card URL 必须为 HTTPS，且不得在 URL 中嵌入用户名或密码。`AGENTMA_A2A_ALLOW_LOOPBACK_HTTP=1` 只为本地开发允许 loopback HTTP；Card 和选出的 RPC URL 仍会经过 DNS、地址固定、重定向、字节和超时限制。

### A2A 远程凭据

以下接口需要网页登录且租户管理员权限；API Key 不能管理凭据：

- `GET /api/a2a/credentials`：列出元数据，不返回密文或明文。
- `GET /api/a2a/credential-options`：列出编辑器可选的引用元数据。
- `POST /api/a2a/credentials`：创建，正文为 `{ "name": "Remote", "secret": "Bearer token value" }`。
- `PUT /api/a2a/credentials/:id`：轮换，正文为 `{ "secret": "new value" }`，引用 ID 不变。
- `DELETE /api/a2a/credentials/:id`：删除；仍被模板引用时返回 `409`。

凭据使用 AES-256-GCM 加密。`AGENTMA_A2A_CREDENTIAL_KEY` 必须是 base64 编码的 32 字节密钥；未设置时会在数据目录创建权限为 `0600` 的 `a2a-credential-key`。数据库备份必须同时安全备份该密钥，但应与数据库分开保存；密钥丢失后已有凭据不可恢复。明文或密文不会进入 Card、模板响应、任务、消息、事件、Artifact、审计或远程工具结果。

## 7. 配额

### `GET /api/quota`

读取当前租户配额。

### `PATCH /api/quota`

管理员更新配额。

请求体按字段局部更新，支持：

- `monthlyActiveSecondsLimit`
- `weeklyRunCountLimit`
- `maxConcurrentRuns`
- `perRunMaxActiveHours`
- `perRunMaxWallClockHours`
- `perRunMaxLlmTokens`
- `perRunMaxToolCalls`

## 8. 团队

### `POST /api/teams`

创建团队。

### `GET /api/teams`

列出团队。

### `GET /api/teams/:id/members`

列出团队成员。

### `POST /api/teams/:id/members`

添加成员。

请求体示例：

```json
{
  "userId": "member@example.com",
  "role": "member"
}
```

### `DELETE /api/teams/:id/members/:userId`

移除成员。

## 9. 审计日志

### `GET /api/audit-logs`

读取当前租户最近 50 条审计日志。

## 10. Agent 模板

### `GET /api/agents`

读取当前用户可见的 Agent 模板列表：自己创建的个人 Agent、已发布的公共 Agent，以及管理员可见的租户内全部 Agent。未发布且不属于当前用户的 Agent 不会返回。

### `GET /api/agents/:id/claude-md`

预览指定 Agent 真实运行时会加载的 `CLAUDE.md` / `CLAUDE.local.md` 文件。服务端优先使用该 Agent 最近一次可访问会话的 `sdkCwd`；如果没有运行会话，则按新会话默认临时 cwd 展示候选路径。响应包含 cwd 来源、候选文件命中状态、已加载文件列表和合并后的原始 Markdown。

### `PUT /api/agents`

保存当前用户的 Agent 模板列表。服务端按 `createdBy` 合并保存：普通用户只能修改、发布、撤回或删除自己创建的 Agent；其他用户已发布的公共 Agent 会保留但不会被本次保存改写。模板设置 `publishedAt` 后会进入公共 Agent 列表，撤回时清空 `publishedAt`。

## 11. Skills 公共目录

公共技能只支持学习成用户背包副本，不支持运行时引用、启用或直接使用公共技能。

### `GET /api/skills/public`

列出公共技能。

响应示例：

```json
[
  {
    "id": "skill-public-1",
    "slug": "code-review",
    "name": "code-review",
    "description": "代码审查技能",
    "authorSub": "admin@example.com",
    "authorTenantId": "tenant-uuid",
    "revision": 1,
    "publishedAt": 1780081794000,
    "updatedAt": 1780081794000
  }
]
```

### `GET /api/skills/public/:id`

读取单个公共技能详情。`:id` 可以是公共技能 `id` 或 `slug`。

### `POST /api/skills/public/:id/learn`

把公共技能复制到当前用户的技能背包。学习后得到的是用户级技能副本，后续公共技能更新不会自动同步到该副本。

请求体：

```json
{
  "nameOverride": "code-review-copy"
}
```

`nameOverride` 可选，用于解决用户背包里已有同名技能的情况。

成功响应示例：

```json
{
  "name": "code-review-copy",
  "description": "代码审查技能",
  "location": "user",
  "path": "/Users/me/.claude/skills/code-review-copy/",
  "enabled": false,
  "installed": true,
  "learnedFromPublicSkillId": "skill-public-1",
  "learnedFromPublicRevision": 1,
  "learnedAt": 1780081795000
}
```

### `POST /api/skills/public`

管理员把用户背包里的技能发布到公共目录。

请求体：

```json
{
  "path": "/Users/me/.claude/skills/code-review/",
  "name": "code-review",
  "description": "代码审查技能"
}
```

### `PATCH /api/skills/public/:id`

管理员更新本租户发布的公共技能。传入 `path` 或 `skillName` 时会复制新的技能包并递增 `revision`；只改 `name`、`description` 或 `slug` 时只更新公共目录信息。

## 12. 事件与部署

这部分接口主要服务当前站内的 MCP/事件桥接，不是稳定公开 API。

- `GET /api/events/health`
- `GET /api/deploy/status/:server`
- `POST /api/events/sources`
- `POST /api/sessions/:id/events/subscribe`
- `GET /api/sessions/:id/events`
- `POST /api/deploy`

如需对外开放，建议单独做版本化和权限收敛。
