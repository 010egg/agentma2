# Memory Injection Count Design

## Goal

Show an injection count on every memory card. The count increases once when that memory's body is included in an Agent run's system prompt. Cards always show the value, including `0`.

The metric is named "injection count" rather than "usage count" because inclusion in context does not prove that the model used the memory in its answer.

## Counting Semantics

- A fully included memory body increments by one.
- A memory body that is partially included by the existing 6K character truncation increments by one.
- A memory listed only in `MEMORY.md`, whose body is not appended, does not increment.
- Reading, listing, editing, refreshing, or manually viewing a memory does not increment.
- Each memory increments at most once per Agent run.
- Each user message starts a new `runAgent` call, including resumed conversations. A 12-turn conversation can therefore add 12 injections to every memory included in all 12 turns; the number does not mean 12 separate conversations or tasks.
- Runs that fail during preprocessing, before the SDK produces its first message, do not increment.
- Once the SDK produces its first message, all memories included in that run's system prompt increment, including runs that later fail.

## Memory Enablement

Memory participation is configurable rather than inferred solely from the presence of `tenantId` and `sub`.

### Run-Level Option

`RunAgentOptions` gains:

```ts
useMemory?: boolean;
```

The effective run-level condition is:

```ts
const memoryEnabled = Boolean(opts.tenantId && opts.sub) && opts.useMemory !== false;
```

Existing ordinary chat callers that omit the option retain the current default of enabled. When disabled, the run receives neither the memory system-prompt context nor the `mcp__memory__remember` tool, and no injection statistics are recorded.

### Agent Template Option

Agent templates gain `useMemory?: boolean`. Existing templates without the field default to enabled. The Agent editor exposes a memory toggle that is on for newly created templates. Ordinary template-based calls pass the template value to `runAgent`.

This switch controls both reading existing memories and exposing the write tool. It is not only a statistics switch.

### Evaluation Option

Evaluation runs gain a persisted `useMemory: boolean` option. The evaluation-run creation UI shows an "使用记忆" toggle that defaults to off. The value is stored on `evaluation_runs` as `use_memory INTEGER NOT NULL DEFAULT 0`; existing rows migrate to off so historical and resumed evaluation runs remain reproducible by default.

Evaluation execution uses these rules:

- Candidate run: `useMemory = evaluationRun.useMemory && candidateAgent.useMemory !== false`.
- Judge run: `useMemory = evaluationRun.useMemory` because the judge has no Agent template.
- When the evaluation switch is off, neither candidate attempts nor judge calls inject memory or increment counters.
- When the evaluation switch is on, each candidate attempt and each judge call is an independent Agent run and increments included memories once. This potentially large increase is intentional and visible from the enabled evaluation configuration.

The evaluation-level switch is a hard upper bound: it can disable memory for the whole evaluation, but it cannot force a candidate Agent whose own template disables memory to use it.

## Storage

Each user's existing memory directory gains a sidecar file named `memory-stats.json`:

```json
{
  "user-prefers-ts": {
    "injectionCount": 12,
    "lastInjectedAt": 1783831200000
  }
}
```

The sidecar is not part of the memory context and is not exposed as a memory item. Keeping statistics outside memory Markdown files prevents count updates from changing memory modification times.

Writes use a temporary file followed by an atomic rename. The temporary file must be created in the same user memory directory and must not end in `.md`; a suitable shape is `.memory-stats.<pid>.<uuid>.tmp`. A missing or malformed statistics file is treated as empty statistics so it cannot block an Agent run. The server should log malformed data for diagnosis.

The deployment runs a single dashboard server process. `recordMemoryInjections` must perform the complete read-update-write transaction synchronously with `readFileSync`, `writeFileSync`, and `renameSync`, with no `await` or promise boundary between them. This is a hard implementation constraint: it serializes concurrent runs on the Node event loop and prevents lost increments. A future multi-process deployment would require moving the counters to SQLite or adding cross-process locking.

## Backend Components

### Context Construction

Replace the string-only context reader with a result that also identifies included memories:

```ts
type MemoryContextResult = {
  context: string;
  injectedNames: string[];
};

buildMemoryContext(auth): MemoryContextResult
```

