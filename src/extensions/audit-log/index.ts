/**
 * Generic activity trail for unattended Pi sessions: every tool call, the turn
 * boundaries between them, and the shape of every outbound model request.
 *
 * This extension has no opinion on what should or should not happen. It
 * refuses nothing and redacts nothing — that is `secret-sentry`'s job, run
 * from a separate extension so a security control and an activity log are not
 * one piece of code with two jobs. This extension only watches and records.
 *
 * FOUR HOOKS:
 *
 *   `tool_call`               a call reached this extension: what was
 *                             ATTEMPTED. Carries no verdict — see below.
 *   `tool_result`             the tool ran, carrying `isError`: what RESULTED.
 *                             Joined to the attempt by Pi's `toolCallId`.
 *   `before_agent_start`      the operator submitted an instruction: a turn
 *                             boundary, so the calls between two boundaries are
 *                             attributable to the instruction that caused them.
 *   `before_provider_request` a model request is going out: its SHAPE.
 *
 * WHAT THIS EXTENSION CANNOT SEE, AND WHY THAT IS SOMEONE ELSE'S RECORD.
 * `secret-sentry` refuses calls that name a sensitive file, with no approval
 * path. Pi's extension runner stops dispatching a `tool_call` event to further
 * extensions the instant any handler returns `{ block: true }`
 * (`ExtensionRunner.emitToolCall` returns as soon as `result.block` is true) —
 * so whether this extension's `tool_call` handler even runs for a call that
 * `secret-sentry` goes on to refuse depends on an extension load order Pi does
 * not guarantee (extensions are discovered via `readdirSync`, unsorted). This
 * extension therefore makes NO CLAIM about admission: its `call` line never
 * carries an `outcome` or `confirmation` field, and a refused call may appear
 * here with no matching `result` line (because the tool never ran) or may not
 * appear at all. `secret-sentry`'s own `security.jsonl` is the authoritative,
 * order-independent record of what was refused and why — see that extension's
 * README. A reviewer wanting the complete picture of one call joins both files
 * by `id`.
 *
 * The same split applies to redaction: `secret-sentry` replaces secret-shaped
 * spans in tool output before the model sees them and records that fact in its
 * own log. This extension's `result` line says only `ok` or `error`; it does
 * not know, and does not claim to know, whether anything was withheld.
 *
 * THREE OF THE FOUR HOOKS ARE HANDED CONTENT THEY MUST NEVER LOG. `tool_result`'s
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
 * The description helper, the model-request reducer, and the log format live in
 * pure, unit-tested helpers (`describe.ts`, `provider-request.ts`,
 * `call-log.ts`); this entry point is the thin glue to the `ExtensionAPI`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { describeCall } from './describe.ts'
import { describeProviderRequest } from './provider-request.ts'
import { CallLog, makeRecord } from './call-log.ts'

/** Where calls are logged. Outside the writable tree (see compose). */
const LOG_ENV = 'AUDIT_LOG_CALL_LOG'
const DEFAULT_LOG = '/var/log/pi/audit-log/calls.jsonl'

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

  /* Every call this extension is dispatched, described but never judged. No
     `outcome`, no `confirmation`, no `block` return — this extension has no
     power to refuse a call and no opinion on whether one should be refused.
     See the header for why a call `secret-sentry` blocks may or may not reach
     here at all. */
  pi.on('tool_call', async (event) => {
    const input = event.input as Record<string, unknown>
    const detail = describeCall(event.toolName, input)

    await log.record(makeRecord({
      phase: 'call',
      id: event.toolCallId,
      tool: event.toolName,
      detail,
    }))
    return undefined
  })

  /* What actually happened, for any call whose tool actually ran. A call
     `secret-sentry` refused never reaches this hook at all — the tool never
     ran, so there is nothing to report here; `secret-sentry`'s own log already
     says why.

     `event.content` is NEVER touched or logged. Redaction is `secret-sentry`'s
     job, performed in its own `tool_result` handler; this one only records
     `ok` / `error` and returns no patch, ever. */
  pi.on('tool_result', async (event) => {
    await log.record(makeRecord({
      phase: 'result',
      id: event.toolCallId,
      tool: event.toolName,
      result: event.isError ? 'error' : 'ok',
    }))
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
