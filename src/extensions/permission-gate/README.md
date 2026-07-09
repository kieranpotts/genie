# `permission-gate`

Requires explicit, interactive user confirmation before any mutating tool call
runs — writes, edits, and shell execution. Confirmation defaults to deny, so a
timeout or a missing interactive UI blocks the operation.

Every decision, whether approved or denied, is logged to an append-only file.



## Relationship to `audited-tools`

The two are complementary and independent:

- `audited-tools` enforces *where* and *what* (path allowlist, sensitive-file refusal) — a non-interactive, policy gate.
- `permission-gate` enforces *whether the human agrees* — an interactive gate on mutating calls.

Run both for layered control. Each keeps its own decision/audit log (and its own copy of the small log helper, since the verbatim-copy installer requires each extension directory to be self-contained).


## What it does

On every `tool_call` event, which fires before a tool executes:

1.  **Classify.** \
    Read-only tools (`read`, `ls`, `grep`, `find`, and their MCP equivalents)
    pass through silently. Mutating tools (`write`, `edit`, `bash`, and
     custom `*_write_file` / `*_edit_file` / etc.) are gated.

2.  **Confirm.** \
    The user is shown the tool name and a summary of the operation
    (the path, or a truncated command) and asked to approve.
    The dialog has a timeout of 60s, after which the call is denied.

3.  **Deny by default.** \
    The confirmation dialog has a timeout of 60s, after which the call is
    denied. A non-interactive UI will also block the call. Only an explicit
    approval by the user will allow the call.

4.  **Log.** \
    The decision, whether approved or denied,  is appended as one JSON line
    to the decision log. A representative sample is shown below.

```json
{"ts":"2026-06-04T12:00:00.000Z","tool":"write","status":"approved","reason":"user approved","detail":"write: /projects/active/x.ts"}
{"ts":"2026-06-04T12:00:30.000Z","tool":"bash","status":"denied","reason":"bash blocked: confirmation timed out (default deny)","detail":"bash: rm -rf /tmp/x"}
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PERMISSION_GATE_LOG` | `/var/log/pi/permission-gate/audit.jsonl` | Append-only decision log path. Should live on a volume outside the read-only rootfs; the extension creates the parent directory on first write. |

## Structure

- `index.ts`: The `tool_call` handler. iT handles the classify → confirm → log → block/allow sequence.
- `policy.ts`: Defines which tool are gated. Applies deny-by-default logic.
- `decision-log.ts`: Formats audit entries and writes them to the decision log.
