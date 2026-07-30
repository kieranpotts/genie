# `audit-log`

Out-of-the-box, Pi has no observability at all. Nothing records what a tool
call named, whether it ran, what a model request contained, or which
instruction from the operator caused any of it.

This extension closes that gap for **unattended, away-from-keyboard** sessions
where nobody is watching each tool call as it happens. With this extension
installed, every tool call Pi's `mcp-client` makes — read or write, whichever
extension registered it — is appended to a JSON-lines file, along with the
turn boundary each call falls under and the shape of every outbound model
request.

**This extension makes no decisions.** It does not refuse calls, does not
redact tool output, and does not decide whether a call should have been
allowed. It only watches and records. That is a deliberate split from
[`secret-sentry`][pi-secret-sentry] in the same repository, which owns those
decisions: a single extension that both decided admission *and* logged it used
to make sense, because the code that blocks a call is naturally the code best
placed to say so. Splitting them apart means this extension cannot make that
claim any more — see *What this extension cannot see* below for the
consequence, and read `secret-sentry`'s README alongside this one if you need
the full picture of one call.

[pi-secret-sentry]: https://github.com/kieranpotts/pi/blob/main/src/extensions/secret-sentry/README.md

## What it does

Four hooks, each appending its own line kind to the same file:

- `tool_call`, before a tool runs — the attempt: which tool, and what it
  named (see *Turn boundaries and calls* below).
- `tool_result`, after a tool runs — the outcome: `ok` or `error`, joined to
  the attempt by Pi's `toolCallId`.
- `before_agent_start`, once per instruction from the operator — a **turn
  boundary**, so the calls that follow are attributable to the instruction
  that caused them.
- `before_provider_request`, once per model call — the **shape** of the
  outbound request, never its content.

```json
{"ts":"2026-06-04T11:59:58.000Z","kind":"turn_start","turn":4,"session":"01936f2e-6b2a-7c31-9e4d-8f1a2b3c4d5e"}
{"ts":"2026-06-04T11:59:59.000Z","kind":"provider_request","model":"computer-programmer","messages":34,"approx_bytes":18422}
{"ts":"2026-06-04T12:00:00.000Z","phase":"call","id":"tc_01","tool":"mcp_read_file","detail":"mcp_read_file: /workspace/src/a.ts"}
{"ts":"2026-06-04T12:00:00.010Z","phase":"result","id":"tc_01","tool":"mcp_read_file","result":"ok"}
{"ts":"2026-06-04T12:00:05.000Z","phase":"call","id":"tc_02","tool":"mcp_write_file","detail":"mcp_write_file: /workspace/x.ts"}
{"ts":"2026-06-04T12:00:05.020Z","phase":"result","id":"tc_02","tool":"mcp_write_file","result":"ok"}
```

### What this extension cannot see

`secret-sentry` refuses a call naming a sensitive file — `.env`, `id_rsa`,
`*.pem` — with no approval path at all, and it records that refusal in its own
log, `security.jsonl`. This extension has no visibility into that decision, for
a reason rooted in how Pi dispatches the `tool_call` event: the runner
(`ExtensionRunner.emitToolCall`) calls each extension's handler in turn, and
**stops calling further extensions the instant any handler returns
`{ block: true }`**. So whether this extension's `tool_call` handler runs at
all for a call `secret-sentry` goes on to refuse depends on which extension
Pi's loader happens to invoke first — and Pi discovers extensions by
`readdirSync`-ing the extensions directory, an order it does not document or
guarantee.

Concretely, for a call `secret-sentry` blocks:

- If this extension's handler ran first, a `call` line appears here, with no
  matching `result` line (because the tool never ran) — indistinguishable, in
  this file alone, from a call that was allowed and then errored inside the
  MCP server.
- If `secret-sentry`'s handler ran first, no line appears here at all for that
  call.

