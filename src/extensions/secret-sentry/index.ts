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
 * EVERY DECISION THIS EXTENSION MAKES is logged to `security.jsonl` — a
 * refusal, and a redaction. This is NOT a general activity log: reading and
 * writing that never trip either control are the separate `audit-log`
 * extension's job. The split exists so this extension is responsible for one
 * thing — deciding, and recording only what it decided — rather than also
 * being the system's general-purpose call logger. See this extension's
 * README for the reasoning, and for why `audit-log`'s trail cannot, on its
 * own, always show that a call was refused.
 *
 * Being the only hook that sees every tool call before `audit-log` might is
 * why the sensitive-file rule lives here: it must cover the `mcp_*` tools,
 * which are the sole route to project files and enforce directory containment
 * but not filename sensitivity.
 *
 * TWO HOOKS:
 *
 *   `tool_call`   before a call runs: refuse it outright, or let it proceed.
 *                 Logs a `blocked` record only for a refusal — an allowed call
 *                 is `audit-log`'s to record, not this extension's.
 *   `tool_result` after it runs, carrying the tool's output: redact
 *                 secret-shaped spans before the model sees them, and log a
 *                 `redaction` record only when something was actually
 *                 replaced.
 *
 * BOTH HOOKS ARE HANDED CONTENT THEY MUST NEVER LOG. `tool_result`'s
 * `event.content` is the tool's full output — the file the agent just read.
 * The redaction record says how many spans were replaced and which rules
 * fired, never the value itself or its length.
 *
 * Note the scope this extension does NOT have to cover: the agent has no local
 * file or shell tools at all (`--no-builtin-tools`, and no extension restores
 * them), so every call reaching these hooks is an `mcp_*` call.
 *
 * The sensitive-file rule, the redactor, and the log format live in pure,
 * unit-tested helpers (`sensitive-files.ts`, `redaction.ts`, `security-log.ts`);
 * this entry point is the thin glue to the `ExtensionAPI`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { basename } from 'node:path'
import { findSensitiveArgument } from './sensitive-files.ts'
import { redactContent, type RedactionOutcome } from './redaction.ts'
import { SecurityLog, makeRecord } from './security-log.ts'

/** Where security decisions are logged. Outside the writable tree (see
 * compose). Distinct from `audit-log`'s general activity trail. */
const LOG_ENV = 'SECRET_SENTRY_SECURITY_LOG'
const DEFAULT_LOG = '/var/log/pi/secret-sentry/security.jsonl'

export default function (pi: ExtensionAPI): void {
  const log = new SecurityLog(process.env[LOG_ENV] ?? DEFAULT_LOG)

  pi.on('tool_call', async (event) => {
    const input = event.input as Record<string, unknown>

    /* Absolute refusal, checked on every call — including read-only ones, which
       are exactly the ones that would exfiltrate a key. Not a prompt: there is
       nobody to ask, and even if there were, a model must not be able to
       socially engineer its way past this. */
    const sensitive = findSensitiveArgument(input)
    if (sensitive !== undefined) {
      const reason = `${event.toolName} blocked: sensitive file refused: ${basename(sensitive)}`
      await log.record(makeRecord({
        kind: 'blocked',
        id: event.toolCallId,
        tool: event.toolName,
        path: sensitive,
        reason,
      }))
      return { block: true, reason }
    }

    /* Everything else proceeds, unprompted. Recording that it did is
       `audit-log`'s job, not this extension's — it did not decide anything
       here, so it has nothing of its own to record. */
    return undefined
  })

  /* Redact before the model sees the result. `redactContent` is pure and
     total, but it runs inside the path that delivers a tool result to the
     model, so an unexpected throw here would break tool execution rather than
     a log line. It FAILS OPEN: the original content goes to the model and
     nothing is recorded. That is the right way round for a defence-in-depth
     control — the sensitive-filename refusal is unaffected — but it does mean
     a bug here is a quiet loss of this control, not a loud one. */
  pi.on('tool_result', async (event) => {
    let redacted: RedactionOutcome<typeof event.content> | undefined
    try {
      redacted = redactContent(event.content)
    } catch {
      redacted = undefined
    }

    if (redacted !== undefined && redacted.count > 0) {
      await log.record(makeRecord({
        kind: 'redaction',
        id: event.toolCallId,
        tool: event.toolName,
        redactions: redacted.count,
        rules: redacted.rules,
      }))
      /* Pi treats a returned `content` as a replacement (`agent-loop.js` does
         `content: afterResult.content ?? result.content`), and that
         replacement lands in BOTH the model's context and the session
         transcript. Only returned when something actually changed. */
      return { content: redacted.value }
    }
    return undefined
  })
}
