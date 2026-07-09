# `audited-tools`

This extension swaps Pi's built-in file and command tools for audited alternatives.

For this extension to work, Pi MUST be run with the `--no-builtin-tools` option.
Started this way, Pi has no file or shell access. This extension will then
provide its own `read`, `write`, `ls`, and `bash` — this time with the
filesystem tools confined to an allowlisted workspace root and rejecting
sensitive filenames, and `bash` confined to a command allowlist with shell
metacharacters rejected.

Every call through the replacement tools is logged to an append-only audit file.

This extension provide a defense-in-depth layer to the agent harness architecture.
Even if the MCP filesystem boundary is bypassed, no file or command operation
happens inside the Pi agent, hardened by this extension, without passing a guard
and being logged.

## What it does

### File tools (`read`, `write`, `ls`)

Each of the three filesystem tools authorizes its `path` argument before any
I/O. It works like this:

1.  **Path allowlist.** \
    The path is canonicalized (`resolve`) and confirmed to lie within the
    configured root via a `relative()` check, which rejects any result
    starting with `..`. This defeats directory traversal (eg.
    `../../etc/passwd`) and prefix-collision attacks (`/projects/active-evil`
    vs. `/projects/active`).

2.  **Sensitive-file refusal.** \
    Regardless of path, basenames matching secrets/key material (eg. `.env*`,
    `id_rsa`, `*.pem`, `*.key`, `.netrc`, `credentials`, …) are refused.

### Command tool (`bash`)

This vets the `command` string before running anything. It works like this:

1.  **No shell, ever.** \
    The command is never handed to a shell. **Control operators**
    (`| & ; < > ` newline`) cause outright denial — these have meaning only
    to a shell, so their only purpose here would be injection.
    There is no good reason to allow these in commands, so there is no
    configuration option to allow some control operators and not others.
    This is the core defense.

2.  **Argument-content characters pass through.** \
    `$ * ? ( ) { } \` are NOT rejected. These routinely appear inside a single
    argument the program interprets itself (eg. `grep 'a.*b'`,
    `find -name '*.ts'`, regexes, literal `$`). Because no shell runs, they
    cannot expand, glob, or substitute — `$(whoami)` and `${HOME}` reach
    the program as literal text. Rejecting them would needlessly
    break common commands. Passing them is both safe and necessary.

3.  **Command allowlist.** \
    After the control-operator check, the command is tokenized (honouring
    quotes) and its first token (the program) must be on the allowlist.
    The program then runs via `execFile` with `shell: false` and the remaining
    tokens as literal arguments, so a vetted argument vector cannot be
    reinterpreted.

4.  **Bounded execution.** \
    Runs in the workspace root with a 30s timeout and a 1 MB output cap.

Default allowlist: read-only inspection (`ls`, `cat`, `head`, `tail`, `grep`,
`find`, `wc`, `file`, `pwd`, `echo`, `which`, `stat`, `diff`, `tree`, `sort`,
`uniq`, `cut`, `basename`, `dirname`) plus common dev tools (`git`, `node`,
`npm`, `npx`, `python`, `python3`, `pip`, `make`, `cargo`, `go`).

Each dev tool carries some surface (eg. `git` can run hooks, `npm` can run
scripts) — narrow the set per deployment if that matters.

A denied call (either kind) returns an error to the model explaining the
refusal. It never performs the operation.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AUDITED_TOOLS_ROOT` | `/projects/active` | The single directory the tools are confined to. |
| `AUDITED_TOOLS_LOG` | `/var/log/pi/audited-tools/audit.jsonl` | Append-only audit log path. |
| `AUDITED_BASH_ALLOWLIST` | Built-in defaults, see above | Comma-separated program allowlist. A leading `+` extends the default (`+terraform,kubectl`); otherwise it replaces it (`ls,cat,git`). |

These are set in the `compose.yaml` file for the hardened container, so
making these environment variables available to the guest environment in which
Pi runs.

If running Pi inside the hardened container, the `AUDITED_TOOLS_LOG` path MUST
be within a **writable volume** mounted from the host. Without this, the write
operation will fail silently, because the hardened container runs with a
read-only rootfs. The hardened container's `compose.yaml` file provides this
via the `pi-logs` volume, mounted from `/var/log/pi`.

The log file path does not need to exist, because the extension will create it,
and its parent directory, on first write.

The following is a representation of log entries. The JSON object has one entry
per line, in fixed key order, for grep-ability. The values for `status` are:
`allowed`, `denied`, or `error`.

```json
{"ts":"2026-06-04T12:00:00.000Z","tool":"write","status":"allowed","path":"/projects/active/src/x.ts"}
{"ts":"2026-06-04T12:00:01.000Z","tool":"read","status":"denied","path":"/projects/active/.env","reason":"sensitive file refused: .env"}
{"ts":"2026-06-04T12:00:02.000Z","tool":"bash","status":"allowed","command":"git status"}
{"ts":"2026-06-04T12:00:03.000Z","tool":"bash","status":"denied","command":"ls; rm -rf /","reason":"command contains disallowed shell operators: ;"}
```

## Extension structure

- `index.ts`: Thin glue to Pi's `ExtensionAPI`. Registers the `read`, `write`, `ls`, and `bash` replacements.
- `path-guard.ts`: Path allowlist + sensitive-filename gate.
- `bash-policy.ts`: Command vetting (control-operator rejection, tokenizing, program allowlist, policy building).
- `audit-log.ts`: Record formatting and writing.
