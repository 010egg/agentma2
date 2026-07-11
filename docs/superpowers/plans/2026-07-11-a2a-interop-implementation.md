# AgentMa A2A 1.0 Implementation Plan

## Objective

Implement the approved A2A interoperability design in small, independently verifiable slices while preserving the existing chat and Agent-run interfaces. Each slice should compile and have focused tests before the next slice begins.

## Working-tree rule

The repository already contains unrelated user changes. Before every edit, inspect the target diff and preserve those changes. Stage and commit only files belonging to the current A2A slice. Do not use destructive checkout or reset commands.

## Task 1: Pin and verify the official A2A 1.0 SDK

Files:

- Modify `dashboard/package.json`
- Modify `dashboard/package-lock.json`
- Add `dashboard/scripts/smoke-a2a-sdk.mjs`

Steps:

1. Install exact version `@a2a-js/sdk@1.0.0-beta.0`; do not use a range.
2. Inspect the installed exports and official Express/client examples.
3. Write a minimal in-process Express smoke server using the SDK's 1.0 Agent Card, JSON-RPC, and SSE helpers.
4. Call it with the official 1.0 client and assert Card discovery, send, stream, get, list, cancel, enum serialization, and `A2A-Version: 1.0` behavior that the SDK actually supports.
5. Record any SDK gaps in comments adjacent to the adapter boundary; do not silently fall back to 0.3 shapes.

Verification:

```bash
cd dashboard
node scripts/smoke-a2a-sdk.mjs
npm run build
```

Commit:

```text
chore(a2a): pin and verify official 1.0 SDK
```

## Task 2: Add reusable credential encryption and storage

Files:

- Add `dashboard/server-credentials.ts`
- Modify `dashboard/server-store.ts`
- Modify `dashboard/server.ts`
- Add `dashboard/scripts/smoke-a2a-credentials.mjs`
- Modify `dashboard/README.md`

Steps:

1. Implement a versioned AES-256-GCM envelope with random 96-bit nonces and authentication tags.
2. Load a 32-byte key from `AGENTMA_A2A_CREDENTIAL_KEY`, or create `a2a-credential-key` in `AGENTMA_DATA_DIR` with mode `0600`.
3. Add `a2a_credentials` with tenant foreign key, encrypted value, creator, and timestamps. Never expose ciphertext from store APIs.
4. Add tenant-admin credential APIs for list metadata, create, rotate, and delete. Password/JWT identities may manage credentials; API-key identities may resolve credentials for A2A execution but may not administer them.
5. Reject deletion when any non-deleted template references the credential.
6. Audit create, rotate, and delete without storing plaintext or ciphertext in the audit diff.
7. Document backup requirements for `a2a-credential-key` and the environment override.

Verification:

- Round-trip encryption and authenticated-decryption failure.
- Ciphertexts differ for the same plaintext.
- Cross-tenant reads fail.
- API responses and logs contain no secret.
- Referenced credentials cannot be deleted; rotation preserves ID.

Commit:

```text
feat(a2a): add encrypted tenant credentials
```

## Task 3: Extend Agent templates and editor configuration

Files:

- Modify `dashboard/src/simulator/types.ts`
- Modify `dashboard/src/utils/agent-templates.ts`
- Modify `dashboard/server-store.ts`
- Modify `dashboard/server.ts`
- Modify `dashboard/src/pages/Agents.tsx`
- Modify `dashboard/src/App.css` only where required for the new controls
- Modify `dashboard/scripts/smoke-agent-import.mjs`
- Add `dashboard/scripts/smoke-a2a-template-config.mjs`

Steps:

1. Add normalized `a2aPublished` and `a2aRemoteAgents` fields to the shared template type.
2. Validate remote names, HTTPS Card URLs, duplicate names, array limits, and credential references on server write. Allow loopback HTTP only when the development flag is active.
3. Preserve the fields through list, replace, import, clone, archive, restore, and local-cache normalization paths.
4. Restrict A2A publishing and remote credential selection to template managers.
5. Add the publishing toggle, computed Card URL, remote-Agent rows, and credential metadata management UI.
6. Show secret values only in create/rotate input fields; clear them immediately after submission and never reload them.

Verification:

- Existing templates normalize to `a2aPublished: false` and an empty remote list.
- Unauthorized users cannot change A2A configuration.
- Import/export and clone behavior preserve references without exporting secret values.
- Existing Agent editor changes in the dirty worktree remain intact.

Commit:

```text
feat(a2a): configure published and remote agents
```

## Task 4: Add A2A task persistence

Files:

- Add `dashboard/server-a2a-store.ts`
- Modify `dashboard/server-store.ts` only for schema bootstrap if necessary
- Add `dashboard/scripts/smoke-a2a-store.mjs`

