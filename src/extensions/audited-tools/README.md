# `audited-tools`

This extension swaps Pi's built-in file and command tools for audited, safer
alternatives.

The extension then provides its own `read`, `write`, `ls`, and `bash` tools,
replacing Pi's built-in tools with the same names. The replacement filesystem
tools are confined to an allowlisted workspace root and they reject sensitive
filenames. The replacement `bash` tools is confined to a command allowlist with
dangerous shell metacharacters rejected.

Every call through the replacement tools is logged to an append-only audit file.

This extension provides a defense-in-depth layer to the agent harness
architecture. Even if the MCP filesystem boundary is bypassed, no file or
command operation happens inside the Pi agent without passing a guard and
being logged.

> [!IMPORTANT]
>
> Pi MUST be run with the `--no-builtin-tools` option for this extension to be
> effective. Started this way, Pi has no file or shell access of its own.
> This extension then makes its own audited tools available.
>
> `--no-builtin-tools` is required for security, not for the extension to
> function. If Pi is run without this flag, the extension still loads and its
> four tools still override Pi's built-in `read`, `write`, `ls`, and `bash`
> tools of the same name (though Pi shows a warning about the collision).
>
> All good. But without the `--no-builtin-tools` option, Pi's other built-in
> tools — `edit`, `grep`, and `find` — have no audited replacement, so they
> remain active. This means a misbehaving model could use these tools to edit
> files outside the workspace, read sensitive files, or search arbitrary paths —
> with no audit trail.
>
> Therefore, a full security profile requires `pi --no-builtin-tools`.

## What it does

### File tools (`read`, `write`, `ls`)

Each filesystem tool checks its `path` argument before doing any I/O, and
refuses it in two cases:

- **Outside the workspace.** The path must resolve to somewhere within the
  configured root — see the `AUDITED_TOOLS_ROOT` environment variable, below.
  This blocks upwards directory traversal, eg. `../../etc/passwd`.

- **A sensitive file.** Names matching well-known secrets or key material —
  eg. `.env*`, `id_rsa`, `*.pem`, `*.key`, `.netrc`, `credentials` —
  are always refused, regardless where those files live in the filesystem.

### Command tool (`bash`)

The replacement `bash` tool vets the `command` argument and refuses it in
two cases:

- **It contains shell control operators.** The only reason the characters
  `|`, `&, `;`, `<`, and `>` would exist in a command is to attempt injection.
  So command containing these characters are always rejected.

- **Its program is not on the allowlist.** The command's first token must be an
  allowed program, which is then run directly with its remaining tokens as
  literal arguments.

The replacement `bash` tool never invokes a shell. Instead, the vetted program
is run via Node's `execFile` with the `shell: false` option. This passes the
argument vector straight to the operating system rather than through `sh -c`.
This matters because a shell is a full interpreter. Give it a string and it
looks for pipes, semi-colons (`;`), `$(…)`, globs, and variable expansion —
all of which make command injection possible.

With no shell in the loop, there is nothing to interpret those constructs.
Thus, the defensive here is structural, swapping the execution environment,
rather than relying on effective sanitization of the input string.

Characters like `$`, `*`, `?`, `(`, `)`, `{`, and `}` pass through as inert text.
For example, `$(whoami)` reaches the program literally rather than expanding.
So commands such as `grep 'a.*b'` work without being a risk.

Commands run only within the workspace root, with a 30s timeout, and a
1 MB output cap.

The following commands are allow-listed by default:

- Read-only inspection commands:
    `ls`, `cat`, `head`, `tail`, `grep`,
    `find`, `wc`, `file`, `pwd`, `echo`,
    `which`, `stat`, `diff`, `tree`, `sort`,
    `uniq`, `cut`, `basename`, `dirname`

- Common dev tools:
    `git`, `node`, `npm`, `npx`, `python`,
    `python3`, `pip`, `make`, `cargo`, `go`

A denied call returns an error to the model explaining the refusal.

## Configuration

The following environment variables can be used to adjust the behavior of this
extension. The variables must be exported into the environment in which the Pi
process is running — so, in the guest environment, if the agent is containerized.

| Variable | Default | Meaning |
|---|---|---|
| `AUDITED_TOOLS_ROOT` | `/projects/active` | The single directory the tools are confined to. |
| `AUDITED_TOOLS_LOG` | `/var/log/pi/audited-tools/audit.jsonl` | Append-only audit log path. |
| `AUDITED_BASH_ALLOWLIST` | Built-in defaults, see above | Comma-separated program allowlist. |

These are set in the `compose.yaml` file for the hardened container.

When `AUDITED_BASH_ALLOWLIST` is set to a non-empty value, it fully replaces
the built-in default allowlist. For example, `ls,cat,git` would restrict Bash
calls to these three commands.

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
