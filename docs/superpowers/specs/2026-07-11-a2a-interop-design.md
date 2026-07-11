# AgentMa A2A 1.0 Interoperability Design

## Summary

AgentMa will expose each explicitly published Agent template as an independent A2A 1.0 Agent and allow templates to call remote A2A Agents. The implementation will use the official `@a2a-js/sdk` at the protocol boundary and reuse the existing `runAgent()` execution path for models, tools, permissions, quotas, and sandboxing.

The first release supports the A2A 1.0 JSON-RPC binding and SSE streaming. It does not change the existing `/api/chat` or `/api/agents/run` contracts.

## Goals

- Publish an Agent Card for each template whose owner enables A2A publishing.
- Accept authenticated A2A messages and execute them with the selected AgentMa template.
- Persist tasks, messages, artifacts, and replayable events.
- Support task lookup, listing, cancellation, idempotency, streaming, and input-required continuation.
- Let an AgentMa template call configured remote A2A 1.0 Agents as tools.
- Preserve tenant isolation, API-key authentication, quota accounting, sandbox behavior, and existing Agent execution behavior.

## Non-goals

- A2A 0.3 compatibility.
- gRPC or HTTP+JSON bindings.
- Push-notification webhooks.
- File or binary message parts.
- A public Agent registry or marketplace discovery.
- Cross-tenant discovery.
- A new task-monitoring dashboard. The only required UI is template publishing and remote-Agent configuration.

## Protocol and Routes

Each published template is one independently addressable A2A Agent:

- `GET /a2a/agents/:templateId/.well-known/agent-card.json`
- `POST /a2a/agents/:templateId/rpc`

Agent Cards are publicly readable. RPC requests require `Authorization: Bearer <api-key>` and an `A2A-Version: 1.0` service parameter. Existing AgentMa JWTs are not advertised as an A2A security scheme; the A2A integration uses tenant API keys intended for machine-to-machine access.

The card advertises:

- A2A protocol version `1.0`.
- The `JSONRPC` interface and template-specific RPC URL.
- Streaming, task lookup, task listing, and task cancellation.
- `text/plain` and structured JSON input/output modes.
- A Bearer security scheme.
- Skills derived from the public-safe template name, summary, tags, and example prompts.

An unpublished, missing, archived, or otherwise unavailable template returns `404` for its Agent Card. RPC authorization failures and inaccessible tasks must not reveal whether a protected resource exists.

## Architecture

### Protocol adapter

A new `dashboard/server-a2a.ts` module owns the A2A boundary. It wires the official A2A Express handlers into the existing Express application, validates protocol versions, translates SDK requests into internal commands, and maps internal events back into A2A data objects.

The module depends on narrow application interfaces rather than importing unrelated server state:

- Template lookup and authorization.
- API-key identity resolution.
- Task storage.
- Agent execution.
- Secret resolution.
- Remote-card fetching and remote A2A calls.

`dashboard/server.ts` only mounts the handlers and provides these dependencies. Existing chat endpoints remain unchanged.

### Execution adapter

The A2A executor builds `RunAgentOptions` from the stored template and authenticated tenant identity, then calls the existing `runAgent()` function. It does not call `/api/agents/run` over HTTP. This preserves a single execution core without creating an internal network hop.

The adapter continues to enforce the existing provider routing, quota checks, permission rules, knowledge-source access, datasource access, skills, MCP configuration, sandboxing, and audit behavior.

### Official SDK boundary

`@a2a-js/sdk` supplies the A2A 1.0 models, JSON-RPC dispatch, SSE framing, Agent Card helpers, and client implementation. AgentMa-specific code supplies execution and storage implementations. Protocol objects are validated at ingress and emitted only in the A2A 1.0 representation.

## Template Configuration

Agent templates gain these fields:

```ts
type A2ARemoteAgentConfig = {
  name: string;
  agentCardUrl: string;
  credentialRef?: string;
};

type AgentTemplateA2AConfig = {
  a2aPublished: boolean;
  a2aRemoteAgents: A2ARemoteAgentConfig[];
};
```

`a2aPublished` defaults to `false`. Publishing is an explicit owner or tenant-admin action.

`credentialRef` identifies a tenant-owned secret. The template API may return the reference identifier but never the resolved secret. Secret values must not appear in Agent Cards, logs, audit payloads, A2A messages, tool results, or frontend state.

The existing Agent editor gains:

- An A2A publishing toggle.
- The computed public Agent Card URL.
- A repeatable remote-Agent editor containing name, Agent Card URL, and credential reference.

## Persistence

SQLite gains four tenant-scoped tables.

### `a2a_tasks`

Stores task identity and current state:

