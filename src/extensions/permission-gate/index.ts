/**
 * Interactive permission gate.
 *
 * Intercepts every tool call before it runs (`tool_call` event) and applies two
 * controls in order:
 *
 *   1. An ABSOLUTE refusal of calls naming a sensitive file — secrets and key
 *      material — which is not offered to the user for approval at all.
 *   2. Explicit user confirmation for any mutating operation — writes, edits,
 *      and shell execution. Confirmation times out to DENY, and a missing
 *      interactive UI also denies.
 *
 * Every decision, approved or denied, is logged to an append-only file outside
 * the agent's writable tree.
 *
 * This is the ecosystem gap the architecture doc calls out: interactive
 * approve/deny prompting. Read-only tools pass the second control straight
 * through; only state-changing calls are gated. The first control applies to
 * every call, read-only included — reading a private key is the exfiltration
 * this exists to stop.
 *
 * Being the only hook that sees every tool call is why the sensitive-file rule
 * lives here rather than in `audited-tools`: it must cover the `mcp_*` tools,
 * which are the sole route to project files and enforce directory containment
 * but not filename sensitivity.
 *
 * The policy, the sensitive-file rule, and the log format live in pure,
 * unit-tested helpers (`policy.ts`, `sensitive-files.ts`, `decision-log.ts`);
 * this entry point is the thin glue to the `ExtensionAPI`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { basename } from 'node:path'
import { decide, describeCall, requiresConfirmation, type ConfirmOutcome } from './policy.ts'
import { findSensitiveArgument } from './sensitive-files.ts'
import { DecisionLog, makeDecision } from './decision-log.ts'

/** Where decisions are logged. Outside the writable tree (see compose). */
const LOG_ENV = 'PERMISSION_GATE_LOG'
const DEFAULT_LOG = '/var/log/pi/permission-gate/audit.jsonl'

/** Confirmation timeout in milliseconds; on expiry the call is denied. */
const CONFIRM_TIMEOUT_MS = 60_000

export default function (pi: ExtensionAPI): void {
  const log = new DecisionLog(process.env[LOG_ENV] ?? DEFAULT_LOG)

  pi.on('tool_call', async (event, ctx) => {
    const input = event.input as Record<string, unknown>
    const detail = describeCall(event.toolName, input)

    /* Absolute refusal, checked on every call — including read-only ones, which
       are exactly the ones that would exfiltrate a key. Not a prompt: there is
       no approval path, so a model cannot socially engineer its way past it. */
    const sensitive = findSensitiveArgument(input)
    if (sensitive !== undefined) {
      const reason = `${event.toolName} blocked: sensitive file refused: ${basename(sensitive)}`
      await log.record(makeDecision(event.toolName, 'denied', reason, detail))
      return { block: true, reason }
    }

    if (!requiresConfirmation(event.toolName)) return // read-only: allow silently

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
