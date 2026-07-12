# AgentMa A2A 出站调用观测实施计划

日期：2026-07-12

## 目标

给"本实例作为调用方去调远程 A2A Agent"这条**出站链路**补上结构化落库与观测页面。现状是出站调用（`server-a2a-client.ts` 的 `callA2ARemote` / `pollTask`）全程零 DB 写入，生命周期只活在内存 + 非持久化的 `onLog`（`scope:'a2a'`）SSE 日志里，唯一留痕是被烘进 assistant 消息正文的纯文本，不可查询。这直接导致"远端其实成功、本地却报超时"这类假失败无法事后定位。

本计划：
1. 新增 `a2a_outbound_calls` 表，记录每次出站调用的租户、会话/运行关联、远端 Agent、起止时间、结果、失败码、远端 taskId/contextId。
2. 埋点打在 A2A 协议客户端咽喉 `callA2ARemote`,**与调用面无关**——不管上面套 MCP 工具、直接编程调用还是未来别的触发面,所有出站调用都必经此处。持久化与关联 id 拼装放在新 store 模块,`callA2ARemote` 只接收一个 recorder 回调、零 DB 依赖。
3. 新增租户隔离的查询 API 与 Observability 页面的 A2A 出站 Tab。

**不做**：深层分布式追踪（span 瀑布、token/成本汇总、采样）。那部分若将来需要，从相同埋点吐 OTel span 指向 Phoenix/Jaeger，别自建 trace 后端。

**调用面无关(重要)**：MCP 包装(`buildA2ARemoteMcp` → `mcp__a2a__remote_*`)只是当前把 A2A 远端暴露给 SDK 工具循环的一种**presentation 层**,业务上保留但不一定长期使用。因此埋点绝不能挂在 MCP wrapper 上——必须挂在 `callA2ARemote`。MCP wrapper 退化成 recorder 的一个透传消费者;换任何调用方式,观测都不丢。

## 数据模型

新表 `a2a_outbound_calls`（一行 = 一次 `callA2ARemote` 调用）：

```sql
CREATE TABLE IF NOT EXISTS a2a_outbound_calls (
  id TEXT PRIMARY KEY,                                  -- 每次调用生成的 uuid
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT,                                      -- 触发的 chat 会话（关联）
  run_id TEXT,                                          -- 触发的 chat run（关联）
  template_id TEXT,                                     -- 调用方 Agent 模板
  caller_sub TEXT,                                      -- 触发用户 sub
  remote_id TEXT,                                       -- 稳定关联键:system-mcp-tool-registration spec 引入的 remote 稳定 id(改名/改 URL 不变);未落地或直接调用时为空
  agent_name TEXT,                                      -- 远端 config.name(仅展示用,可变;关联优先用 remote_id)
  sdk_tool_name TEXT,                                   -- 调用面元数据:经 MCP 时 mcp__a2a__remote_*,直接调用时为空
  card_url TEXT,                                        -- config.agentCardUrl
  remote_task_id TEXT,                                  -- 远端 task.id（若走到任务态）
  remote_context_id TEXT,
  outcome TEXT NOT NULL,                                -- 'ok' | 'error'
  error_code TEXT,                                      -- headers_timeout/total_timeout/connect_timeout/blocked_destination/task_timeout/rpc_error/other
  error_message TEXT,                                   -- 已脱敏、截断 <=500
  result_bytes INTEGER,                                 -- ok 时结果字节数
  poll_count INTEGER,                                   -- 轮询次数（可选）
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a2a_outbound_tenant_started
  ON a2a_outbound_calls (tenant_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_outbound_session
  ON a2a_outbound_calls (tenant_id, session_id, started_at DESC);
```

脱敏：`error_message` 必须复用客户端已有的凭证脱敏（`redactCredential`/`safeLogError` 已做），store 层不接触凭证。

## 关联链路（correlation）

目标：能 join 出「chat turn → 出站调用 → 远端任务」。当前 `RunAgentOptions` 不带 runId/sessionId，需补：