Steps:

1. Add `a2a_tasks`, `a2a_messages`, `a2a_artifacts`, and `a2a_task_events` with foreign keys and tenant-aware indexes.
2. Define typed store operations for create, transition, append message, append artifact, append event, get, filtered list, and idempotency lookup.
3. Use a transaction to persist state and its corresponding event atomically.
4. Enforce `tenantId + templateId + callerSub` scope in every query rather than filtering after reads.
5. Implement cursor-based task listing with bounded page size.
6. On startup, reconcile submitted, working, and input-required rows to failed with an interruption message and event.

Verification:

- State transition and event sequence are atomic and monotonically ordered.
- Duplicate message IDs return the existing task.
- Cross-tenant, cross-template, and cross-caller reads produce not-found.
- Restart reconciliation is deterministic and idempotent.

Commit:

```text
feat(a2a): persist tasks messages and events
```

## Task 5: Implement the public Agent Card and authenticated RPC boundary

Files:

- Add `dashboard/server-a2a.ts`
- Modify `dashboard/server.ts`
- Add `dashboard/scripts/smoke-a2a-protocol.mjs`

Steps:

1. Define narrow adapter dependencies for template lookup, authentication, task store, execution, credentials, and outbound client.
2. Mount the template-specific Card and RPC routes before the SPA fallback.
3. Build public-safe A2A 1.0 Cards only for active templates with `a2aPublished === true`.
4. Advertise JSON-RPC 1.0, streaming, supported text/JSON modes, and Bearer authentication.
5. Require existing AgentMa API keys for RPC. Reject JWTs for A2A machine endpoints so the advertised security behavior is exact.
6. Validate `A2A-Version: 1.0`, request size, JSON-RPC envelope, message parts, and supported operations.
7. Map validation, authentication, authorization, not-found, not-cancelable, unsupported operation, version, and content-type errors to standard A2A/JSON-RPC results.

Verification:

- Unpublished/missing Card returns 404 without metadata leakage.
- API-key tenant can call only visible published templates in that tenant.
- Official client passes Card and protocol error tests.
- Existing `/api/*` and SPA fallback behavior remain unchanged.

Commit:

```text
feat(a2a): expose agent cards and RPC boundary
```

## Task 6: Adapt `runAgent()` to A2A execution and streaming

Files:

- Add `dashboard/server-a2a-executor.ts`
- Modify `dashboard/server-a2a.ts`
- Modify `dashboard/server-agent.ts` only through additive adapter hooks where unavoidable
- Add `dashboard/scripts/smoke-a2a-execution.mjs`

Steps:

1. Build `RunAgentOptions` from the stored template and authenticated API-key identity using the same provider, quota, knowledge, datasource, skill, MCP, sandbox, and permission setup as existing runs.
2. Extract or reuse shared run-option construction where duplication would cause the A2A and existing endpoints to diverge. Keep public endpoint response shapes unchanged.
3. Register live tasks with `AbortController` and a bounded subscriber set.
4. Translate internal events into submitted, working, status update, message, artifact, and terminal A2A events.
5. Persist each event before SSE emission and replay stored events on reconnect.
6. Persist final text as an Agent message and `structuredOutput` as a JSON artifact.
7. Record existing quotas exactly once per run, including failure and cancellation paths.

Verification:

- Official client can send, stream, reconnect, get, list, and cancel.
- Slow/disconnected SSE clients do not leak listeners or prevent execution cleanup.
- Completed, failed, rejected, and canceled states are emitted exactly once.
- Existing chat/run smoke tests still pass.

Commit:

```text
feat(a2a): execute and stream persisted tasks
```

## Task 7: Implement input-required pause and continuation

Files:

- Add `dashboard/server-a2a-input.ts`
- Modify `dashboard/server-a2a-executor.ts`
- Modify `dashboard/server-a2a.ts`
- Add `dashboard/scripts/smoke-a2a-input-required.mjs`

Steps:

1. Add a live pause registry keyed by tenant, caller, template, and task ID.
2. Convert permission and `AskUserQuestion` requests into a persisted input descriptor and `TASK_STATE_INPUT_REQUIRED` status message.
3. Parse continuation messages only when both `contextId` and `taskId` match the pending interaction.
4. Validate explicit permission decisions and structured question answers, then invoke the existing resolvers and return to working.
5. Enforce a default 30-minute timeout with `AGENTMA_A2A_INPUT_TIMEOUT_MS` constrained to 1 minute–24 hours.
6. Fail timed-out and restart-interrupted tasks cleanly; remove registry entries on all terminal paths.

Verification:

- Permission allow/deny and question answers resume the same live task.
- Mismatched caller/context/task cannot resume it.
- Timeout and cancellation release promises and listeners.
- Restart reconciliation explains that live execution could not resume.

