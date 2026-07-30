# `permission-gate`

Out-of-the-box, Pi has no permission popups. Every tool call requested by a
model is honored by the harness.

This extension changes that. With this extension installed, Pi:

- **refuses outright** any tool call naming a sensitive file — secrets and key
  material — with no approval path at all;
- requires explicit, interactive user confirmation before any mutating tool call
  runs — writes, edits, moves, and directory creation; and
- **redacts secret-shaped values from tool output** before the model sees them,
  which is the same concern approached from the other side: the first control
  matches a file's *name*, so it cannot see a key pasted into an ordinary
  `notes.txt`.

Confirmation defaults to deny, so a timeout or a missing interactive UI blocks
the operation.

**Every tool call is logged** to an append-only file — not only the ones that
prompted. Reads are never confirmed, but they are still actions against the
filesystem, and `docs/requirements.md` asks for observability of every one of
them. The same file carries the **turn boundaries** between calls and the
**shape** of every outbound model request, so the trail covers both channels the
agent has — never the content of either.

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
    The user is shown the tool name and a summary of the operation (the path, or
    a source and destination) and asked to approve. The dialog is the only place
    anything is shortened, and only past 800 characters — at which point it says
    how much it withheld rather than trailing an ellipsis. Nothing gated today
    comes close to that; the record is never shortened at all. See
    *What the log does not capture*.

4.  **Deny by default.** \
    The confirmation dialog has a timeout of 60s, after which time the call is
    denied. A non-interactive UI will also block the call. Only an explicit
    approval by the user will allow the call.

5.  **Log the call — every call.** \
    A JSON line is appended to the call log, which lives on a volume mounted
    from `/var/log/pi/` on the host system. This includes the read-only calls
    that passed straight through at step 2: a trail that recorded only
    confirmations would omit every `mcp_read_file`, `mcp_list_directory` and
    `mcp_search_files` — which is to say every read of project content, the
    whole reason the agent has filesystem access at all.

6.  **Redact secrets from the output, then log what the call did.** \
    A second hook, `tool_result`, fires after the tool runs. It replaces any
    secret-shaped value in the output before the model sees it (see *Redaction*
    below), then appends a second line carrying the real outcome and what was
    withheld. See below for why one line was not enough.

Two further hooks fire outside that sequence and append their own line kinds:

- `before_agent_start`, once per instruction from the operator, appends a **turn
  boundary**, so the calls between two boundaries are attributable to the
  instruction that caused them. See *Turn boundaries* below.
- `before_provider_request`, once per model call, appends the **shape** of the
  outbound request. See *Model requests* below.

```json
{"ts":"2026-06-04T11:59:58.000Z","kind":"turn_start","turn":4,"session":"01936f2e-6b2a-7c31-9e4d-8f1a2b3c4d5e"}
{"ts":"2026-06-04T11:59:59.000Z","kind":"provider_request","model":"computer-programmer","messages":34,"approx_bytes":18422}
{"ts":"2026-06-04T12:00:00.000Z","phase":"call","id":"tc_01","tool":"mcp_read_file","outcome":"allowed","confirmation":"not-required","detail":"mcp_read_file: /workspace/src/a.ts"}
{"ts":"2026-06-04T12:00:00.010Z","phase":"result","id":"tc_01","tool":"mcp_read_file","result":"ok"}
{"ts":"2026-06-04T12:00:05.000Z","phase":"call","id":"tc_02","tool":"mcp_write_file","outcome":"allowed","confirmation":"approved","detail":"mcp_write_file: /workspace/x.ts"}
{"ts":"2026-06-04T12:00:05.020Z","phase":"result","id":"tc_02","tool":"mcp_write_file","result":"ok"}
{"ts":"2026-06-04T12:00:10.000Z","phase":"call","id":"tc_03","tool":"mcp_read_file","outcome":"blocked","confirmation":"not-offered","detail":"mcp_read_file: /workspace/.env","reason":"mcp_read_file blocked: sensitive file refused: .env"}
{"ts":"2026-06-04T12:00:30.000Z","phase":"call","id":"tc_04","tool":"mcp_write_file","outcome":"blocked","confirmation":"timeout","detail":"mcp_write_file: /workspace/y.ts","reason":"mcp_write_file blocked: confirmation timed out (default deny)"}
{"ts":"2026-06-04T12:00:40.000Z","phase":"result","id":"tc_05","tool":"mcp_read_file","result":"ok","redactions":2,"rules":["aws-access-key-id","github-token"]}
```