Either way, **this extension's `call` line never carries an `outcome` or
`confirmation` field**, unlike the equivalent line in the single extension this
was split from — this extension is not the one deciding, so it does not
pretend to. `secret-sentry`'s `security.jsonl` is the order-independent,
authoritative record of what was refused and why; it is written from inside
the same handler that makes the block decision, so it exists regardless of
extension load order. A reviewer who needs to know whether a specific
`toolCallId` ran, was refused, or ran and had output redacted must read both
files and join on `id`.

The same split applies to tool-output redaction: `secret-sentry` replaces
secret-shaped spans before the model sees them and records that in its own
log (`redactions`, `rules`). This extension's `result` line says only `ok` or
`error` — it does not know, and does not claim to know, whether anything was
withheld from that result.

### Two lines per call

`phase` distinguishes them, and `id` — Pi's `toolCallId` — joins them.

| `phase` | Hook | Written | Records |
|---|---|---|---|
| `call` | `tool_call` | when this extension is dispatched the event | what the call named |
| `result` | `tool_result` | after the tool runs | `ok` / `error` |

**Two lines rather than one, deliberately, for the same reason `secret-sentry`
keeps two.** Buffering the attempt in memory until the result arrived would
give one tidy line per call, but the only record of the attempt would live in
the process for the duration of the call — so a crash, a kill, or an OOM
between the two would erase the evidence that it was ever made. Appending on
observation means the trail is never less complete than the events that have
actually happened.

### Turn boundaries

The `call` and `result` lines are a flat sequence, so *"what did the agent do
in response to **that** instruction"* used to be answerable only by
correlating timestamps against a session transcript — which lives on a
different volume, under a different retention policy, and is the agent's own
narrative rather than an independent record. A third line kind closes that
gap:

```json
{"ts":"…","kind":"turn_start","turn":7,"session":"01936f2e-…"}
{"ts":"…","phase":"call","id":"tc_21","tool":"mcp_read_file","detail":"mcp_read_file: /workspace/src/a.ts"}
{"ts":"…","phase":"result","id":"tc_21","tool":"mcp_read_file","result":"ok"}
```

Every call line belongs to the turn whose boundary most recently preceded it.
The hook is `before_agent_start`, which fires after a prompt is submitted and
before the agent loop runs.

| Field | Says |
|---|---|
| `kind` | `turn_start`. Turn lines carry **no `phase`** — see below. |
| `turn` | Which turn, counted from 1 **by the running process**. |
| `session` | Pi's session id. Omitted, rather than faked, if unavailable. |

**No `phase`, deliberately.** A line without that field yields `null` on a
`.phase` selector, which matches neither `"call"` nor `"result"` — so a `jq`
recipe written against those two lines keeps working unmodified once turn
lines and provider-request lines exist alongside them.

**`turn` is an ordinal, not an id.** It counts agent runs in the current
process: it is not persisted, does not restart per session, and starts again
at 1 when Pi restarts — including on `--resume`, which keeps the same
`session`. `session` plus file order is what makes a turn identifiable in a
file that is appended to forever; the number is for referring to one.

**It records a boundary, not content.** `before_agent_start` hands the
handler the operator's prompt, any attached images, and the fully assembled
system prompt. None of it is logged, and the key set is closed by a test for
the same reason the `result` line's is: this line must not grow into a record
of what the turn was *about*, or the audit trail becomes a copy of the
conversation.

**One boundary per agent run, which is not quite one per message.** A message
queued while the agent is already streaming — a steer or a follow-up — is
consumed by the run already in flight and does not start a new one, so it
produces no boundary and its calls are attributed to the turn in progress.

### Model requests

Tool calls were only part of what the agent does. Every model call also leaves
the process, carrying whatever the agent has read, and the trail used to say
nothing about it at all. `before_provider_request` closes that:

```json
{"ts":"…","kind":"provider_request","model":"computer-programmer","messages":34,"approx_bytes":18422}
```

| Field | Says |
|---|---|
| `model` | The model id **as it appears in the outbound body** — what was asked for, not what Pi has selected in its own state. |
| `messages` | How many messages the request carries. |
| `approx_bytes` | Size of the serialised body. |