Context text must remain behaviorally compatible with the current implementation. A name is added to `injectedNames` exactly when its memory file is read successfully and its section is appended to `out` inside the existing loop. A read that enters the loop but fails inside the current `catch {}` is not counted. The final `slice(0, MAX_INJECT_CHARS + 240)` does not revise the names: the final appended memory counts even if truncation leaves only part of its body or only its section header.

### Statistics Recording

Add an isolated operation:

```ts
recordMemoryInjections(auth, injectedNames): void

createMemoryInjectionRecorder(auth, injectedNames): () => void
```

`createMemoryInjectionRecorder` returns an idempotent closure backed by a per-run boolean. The Agent runner builds the memory context before preprocessing, creates the recorder, and invokes it for every yielded SDK message; only the first call writes statistics. Keeping this gate in a small exported helper makes the stream behavior executable in the focused smoke test without making a real provider request.

Statistics failures are non-fatal: the run continues, and a server warning records the failure without exposing filesystem details to the user.

### Memory API

`MemoryListItem` and memory detail responses add:

```ts
injectionCount: number;
lastInjectedAt: number | null;
```

Memories without a statistics entry return `injectionCount: 0` and `lastInjectedAt: null`.

### Lifecycle Rules

- Creating a memory starts at zero without requiring an eager statistics entry.
- Editing or overwriting the same slug preserves its statistics.
- Deleting a memory removes its statistics entry.
- Consolidation removes statistics for deleted, damaged, duplicate, or otherwise absent memory files.
- When consolidation removes a duplicate body, the removed copy's count is discarded rather than merged into the retained memory. This is intentional because counts belong to slugs, not deduplicated content.
- Rebuilding `MEMORY.md` does not affect statistics.
- A memory can be deleted after context construction but before the first SDK message, causing a short-lived orphan statistics entry when recording occurs. APIs hide orphan entries, and later delete or consolidation cleanup removes them; this race is accepted.

## Frontend

Extend the memory item type with `injectionCount` and `lastInjectedAt`. Every memory card renders a muted badge beside its type and updated timestamp:

```text
项目  注入 12 次  2026/7/12 03:20
```

Zero is explicit:

```text
项目  注入 0 次  2026/7/12 03:20
```

The card does not claim that the memory affected the answer. Its count badge has a tooltip explaining: "每次 Agent 运行将该忆块注入上下文时计数；同一多轮对话会按轮累计。" `lastInjectedAt` is returned for future observability but is not displayed in this change.

## Error Handling

- Missing sidecar: return zero counts and create it on the first increment.
- Malformed sidecar: warn, recover from empty statistics, and replace it on the next successful increment.
- Failed atomic write: preserve the prior file when possible, warn, and continue the Agent run.
- Orphan statistics: hide them from APIs and remove them during delete or consolidation operations.

## Verification

Add `dashboard/scripts/smoke-memory-stats.mjs` and an `npm run smoke:memory-stats` package script. The smoke must import and execute the real TypeScript memory implementation through the repository's `tsx` runtime and verify:

1. Existing memories return zero without a sidecar.
2. The first simulated SDK stream message increments each included memory once.
3. Later simulated stream messages do not increment more than once per run.
4. Memories excluded by the 6K limit do not increment.
5. A partially included final memory increments.
6. List, detail, edit, and refresh operations do not increment.
7. Delete and consolidation remove orphan statistics.
8. A malformed statistics file does not prevent context construction or Agent execution.
9. Ordinary Agent runs default memory on, an Agent template can disable it, and disabled runs expose neither context nor the remember tool.
10. Evaluation runs default memory off; enabling an evaluation still respects a candidate Agent's disabled template, while judge calls follow the evaluation switch.

Verification and deployment commands are explicit:

```bash
cd /Users/xiaoqin/agentma2/dashboard
npm run smoke:memory-stats
npm run build
launchctl kickstart -k "gui/$(id -u)/ai.agentma2.dashboard"
```

After restart, verify that `launchctl print "gui/$(id -u)/ai.agentma2.dashboard"` reports `state = running`, inspect `/tmp/agentma2-dashboard-server.log` for startup errors, and confirm that `https://dandelion.skin/memories` displays `注入 0 次` or the accumulated count on every card.

## Out of Scope

- Determining whether the model actually cited or relied on a memory.
- Changing memory selection, relevance ranking, or the 6K context limit.
- Resetting counters from the UI.
- Historical backfilling before this feature is deployed.
- Multi-process counter coordination.
