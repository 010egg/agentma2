# System MCP Tool Registration Design

## Goal

Expose the built-in memory MCP tools and template-scoped A2A remote Agent tools through the same tool catalog and Agent selection experience used by other MCP-backed tools.

The UI selection must match runtime availability:

- `memory.recall` and `memory.remember` are selected by default for every new Agent.
- Existing Agents keep memory disabled when their legacy `useMemory` value is `false`.
- Each A2A remote Agent creates one template-scoped MCP tool that is selected by default when the remote is added.
- A2A tools are never enabled for unrelated Agent templates.
- Clearing a selection prevents the corresponding MCP tool from being registered at runtime.

## Architecture

Introduce a unified platform MCP tool descriptor layer. It returns both static platform tools and dynamic template-scoped tools.

Static descriptors cover:

- `memory.recall`
- `memory.remember`

Dynamic descriptors cover one tool for each configured A2A remote Agent. Each remote receives a persisted stable ID, and its logical tool ID is derived from that ID, for example `a2a.remote.<remoteId>`. Renaming the remote or changing its Agent Card URL does not change its selection identity.

Because the stable ID is deliberately independent of every mutable field (name, Agent Card URL, order), it **cannot be recomputed** — it must be stored as a first-class field on the remote's persisted configuration and read back, never derived. The ID is therefore a new required field on each `a2aRemoteAgents` entry, and template normalization must preserve it (see Persistence And Migration). It is a randomly minted opaque value (e.g. a UUID), not a hash of any remote field.

Each descriptor includes enough metadata for both catalog display and runtime mapping:

- logical tool ID;
- MCP server name;
- SDK-visible tool name;
- display name and description;
- input schema and annotations;
- scope (`global` or `template`);
- owning template and remote IDs when template-scoped.

The global tool catalog displays platform descriptors alongside existing built-in, internal, and custom tools. Platform tools are read-only catalog entries: users can inspect them but cannot edit their endpoint or delete them. A2A entries identify the owning Agent template and remote Agent.

The Agent editor receives the same descriptor format but filters template-scoped descriptors to the Agent being edited.

## Persistence And Migration

Agent templates gain a `platformMcpTools` field containing stable logical tool IDs. It distinguishes three states:

- missing: legacy template requiring migration defaults;
- present and non-empty: exact selected tools;
- present and empty: the user explicitly disabled every platform MCP tool.

"Exact selected tools" applies literally to the **static** platform tools (the two memory tools), which the editor always renders as explicit checkboxes: an absent memory ID means deselected. Dynamic A2A tools remain default-on when added out-of-band: a configured remote whose ID is absent from `platformMcpTools` is selected unless its logical tool ID appears in `disabledPlatformMcpTools`. The latter is an explicit-disable tombstone set and only accepts A2A tool IDs. This extra state is required because a missing ID cannot simultaneously mean both default-on and explicitly disabled.

The existing general `tools` array remains responsible for SDK built-ins and the current internal/custom tool selection. Platform MCP selection is stored separately so legacy absence is distinguishable from an explicit empty selection.

Migration rules are applied while normalizing a template:

- For a legacy template with `useMemory !== false`, select both memory tools.
- For a legacy template with `useMemory === false`, select neither memory tool.
- Select every existing A2A remote Agent tool in a legacy template, preserving current behavior.
- **Preserve and mint the stable ID during A2A normalization.** The existing `a2aRemoteAgents` normalization rebuilds each entry into a fixed shape (currently `{ name, agentCardUrl, credentialRef? }`) and drops any other field; it must be extended to carry `id` through unchanged, and to mint a fresh opaque ID for any entry missing one. Without this, every save silently strips the ID and orphans every `platformMcpTools` reference. The minted ID and any selection referencing it must be written in the **same** save (see Stable Remote ID Invariants).
- **Default-select a configured remote whose ID is absent from `platformMcpTools` and `disabledPlatformMcpTools`.** Migration's "select all A2A" covers legacy templates, while the tombstone lets an explicit editor action persist a disabled remote without making ordinary partial saves dangerous.
- Ignore removed A2A remote IDs when normalizing selections (selection references a remote no longer in `a2aRemoteAgents`).
- Prune tombstones for removed remotes, and reject non-A2A IDs in `disabledPlatformMcpTools`.
- Save the new exact selection format on the next template update.

### Stable Remote ID Invariants

- IDs are minted at normalization for any remote lacking one, and are always persisted together with (never after) any selection that references them, in one atomic template write.
- Reading a legacy template (missing `platformMcpTools`) always re-derives a select-all result from the current remotes; it never emits a stored selection that references a not-yet-persisted ID. This makes a run-without-save followed by a reload idempotent even though each read may mint transient IDs, because no read persists a reference to a transient ID.
- A minted ID becomes authoritative only after the first successful save that transitions the template from legacy to `platformMcpTools`-present; that save writes the IDs onto the remotes and the derived (or user-adjusted) selection together.

The legacy `useMemory` field remains readable for backward compatibility. Once `platformMcpTools` is present, it is authoritative. When templates are saved, write `useMemory: true` when either memory tool is selected and `useMemory: false` when both are disabled, so older consumers receive a consistent coarse value.

Server-side validation rejects:

- unknown platform MCP tool IDs;
- malformed or duplicate A2A remote IDs;
- A2A selections that do not refer to a remote in the same template;
- global selections that are not part of the static platform catalog.

## User Experience

