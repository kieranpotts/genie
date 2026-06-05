# audited-tools

Audited replacements for Pi's built-in file **and command** tools, for use with `--no-builtin-tools`. Started that way, Pi has no file or shell access; this extension provides `read`, `write`, `ls`, and `bash` back — the file tools confined to an allowlisted workspace root and refusing sensitive filenames, and `bash` confined to a command allowlist with shell metacharacters rejected. Every call is logged to an append-only audit file.

This is the defence-in-depth layer of the secure local agent architecture: even if the MCP filesystem boundary is bypassed, no file or command operation happens without passing a guard and being recorded. See [docs/local-agent-architecture.md](../../../docs/local-agent-architecture.md).

## What it does

### File tools (`read`, `write`, `ls`)

Each authorises its `path` argument before any I/O:

1. **Path allowlist.** The path is canonicalised (`resolve`) and confirmed to lie within the configured root via a `relative()` check that rejects any result starting with `..`. This defeats directory traversal (`../../etc/passwd`) and prefix-collision attacks (`/projects/active-evil` vs. `/projects/active`). Allowlist, never blocklist.
2. **Sensitive-file refusal.** Regardless of path, basenames matching secrets/key material (`.env*`, `id_rsa`, `*.pem`, `*.key`, `.netrc`, `credentials`, …) are refused.

### Command tool (`bash`)

Vets the `command` string before running anything:

1. **No shell, ever.** The command is never handed to a shell. **Control operators** (`| & ; < > ` newline`) cause outright denial — these have meaning only to a shell, so their only purpose here would be injection. This is the core defence.
2. **Argument-content characters pass through.** `$ * ? ( ) { } \` are *not* rejected: they routinely appear inside a single argument the program interprets itself (`grep 'a.*b'`, `find -name '*.ts'`, regexes, literal `$`). Because no shell runs, they cannot expand, glob, or substitute — `$(whoami)` and `${HOME}` reach the program as literal text. Rejecting them would needlessly break common commands; passing them is both safe and necessary.
3. **Command allowlist.** After the control-operator check, the command is tokenised (honouring quotes) and its first token (the program) must be on the allowlist. The program then runs via `execFile` with the remaining tokens as literal arguments — no reinterpretation.
4. **Bounded execution.** Runs in the workspace root with a 30s timeout and a 1 MB output cap.

Default allowlist: read-only inspection (`ls cat head tail grep find wc file pwd echo which stat diff tree sort uniq cut basename dirname`) plus common dev tools (`git node npm npx python python3 pip make cargo go`). Each dev tool carries some surface (e.g. `git` can run hooks, `npm` can run scripts) — narrow the set per deployment if that matters.

A denied call (either kind) returns an error to the model explaining the refusal; it never performs the operation.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AUDITED_TOOLS_ROOT` | `/projects/active` | The single directory the tools are confined to. |
| `AUDITED_TOOLS_LOG` | `/home/pi/sessions/audit.jsonl` | Append-only audit log path. Should live on a volume outside the agent's writable tree. |
| `AUDITED_BASH_ALLOWLIST` | (built-in default) | Comma-separated program allowlist. A leading `+` extends the default (`+terraform,kubectl`); otherwise it replaces it (`ls,cat,git`). |

These are set by `src/infrastructure/compose.yaml` for the hardened container.

> There is deliberately **no** metacharacter configuration. Tracing each character showed two groups: control operators (`| & ; < > ` newline`) can never do anything useful when "allowed" (no shell runs, so they would be useless literals) — so they are permanently rejected; argument-content characters (`$ * ? ( ) { } \`) are already passed through safely as inert literals — so no toggle is needed. The only tunable is the program allowlist above.

## Audit record format

One JSON object per line, fixed key order for greppability:

```json
{"ts":"2026-06-04T12:00:00.000Z","tool":"write","status":"allowed","path":"/projects/active/src/x.ts"}
{"ts":"2026-06-04T12:00:01.000Z","tool":"read","status":"denied","path":"/projects/active/.env","reason":"sensitive file refused: .env"}
{"ts":"2026-06-04T12:00:02.000Z","tool":"bash","status":"allowed","command":"git status"}
{"ts":"2026-06-04T12:00:03.000Z","tool":"bash","status":"denied","command":"ls; rm -rf /","reason":"command contains disallowed shell operators: ;"}
```

`status` is `allowed`, `denied`, or `error`.

## Design notes

- **Pure, tested core.** Path logic (`path-guard.ts`), command vetting (`bash-policy.ts`), and the log format (`audit-log.ts`) are pure and unit-tested — including the full traversal, prefix-collision, sensitive-filename, and command-injection matrices. `index.ts` is thin glue to the `ExtensionAPI`, the filesystem, and the process spawner.
- **No shell for `bash`.** Commands run via `execFile` with `shell: false`, so a vetted argument vector cannot be reinterpreted.
- **Logging never breaks a tool.** A failed audit write is swallowed — the operation's own result still stands — so audit I/O cannot deny the agent service.

## Files

- `index.ts` — registers the `read`, `write`, `ls`, and `bash` replacements.
- `path-guard.ts` — pure path allowlist + sensitive-filename gate.
- `bash-policy.ts` — pure command vetting (control-operator rejection, tokenising, program allowlist, policy building).
- `audit-log.ts` — pure record formatting + append-only file sink.