1. `server-agent.ts` `RunAgentOptions` 增加可选 `runId?: string; sessionId?: string;`（放在 `tenantId/sub` 附近，约 502 行）。
2. `server.ts` 两处 `runAgent({...})` 调用（约 2323 行主链路、5130 行 A2A 执行器链路）传入 `runId: run.id, sessionId: run.sessionId`（`ServerOwnedRun` 已有 `id`/`sessionId`/`tenantId`/`ownerSub`，见 server.ts:151）。
3. `server-agent.ts:1254` `buildA2ARemoteMcp(...)` 的 options 里透传 `runId`/`sessionId`，随 recorder 一起下沉给 `callA2ARemote`。

## 埋点接缝（打在 callA2ARemote，与调用面无关）

**主埋点在 `callA2ARemote` 本身**,不在 MCP wrapper。给 `callA2ARemote` 增加一个可选 recorder 参数:

```ts
type A2AOutboundRecorder = (record: {
  remoteId?: string;             // 稳定关联键(见 system-mcp-tool-registration spec);从 config.id 带入,缺失留空
  agentName: string; cardUrl: string;
  startedAt: number; endedAt: number;
  outcome: 'ok' | 'error';
  errorCode?: string; errorMessage?: string;
  resultBytes?: number;
  remoteTaskId?: string; remoteContextId?: string;
  pollCount?: number;
}) => void;

export async function callA2ARemote(
  tenantId, config, input, requester?, signal?,
  recorder?: A2AOutboundRecorder,   // 新增
) { ... }
```

- 在 `callA2ARemote` 函数体最外层包 `try/catch/finally`(约 [server-a2a-client.ts:266-322](../../dashboard/server-a2a-client.ts))：入口记 `startedAt`,`finally` 里算 `endedAt` 并调 `recorder`。这样连 discovery 失败(`resolveRpcUrl`)、凭证缺失都能被记录,因为它们都在函数体内。
- 失败码在 `catch` 里分类:`error instanceof OutboundRequestError ? error.code : classify(error)`(`headers_timeout`/`total_timeout`/`connect_timeout`/`blocked_destination` 来自 `OutboundRequestError.code`;`message === 'Remote Agent task timed out.'` → `'task_timeout'`;`/^Remote A2A error:/` → `'rpc_error'`;否则 `'other'`),`errorMessage = safeLogError(error)`(已凭证脱敏)。
- `remoteTaskId/remoteContextId` 在 `remoteTaskId = task?.id` 赋值处(约 285、313 行)记入闭包变量;`pollCount` 在 `pollTask` 里累加并回传(可 phase 2)。成功分支 `resultBytes = returned.length`。
- **客户端零 DB 依赖**,只调 recorder。`buildA2ARemoteMcp` 把它拿到的 recorder 透传给 `callA2ARemote`——MCP wrapper 只是众多可能调用方之一;将来任何直接 `callA2ARemote(...)` 的编排代码,传同一个 recorder 即可,观测不丢。

`server-agent.ts:1254` 处组装 recorder(会话/运行关联 id 在这层补齐):

```ts
const recorder = rec => recordA2AOutboundCall({
  tenantId: opts.tenantId, sessionId: opts.sessionId, runId: opts.runId,
  templateId: opts.templateId, callerSub: opts.sub,
  sdkToolName,                       // 从 descriptor 带入(仅当经 MCP 面时有值)
  ...rec,
});
// 经 MCP 面:buildA2ARemoteMcp(tenantId, remotes, { ..., recorder })
// 直接调用:callA2ARemote(tenantId, config, input, requester, signal, recorder)
```

> 注:`sdk_tool_name` 只在经 MCP 面调用时有值,故它属于"调用面元数据"、不是 A2A 协议字段——表里保持 nullable,直接调用时为空。

### 与 system-mcp-tool-registration 的对齐

关联键**优先用 `remote_id`(稳定 id),不用 `agent_name`(可变)**。该稳定 id 由 `docs/superpowers/specs/2026-07-12-system-mcp-tool-registration-design.md` 引入,是 `a2aRemoteAgents` 条目上的持久字段;落地后 `callA2ARemote` 从 `config.id` 取值经 recorder 落到 `remote_id`。两份文档触碰同一 `callA2ARemote` 接缝(本方案的 recorder + 该 spec 的"按选择过滤 remote"),须在一次协调改动里落地:**过滤先于 recorder,共用同一稳定-id 描述符与 recorder 透传接缝,谁先落地谁把接缝露出来**。稳定 id 未落地前 `remote_id` 留空,`agent_name` 仍写入作展示回退。

