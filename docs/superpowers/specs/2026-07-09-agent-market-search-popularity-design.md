# Agent Market Search And Popularity Design

## Goal

Improve the Agents market so a tenant with many Agent templates can find and rank templates quickly. The first version adds search, sorting, and visible popularity numbers on Agent cards.

Popularity is tenant-wide and cross-account: every completed or attempted `/api/chat` run that carries an Agent template id increments that template's visible usage count for the tenant. It does not matter whether the user started from the Agent template card or selected the Agent in the conversations page.

## Current Context

The Agents page currently splits templates into public and personal sections. It does not search, does not expose usage counts, and preserves the backend list order. Chat sessions already store `template_id`, and `/api/chat` receives `templateId` whenever a template is used for a run.

Existing `recordAgentRun` audit rows record model/status but do not identify `templateId`, so template popularity cannot be reliably computed from audit logs alone. Chat messages persist assistant messages with a run id/status/outcome and are attached to chat sessions, which have `template_id`.

## Data Model

Expose a normalized optional field on every Agent template returned by `/api/agents`:

```ts
popularity: {
  runCount: number;
  lastRunAt: number | null;
}
```

`runCount` is the tenant-wide count across all accounts for the template id. `lastRunAt` is the most recent persisted run timestamp for that template in the same tenant.

The first implementation can compute this from existing chat tables at request time. It should count assistant messages with a `run_id`, grouped by `chat_sessions.template_id`, because those represent actual agent run attempts persisted by `/api/chat`. This covers repeated turns inside the same conversation, unlike counting sessions.

If this becomes expensive later, the same response shape can be backed by a denormalized counter table without changing the UI contract.

## UI

Agents page toolbar:

- Keep New Agent, local import, and Git import actions.
- Add a search input.
- Add a sort select with:
  - 热度优先, default.
  - 最近更新.
  - 名称.

Search should match template name, description, system prompt, tools, skills, MCP server names, and event source names. Search filters public and personal sections consistently.

Sorting applies within each section after filtering:

1. 热度优先: `popularity.runCount` descending, then `popularity.lastRunAt`, then `updatedAt`.
2. 最近更新: `updatedAt` descending.
3. 名称: locale-aware name ascending.

Cards must visibly show the number, for example `使用 123 次`. If there is a `lastRunAt`, show it as a secondary small value or title such as `最近使用 2026/7/9`.

Empty states should distinguish between no templates and no search results.

## API Behavior

`GET /api/agents` remains the only template list endpoint for this feature. The server should enrich visible templates with popularity before returning them. Visibility rules remain unchanged:

- Tenant admins can see all non-deleted templates.
- Members can see their own templates and published templates.
- Popularity counts are tenant-wide for the template id even if the viewer did not personally run the template.

## Testing

- Add backend/store coverage through existing smoke paths where practical: create an Agent, run chat twice with the same template id, fetch `/api/agents`, and assert `popularity.runCount >= 2`.
- Keep a deterministic fallback by checking that templates with no runs return `runCount: 0`.
- Run `npm run build`.
- Run relevant smoke coverage for agent import/listing if changed.

## Out Of Scope

- Global cross-tenant popularity.
- Likes, favorites, ratings, or reviews.
- Time-windowed trending scores.
- Popularity decay.
- A separate analytics dashboard.