Commit:

```text
feat(a2a): support input-required continuation
```

## Task 8: Build the standalone outbound URL guard

Files:

- Add `dashboard/server-outbound-url.ts`
- Add `dashboard/scripts/smoke-outbound-url-guard.mjs`
- Modify `dashboard/README.md`

Steps:

1. Parse and normalize URLs; allow HTTPS only in production.
2. Resolve all A/AAAA results and require every result to be globally routable unicast; explicitly reject loopback, RFC1918, link-local, carrier-grade NAT, multicast, unspecified, documentation/test, benchmark, reserved, and known metadata destinations for both IPv4 and IPv6.
3. Connect to the validated resolved address while preserving the original TLS server name and Host header to prevent DNS rebinding between check and connection.
4. Re-run validation for every redirect and cap redirect count.
5. Add connect, headers, idle, and total timeouts plus byte limits.
6. Permit loopback HTTP only behind an explicit development flag and never infer development mode from an arbitrary request.
7. Return sanitized errors that do not reveal internal resolved addresses to tenants.

Verification:

- IPv4, IPv6, encoded host, redirect, mixed-DNS, and DNS-rebinding cases are covered.
- Metadata and private network targets are blocked.
- Allowed public HTTPS and explicit local-development cases work.

Commit:

```text
feat(security): add guarded outbound URL client
```

## Task 9: Implement remote A2A tools

Files:

- Add `dashboard/server-a2a-client.ts`
- Modify `dashboard/server-agent.ts`
- Modify `dashboard/server-a2a-executor.ts`
- Add `dashboard/scripts/smoke-a2a-bidirectional.mjs`

Steps:

1. Fetch and cache remote Cards through the outbound guard, keyed by tenant and URL with bounded TTL/size.
2. Validate A2A 1.0 and select a JSON-RPC interface; never accept an endpoint that fails the same outbound policy.
3. Resolve credentials just before calls and add only the allowed A2A headers and Bearer token.
4. Generate stable sanitized internal tools for configured remotes, with bounded text/JSON inputs and outputs.
5. Map completed messages and artifacts into tool results; summarize progress without persisting secrets or unbounded remote payloads.
6. Propagate remote input-required to the parent pause controller and forward the continuation to the same remote task/context.
7. Track remote child task IDs and attempt cancellation when the parent is canceled.

Verification:

- Two local AgentMa Agents complete a bidirectional call using the official client/server paths.
- Structured artifacts survive the round trip.
- Input-required and cancellation propagate.
- Credential values do not appear in logs, database JSON fields, events, or tool results.

Commit:

```text
feat(a2a): call remote agents as tools
```

## Task 10: Complete conformance, security, and regression coverage

Files:

- Add `dashboard/scripts/smoke-a2a.mjs` as the orchestrating suite
- Modify `dashboard/package.json` scripts
- Update `dashboard/docs/api.md`
- Update `dashboard/README.md`

Steps:

1. Assemble all A2A smoke tests under `npm run smoke:a2a`.
2. Add malformed protocol payload, oversized body/event, auth leakage, task isolation, duplicate message, reconnect, timeout, cancellation race, restart, and SSRF cases.
3. Document Card URLs, authentication, supported operations, examples, configuration, environment flags, credential backup, and stated non-goals.
4. Run TypeScript build and lint; distinguish pre-existing failures from regressions with exact evidence.
5. Run the existing high-risk smoke suites for chat write/resume, permissions, questions, subagents, provider routing, quota, knowledge, Agent import/visibility, and sandbox environment.

Verification:

```bash
cd dashboard
npm run build
npm run lint
npm run smoke:a2a
npm run smoke:chat-write
npm run smoke:chat-resume
npm run smoke:chat-ask-user-question
npm run smoke:chat-subagents
npm run smoke:provider-routing
npm run smoke:user-plan-quotas
npm run smoke:knowledge
npm run smoke:agent-import
npm run smoke:agent-visibility
```

Commit:

```text
test(a2a): complete interoperability coverage
```

## Final review checklist

- Agent Cards expose only public-safe fields and only when explicitly enabled.
- RPC accepts API keys, not browser JWT sessions.
- Every store query scopes tenant, template, and caller in SQL.
- No plaintext credential or ciphertext reaches API responses, logs, events, audits, artifacts, or frontend caches.
- Remote URL validation remains bound to the actual network connection.
- Every live registry entry, timeout, listener, and subscriber is cleaned up on success, failure, cancellation, disconnect, and shutdown.
- Existing endpoint contracts and unrelated working-tree changes are preserved.
- A2A SDK is pinned exactly and its protocol smoke test passes.
