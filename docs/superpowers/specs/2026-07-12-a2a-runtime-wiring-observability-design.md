# A2A 普通运行接线与可观测性修复设计

## 背景

Agent 模板能够保存远程 A2A Agent 配置，入站 A2A Task 执行也会把这些配置传给 `runAgent()`。但普通聊天 `/api/chat` 和页面运行 `/api/agents/run` 没有传递 `a2aRemoteAgents`，因此用户最常使用的运行入口不会创建远程 A2A MCP 工具。

当前生产 Agent Card 还会因服务进程缺少 `AGENTMA_PUBLIC_URL` 而根据反向代理后的内部 HTTP 请求生成 `http://dandelion.skin/.../rpc`。出站 URL 防护会拒绝该地址。运行流也没有区分“远程工具已加载”“模型未选择调用”和“远程调用失败”，导致用户无法判断 A2A 是否生效。

## 目标

- 普通聊天和页面 Agent 运行都使用服务端保存的远程 A2A 配置。
- 不信任请求体携带的远程配置；只使用当前租户可见的已保存模板。
- 在聊天流中明确显示远程工具加载和调用结果，不泄露凭据。
- 生产 Agent Card 发布 HTTPS RPC URL。
- 用回归测试覆盖两个普通运行入口及日志行为。

## 非目标

- 本切片不开发完整的多 Agent 协作监控页面。
- 不改变模型自主决定是否调用远程 Agent 的行为。
- 不把 A2A 运行时工具写入静态 Tools 目录。
- 不改变 A2A 认证模型或放宽 SSRF 防护。

## 服务端接线

### `/api/chat`

该入口已经按 `templateId` 读取 `getVisibleAgentTemplate()`。调用 `runAgent()` 时新增：

```ts
a2aRemoteAgents: template?.a2aRemoteAgents
```

这样配置来源保持为服务端规范化后的模板，无法通过请求体伪造凭据引用或跨租户远程配置。

### `/api/agents/run`

该入口同时接收页面提交的模板快照和可选模板 ID。远程 A2A 配置只取 `storedTemplate?.a2aRemoteAgents`；没有可见的已保存模板时，不接受请求体中的远程配置。

页面运行应继续使用已保存模板的 ID、seed 和租户权限上下文。其余已有的模型、工具和知识配置合并行为不在本次修改范围内。

## 运行日志

`runAgent()` 在成功创建 A2A MCP server 后发出一条 `run_log`：列出已加载的远程别名和最终 SDK 工具名，例如：

```text
A2A 已加载：可视化 (mcp__a2a__remote_agent_333f1a10)
```

工具处理器在实际调用前、成功后和失败后分别发出 A2A 范围日志。日志只包含本地别名、远程 Task ID（如存在）、状态和经过截断的安全错误信息；不输出 Authorization、凭据内容或完整远程响应。

`AgentEvent.run_log.scope` 增加 `a2a`。现有聊天页面已经显示 `run_log`，无需新增页面结构即可让用户看到以下状态：

1. 配置已注入并生成工具。
2. 模型是否实际选择了远程工具。
3. 请求是否成功到达远程 Agent。
4. 失败发生在发现、认证、RPC 还是远程执行阶段。

## A2A 客户端边界

`buildA2ARemoteMcp()` 接收一个可选事件回调，由 `runAgent()` 注入。工具名继续使用现有稳定 ASCII 生成规则。调用事件在 MCP 工具处理器内部产生，因此只有模型真正调用时才记录“调用开始”。

凭据继续由 `credentialRef` 在服务端即时解析。错误信息继续经过凭据清理和长度限制。发现及 RPC 仍统一经过 `guardedFetch()`，不为修复生产 URL 而放宽 HTTP 或私网限制。

## 部署配置

LaunchAgent 的环境变量增加：

```text
AGENTMA_PUBLIC_URL=https://dandelion.skin
```

随后重新加载 `ai.agentma2.dashboard` 服务。重新加载后同时检查两个公开 Card，确认 `supportedInterfaces[0].url` 均为 HTTPS，并对 RPC 端点做一次不含密钥的协议探测以确认其返回 JSON 而非 HTML。

## 错误处理

- 模板没有远程配置：不创建 A2A MCP，也不显示加载日志。
- Card 发现失败：工具返回 `isError: true`，同时显示脱敏的 A2A 失败日志。
- 远程要求认证：仍使用模板引用的租户凭据；不存在或无效时明确显示认证/RPC 失败。
- 模型没有调用：只显示“已加载”，不伪造调用记录。
- 客户端取消运行：沿用现有 AbortSignal 和远程 CancelTask 尝试。

## 测试与验收

新增回归覆盖：

- `/api/chat` 的已保存模板远程配置会传入 `runAgent()`。
- `/api/agents/run` 只注入已保存模板远程配置，不信任请求体伪造配置。
- 中文别名生成稳定的 ASCII SDK 工具名。
- 加载、开始、成功和失败日志均出现且不包含凭据。
- 无远程配置时不会创建 A2A server 或日志。

运行现有 `npm run smoke:a2a` 与 `npm run build`，并进行生产 Card HTTPS 验证。验收时在“自主agent”对话中发送明确任务，例如“请调用可视化 Agent，把以下数据制作成图表”，页面应先显示工具加载日志，再显示实际 A2A 调用日志；如果模型未调用，也能从只有加载日志这一事实清楚判断。
