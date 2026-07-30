# `secret-sentry`

Out-of-the-box, Pi has no security controls at all. Every tool call requested
by a model is honored by the harness, and every value a tool returns reaches
the model unchanged.

This extension changes that, for **unattended, away-from-keyboard** sessions
where nobody is watching each tool call as it happens. With this extension
installed, Pi:

- **refuses outright** any tool call naming a sensitive file — secrets and key
  material — with no approval path at all; and
- **redacts secret-shaped values from tool output** before the model sees them,
  which is the same concern approached from the other side: the first control
  matches a file's *name*, so it cannot see a key pasted into an ordinary
  `notes.txt`.

There is deliberately **no interactive confirmation** here. A prompt that
nobody is present to answer could only ever time out and default-deny, which
would make every mutating call fail rather than gate it — theatre, not a
control. If you want an interactive, at-keyboard confirmation gate instead,
see [`permission-gate`][pi-permission-gate] in the `pi` repository, which uses
the same sensitive-file detection to route a call through a confirmation
dialog rather than to block it outright.

**Every decision this extension makes is logged** — a refusal, and a
redaction — to its own append-only file, `security.jsonl`. This is
deliberately **not** a general call log any more: reading and writing that
trip neither control here are recorded by the separate [`audit-log`][pi-audit-log]
extension instead, which owns the generic "every call, every turn boundary,
every model request" trail. This extension used to do both jobs; it now does
one, and records only what it, specifically, decided.

The `tool_call` hook this extension registers is not the only place in the
harness that sees a tool call any more, either — `audit-log` also has one, and
between them the two hooks cover the same `mcp_*` surface. But
Pi stops dispatching a `tool_call` event to further extensions the instant any
handler blocks it, so a call this extension refuses may never reach
`audit-log`'s handler at all, depending on an extension load order Pi does not
guarantee. That is why this extension's own log is the **authoritative**
record of what it refused: it is written from inside the very handler that
decides, so its completeness does not depend on what any other extension does
or in what order. See *What this extension logs* below, and `audit-log`'s
README for the complementary half of the trail.

[pi-permission-gate]: https://github.com/kieranpotts/pi/blob/main/src/extensions/permission-gate/README.md
[pi-audit-log]: https://github.com/kieranpotts/pi/blob/main/src/extensions/audit-log/README.md

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
    key is precisely the exfiltration it exists to stop. There is no approval
    path, so a misbehaving model cannot talk its way past it — there is nobody
    there to talk to.

    Arguments are read from the path-bearing keys (`path`, `paths`, `source`,
    `destination`, …), which covers the MCP filesystem server's argument shapes.
    Keys that carry patterns rather than paths — `search_files` takes `pattern`
    — are not checked, so searching *for* `*.key` files by name is still
    allowed; only opening one is not.

    A refusal is logged immediately, to this extension's own file (see below),
    with the reason and the full offending path.

2.  **Everything else proceeds.** \
    There is no mutating/read-only distinction here and nothing is gated by a
    prompt: mutating tools (`*_write_file`, `*_edit_file`, `*_move_file`,
    `*_create_directory`) run exactly as read-only ones do. Running unattended
    means the agent has to be able to act without a human in the loop.
    Containment (staying inside the project) is the MCP server's job, on the
    far side of a boundary this extension cannot see past. This extension
    records nothing for a call it does not refuse — that is `audit-log`'s job.

3.  **Redact secrets from the output.** \
    A second hook, `tool_result`, fires after the tool runs. It replaces any
    secret-shaped value in the output before the model sees it (see
    *Redaction* below), and if anything was replaced, appends a `redaction`
    record naming the count and which rules fired.

## What this extension logs

Two record kinds, in `security.jsonl`, neither of which is a `call`/`result`
pair the way `audit-log`'s are — a blocked call never runs, so there is
nothing to pair it with, and a redaction is a fact about a result that already
has its own `ok`/`error` line elsewhere:

```json
{"ts":"2026-06-04T12:00:10.000Z","kind":"blocked","id":"tc_03","tool":"mcp_read_file","path":"/workspace/.env","reason":"mcp_read_file blocked: sensitive file refused: .env"}
{"ts":"2026-06-04T12:00:40.000Z","kind":"redaction","id":"tc_05","tool":"mcp_read_file","redactions":2,"rules":["aws-access-key-id","github-token"]}
```

