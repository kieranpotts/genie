# audited-tools

Audited replacements for Pi's built-in file tools, for use with `--no-builtin-tools`. Started that way, Pi has no file access; this extension provides `read`, `write`, and `ls` back — each confined to an allowlisted workspace root, each refusing sensitive filenames, and each logged to an append-only audit file.

This is the defence-in-depth layer of the secure local agent architecture: even if the MCP filesystem boundary is bypassed, no file operation happens without passing the path guard and being recorded. See [docs/local-agent-architecture.md](../../../docs/local-agent-architecture.md) and [docs/local-agent-implementation-plan.md](../../../docs/local-agent-implementation-plan.md) (step 6).

## What it does

Each tool authorises its `path` argument before any I/O:

1. **Path allowlist.** The path is canonicalised (`resolve`) and confirmed to lie within the configured root via a `relative()` check that rejects any result starting with `..`. This defeats directory traversal (`../../etc/passwd`) and prefix-collision attacks (`/projects/active-evil` vs. `/projects/active`). Allowlist, never blocklist.
2. **Sensitive-file refusal.** Regardless of path, basenames matching secrets/key material (`.env*`, `id_rsa`, `*.pem`, `*.key`, `.netrc`, `credentials`, …) are refused.
3. **Audit log.** Every call — allowed, denied, or errored — is appended as one JSON line to the audit file.

A denied call returns an error result to the model explaining the refusal; it never performs the operation.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AUDITED_TOOLS_ROOT` | `/projects/active` | The single directory the tools are confined to. |
| `AUDITED_TOOLS_LOG` | `/home/pi/sessions/audit.jsonl` | Append-only audit log path. Should live on a volume outside the agent's writable tree. |

Both are set by `src/infra/compose.yaml` for the hardened container.

## Audit record format

One JSON object per line, fixed key order for greppability:

```json
{"ts":"2026-06-04T12:00:00.000Z","tool":"write","status":"allowed","path":"/projects/active/src/x.ts"}
{"ts":"2026-06-04T12:00:01.000Z","tool":"read","status":"denied","path":"/projects/active/.env","reason":"sensitive file refused: .env"}
```

`status` is `allowed`, `denied`, or `error`.

## Design notes

- **Pure, tested core.** Path logic (`path-guard.ts`) and the log format (`audit-log.ts`) are pure and unit-tested, including the full traversal, prefix-collision, and sensitive-filename matrix. `index.ts` is thin glue to the `ExtensionAPI` and the filesystem.
- **Logging never breaks a tool.** A failed audit write is swallowed — the operation's own result still stands — so audit I/O cannot deny the agent service.

## Files

- `index.ts` — registers the `read`, `write`, `ls` replacements.
- `path-guard.ts` — pure path allowlist + sensitive-filename gate.
- `audit-log.ts` — pure record formatting + append-only file sink.