### Two lines per call

`phase` distinguishes them, and `id` — Pi's `toolCallId` — joins them.

| `phase` | Hook | Written | Records |
|---|---|---|---|
| `call` | `tool_call` | before the tool runs | what the **gate** decided |
| `result` | `tool_result` | after the tool runs | what the **tool** did (`ok` / `error`), and what was redacted from its output |

The second line exists because the first is not a record of what happened. The
gate decides *admission*; it does not perform the call. A read of a path outside
`/workspace` is admitted here and then refused by the MCP filesystem server, so
a trail of attempts alone asserts reads that never occurred:

```json
{"ts":"…","phase":"call","id":"tc_09","tool":"mcp_read_file","outcome":"allowed","confirmation":"not-required","detail":"mcp_read_file: /workspace/../etc/passwd"}
{"ts":"…","phase":"result","id":"tc_09","tool":"mcp_read_file","result":"error"}
```

**Two lines rather than one enriched line, deliberately.** Buffering the attempt
in memory until the result arrived would give one tidy line per call, but the
only record of the attempt would live in the process for the duration of the
call — so a crash, a kill, or an OOM between the two would erase the evidence
that it was ever made. Appending on observation means the trail is never less
complete than the events that have actually happened. The cost is volume —
roughly double — which is why retention was settled explicitly rather than left
to a default; see *Retention* below.

A blocked call has no `result` line if the harness never runs the tool. The
absence is not ambiguous: the `call` line already says `blocked` and why.

### Redaction

The sensitive-filename refusal matches a file's **name**. So `.env` and `id_rsa`
cannot be opened — but a key pasted into `notes.txt`, a token in a config sample,
or a credential in a log excerpt passes straight through into the model's
context, from where it is re-sent on every subsequent request for the rest of the
session. `tool_result` is where that is closed:

```
api key: ghp_1234…      →     api key: [redacted: github-token]
```

The replacement names the rule that fired, which is deliberate: a silently
truncated value would have the agent theorising about a corrupt file, whereas a
named redaction is self-explanatory. The rest of the output is untouched, so the
file is still readable.

**The rules, and the reason there are only a few.** Every rule anchors on a
distinctive **literal** — a PEM delimiter, or an issuer's key prefix:

| Rule | Matches |
|---|---|
| `private-key-block` | `-----BEGIN … PRIVATE KEY-----` … `-----END … PRIVATE KEY-----`, delimiter to delimiter |
| `aws-access-key-id` | `AKIA…` / `ASIA…` plus exactly 16 upper-case alphanumerics |
| `github-token` | `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` with a 36-character body, and the fine-grained `github_pat_` form |
| `slack-token` | `xox[abprs]-` and a hyphen-delimited body |
| `anthropic-api-key` | `sk-ant-…` |
| `openai-api-key` | `sk-…` / `sk-proj-…`, requiring at least 32 further characters |

**There is deliberately no entropy heuristic**, and that is the central design
decision rather than an omission. High-entropy strings are also hashes, UUIDs,
minified code, base64 test fixtures, and lockfile integrity digests. Redaction is
*silent* — it changes what the model reads without telling the operator at the
time — so a false positive is not a cosmetic problem: it is corrupted input
producing a confusing failure somewhere else entirely. The test suite pins that
down with the specific shapes that would fire on a randomness test and must not
fire here.

