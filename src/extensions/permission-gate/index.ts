/**
 * Interactive permission gate.
 *
 * Intercepts every tool call before it runs (`tool_call` event) and requires
 * explicit user confirmation for any mutating operation — writes, edits, and
 * shell execution. Confirmation times out to DENY, and a missing interactive UI
 * also denies. Every decision, approved or denied, is logged to an append-only
 * file outside the agent's writable tree.
 *
 * This is the ecosystem gap the architecture doc calls out: interactive
 * approve/deny prompting. Read-only tools pass straight through; only
 * state-changing calls are gated.
 *
 * The policy and the log format live in pure, unit-tested helpers
 * (`policy.ts`, `decision-log.ts`); this entry point is the thin glue to the
 * `ExtensionAPI`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { decide, describeCall, requiresConfirmation, type ConfirmOutcome } from './policy.ts'
import { DecisionLog, makeDecision } from './decision-log.ts'

/** Where decisions are logged. Outside the writable tree (see compose). */
const LOG_ENV = 'PERMISSION_GATE_LOG'
const DEFAULT_LOG = '/home/pi/sessions/permissions.jsonl'

/** Confirmation timeout in milliseconds; on expiry the call is denied. */
const CONFIRM_TIMEOUT_MS = 60_000

export default function (pi: ExtensionAPI): void {
  const log = new DecisionLog(process.env[LOG_ENV] ?? DEFAULT_LOG)

  pi.on('tool_call', async (event, ctx) => {
    if (!requiresConfirmation(event.toolName)) return // read-only: allow silently

    const detail = describeCall(event.toolName, event.input as Record<string, unknown>)
    const outcome = await askUser(ctx, event.toolName, detail)
    const decision = decide(event.toolName, outcome)

    await log.record(makeDecision(event.toolName, decision.status, decision.reason, detail))

    if (decision.block) {
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
