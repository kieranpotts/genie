/**
 * Silent, unattended security controls for away-from-keyboard Pi sessions.
 *
 * Intercepts every tool call before it runs (`tool_call` event) and applies
 * one control:
 *
 *   An ABSOLUTE refusal of calls naming a sensitive file — secrets and key
 *   material — with no approval path at all. There is nobody to ask: this
 *   extension is built for unattended operation, so a prompt that could only
 *   ever time out and default-deny would be theatre, not a control. See pi's
 *   `permission-gate` for the eyes-on counterpart, where the same detection
 *   feeds an interactive confirmation instead of an outright block.
 *
 * Everything else proceeds. Mutating calls — writes, edits, moves, directory
 * creation — are not gated here: the point of running unattended is that the
 * agent can act without a human in the loop, and containment (staying inside
 * the project) is the MCP server's job, enforced on the far side of the
 * boundary this extension cannot see past.
 *
 * A second control applies on the way BACK: secret-shaped spans are redacted
 * from tool output before the model sees it (`tool_result`). The first
 * control matches a file's NAME, so it cannot see a key pasted into an
 * ordinary `.txt`; this one matches the value's shape wherever it appears.
 * See `redaction.ts`, which is also explicit about being defence in depth
 * rather than a boundary.
 *
 * EVERY call is logged to an append-only file outside the agent's writable
 * tree — not only the blocked ones. A read is an action, and
 * `docs/requirements.md` asks for observability of every action against the
 * filesystem; a trail that recorded only refusals would omit the entire read
 * and write surface, which is most of what the agent does.
 *
 * Being the only hook that sees every tool call is why the sensitive-file
 * rule lives here: it must cover the `mcp_*` tools, which are the sole route
 * to project files and enforce directory containment but not filename
 * sensitivity. Since the removal of `audited-tools` it is also why this is
 * the ONLY audit trail the system has, which is what makes logging the full
 * call surface load-bearing rather than a nicety.
 *
 * FOUR HOOKS, and the second is why the trail is truthful:
 *
 *   `tool_call`               before a call runs: what was ATTEMPTED. On its own
 *                             this asserts reads the MCP server then refuses
 *                             (traversal, outside the allowed directory).
 *   `tool_result`             after it runs, carrying `isError`: what RESULTED.
 *                             Joined to the attempt by Pi's `toolCallId`. Also
 *                             the one hook here that CHANGES what the agent
 *                             sees: secret-shaped spans are redacted from the
 *                             output before it reaches the model.
 *   `before_agent_start`      the operator submitted an instruction: a turn
 *                             boundary, so the calls between two boundaries are
 *                             attributable to the instruction that caused them.
 *   `before_provider_request` a model request is going out: its SHAPE.
 *
 * THREE OF THE FOUR ARE HANDED CONTENT THEY MUST NEVER LOG. `tool_result`'s
 * `event.content` is the tool's full output — the file the agent just read.
 * `before_agent_start`'s `event.prompt` and `event.systemPrompt` are the
 * instruction and the system prompt. `before_provider_request`'s `event.payload`
 * is the entire conversation, which makes it the worst of the three: the easiest
 * thing to write there is `JSON.stringify(payload)`, and the result would be a
 * copy of every file the agent has read, in a file whose purpose is to be
 * trusted. Every handler here records named scalars and never spreads an event.
 *
 * Note the scope this extension does NOT have to cover: the agent has no local
 * file or shell tools at all (`--no-builtin-tools`, and no extension restores
 * them), so every call reaching these hooks is an `mcp_*` call.
 *
 * The sensitive-file rule, the description helper, and the log format live in
 * pure, unit-tested helpers (`sensitive-files.ts`, `describe.ts`,
 * `call-log.ts`); this entry point is the thin glue to the `ExtensionAPI`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { basename } from 'node:path'
import { describeCall } from './describe.ts'
import { findSensitiveArgument } from './sensitive-files.ts'
import { describeProviderRequest } from './provider-request.ts'
import { redactContent, type RedactionOutcome } from './redaction.ts'
import { CallLog, makeRecord } from './call-log.ts'

/** Where calls are logged. Outside the writable tree (see compose). */
const LOG_ENV = 'SECRET_SENTRY_CALL_LOG'
const DEFAULT_LOG = '/var/log/pi/secret-sentry/calls.jsonl'

