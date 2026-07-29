# `permission-gate`

Out-of-the-box, Pi has no permission popups. Every tool call requested by a
model is honored by the harness.

This extension changes that. With this extension installed, Pi:

- **refuses outright** any tool call naming a sensitive file — secrets and key
  material — with no approval path at all; and
- requires explicit, interactive user confirmation before any mutating tool call
  runs — writes, edits, moves, and directory creation.

Confirmation defaults to deny, so a timeout or a missing interactive UI blocks
the operation.

Every decision, whether approved or denied, is logged to an append-only file.

The `tool_call` hook is the only place in the harness that sees **every** tool
call, whichever extension registered it. That is why the sensitive-file rule
lives here: it must cover the `mcp_*` tools, which are the agent's sole route to
project files.

## What it does

This extension runs the following logic sequence on every `tool_call` event,
which fires before a tool is invoked:

1.  **Refuse sensitive files.** \
    Every path-shaped argument is checked against a list of secret and key-material
    filename patterns — `.env*`, `id_rsa`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
    `.netrc`, `.npmrc`, `.pgpass`, `credentials`, `.git-credentials` — matched on
    the basename, case-insensitively, wherever the file lives. A match blocks the
    call immediately.

    This check runs on **every** call, including read-only ones: reading a private
    key is precisely the exfiltration it exists to stop. It is deliberately **not**
    a prompt — there is no approval path, so a misbehaving model cannot talk a
    distracted operator past it.

    Arguments are read from the path-bearing keys (`path`, `paths`, `source`,
    `destination`, …), which covers the MCP filesystem server's argument shapes.
    Keys that carry patterns rather than paths — `search_files` takes `pattern`
    — are not checked, so searching *for* `*.key` files by name is still
    allowed; only opening one is not.

2.  **Classify the tool: read-only versus mutating** \
    Read-only tools (`mcp_read_file`, `mcp_list_directory`, `mcp_search_files`,
    …) pass through silently. Mutating tools (`*_write_file`, `*_edit_file`,
    `*_move_file`, `*_create_directory`, and the unprefixed `write` / `edit`)
    are gated.

3.  **Confirm.** \
    The user is shown the tool name and a summary of the operation (the path,
    or a truncated list of paths) and asked to approve.

4.  **Deny by default.** \
    The confirmation dialog has a timeout of 60s, after which time the call is
    denied. A non-interactive UI will also block the call. Only an explicit
    approval by the user will allow the call.

5.  **Log.** \
    The decision, whether approved or denied, is appended as one JSON line
    to a decision log, which lives on a volume mounted from `/var/log/pi/`
    on the host system. A representative sample of log entries is shown below.

```json
{"ts":"2026-06-04T12:00:00.000Z","tool":"write","status":"approved","reason":"user approved","detail":"write: /projects/active/x.ts"}
{"ts":"2026-06-04T12:00:10.000Z","tool":"mcp_read_file","status":"denied","reason":"mcp_read_file blocked: sensitive file refused: .env","detail":"mcp_read_file: /projects/active/.env"}
{"ts":"2026-06-04T12:00:30.000Z","tool":"mcp_write_file","status":"denied","reason":"mcp_write_file blocked: confirmation timed out (default deny)","detail":"mcp_write_file: /projects/active/y.ts"}
```

### What this does not do

Containment — keeping file access inside the project — is **not** enforced here.
That is the MCP filesystem server's job, and it does it on the far side of the
boundary, where a compromised agent process cannot reach the check. This
extension only answers the question the MCP server has no opinion on: *is this a
name we never touch?*

## Configuration

The following environment variables can be used to adjust the behavior of this
extension. The variables must be exported into the environment in which the Pi
process is running — so, in the guest environment, if the agent is containerized.

| Variable | Default | Description |
|---|---|---|
| `PERMISSION_GATE_LOG` | `/var/log/pi/permission-gate/audit.jsonl` | Append-only decision log path. |

If running Pi inside the hardened container, the `PERMISSION_GATE_LOG` path MUST
be within a **writable volume** mounted from the host. Without this, the write
operation will fail silently, because the hardened container runs with a
read-only rootfs. The hardened container's `compose.yaml` file provides this
via the `pi-logs` volume, mounted at `/var/log/pi`.

> [!IMPORTANT]
> The volume must also be **owned by the agent's uid**, or the log silently never
> appears. The image creates `/var/log/pi/permission-gate` as the `pi` user so
> that Docker seeds a new named volume with that ownership — but a volume created
> before that layer existed keeps its original `root:root` ownership, and the
> agent cannot write to it. Because the sink swallows write failures by design (a
> failed log must not change a tool's outcome), this fails **silently**: the log
> file simply never appears. Remove the volume to re-seed it:
>
> ```sh
> docker compose -f src/infrastructure/compose.yaml down
> docker volume rm pi-secure-agent_pi-logs
> ```

The log file path does not need to exist, because the extension will create it,
and its parent directory, on first write.
