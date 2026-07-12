# System MCP Tool Registration Implementation Plan

## Scope

Implement the approved system MCP registration design while preserving the current Agent template, A2A discovery, and tenant MCP connection behavior already under development in this worktree.

`platformMcpTools` stores selected logical tool IDs. Because dynamic A2A tools are default-on even when added outside the editor, `disabledPlatformMcpTools` stores explicit A2A deselections; without this tombstone, an absent ID cannot mean both default-on and explicitly disabled.

## Steps

1. Add shared browser-safe constants and helpers for memory IDs, A2A logical IDs, platform descriptors, and selection reconciliation.
2. Extend Agent template and A2A remote types with stable remote IDs and platform selection fields.
3. Preserve or mint remote IDs in frontend and server normalization, validate selections, prune removed A2A references, derive legacy `useMemory`, and persist the normalized fields atomically.
4. Allow the memory MCP builder and prompt builder to expose recall and remember independently.
5. Filter A2A remotes before building the local SDK MCP adapter and restrict permission auto-allow to the actually registered platform tools.
6. Add an authenticated platform tool catalog API that combines static memory descriptors with visible template-scoped A2A descriptors.
7. Load platform tools independently in the tool catalog and render them as read-only MCP-backed entries.
8. Replace the legacy memory toggle in the Agent editor with platform tool checkboxes; synchronize A2A add/remove and explicit enable/disable state.
9. Add a platform MCP smoke test, run existing memory/A2A template tests, build the dashboard, and verify the two affected pages in the browser.

## Compatibility

- Missing `platformMcpTools` migrates from `useMemory` and selects all configured A2A remotes.
- Missing remote IDs are minted during normalization and saved with selections in the same template transaction.
- Existing direct `runAgent` callers that do not pass `platformMcpTools` retain the old memory and A2A defaults.
- Ordinary tenant MCP connections remain in `mcpServers` and are not counted as platform MCP tools.