| `kind` | Written from | Fields | Records |
|---|---|---|---|
| `blocked` | `tool_call` | `path`, `reason` | A call refused before it ran. |
| `redaction` | `tool_result` | `redactions`, `rules` | Secret-shaped output replaced — only written when at least one rule fired. |

`id` — Pi's `toolCallId` — is on both, so this file can be joined against
`audit-log`'s by that field when a reviewer wants the complete picture of one
call. A blocked call's `id` may have no corresponding line in `audit-log`'s
file at all (see the intro); that absence is not a gap in *this* file.

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
*silent* — it changes what the model reads without telling anyone at the
time — so a false positive is not a cosmetic problem: it is corrupted input
producing a confusing failure somewhere else entirely. The test suite pins that
down with the specific shapes that would fire on a randomness test and must not
fire here.

`openai-api-key` is the weakest anchor of the set, since `sk-` is only three
characters, which is why it demands 32 more. Because only the matched span is
replaced, a false positive costs one value rather than the whole output.

**What the log records.** Only when something was redacted — the *presence* of
the `redaction` line is the signal, so "nothing matched" and "the redactor did
not run" cannot be confused:

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
  and nothing is recorded. That keeps a bug here from breaking tool execution,
  but it does mean such a bug is a quiet loss of this control rather than a
  loud one.
- **No off switch.** There is no environment variable to disable it, deliberately
  — a control that can be turned off by whatever sets the environment is a weaker
  control. If a rule misfires, the log's `rules` field names the culprit and the
  fix is a code change.

## What this extension does not enforce

Containment — keeping file access inside the project — is **not** enforced here.
That is the MCP filesystem server's job, and it does it on the far side of the
boundary, where a compromised agent process cannot reach the check. This
extension only answers the questions the MCP server has no opinion on: *is this a
name we never touch?*, and *does this output contain something that looks like a
credential?*

Neither an interactive confirmation gate nor an execution sandbox. The agent
acts freely on everything that is not a named secret file, because running
unattended means there is no human to gate mutating calls against — see pi's
`permission-gate` for the eyes-on alternative.

Both controls this extension does run inside the agent's own process, so they
are cooperative controls — evidence and friction, not a boundary. The
boundaries in this design are elsewhere: the MCP server's containment, the
read-only rootfs, the internal network, and the absence of any execution tool.

Nor does this extension record the generic activity trail — every call, turn
boundary, and model request — any more. That is `audit-log`'s job; see its
README.

## Configuration

The following environment variables can be used to adjust the behavior of this
extension. The variables must be exported into the environment in which the Pi
process is running — so, in the guest environment, if the agent is containerized.

| Variable | Default | Description |
|---|---|---|
| `SECRET_SENTRY_SECURITY_LOG` | `/var/log/pi/secret-sentry/security.jsonl` | Append-only security-decisions log path. |

If running Pi inside the hardened container, the `SECRET_SENTRY_SECURITY_LOG`
path MUST be within a **writable volume** mounted from the host. Without this,
the write operation will fail silently, because the hardened container runs
with a read-only rootfs. The hardened container's `compose.yaml` file provides
this via the `pi-logs` volume, mounted at `/var/log/pi` — the same volume
`audit-log` uses, each extension writing to its own subdirectory.

> [!IMPORTANT]
> The volume must also be **owned by the agent's uid**, or the log silently never
> appears. The image creates `/var/log/pi/secret-sentry` as the `pi` user so
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
truncation path in this code.

This file is far smaller than the generic trail `audit-log` keeps, because it
only ever gains a line when this extension actually refuses a call or redacts
something — for a session with no blocked calls and no secrets in ordinary
output, it may stay empty. **Truncation must not live here anyway**: a cap
inside this extension would put delete-my-own-history logic inside the
audited process, and append-only is a property worth keeping regardless of
this file's size — `compose.yaml` relies on the log volume outliving the
container so a compromised session cannot erase its own trail.

Pruning and archival are the **operator's**, from the host. The procedure — a
size check, and piping the log out to a dated `.gz` — is in the runbook
(`src/infrastructure/README.md`, *Retention*), along with the triggers for
revisiting the policy.
