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
- Runs that fail during preprocessing, before the SDK produces its first message, do not increment.
- Once the SDK produces its first message, all memories included in that run's system prompt increment, including runs that later fail.

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

Writes use a temporary file followed by an atomic rename. A missing or malformed statistics file is treated as empty statistics so it cannot block an Agent run. The server should log malformed data for diagnosis.

The deployment runs a single dashboard server process, so synchronous read-update-write operations are sufficient for in-process serialization. A future multi-process deployment would require moving the counters to SQLite or adding cross-process locking.

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

Context text must remain behaviorally compatible with the current implementation. `injectedNames` contains each memory whose section begins before the final character limit, including the final partially included memory.

### Statistics Recording

Add an isolated operation:

```ts
recordMemoryInjections(auth, injectedNames): void
```

The Agent runner builds the memory context before preprocessing but records the names only after the SDK yields its first message. A per-run boolean prevents duplicate recording while consuming later stream messages.

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
- Rebuilding `MEMORY.md` does not affect statistics.

## Frontend

Extend the memory item type with `injectionCount` and `lastInjectedAt`. Every memory card renders a muted badge beside its type and updated timestamp:

```text
项目  注入 12 次  2026/7/12 03:20
```

Zero is explicit:

```text
项目  注入 0 次  2026/7/12 03:20
```

The card does not claim that the memory affected the answer. `lastInjectedAt` is returned for future observability but is not displayed in this change.

## Error Handling

- Missing sidecar: return zero counts and create it on the first increment.
- Malformed sidecar: warn, recover from empty statistics, and replace it on the next successful increment.
- Failed atomic write: preserve the prior file when possible, warn, and continue the Agent run.
- Orphan statistics: hide them from APIs and remove them during delete or consolidation operations.

## Verification

Focused automated coverage should verify:

1. Existing memories return zero without a sidecar.
2. A successful Agent stream increments each included memory once.
3. Multiple stream messages do not increment more than once per run.
4. Memories excluded by the 6K limit do not increment.
5. A partially included final memory increments.
6. List, detail, edit, and refresh operations do not increment.
7. Delete and consolidation remove orphan statistics.
8. A malformed statistics file does not prevent context construction or Agent execution.

Run the existing TypeScript/Vite checks that are viable in the current repository, build the frontend with `npx vite build`, restart the dashboard server using the host's existing service mechanism, and verify that `https://dandelion.skin/memories` displays `注入 0 次` or the accumulated count on every card.

## Out of Scope

- Determining whether the model actually cited or relied on a memory.
- Changing memory selection, relevance ranking, or the 6K context limit.
- Resetting counters from the UI.
- Historical backfilling before this feature is deployed.
- Multi-process counter coordination.
