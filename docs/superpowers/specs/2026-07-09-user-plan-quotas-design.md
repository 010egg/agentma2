# User Plan Quotas Design

Date: 2026-07-09

## Summary

Self-registered users should join the system account owned by `admin@agentma.com` instead of creating isolated workspaces. Those users start as `member` users on the `free` plan. Admins manage each user's plan and quota overrides from Account > User Management.

Runtime quota enforcement is per user. Free users are limited by daily conversation count. Plus, pro, and max users are limited by rolling token windows: 5 hours and 7 days. Pro receives 5x plus quotas. Max receives 20x plus quotas.

## Goals

- Make open registration join the `admin@agentma.com` tenant.
- Keep self-registered users as members, not tenant admins.
- Add per-user plan tiers: `free`, `plus`, `pro`, `max`.
- Enforce user-level quotas before starting an agent run.
- Record actual usage after an agent run completes.
- Expose plan and quota controls in Account > User Management.

## Non-Goals

- Do not replace existing tenant-level quota controls for upload limits, concurrent runs, tool calls, or per-run duration.
- Do not add payment processing.
- Do not migrate every historical smoke-test tenant into the admin tenant.
- Do not remove the existing admin-created user flow.

## Existing Context

`registerUser` currently creates a new tenant for every self-registered email and makes that user `tenant_admin`.

The admin account exists:

- Email: `admin@agentma.com`
- Tenant ID in the local database: `5a5bf228-bb5c-4606-bb70-11ee2bd3351b`

The existing quota system is tenant scoped. It stores aggregate counters in `quotas` and records runs through `audit_logs` with `action = 'agent_run'`. Account > Quota Management already displays tenant quota and recent run usage.

Observed `admin@agentma.com` tenant run data:

- 679 agent runs
- P50 single-run tokens: about 12k
- P90 single-run tokens: about 130k
- P95 single-run tokens: about 325k
- Max single-run tokens: about 2.05M

These values justify a plus default of 1M tokens per 5 hours and 5M tokens per week. That allows normal long tasks while keeping very heavy use in higher tiers.

## Plan Defaults

| Plan | Daily conversations | 5-hour tokens | Weekly tokens |
| --- | ---: | ---: | ---: |
| free | 5 | unlimited | unlimited |
| plus | unlimited | 1,000,000 | 5,000,000 |
| pro | unlimited | 5,000,000 | 25,000,000 |
| max | unlimited | 20,000,000 | 100,000,000 |

In plan defaults, `unlimited` means no limit is enforced for that window. In user override columns, `NULL` means "use the plan default"; only the resolved effective limit can be unlimited.

## Data Model

Add nullable user plan and override columns to `users`:

- `plan_tier TEXT NOT NULL DEFAULT 'free'`
- `daily_conversation_limit INTEGER`
- `five_hour_token_limit INTEGER`
- `weekly_token_limit INTEGER`

The effective quota for a user is:

1. Start with defaults for `plan_tier`.
2. Apply non-null user override columns.
3. Resolve the plan default. If the resolved effective limit is null, that window is unlimited.

Add `user_usage_events`:

- `id TEXT PRIMARY KEY`
- `tenant_id TEXT NOT NULL`
- `user_id TEXT NOT NULL`
- `event_type TEXT NOT NULL`
- `tokens INTEGER NOT NULL DEFAULT 0`
- `model TEXT`
- `run_id TEXT`
- `created_at INTEGER NOT NULL`

Indexes:

- `(tenant_id, user_id, event_type, created_at DESC)`
- `(tenant_id, created_at DESC)`

Events:

- `conversation_started`: inserted after a run is accepted. Counts daily conversations.
- `agent_tokens`: inserted after a run finishes with actual input + output tokens.

This append-only table avoids fragile reset jobs. Window usage is computed by summing events since the window start.

## Registration Flow

`registerUser` changes:

1. Normalize email and validate password as today.
2. Look up `admin@agentma.com`.
3. If the admin account exists, create the user in that tenant:
   - role: `member`
   - plan_tier: `free`
   - no custom quota overrides
4. If the admin account is missing, preserve current behavior as a setup fallback and create a new tenant admin.

The fallback keeps first-run setup possible on a new machine.

## Runtime Enforcement

Add store helpers:

- `getUserPlanQuota(tenantId, userId)`
- `getUserQuotaUsage(tenantId, userId, now)`
- `checkUserRunQuota(tenantId, userId, now)`
- `recordConversationStarted(tenantId, userId)`
- `recordUserRunTokens(tenantId, userId, info)`
- `updateUserPlanQuota(tenantId, userId, patch)`

`/api/agents/run` checks quota before opening the SSE stream:

- For `free`, deny when daily conversation count is at or above the effective daily limit.
- For `plus`, `pro`, and `max`, deny when either rolling token window is already at or above the effective limit.
- API key identities should use the key creator's user when possible. If that cannot be resolved, keep tenant-level behavior and do not apply user-level plan quotas.

After a run is accepted:

- Insert `conversation_started` immediately, so free daily count cannot be bypassed by disconnecting early.

After `runAgent` completes:

- Keep the existing `recordAgentRun` behavior.
- Insert `agent_tokens` using `inputTokens + outputTokens`.

If the run fails before any model usage, record zero tokens but keep the conversation count. That matches the user-visible fact that a conversation attempt was made.

## API

Extend `GET /api/users` rows with:

- `planTier`
- `quota`
- `usage`

Add or extend admin patch support:

`PATCH /api/users/:email`

Body:

```json
{
  "role": "member",
  "planTier": "plus",
  "dailyConversationLimit": null,
  "fiveHourTokenLimit": 1000000,
  "weeklyTokenLimit": 5000000
}
```

Role changes and quota changes can be submitted independently.

Quota denial response:

```json
{
  "error": "quota_exceeded",
  "message": "本周 token 额度已用完",
  "quota": {
    "planTier": "plus",
    "window": "weekly",
    "used": 5000000,
    "limit": 5000000,
    "resetsAt": 1784000000000
  }
}
```

The frontend should show `message`.

## Account UI

User Management table adds:

- Plan selector: `free`, `plus`, `pro`, `max`
- Daily usage for free users: `used / limit`
- Token usage for paid users:
  - 5-hour tokens: `used / limit`
  - Weekly tokens: `used / limit`
- Optional "custom quota" controls for selected user rows.

Default plan changes should immediately preview the effective limits. Custom quota fields can be cleared to return to plan defaults.

Quota Management remains tenant-level and should keep its current layout.

## Error Handling

- If `admin@agentma.com` exists but the tenant row is missing, registration returns a 500-level setup error instead of creating a detached tenant.
- If quota check fails because the user no longer exists, return 401 or 403 through existing auth handling.
- Invalid plan tier returns 400.
- Negative quota overrides return 400.
- Null quota overrides mean "use plan default" for the UI patch endpoint.

## Testing

Add focused coverage with smoke or integration scripts:

1. Self-register a new user and verify:
   - Same tenant as `admin@agentma.com`
   - Role is `member`
   - Plan is `free`
2. Set user to free with daily limit 1:
   - First run is accepted
   - Second run in same day is denied before SSE starts
3. Set user to plus with very low token limits:
   - A run is accepted when current usage is below limit
   - A later run is denied when the rolling window is exhausted
4. Change user to pro/max and verify limits scale 5x/20x from plus defaults.
5. Verify existing tenant quota endpoint still works.

## Rollout Notes

Existing users should receive `plan_tier = 'free'` during migration. Admins can promote selected users after deployment. Historical `audit_logs` are not backfilled into `user_usage_events`; enforcement starts from the deployment moment. Account usage can optionally show only user quota events to avoid confusing historical identity changes between email and user ID actors.