### Tool Catalog

The tool catalog shows `memory.recall` and `memory.remember` under the `memory` MCP server. Dynamic A2A entries appear under the `a2a` MCP server and show their owning template and remote Agent.

They use the existing catalog search, source filters, categories, detail panel, schemas, and annotations. Platform entries are visually consistent with ordinary MCP-backed tools but expose no edit or delete commands.

If dynamic A2A catalog loading fails, static tools remain available and the page reports a localized dynamic-tool loading error instead of clearing the entire catalog.

### Agent Editor

Platform MCP tools appear in the Agent's enabled-tools area:

- A new Agent starts with both memory tools checked.
- The legacy standalone memory checkbox is replaced by the two real tool choices, avoiding two conflicting controls.
- Adding an A2A remote assigns its stable ID, creates its tool descriptor, and checks it immediately.
- Clearing an A2A checkbox preserves the Card and credential configuration but prevents runtime registration.
- Removing a remote also removes its descriptor and selection ID.
- Reordering, renaming, or editing the Card URL does not reset the checkbox.

The A2A configuration panel remains responsible for Agent Card discovery, credentials, publishing, and remote lifecycle. The tool picker remains responsible for runtime enablement.

## Runtime Behavior

The memory MCP builder accepts the selected memory capabilities and registers only those tools:

- neither selected: do not create the memory MCP;
- only recall selected: register `recall` only;
- only remember selected: register `remember` only;
- both selected: register both.

Memory system-prompt content must reflect actual availability. It must not instruct the model to recall or remember when that operation is disabled. The memory index is injected only when recall is available; enabling remember alone may include a concise write-only instruction without exposing a recall workflow.

Before building the A2A MCP, runtime code filters configured remotes by the template's exact platform MCP selection. Only selected remotes are passed to `buildA2ARemoteMcp`. Existing Agent Card discovery and HTTP JSON-RPC behavior remains unchanged; MCP remains only the local Claude Agent SDK adapter.

Permission enforcement uses the same filtered runtime descriptor set. An unselected memory or A2A tool is neither registered nor auto-allowed.

## Error Handling

- Agent Card discovery failure does not corrupt or remove the saved remote configuration. The UI reports the discovery error on that remote.
- Runtime A2A failures retain the guarded error response and sanitized logging already implemented by the adapter.
- Stable remote IDs and the existing SDK tool-name collision handling prevent two A2A entries from sharing an effective tool identity.
- Catalog failures are isolated by source so one dynamic source does not hide static or custom tools.
- Invalid saved selections are rejected at the API boundary and normalized defensively when reading legacy data.

## Testing

Add focused coverage for:

- new Agent defaults selecting both memory tools;
- all four memory selection combinations;
- legacy `useMemory` migration for enabled and disabled templates;
- legacy A2A remotes receiving stable IDs and default selections;
- stable IDs surviving a full normalize→save→reload cycle (regression guard: normalization must not strip `id` from `a2aRemoteAgents`);
- a configured remote whose ID is absent from a present, non-empty `platformMcpTools` remaining selected after a memory-only or otherwise partial save (drift default-select), versus an explicit editor removal deselecting it;
- A2A add, remove, rename, reorder, and Card URL edits preserving the intended selection;
- cross-template and unknown tool selection rejection;
- runtime MCP registration containing only selected memory and A2A tools;
- permission checks denying unselected platform tools;
- memory system prompts matching the selected capabilities;
- tool catalog aggregation and partial dynamic-load failure;
- Agent editor checkbox synchronization with remote lifecycle operations.

Run the existing Agent template, memory, A2A, and bidirectional A2A smoke tests. Add a dedicated platform MCP selection smoke test if the existing suites do not cover persistence through an API save and a real runtime invocation.

Complete browser verification for the tool catalog and Agent editor at desktop and mobile widths, checking wrapping, overflow, disabled states, and selection synchronization.

## Coordination

Two in-flight efforts touch the same A2A runtime seam; sequence and compose rather than each wrapping the call site independently.

- **A2A outbound observability** (`docs/superpowers/plans/2026-07-12-a2a-outbound-observability-implementation.md`) adds a `recorder` parameter to `callA2ARemote` and persists a row per outbound call. Its correlation key should be the **stable `remoteId` this spec introduces**, not the mutable `agent_name` — carry `remoteId` into the outbound record so a call can be traced back to a specific configured remote across renames. Add `remote_id` alongside `agent_name` in the outbound table when both land.
- Both efforts modify `buildA2ARemoteMcp` / `describeA2ARemoteTools` and the point where configured remotes are turned into runtime tools. This spec's **selection filter** (only pass selected remotes to `buildA2ARemoteMcp`) and the observability plan's **recorder wiring** wrap the same `callA2ARemote` invocation; land them in one coordinated change so the filter runs before the recorder and neither re-wraps the other.
- `server-a2a-client.ts` is under active edit; whichever effort lands first should expose the shared seam (stable-ID-keyed descriptor + recorder pass-through) the other consumes, to avoid a merge that double-wraps or drops the ID.

## Out Of Scope

- Changing A2A discovery from Agent Card HTTP discovery to MCP.
- Publishing A2A tools across Agent templates.
- Letting users edit or delete platform MCP tool definitions.
- Moving ordinary tenant MCP connections into the platform MCP selection field.
- Changing A2A JSON-RPC methods, polling, credentials, or outbound URL policy beyond what selection filtering requires.