- `id`
- `tenant_id`
- `template_id`
- `caller_sub`
- `context_id`
- `message_id`
- `state`
- `status_message_json`
- `final_message_json`
- `error_json`
- `created_at`
- `updated_at`
- `completed_at`

`tenant_id + template_id + caller_sub + message_id` is unique when a message ID is supplied. This implements retry idempotency without allowing one caller to observe another caller's request.

### `a2a_messages`

Stores ordered inbound and outbound A2A messages, including role, message ID, task ID, context ID, serialized parts, and timestamp.

### `a2a_artifacts`

Stores task artifacts. Final structured output becomes a JSON artifact. Final text remains an Agent message and may also be represented as a text artifact when the official SDK's response contract requires it.

### `a2a_task_events`

Stores an increasing sequence number and serialized A2A event for each task. The event log supports stream replay after reconnect and provides an audit trail. Retention follows the same policy as task records; no event is stored outside its task's tenant and caller scope.

On process startup, tasks left in submitted, working, or input-required states are marked failed with a restart-interruption reason. Historical tasks remain queryable.

## Operations and State Mapping

The JSON-RPC endpoint supports the A2A 1.0 operations corresponding to:

- Send message.
- Stream message.
- Get task.
- List tasks.
- Cancel task.

Push-notification and extended-card operations return the standard unsupported-operation error.

Internal execution events map to A2A states as follows:

| Internal condition | A2A state |
| --- | --- |
| Accepted but not executing | `TASK_STATE_SUBMITTED` |
| Agent execution active | `TASK_STATE_WORKING` |
| Permission decision or user answer required | `TASK_STATE_INPUT_REQUIRED` |
| Successful result | `TASK_STATE_COMPLETED` |
| Execution or provider error | `TASK_STATE_FAILED` |
| Client cancellation | `TASK_STATE_CANCELED` |
| Policy or quota rejection after task creation | `TASK_STATE_REJECTED` |

Validation, authentication, or quota failures detected before task creation return protocol errors and do not create task records.

Every transition is committed to `a2a_tasks` and appended to `a2a_task_events` before it is emitted to a live SSE subscriber. Streaming clients therefore cannot observe an event that cannot later be replayed.

## Input-required Continuation

The existing permission requester and `AskUserQuestion` requester are adapted into an A2A pause controller.

When either requests input:

1. Persist the pending interaction descriptor on the task.
2. Transition the task to `TASK_STATE_INPUT_REQUIRED` with a clear Agent message describing the required decision or answer.
3. Keep the live execution suspended for a bounded period.
4. Accept a new `SendMessage` whose message has the same `contextId` and the pending task's `taskId`.
5. Validate and translate the response into the existing permission or question resolver.
6. Transition back to `TASK_STATE_WORKING` and continue execution.

If the process restarts while input is pending, the original in-memory SDK execution cannot be resumed safely. The task is marked failed with an interruption explanation. The client may start a new task in the same context using the stored conversation messages.

A normal follow-up message in the same context creates a new task. It does not mutate a completed task.

## Cancellation

Live tasks are registered by task ID with an `AbortController`. `CancelTask`:

- Verifies tenant, template, and caller ownership.
- Returns `TaskNotCancelableError` for terminal tasks.
- Aborts live local execution.
- Attempts cancellation of any active remote A2A child task.
- Persists and emits `TASK_STATE_CANCELED` exactly once.

Cancellation never launches new work. After a task reaches any terminal state, including canceled, another cancellation request returns `TaskNotCancelableError` as required by the advertised operation semantics.

## Remote A2A Agents

Each configured remote Agent is exposed to `runAgent()` as a generated internal tool with a stable, sanitized name. The tool accepts text or JSON input and may request streaming. Its result contains the remote final message, artifacts, remote task ID, and non-secret metadata.

### Card discovery

The server fetches the configured Agent Card, validates A2A 1.0 support, selects a JSON-RPC interface, and caches the validated card for a short bounded period. Cache keys include tenant and URL so tenant credentials and policy cannot cross boundaries.

### Authentication

If `credentialRef` is configured, the server resolves it immediately before the remote request and sends it as a Bearer token. Resolved values are never persisted in task events or remote-call results.

### Remote task behavior

- Completed remote messages and artifacts become the local tool result.
- Remote working updates may be summarized into local progress events.
- Remote `TASK_STATE_INPUT_REQUIRED` pauses the local parent task. The caller's continuation is forwarded to the same remote context and task.
- Local cancellation triggers a best-effort remote `CancelTask` before the local task reaches canceled state.
- Remote failure produces a bounded diagnostic tool error; it does not expose remote credentials or raw untrusted headers.