`openai-api-key` is the weakest anchor of the set, since `sk-` is only three
characters, which is why it demands 32 more. Because only the matched span is
replaced, a false positive costs one value rather than the whole output.

**What the log records.** The `result` line gains two fields, and only when
something was redacted — the *presence* of the field is the signal, so
"nothing matched" and "the redactor did not run" cannot be confused:

| Field | Says |
|---|---|
| `redactions` | How many spans were replaced. |
| `rules` | Which rules fired, by name. |

Nothing else, and this is the sharpest case of the no-content rule in this whole
log: the record is specifically about a secret, so it must describe it without
carrying it. Not the value, not its length, not its position. A record that
reported the finding in full would be a more convenient way to leak exactly what
the redactor exists to protect.

**It changes the session transcript too, which is the point.** Pi treats returned
content as a replacement, and that replacement lands both in the model's context
and in the session file on the `pi-sessions` volume. So a redacted secret is not
merely hidden from this request — it is absent from the conversation history that
would be re-sent on resume. Verified by reading the transcript, not assumed.

**Limits, stated because the rules invite more confidence than they earn:**

- **Defence in depth, not a boundary.** The agent can still be induced to read a
  file and act on what it says without any recognised shape appearing. Nothing
  here makes it safe to keep secrets in a project the agent can read.
- **Only text.** Non-text content parts pass through untouched — a key in a
  screenshot is not something a regex over a string can see.
- **Only these shapes.** A database password, an internal API token with no
  recognisable prefix, or a passphrase in prose is not matched. A shape with no
  literal anchor cannot be added without accepting false positives.
- **Fails open.** If the redactor throws, the original output goes to the model
  and the result is recorded without redaction fields. That keeps a bug here from
  breaking tool execution, but it does mean such a bug is a quiet loss of this
  control rather than a loud one.
- **No off switch.** There is no environment variable to disable it, deliberately
  — a control that can be turned off by whatever sets the environment is a weaker
  control. If a rule misfires, the log's `rules` field names the culprit and the
  fix is a code change.

### Turn boundaries

The `call` and `result` lines are a flat sequence, so *"what did the agent do in
response to **that** instruction"* used to be answerable only by correlating
timestamps against a session transcript — which lives on a different volume,
under a different retention policy, and is the agent's own narrative rather than
an independent record. A third line kind closes that gap:

```json
{"ts":"…","kind":"turn_start","turn":7,"session":"01936f2e-…"}
{"ts":"…","phase":"call","id":"tc_21","tool":"mcp_read_file","outcome":"allowed","confirmation":"not-required","detail":"mcp_read_file: /workspace/src/a.ts"}
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

**No `phase`, deliberately.** The runbook's `jq` recipes all select on `.phase`,
and a line without that field yields `null`, which matches neither `"call"` nor
`"result"` — so every documented query returns exactly what it did before turn
lines existed, including the tool-frequency count that the gateway's `--tools`
allowlist is waiting on. Re-check this if a recipe is ever written that selects
lines by the *absence* of a field rather than by its value.

**`turn` is an ordinal, not an id.** It counts agent runs in the current process:
it is not persisted, does not restart per session, and starts again at 1 when Pi
restarts — including on `--resume`, which keeps the same `session`. `session`
plus file order is what makes a turn identifiable in a file that is appended to
forever; the number is for referring to one.

**It records a boundary, not content.** `before_agent_start` hands the handler
the operator's prompt, any attached images, and the fully assembled system
prompt. None of it is logged, and the key set is closed by a test for the same
reason the `result` line's is: this line must not grow into a record of what the
turn was *about*, or the audit trail becomes a copy of the conversation.

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

**What this is not.** It is written inside the agent's own process, so it is
evidence rather than a boundary, in exactly the sense the rest of this extension
is. An independent record would come from the host-side LiteLLM proxy, which
sees the same traffic and holds the credentials. That is deliberately not built;
`TODO.md` records the reasoning, including the thing the proxy could not do — a
proxy-side log knows nothing about turns or sessions, so it could not attribute
a request to the instruction that caused it.

### The attempt record's two axes

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

- **Paths, never content.** `detail` carries the path a call named, never what
  it returned. The `result` line is deliberately minimal for the same reason:
  `tool_result` hands the handler the tool's entire output — the file the agent
  just read — and copying that here would turn the audit trail into a second
  copy of every secret the agent has touched.

  **But every path it named, in full.** `detail` is never truncated, however
  many paths a call carries. It was once capped at 120 characters, which is
  two or three realistic `/workspace/…` entries, so a ten-file
  `read_multiple_files` recorded the first few and an ellipsis — a trail that
  could not answer which files were read, failing silently, because an ellipsis
  reads like formatting rather than like missing evidence. The cap belonged to
  the confirmation dialog and had been borrowed for the record. The two are now
  separate functions (`describeCall`, `describeForPrompt`), because a dialog
  must fit a screen and a record must be complete, and one string could only
  ever satisfy the weaker requirement.
- **What was sent to a model.** Model requests are recorded as *shape* — model,
  message count, size — never as payload. The conversation itself is the session
  transcript's job, on a different volume with a different purpose.
- **The provider's reply.** `after_provider_response` carries the status and
  headers of the response and is not handled, so the trail shows that a request
  went out, not whether it succeeded. Unlike the tool-call case — where an
  attempt-only record wrongly asserted reads that were refused — a request line
  overclaims nothing: it says a request was sent, which is true. There is also no
  id in either event to join a response to its request.
- **What a turn was about.** Turn boundaries are recorded; the instruction that
  opened one is not. `turn` and `session` say *which* turn, so the trail can be
  read against a session transcript, but the prompt itself stays out.
- **Secrets in shapes no rule matches.** Redaction covers the shapes listed
  above, so a database password, a prefix-less internal token, or a passphrase in
  prose still reaches the model. The trail records that redaction happened, never
  that a file was free of secrets.

### What this extension does not enforce

Containment — keeping file access inside the project — is **not** enforced here.
That is the MCP filesystem server's job, and it does it on the far side of the
boundary, where a compromised agent process cannot reach the check. This
extension only answers the questions the MCP server has no opinion on: *is this a
name we never touch?*, and *does this output contain something that looks like a
credential?*

Both of those run inside the agent's own process, so they are cooperative
controls — evidence and friction, not a boundary. The boundaries in this design
are elsewhere: the MCP server's containment, the read-only rootfs, the internal
network, and the absence of any execution tool.

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

### Retention

**The log grows without bound. This extension never deletes from it, and that is
deliberate.** The sink can only append; there is no cap, no rotation, and no
truncation path in this code — not on the file, and not on the lines it holds
(see *What the log does not capture* on why `detail` is complete).

Two reasons, and the second is the one that constrains future changes:

- **The volume does not justify the loss.** A call costs about **316 bytes**
  across its two lines, so a million tool calls — years of heavy single-operator
  use — is roughly 316 MB. Discarding the oldest entries of an accountability
  record to reclaim that is a bad trade. The other two line kinds do not move
  that number much: a turn line is ~112 bytes with one per instruction, and a
  provider-request line is ~126 bytes with roughly one per model call — a few
  percent on top of the calls they describe, not a change of order.
- **Truncation must not live here.** A cap inside this extension would put
  delete-my-own-history logic inside the audited process. Append-only is a
  property worth keeping: `compose.yaml` relies on the log volume outliving the
  container so a compromised session cannot erase its own trail, and a rotation
  step running as the agent's uid would spend that.

Pruning and archival are the **operator's**, from the host. The procedure — a
size check, and piping the log out to a dated `.gz` — is in the runbook
(`src/infrastructure/README.md`, *Retention*), along with the triggers for
revisiting the policy.
