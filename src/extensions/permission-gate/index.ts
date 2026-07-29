/**
 * Interactive permission gate.
 *
 * Intercepts every tool call before it runs (`tool_call` event) and applies two
 * controls in order:
 *
 *   1. An ABSOLUTE refusal of calls naming a sensitive file — secrets and key
 *      material — which is not offered to the user for approval at all.
 *   2. Explicit user confirmation for any mutating operation — writes, edits,
 *      moves, and directory creation. Confirmation times out to DENY, and a
 *      missing interactive UI also denies.
 *
 * EVERY call is logged to an append-only file outside the agent's writable
 * tree — not only the ones that prompted. A read is an action, and
 * `docs/requirements.md` asks for observability of every action against the
 * filesystem; a trail that recorded only confirmations would omit the entire
 * read surface, which is most of what the agent does.
 *
 * This is the ecosystem gap the architecture doc calls out: interactive
 * approve/deny prompting. Read-only tools pass the second control straight
 * through; only state-changing calls are gated. The first control applies to
 * every call, read-only included — reading a private key is the exfiltration
 * this exists to stop.
 *
 * Being the only hook that sees every tool call is why the sensitive-file rule
 * lives here: it must cover the `mcp_*` tools, which are the sole route to
 * project files and enforce directory containment but not filename sensitivity.
 * Since the removal of `audited-tools` it is also why this is the ONLY audit
 * trail the system has, which is what makes logging the read surface load-
 * bearing rather than a nicety.
 *
 * What this records is what was ATTEMPTED, not what resulted: the `tool_call`
 * hook fires before the call runs, so a read the MCP server then refuses (path
 * traversal, outside the allowed directory) is recorded here as allowed. Closing
 * that gap needs the `tool_result` hook or a gateway-side `after:` interceptor;
 * see TODO.md.
 *
 * Note the scope this extension does NOT have to cover: the agent has no local
 * file or shell tools at all (`--no-builtin-tools`, and no extension restores
 * them), so every call reaching these hooks is an `mcp_*` call.
 *
 * The policy, the sensitive-file rule, and the log format live in pure,
 * unit-tested helpers (`policy.ts`, `sensitive-files.ts`, `call-log.ts`);
 * this entry point is the thin glue to the `ExtensionAPI`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { basename } from 'node:path'
import { decide, describeCall, requiresConfirmation, type ConfirmOutcome } from './policy.ts'
import { findSensitiveArgument } from './sensitive-files.ts'
import { CallLog, makeRecord } from './call-log.ts'

/** Where calls are logged. Outside the writable tree (see compose). */
const LOG_ENV = 'PERMISSION_GATE_CALL_LOG'
const DEFAULT_LOG = '/var/log/pi/permission-gate/calls.jsonl'

/** Confirmation timeout in milliseconds; on expiry the call is denied. */
const CONFIRM_TIMEOUT_MS = 60_000

export default function (pi: ExtensionAPI): void {
  const log = new CallLog(process.env[LOG_ENV] ?? DEFAULT_LOG)

  pi.on('tool_call', async (event, ctx) => {
    const input = event.input as Record<string, unknown>
    const detail = describeCall(event.toolName, input)

    /* Absolute refusal, checked on every call — including read-only ones, which
       are exactly the ones that would exfiltrate a key. Not a prompt: there is
       no approval path, so a model cannot socially engineer its way past it. */
    const sensitive = findSensitiveArgument(input)
    if (sensitive !== undefined) {
      const reason = `${event.toolName} blocked: sensitive file refused: ${basename(sensitive)}`
      await log.record(makeRecord({
        tool: event.toolName, outcome: 'blocked', confirmation: 'not-offered', detail, reason,
      }))
      return { block: true, reason }
    }

    /* Read-only: allowed without a prompt, but NOT without a record. This is
       every mcp_read_file, mcp_list_directory, mcp_search_files — which is to
       say every read of project content, the whole reason the agent has
       filesystem access at all. Logging only confirmations would leave that
       entire surface invisible to a reviewer. */
    if (!requiresConfirmation(event.toolName)) {
      await log.record(makeRecord({
        tool: event.toolName, outcome: 'allowed', confirmation: 'not-required', detail,
      }))
      return undefined
    }

    const outcome = await askUser(ctx, event.toolName, detail)
    const decision = decide(event.toolName, outcome)

    await log.record(makeRecord({
      tool: event.toolName,
      outcome: decision.outcome,
      confirmation: decision.confirmation,
      detail,
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    }))

    if (decision.outcome === 'blocked') {
      return { block: true, reason: decision.reason }
    }
    return undefined
  })
}

/**
 * Ask the user to confirm, translating the UI result into a ConfirmOutcome.
 * No interactive UI (print/RPC mode) or any non-approval defaults to deny.
 */
async function askUser (
  ctx: { hasUI: boolean, ui: { confirm: (title: string, message: string, opts?: { timeout?: number }) => Promise<boolean> } },
  toolName: string,
  detail: string
): Promise<ConfirmOutcome> {
  if (!ctx.hasUI) return 'no-ui'
  try {
    const approved = await ctx.ui.confirm(
      `Allow ${toolName}?`,
      `The agent wants to run:\n\n${detail}\n\nApprove this operation?`,
      { timeout: CONFIRM_TIMEOUT_MS }
    )
    return approved ? 'approved' : 'rejected'
  } catch {
    // Dialog dismissed/aborted/timed out without an explicit answer.
    return 'timeout'
  }
}
