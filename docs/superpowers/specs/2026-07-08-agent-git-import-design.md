# Agent Git Import Design

## Goal

Add support for importing Agent templates from public HTTPS git repositories such as GitHub, GitLab, and Gitea. The first version accepts a `https://...git` URL plus an optional branch, tag, or commit ref. It does not store credentials and does not support SSH, `file://`, private repository tokens, or local network clone targets.

The imported repository should behave like the existing local project import: project files are unpacked into a template seed directory, detected Claude Code agents and skills are reflected in the generated Agent template, and new Agent runs receive the seed files in their runtime cwd.

## Existing Context

The current Agents page supports local directory import through `POST /api/agents/import`. The backend already has the important primitives:

- Multipart upload limits: 300 files, 2 MB per file, 50 MB total.
- Path normalization and root stripping for browser directory uploads.
- Blocked entries such as `.git`, `node_modules`, `.agent-home`, and `.agentma-seeded`.
- Sanitization for `.claude/settings*.json`, which are renamed to `.imported`.
- Sanitization for `.mcp.json`, preserving only remote HTTP/SSE-style MCP servers and removing stdio MCP.
- Atomic seed directory replacement under `dataDir/agent-seeds/<tenant>/<template>`.
- Template generation from the import report.
- Runtime seed injection through `runAgent({ seedDir })`.

Git import should reuse that pipeline rather than creating a second importer.

## User Flow

On `/agents`, the toolbar adds a Git import action next to the existing local project import.

1. User clicks Git import.
2. A dialog asks for:
   - Repository URL, required.
   - Branch, tag, or commit ref, optional.
3. The UI posts JSON to `POST /api/agents/import/git`.
4. On success, the UI refreshes Agent templates, selects the imported template, and opens the existing import report dialog.
5. On failure, the UI shows the backend error message.

The existing local directory import remains unchanged.

## API

Add `POST /api/agents/import/git`.

Request body:

```json
{
  "url": "https://github.com/org/repo.git",
  "ref": "main",
  "mode": "new",
  "templateId": "",
  "name": ""
}
```

Response shape matches `POST /api/agents/import`:

```json
{
  "template": {},
  "report": {}
}
```

The endpoint should support the same `mode` semantics as local import:

- `new`: create a new template.
- `merge` or `merge:<templateId>`: replace seed files for an existing manageable template.

The first UI version can default to `new`; the backend should still share merge handling with the local import route where practical.

## Git Safety

Validate repository URLs before invoking git:

- Require `https:` protocol.
- Require a hostname.
- Reject username or password embedded in the URL.
- Reject localhost names.
- Reject literal private, loopback, link-local, multicast, and unspecified IP addresses.
- Reject non-standard protocols such as `ssh:`, `git:`, `file:`, and `http:`.

The initial version will not fully resolve DNS before clone. That means a public hostname that resolves to a private address is not blocked by validation alone. This is an accepted first-version limitation and should be called out in code comments or error notes. A later hardening pass can resolve A/AAAA records and block private targets before clone.

Validate refs before invoking git:

- Empty ref means clone the default branch.
- Accept simple branch, tag, and commit-ish strings made from alphanumerics plus `._/-`.
- Reject refs with whitespace, shell metacharacters, leading dash, `..`, `@{`, backslash, or control characters.
- Limit ref length.

Use `execFile`, never shell interpolation.

Clone behavior:

- Clone into a unique temporary directory under `os.tmpdir()`.
- Use `git clone --depth 1 --single-branch`.
- If `ref` is present, pass `--branch <ref>`.
- Set a timeout for clone.
- Set a controlled environment and disable interactive prompts with `GIT_TERMINAL_PROMPT=0`.
- Always remove the temporary directory after import failure or success.

## Import Data Flow

After clone:

1. Walk the cloned working tree.
2. Skip directories already blocked by the import policy, especially `.git`, `node_modules`, and `.agent-home`.
3. Build in-memory file objects with `buffer`, `originalname`, and relative path metadata.
4. Enforce the same file count, per-file size, and total size limits before or during the walk.
5. Pass the collected files and relative paths into the existing unpacking function.

The shared unpacker should remain the source of truth for:

- Path traversal checks.
- Settings renaming.
- MCP sanitization.
- Detected agents, skills, `CLAUDE.md`, and remote MCP names.
- Atomic seed replacement.

The git endpoint should append import notes with repository URL and ref information. Audit metadata should include source type `git`, URL origin/path, selected ref, unpacked count, skipped count, detected agents, detected skills, and disabled items.

## UI Design

Agents page state additions:

- Git import dialog open/closed.
- Repository URL input.
- Ref input.
- Git import loading state can reuse the existing `isImporting` flag.

Controls:

- Keep the existing local directory import button.
- Add a Git import button beside it.
- The dialog uses existing modal/card styling and existing button classes.
- Submit is disabled while importing or when the URL is blank.

The import report modal remains unchanged except for showing any new notes from the backend.

## Error Handling

Return concise 4xx errors for user-correctable problems:

- Invalid URL.
- Unsupported protocol.
- Embedded credentials are not supported.
- Invalid ref.
- Git executable is unavailable.
- Clone failed.
- No importable files found.
- Import limits exceeded.

Log detailed clone errors on the server, but do not leak credentials, environment values, or long command output to the client.

## Testing

Unit-level coverage can focus on pure helpers:

- HTTPS URL validation accepts GitHub/GitLab/Gitea-style URLs.
- URL validation rejects SSH, HTTP, file URLs, embedded credentials, localhost, and literal private IPs.
- Ref validation accepts common branches/tags/SHA strings and rejects unsafe values.
- Git working tree enumeration skips blocked directories and enforces limits.

Smoke coverage:

- Extend or add an agent import smoke test that initializes a temporary git repository, serves it over a local HTTPS-compatible test path if available, imports it, and verifies the returned template/report.
- If HTTPS serving is not practical in the smoke environment, keep the smoke test on the extracted helper path and run build/typecheck as the main regression guard.

Manual verification:

- Import a public GitHub repository containing `CLAUDE.md`, `.claude/agents`, `.claude/skills`, and `.mcp.json`.
- Verify the generated Agent appears in `/agents`.
- Verify the report shows detected files and disabled settings/MCP entries.
- Start a conversation with the imported Agent and verify seed files are present in the run cwd.

## Out Of Scope

- Private repositories.
- Personal access tokens.
- SSH clone URLs.
- Git submodules.
- Recursive clone.
- DNS rebinding or full network egress policy hardening.
- Background clone jobs or progress streaming.