## Store 模块

新增 `dashboard/server-a2a-outbound-store.ts`，镜像 `server-a2a-store.ts` 的模块级 `defaultStore` + 薄导出模式：

- `initializeA2AOutboundStore(db)`：建表 + 索引（上文 SQL）。
- `recordA2AOutboundCall(input)`：生成 `id = crypto.randomUUID()`，`duration_ms = ended_at - started_at`，`error_message` 截断 500，INSERT。
- `listA2AOutboundCalls(scope, { sessionId?, limit?, cursor? })`：按 `tenant_id` 过滤，可选 `session_id`，`started_at DESC` 分页（游标复用 a2a-store 的 base64url `{startedAt,id}` 写法）。

在 [server-store.ts:482](../../dashboard/server-store.ts)（`initializeA2ATaskStore(db)` 之后）追加 `initializeA2AOutboundStore(db)`，共用同一 `db` handle。

## API

`server.ts` 新增（对齐现有 `/api/a2a/credentials` 的 authMiddleware 用法，约 2820 行附近）：

```
GET /api/a2a/outbound-calls?sessionId=&limit=&cursor=
```

- `authMiddleware`；`tenantId = req.auth.tenantId`。
- 非管理员（`req.auth.role !== 'tenant_admin'`）追加 `caller_sub = req.auth.sub` 过滤，只看自己触发的调用；管理员看本租户全部。
- 返回 `{ calls: [...], nextCursor?: string }`。

## 前端

`dashboard/src/pages/Observability.tsx`（现只 fetch `/api/audit-logs` 渲染 runs，用 `useAuth` + `normalizeRunOutcome`/`outcomeBadgeClass`）：

1. 顶部加 Tab 切换：`审计日志` / `A2A 出站`。
2. A2A 出站 Tab：fetch `/api/a2a/outbound-calls`，表格列：时间、远端 Agent（`agent_name` + `sdk_tool_name`）、结果 badge（复用 `outcomeBadgeClass`，ok→绿/error→红）、耗时（`duration_ms` 格式化）、失败码（`error_code`）、远端 taskId、会话链接（`session_id` → `/conversations?...&conversationId=`）。
3. 顶部按 `session_id` 过滤输入框；失败码用小 badge 高亮 `*_timeout`。

## 验证

server*.ts 不在 tsconfig、tsc 全绿也可能悬空崩，必须实跑（见项目 gotcha）：

1. 新增 `dashboard/scripts/smoke-a2a-outbound.mjs`：直接调 `recordA2AOutboundCall` 写入 ok/error 两条，再打 `GET /api/a2a/outbound-calls`（带/不带 sessionId、管理员/普通用户各一次）断言过滤与分页；镜像 `scripts/smoke-mcp-connections.mjs`。
2. 用 `AGENTMA_A2A_ALLOW_LOOPBACK_HTTP=1` 起一个本地回环 A2A agent，真实触发一次 `callA2ARemote`，确认成功/超时两种路径都落一行且 `error_code` 正确。
3. `npm run build`，然后 `launchctl kickstart -k .../ai.agentma2.dashboard`（部署是手动的，push≠live），在 dandelion.skin 上验证 Observability 的 A2A Tab 有数据。

## 步骤

1. 建 `server-a2a-outbound-store.ts`（建表 + record + list），在 `server-store.ts` 接入 init。
2. `callA2ARemote` 加可选 `recorder` 参数,函数体最外层 try/catch/finally 测时 + 分类失败码 + 捕获 remote task/context id,客户端零 DB 依赖;`buildA2ARemoteMcp` 仅透传 recorder(不在 wrapper 埋点)。
3. `RunAgentOptions` 加 `runId/sessionId`，`server.ts` 两处 `runAgent` 传入，`server-agent.ts` 组装 recorder(补会话/运行关联 id)接到 store,并下沉给 `callA2ARemote`/`buildA2ARemoteMcp`。
4. 加 `GET /api/a2a/outbound-calls`（租户隔离 + 非管理员 own-sub 过滤）。
5. Observability 页加 A2A 出站 Tab + 会话过滤。
6. 写 smoke，回环真实触发验证，构建 + kickstart 部署，线上验收。
