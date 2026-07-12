# On-Demand Memory Recall Design

## Status

This design supersedes `2026-07-12-memory-injection-count-design.md` for memory retrieval and counting semantics. The Agent and evaluation memory enablement switches from the earlier design remain in force.

## Problem

The current implementation appends every memory Markdown file that fits under the context limit. A normal Agent run therefore increments every appended memory even when only one memory is relevant. The displayed number measures bulk context exposure, not an individual memory call.

The replacement must make retrieval selective and make the counter correspond to a concrete per-memory operation.

## Decision

Use MCP-based on-demand recall:

- The Agent system prompt receives only `MEMORY.md`, containing memory names and summaries.
- The memory MCP exposes `recall` alongside the existing `remember` tool.
- The Agent calls `mcp__memory__recall` when an index entry appears relevant.
- Only memories whose body is successfully returned by `recall` increment their counter.

The metric is named "recall count" (`召回次数`). It still does not prove that the model used the body in its final answer; it proves that the body was retrieved into the Agent loop.

## Agent Context

Replace bulk body construction with an index-only reader:

```ts
readMemoryIndex(auth): string
```

The reader loads `MEMORY.md`, trims it, and limits it to the existing memory-index context budget. It never reads or appends individual memory bodies and has no statistics side effects.

The memory system prompt states:

- The index is routing metadata, not the full memory content.
- Before relying on an index entry, call `mcp__memory__recall` for its name.
- Recall only entries relevant to the current request.
- Use `mcp__memory__remember` for new durable facts under the existing write policy.

If memory is disabled for the run, neither the index nor the memory MCP server is provided.

## Recall Tool

Add this tool to `buildMemoryMcp`:

```ts
recall({ names: string[] })
```

Input rules:

- `names` contains 1 to 8 memory slugs.
- Duplicate names in one request are normalized and deduplicated while preserving first-seen order.
- Names use the existing slug normalization and per-user path containment rules.

Output rules:

- Successfully read memories are returned as clearly separated sections containing name, description, type, and body.
- Missing or unreadable names are reported in an omitted list and are not counted.
- Total returned memory text is limited to 12,000 characters.
- A memory counts when its section is appended to the tool result. The final memory counts if the output limit returns only part of its section.
- Names not appended because the output limit was already reached are reported as omitted and are not counted.

Counting rules:

- A successfully returned memory increments once per tool request.
- Repeating a name inside one request increments once.
- Recalling the same memory in a later tool request, including later in the same Agent run, increments again because another retrieval occurred.
- Reading memories through the management REST API does not increment.
- Listing the index does not increment.
- `remember` does not increment recall count.

Statistics write failures are non-fatal. The recall tool still returns the memory body and logs a server warning.

## Statistics Format And Reset

Upgrade `memory-stats.json` to a versioned format:

```json
{
  "version": 2,
  "memories": {
    "talmud-open-debate-vs-authoritative-text": {
      "recallCount": 3,
      "lastRecalledAt": 1783845450050
    }
  }
}
```

Version 1/unversioned files containing `injectionCount` are not migrated because their values were produced by the invalid bulk-injection definition. They are treated as empty version 2 statistics, so every memory displays zero after deployment. The next successful recall or lifecycle cleanup writes the version 2 structure atomically.

The existing storage constraints remain mandatory:

- The complete read-update-write transaction is synchronous with no `await` boundary.
- The temporary file is in the same memory directory.
- The temporary filename does not end in `.md`.
- Write uses temporary file plus `renameSync`.
- Missing or malformed statistics are treated as empty and do not block recall.

## Lifecycle

- New memories start at `recallCount: 0` without an eager statistics entry.
- Editing or overwriting the same slug preserves version 2 recall statistics.
- Deleting a memory removes its statistics entry.
- Consolidation removes statistics for deleted, damaged, duplicate, or absent files.
- Duplicate memories removed by consolidation do not merge their counts into the retained slug.

## Run And Evaluation Switches

Keep the existing enablement behavior:

- Ordinary Agent runs default memory on.
- An Agent template can disable memory.
- Evaluation runs default memory off.
- Candidate evaluation runs require both the evaluation switch and candidate Agent switch to be on.
- Judge runs follow the evaluation switch.

When enabled, evaluation counters increase only if the candidate or judge actually calls `recall`; merely starting an evaluation attempt does not change any count.

## API And Frontend

Memory list and detail responses replace the previous fields with:

```ts
recallCount: number;
lastRecalledAt: number | null;
```

Every memory card always displays:

```text
召回 0 次
召回 3 次
```

The tooltip reads: `Agent 通过 memory.recall 读取该忆块正文时计数；仅展示索引不会计数。`

The Agent and evaluation memory toggles remain unchanged.

## Removed Behavior

The Agent runner no longer:

- appends every memory body to the system prompt;
- creates a first-stream-message recorder;
- increments counters when an SDK run starts.

`buildMemoryContext`, `recordMemoryInjections`, and `createMemoryInjectionRecorder` are removed or replaced by index/recall-specific functions. The compatibility `readMemoryContext` function is removed if no callers remain.

## Verification

Update `dashboard/scripts/smoke-memory-stats.mjs` to execute the real memory MCP/storage behavior and verify:

1. The system context contains the index but no memory body.
2. Existing unversioned `injectionCount` statistics appear as zero.
3. Recalling one memory increments only that memory.
4. Unrelated memories remain zero.
5. Duplicate names in one recall request increment once.
6. Separate successful recall requests increment separately.
7. Missing and unreadable memories do not increment.
8. Memories omitted by the 12,000-character output limit do not increment.
9. A partially returned final memory increments.
10. REST list/detail operations do not increment.
11. Delete and consolidation clean version 2 statistics.
12. Malformed statistics do not prevent recall and are replaced on the next successful mutation.
13. A disabled ordinary Agent run exposes neither index nor memory tools.
14. Evaluation memory defaults off and preserves the candidate Agent hard bound.

Run:

```bash
cd /Users/xiaoqin/agentma2/dashboard
npm run smoke:memory-stats
npm run smoke:evaluations
npm run build
launchctl kickstart -k "gui/$(id -u)/ai.agentma2.dashboard"
```

After restart, verify the service is running, check the server log, and confirm the production bundle contains `召回` and the `memory.recall` guidance. A live conversation about one known memory should increment that memory only after a recall tool call; unrelated cards must remain unchanged.

## Out Of Scope

- Embedding or vector-search infrastructure.
- A separate LLM retrieval pass before the main Agent.
- Proving that recalled content affected the final answer.
- Backfilling or preserving invalid version 1 injection counts.
- Cross-process counter coordination.
