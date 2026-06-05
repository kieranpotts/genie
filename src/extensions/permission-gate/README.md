# permission-gate

Requires explicit, interactive user confirmation before any mutating tool call runs — writes, edits, and shell execution. Confirmation defaults to **deny**: a timeout or a missing interactive UI blocks the operation. Every decision, approved or denied, is logged to an append-only file.

This is the interactive-approval layer the architecture doc flags as the immature gap across the ecosystem (most setups are fully open or fully closed). See [docs/local-agent-architecture.md](../../../docs/local-agent-architecture.md).

## What it does

On every `tool_call` (which fires before a tool executes and can block it):

1. **Classify.** Read-only tools (`read`, `ls`, `grep`, `find`, and their MCP equivalents) pass through silently. Mutating tools (`write`, `edit`, `bash`, and custom `*_write_file` / `*_edit_file` / etc.) are gated.
2. **Confirm.** The user is shown the tool name and a summary of the operation (the path, or a truncated command) and asked to approve. The dialog has a timeout.
3. **Default deny.** Only an explicit approval allows the call. Rejection, timeout, or no interactive UI all block it with a clear reason returned to the model.
4. **Log.** The decision is appended as one JSON line to the decision log.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PERMISSION_GATE_LOG` | `/home/pi/sessions/permissions.jsonl` | Append-only decision log path. Should live outside the agent's writable tree. |

The confirmation timeout is 60s (after which the call is denied).

## Decision record format

One JSON object per line:

```json
{"ts":"2026-06-04T12:00:00.000Z","tool":"write","status":"approved","reason":"user approved","detail":"write: /projects/active/x.ts"}
{"ts":"2026-06-04T12:00:30.000Z","tool":"bash","status":"denied","reason":"bash blocked: confirmation timed out (default deny)","detail":"bash: rm -rf /tmp/x"}
```

## Relationship to `audited-tools`

The two are complementary and independent:

- `audited-tools` enforces *where* and *what* (path allowlist, sensitive-file refusal) — a non-interactive, policy gate.
- `permission-gate` enforces *whether the human agrees* — an interactive gate on mutating calls.

Run both for layered control. Each keeps its own decision/audit log (and its own copy of the small log helper, since the verbatim-copy installer requires each extension directory to be self-contained).

## Files

- `index.ts` — `tool_call` handler: classify → confirm → log → block/allow.
- `policy.ts` — pure classification (which tools are gated) and default-deny decision logic.
- `decision-log.ts` — pure record formatting + append-only file sink.