## Network Security

Remote Agent Card and RPC URLs are untrusted input. The remote client must:

- Require HTTPS in production.
- Permit HTTP only for loopback hosts when an explicit development flag is enabled.
- Resolve DNS and reject loopback, link-local, private, multicast, unspecified, and cloud-metadata destinations in production.
- Revalidate every redirect target and cap redirects.
- Apply connection, response, and total-operation timeouts.
- Limit Agent Card, message, event, and artifact sizes.
- Reject unsupported content types and protocol versions.
- Avoid forwarding inbound headers other than explicitly supported A2A service parameters and the resolved remote credential.

These controls apply to initial Card discovery and every subsequent RPC endpoint selected from the Card.

## Authentication and Authorization

Agent Card retrieval is anonymous but only available for explicitly published templates. Cards contain public-safe metadata only.

RPC uses existing AgentMa API keys as Bearer credentials. Authentication resolves a tenant and machine identity. Every task operation is scoped by:

- `tenant_id`
- `template_id`
- `caller_sub`

An inaccessible task returns the same not-found response as a nonexistent task. API keys cannot invoke unpublished templates. Existing tenant quota and template visibility rules apply to A2A execution.

## Error Handling

The adapter uses A2A 1.0 standard error semantics and JSON-RPC codes:

- Invalid JSON or request envelope: standard JSON-RPC parse/request errors.
- Invalid message, parts, version, or parameters: invalid-params or version-not-supported.
- Missing or inaccessible task: task-not-found.
- Terminal task cancellation: task-not-cancelable.
- Unsupported push notification or binding operation: unsupported-operation.
- Unsupported media type: content-type-not-supported.
- Unexpected internal failure: internal error with a correlation ID.

User-visible errors are bounded and sanitized. Full diagnostics are server-side and include tenant-safe correlation data, not secrets.

## Observability and Quotas

Local Agent execution retains existing token and conversation quota accounting. A2A task records add protocol-level duration, state transition, remote-call count, and remote latency metrics.

Remote-provider token or monetary costs are not added to local token usage because AgentMa cannot verify them. The system records remote Agent name, host, task ID, duration, terminal state, and byte counts for operational visibility.

## Testing

### Unit tests

- A2A Part and message conversion.
- Internal-event to A2A-state mapping.
- JSON-RPC and A2A error mapping.
- Protocol-version validation.
- URL, redirect, DNS, and SSRF policy.
- Message-ID idempotency.
- Secret redaction.

### Storage tests

- Tenant, template, and caller isolation.
- State transition atomicity.
- Event sequence ordering and replay.
- Duplicate message handling.
- Cancellation and terminal-state behavior.
- Startup reconciliation of interrupted tasks.

### Protocol integration tests

Use the official A2A JavaScript client against a real local Express server to verify:

- Public Agent Card discovery.
- Bearer authentication.
- Synchronous send.
- SSE streaming and replay.
- Task get and list filtering.
- Cancellation.
- Structured output artifact creation.
- Standard error responses.

### Bidirectional tests

Run two local published AgentMa templates and verify:

- One discovers and invokes the other through a generated tool.
- Remote text and structured artifacts return to the parent Agent.
- Remote input-required state propagates to the parent and resumes after a caller response.
- Parent cancellation attempts remote cancellation.
- Remote credentials never appear in persisted events or output.

### Regression tests

Run the existing chat, Agent execution, permission, provider-routing, quota, knowledge, and subagent smoke tests. Existing endpoint response shapes must remain unchanged.

## Delivery Criteria

The feature is complete when:

- A published template is discoverable through its public A2A 1.0 Agent Card.
- The official A2A JavaScript client can authenticate, send and stream messages, query/list tasks, and cancel a live task.
- Task state, messages, artifacts, and events survive process restarts, with interrupted live work reconciled explicitly.
- Permission and question flows appear as input-required and can resume during the live process lifetime.
- An AgentMa Agent can securely invoke another A2A 1.0 Agent configured on its template.
- Tenant/caller isolation, SSRF protections, idempotency, and secret redaction tests pass.
- Existing AgentMa chat and Agent-run behavior passes regression tests.

## Implementation Sequence

1. Add the official SDK and define the protocol adapter interfaces.
2. Add template fields, validation, storage, and Agent editor controls.
3. Add A2A task/message/artifact/event storage and startup reconciliation.
4. Implement Agent Card and authenticated JSON-RPC routing.
5. Implement execution, state mapping, streaming, replay, listing, and cancellation.
6. Implement input-required pause and live continuation.
7. Implement secure remote Card discovery, secret resolution, and generated remote tools.
8. Add protocol, bidirectional, security, and regression tests.
