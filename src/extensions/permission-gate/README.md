# `permission-gate`

Out-of-the-box, Pi has no permission popups. Every tool call requested by a
model is honored by the harness.

This extension changes that. With this extension installed, Pi requires explicit,
interactive user confirmation before any mutating tool call runs — writes,
edits, and shell execution.

Confirmation defaults to deny, so a timeout or a missing interactive UI blocks
the operation.

Every decision, whether approved or denied, is logged to an append-only file.

## What it does

This extension runs the following logic sequence on every `tool_call` event,
which fires before a tool is invoked:

1.  **Classify the tool: read-only versus mutating/dangerous** \
    Read-only tools (`read`, `ls`, `grep`, `find`, and their MCP equivalents)
    pass through silently. Mutating tools (`write`, `edit`, `bash`, and
     custom `*_write_file` / `*_edit_file` / etc.) are gated.

2.  **Confirm.** \
    The user is shown the tool name and a summary of the operation
    (the path, or a truncated command) and asked to approve.

3.  **Deny by default.** \
    The confirmation dialog has a timeout of 60s, after which time the call is
    denied. A non-interactive UI will also block the call. Only an explicit
    approval by the user will allow the call.

4.  **Log.** \
    The decision, whether approved or denied, is appended as one JSON line
    to a decision log, which lives on a volume mounted from `/var/log/pi/`
    on the host system. A representative sample of log entries is shown below.

```json
{"ts":"2026-06-04T12:00:00.000Z","tool":"write","status":"approved","reason":"user approved","detail":"write: /projects/active/x.ts"}
{"ts":"2026-06-04T12:00:30.000Z","tool":"bash","status":"denied","reason":"bash blocked: confirmation timed out (default deny)","detail":"bash: rm -rf /tmp/x"}
```

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
via the `pi-logs` volume, mounted from `/var/log/pi`.

The log file path does not need to exist, because the extension will create it,
and its parent directory, on first write.
