# `audited-tools`

This extension gives Pi an audited, allowlisted replacement for its built-in
`bash` tool.

Every call is vetted before anything runs — no shell is ever invoked, shell
control operators are rejected, and only allowlisted programs execute — and
every call is logged to an append-only audit file.

> [!IMPORTANT]
>
> Pi MUST be run with the `--no-builtin-tools` option for this extension to be
> effective. Started this way, Pi has no file or shell access of its own. This
> extension then provides the audited `bash`, and the `mcp-client` extension
> provides the mediated file tools.
>
> `--no-builtin-tools` is required for security, not for the extension to
> function. If Pi is run without this flag, this extension's `bash` still
> overrides Pi's built-in tool of the same name (though Pi shows a warning about
> the collision) — but Pi's other built-in tools, including `read`, `write`,
> `edit`, `grep`, and `find`, remain active with direct, unaudited access to the
> container's filesystem.
>
> Therefore, a full security profile requires `pi --no-builtin-tools`.

## Scope

Read this before assuming this extension guards project files. **It does not.**

In the hardened container, the agent has no project mount at all: the project is
reachable only through the `mcp_*` tools, which the MCP filesystem server
mediates on the far side of the boundary. The `bash` tool here runs inside the
agent container, so it can see the container's own filesystem and nothing of the
project. It is a guard on what the agent may **execute locally** — not a second
gate in front of the MCP boundary.

This extension used to also provide audited `read`, `write`, and `ls` tools,
described as a defence-in-depth layer behind MCP. They were removed, because
that description was never true as deployed: they were rooted at
`/projects/active`, a path that exists only inside the MCP filesystem server's
container, so every call failed — while still being recorded in the audit trail
as *allowed*.

The one control those tools carried that the MCP server does not replicate —
refusing sensitive filenames such as `.env` and `*.pem` — now lives in the
[`permission-gate`](../permission-gate/) extension, whose `tool_call` hook sees
every tool call including the `mcp_*` ones. That is a strictly wider guarantee
than the one it replaced.

## What it does

The `bash` tool vets the `command` argument and refuses it in two cases:

- **It contains shell control operators.** The only reason the characters `|`,
  `&`, `;`, `<`, `>`, and backtick would exist in a command is to attempt
  injection. So commands containing these characters are always rejected.

- **Its program is not on the allowlist.** The command's first token must be an
  allowed program, which is then run directly with its remaining tokens as
  literal arguments.

The `bash` tool never invokes a shell. Instead, the vetted program is run via
Node's `execFile` with the `shell: false` option. This passes the argument vector
straight to the operating system rather than through `sh -c`. This matters
because a shell is a full interpreter. Give it a string and it looks for pipes,
semi-colons (`;`), `$(…)`, globs, and variable expansion — all of which make
command injection possible.

With no shell in the loop, there is nothing to interpret those constructs. Thus,
the defence here is structural, swapping the execution environment, rather than
relying on effective sanitization of the input string.

Characters like `$`, `*`, `?`, `(`, `)`, `{`, and `}` pass through as inert text.
For example, `$(whoami)` reaches the program literally rather than expanding. So
commands such as `grep 'a.*b'` work without being a risk.

Commands run in the configured working directory, with a 30s timeout, and a 1 MB
output cap.

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

Note that a command naming a sensitive file — `cat id_rsa` — is refused before it
reaches this extension, by the `permission-gate`.

## Configuration

The following environment variables can be used to adjust the behavior of this
extension. The variables must be exported into the environment in which the Pi
process is running — so, in the guest environment, if the agent is containerized.

| Variable | Default | Meaning |
|---|---|---|
| `AUDITED_BASH_CWD` | `/home/pi` | Working directory vetted commands run in. Must exist. |
| `AUDITED_TOOLS_LOG` | `/var/log/pi/audited-tools/audit.jsonl` | Append-only audit log path. |
| `AUDITED_BASH_ALLOWLIST` | Built-in defaults, see above | Comma-separated program allowlist. |

These are set in the `compose.yaml` file for the hardened container.

`AUDITED_BASH_CWD` is a working directory, not a security boundary — the command
allowlist is the boundary. It defaults to the agent's home because that is the
one directory guaranteed to exist in the hardened image. A command that names an
absolute path elsewhere still reaches it, subject to the allowlist, the
sensitive-filename refusal in `permission-gate`, and the container's own
filesystem permissions.

When `AUDITED_BASH_ALLOWLIST` is set to a non-empty value, it fully replaces the
built-in default allowlist. For example, `ls,cat,git` would restrict bash calls
to these three commands.

If running Pi inside the hardened container, the `AUDITED_TOOLS_LOG` path MUST be
within a **writable volume** mounted from the host. Without this, the write
operation will fail silently, because the hardened container runs with a
read-only rootfs. The hardened container's `compose.yaml` file provides this via
the `pi-logs` volume, mounted at `/var/log/pi`.

> [!IMPORTANT]
> The volume must also be **owned by the agent's uid**. The image creates
> `/var/log/pi` as the `pi` user so that Docker seeds a new named volume with
> that ownership — but a volume created before that layer existed keeps its
> original `root:root` ownership, and the agent cannot write to it. Because both
> log sinks swallow write failures by design (a failed log must not change a
> tool's outcome), this fails **silently**: the log file simply never appears.
> Remove the volume to re-seed it:
>
> ```sh
> docker compose -f src/infrastructure/compose.yaml down
> docker volume rm pi-secure-agent_pi-logs
> ```

The log file path does not need to exist, because the extension will create it,
and its parent directory, on first write.

The following is a representation of log entries. The JSON object has one entry
per line, in fixed key order, for grep-ability. The values for `status` are:
`allowed`, `denied`, or `error`.

```json
{"ts":"2026-06-04T12:00:02.000Z","tool":"bash","status":"allowed","command":"git status"}
{"ts":"2026-06-04T12:00:03.000Z","tool":"bash","status":"denied","command":"ls; rm -rf /","reason":"command contains disallowed shell operators: ;"}
{"ts":"2026-06-04T12:00:04.000Z","tool":"bash","status":"denied","command":"curl http://x","reason":"program not on allowlist: curl"}
```