export default function (pi: ExtensionAPI): void {
  const log = new CallLog(process.env[LOG_ENV] ?? DEFAULT_LOG)

  /* Turn ordinal, counted from 1 by this process. Deliberately not persisted:
     state that survives a restart would have to live on the log volume, and
     nothing on that volume should be writable by this process except by
     appending. See TurnRecord for what the number does and does not identify. */
  let turn = 0

  /* Turn boundaries. Fires after the operator submits an instruction and before
     the agent loop runs, so every call line until the next boundary belongs to
     this turn. Without these the trail is a flat sequence and "what did the
     agent do in response to THAT instruction" is answerable only by correlating
     timestamps against a session transcript on a different volume with a
     different retention policy.

     Records a boundary, not content. `event.prompt`, `event.images`, and
     `event.systemPrompt` are all in scope here and none of them is logged. */
  pi.on('before_agent_start', async (_event, ctx) => {
    turn += 1
    const session = sessionId(ctx)
    await log.record(makeRecord({
      kind: 'turn_start',
      turn,
      ...(session !== undefined ? { session } : {}),
    }))
    return undefined
  })

  /* Outbound model requests, as SHAPE only. This is the last unaudited channel
     the agent has: `docs/requirements.md` asks for observability of what the
     agent does, and until now the trail said nothing about what it sent to a
     model.

     The event's `payload` is the ENTIRE conversation — system prompt, every
     message, and the contents of every file read this session. It is never
     logged; `describeProviderRequest` takes named scalars off it and nothing
     more. See `provider-request.ts`.

     RETURN UNDEFINED. `runner.js` treats any non-undefined return from this
     handler as a REPLACEMENT payload (`if (handlerResult !== undefined)
     currentPayload = handlerResult`), so a stray return value here would rewrite
     the request the agent is about to send. A logging handler must not be able
     to do that; there is a test asserting this returns undefined. */
  pi.on('before_provider_request', async (event) => {
    await log.record(makeRecord({
      kind: 'provider_request',
      ...describeProviderRequest(event.payload),
    }))
    return undefined
  })

  pi.on('tool_call', async (event) => {
    const input = event.input as Record<string, unknown>
    const detail = describeCall(event.toolName, input)

    /* Absolute refusal, checked on every call — including read-only ones, which
       are exactly the ones that would exfiltrate a key. Not a prompt: there is
       nobody to ask, and even if there were, a model must not be able to
       socially engineer its way past this. */
    const sensitive = findSensitiveArgument(input)
    if (sensitive !== undefined) {
      const reason = `${event.toolName} blocked: sensitive file refused: ${basename(sensitive)}`
      await log.record(makeRecord({
        phase: 'call',
        id: event.toolCallId,
        tool: event.toolName,
        outcome: 'blocked',
        confirmation: 'not-offered',
        detail,
        reason,
      }))
      return { block: true, reason }
    }

    /* Everything else proceeds, unprompted — but NOT unrecorded. This is every
       mcp_read_file, mcp_write_file, mcp_edit_file — which is to say every
       action against project content, the whole reason the agent has
       filesystem access at all. Logging only refusals would leave that entire
       surface invisible to a reviewer. */
    await log.record(makeRecord({
      phase: 'call',
      id: event.toolCallId,
      tool: event.toolName,
      outcome: 'allowed',
      confirmation: 'not-required',
      detail,
    }))
    return undefined
  })

  /* What actually happened. This extension admits calls; it does not perform
     them, so `tool_call` alone cannot say whether the MCP server honoured or
     refused one. `isError` is that missing axis.

     Every result is recorded, including results for calls this extension
     blocked, if the harness reports them. Suppressing those would need a set
     of blocked ids held for the life of the session — unbounded state to hide
     a line that is accurate anyway: a blocked call whose result is an error is
     exactly what the trail should show.

     `event.content` is NEVER touched. See the header. */
  pi.on('tool_result', async (event) => {
    /* Redact before recording, so the record can say what was withheld.
       `redactContent` is pure and total, but it runs inside the path that
       delivers a tool result to the model, so an unexpected throw here would
       break tool execution rather than a log line. It FAILS OPEN: the original
       content goes to the model and the result is recorded without redaction
       fields. That is the right way round for a defence-in-depth control — the
       sensitive-filename refusal is unaffected — but it does mean a bug here is
       a quiet loss of this control, not a loud one. */
    let redacted: RedactionOutcome<typeof event.content> | undefined
    try {
      redacted = redactContent(event.content)
    } catch {
      redacted = undefined
    }

    await log.record(makeRecord({
      phase: 'result',
      id: event.toolCallId,
      tool: event.toolName,
      result: event.isError ? 'error' : 'ok',
      ...(redacted !== undefined && redacted.count > 0
        ? { redactions: redacted.count, rules: redacted.rules }
        : {}),
    }))

    /* Only return a patch when something actually changed. Pi treats a returned
       `content` as a replacement (`agent-loop.js` does `content:
       afterResult.content ?? result.content`), and that replacement lands in
       BOTH the model's context and the session transcript — so returning
       untouched content on every call would rewrite every tool result in the
       session to no purpose. */
    if (redacted !== undefined && redacted.count > 0) {
      return { content: redacted.value }
    }
    return undefined
  })
}

/**
 * The current session's id, or `undefined` if the harness will not give one up.
 *
 * Defensive on purpose. This is the only thing any handler here logs from the
 * context rather than from its event, and a turn marker is worth less than a
 * working agent: an id that cannot be obtained is omitted from the record
 * instead of throwing out of the handler.
 */
function sessionId (ctx: { sessionManager?: { getSessionId?: () => string } }): string | undefined {
  try {
    const id = ctx.sessionManager?.getSessionId?.()
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}
