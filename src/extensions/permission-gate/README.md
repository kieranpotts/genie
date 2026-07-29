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

**Every tool call is logged** to an append-only file — not only the ones that
prompted. Reads are never confirmed, but they are still actions against the
filesystem, and `docs/requirements.md` asks for observability of every one of
them.

The `tool_call` hook is the only place in the harness that sees **every** tool
call, whichever extension registered it. That is why the sensitive-file rule
lives here: it must cover the `mcp_*` tools, which are the agent's sole route to
project files. Since the removal of `audited-tools` it is also why this is the
system's **only** audit trail — so anything this extension does not record is
not recorded anywhere.

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
    …) pass through without a prompt — but not without a record; see step 5.
    Mutating tools (`*_write_file`, `*_edit_file`, `*_move_file`,
    `*_create_directory`, and the unprefixed `write` / `edit`) are gated.

3.  **Confirm.** \
    The user is shown the tool name and a summary of the operation (the path,
    or a truncated list of paths) and asked to approve.

4.  **Deny by default.** \
    The confirmation dialog has a timeout of 60s, after which time the call is
    denied. A non-interactive UI will also block the call. Only an explicit
    approval by the user will allow the call.

5.  **Log the call — every call.** \
    One JSON line per tool call is appended to the call log, which lives on a
    volume mounted from `/var/log/pi/` on the host system. This includes the
    read-only calls that passed straight through at step 2: a trail that
    recorded only confirmations would omit every `mcp_read_file`,
    `mcp_list_directory` and `mcp_search_files` — which is to say every read of
    project content, the whole reason the agent has filesystem access at all.

```json
{"ts":"2026-06-04T12:00:00.000Z","tool":"mcp_read_file","outcome":"allowed","confirmation":"not-required","detail":"mcp_read_file: /workspace/src/a.ts"}
{"ts":"2026-06-04T12:00:05.000Z","tool":"mcp_write_file","outcome":"allowed","confirmation":"approved","detail":"mcp_write_file: /workspace/x.ts"}
{"ts":"2026-06-04T12:00:10.000Z","tool":"mcp_read_file","outcome":"blocked","confirmation":"not-offered","detail":"mcp_read_file: /workspace/.env","reason":"mcp_read_file blocked: sensitive file refused: .env"}
{"ts":"2026-06-04T12:00:30.000Z","tool":"mcp_write_file","outcome":"blocked","confirmation":"timeout","detail":"mcp_write_file: /workspace/y.ts","reason":"mcp_write_file blocked: confirmation timed out (default deny)"}
```

### The record's two axes

`outcome` and `confirmation` are deliberately **separate fields**, because they
answer different questions and a reviewer needs both:

| Field | Values | Answers |
|---|---|---|
| `outcome` | `allowed`, `blocked` | Did the call run? |
| `confirmation` | `not-required`, `not-offered`, `approved`, `rejected`, `timeout`, `no-ui` | Was a human involved, and what did they say? |

The two `no prompt was shown` values are not interchangeable, and the difference
is the point:

- **`not-required`** — a read-only call. There was nothing to approve. Pairs
  with `allowed`.
- **`not-offered`** — a sensitive-file refusal. There is deliberately **no
  approval path**, so a model cannot socially engineer its way past it. Pairs
  with `blocked`.

Collapsing these onto a single `status` field would leave the *cause* of a
denial legible only as prose in `reason`, so "refused outright by policy" and
"the operator said no" could not be told apart without parsing English. They are
different events in a review, and they are counted separately.

`reason` is present only on a blocked call. For an allowed one the two axes
already say everything there is to say.

### What the log does not capture

- **Attempts, not results.** The `tool_call` hook fires *before* the call runs,
  so this records what was requested. A read that the MCP filesystem server then
  refuses — path traversal, or a path outside the allowed directory — is logged
  here as `allowed`, because the gate never sees the outcome. Recording what a
  call actually *did* needs the `tool_result` hook or a gateway-side `after:`
  interceptor; both are open items in `TODO.md`.
- **Paths, never content.** `detail` carries the path a call named, never what
  it returned. Logging what was read would copy the secrets out of the files and
  into the audit trail, which is the opposite of the point.

### What this extension does not enforce

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
| `PERMISSION_GATE_CALL_LOG` | `/var/log/pi/permission-gate/calls.jsonl` | Append-only tool-call log path. |

If running Pi inside the hardened container, the `PERMISSION_GATE_CALL_LOG` path MUST
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