Every field is omitted when the payload does not carry it, because a `0` would
be a claim about the request rather than an absence of one. The payload's shape
belongs to the provider — the OpenAI-completions body for this stack's LiteLLM
route — so nothing is assumed about it.

**`approx_bytes` is approximate in a specific way.** It measures the JSON the
handler can see, not the bytes on the wire: headers, compression, and any
provider-side re-encoding are outside it. It exists so that context growth is
visible *without* recording the context. Watching it climb across a turn is the
cheapest signal there is that the agent is accumulating file content it will
re-send on every subsequent call.

**Shape, never content — and this is the line where that rule earns its keep.**
The event hands the handler `payload: unknown`, and that payload is the whole
conversation: the system prompt, every message, and the contents of every file
read this session. The easiest thing to write in this handler is
`JSON.stringify(payload)`, and the result would be a complete copy of everything
the agent has touched, in the one file that is supposed to be trustworthy. So
the extraction lives in a pure, separately tested module (`provider-request.ts`)
that takes named scalars and never spreads, and a test asserts the record's key
set is closed.

**The handler returns `undefined`, and must.** Pi treats any other return value
from this hook as a *replacement payload* — `runner.js` does
`if (handlerResult !== undefined) currentPayload = handlerResult` — so a logging
handler that returned something would silently rewrite the request the agent is
about to send. There is a test for it.

### What the log does not capture

- **Paths, never content.** `detail` carries the path a call named, never what
  it returned. The `result` line is deliberately minimal for the same reason:
  `tool_result` hands the handler the tool's entire output — the file the agent
  just read — and copying that here would turn the audit trail into a second
  copy of every secret the agent has touched.

  **But every path it named, in full.** `detail` is never truncated, however
  many paths a call carries. It was once capped at 120 characters, which is
  two or three realistic `/workspace/…` entries, so a ten-file
  `read_multiple_files` recorded the first few and an ellipsis — a trail that
  could not answer which files were read, failing silently, because an
  ellipsis reads like formatting rather than like missing evidence.
- **What was sent to a model.** Model requests are recorded as *shape* — model,
  message count, size — never as payload. The conversation itself is the session
  transcript's job, on a different volume with a different purpose.
- **What a turn was about.** Turn boundaries are recorded; the instruction that
  opened one is not. `turn` and `session` say *which* turn, so the trail can be
  read against a session transcript, but the prompt itself stays out.
- **Whether a call was ever admitted, or what it output.** That is
  `secret-sentry`'s record, not this one — see *What this extension cannot
  see* above.

## Configuration

The following environment variables can be used to adjust the behavior of this
extension. The variables must be exported into the environment in which the Pi
process is running — so, in the guest environment, if the agent is
containerized.

| Variable | Default | Description |
|---|---|---|
| `AUDIT_LOG_CALL_LOG` | `/var/log/pi/audit-log/calls.jsonl` | Append-only activity-log path. |

If running Pi inside the hardened container, the `AUDIT_LOG_CALL_LOG` path
MUST be within a **writable volume** mounted from the host. Without this, the
write operation will fail silently, because the hardened container runs with
a read-only rootfs. The hardened container's `compose.yaml` file provides
this via the `pi-logs` volume, mounted at `/var/log/pi` — the same volume
`secret-sentry` uses, each extension writing to its own subdirectory.

> [!IMPORTANT]
> The volume must also be **owned by the agent's uid**, or the log silently
> never appears. See `secret-sentry`'s README for the mechanism and the
> `docker volume rm` remedy — it applies identically here.

The log file path does not need to exist, because the extension will create
it, and its parent directory, on first write.

### Retention

**The log grows without bound. This extension never deletes from it, and that
is deliberate.** The sink can only append; there is no cap, no rotation, and no
truncation path in this code.

**Truncation must not live here**, for the same reason it must not live in
`secret-sentry`: a cap inside this extension would put delete-my-own-history
logic inside the audited process. Pruning and archival are the **operator's**,
from the host — see `src/infrastructure/README.md`, *Retention*.
