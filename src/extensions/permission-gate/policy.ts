/**
 * Permission policy for the gate: which tool calls require explicit user
 * confirmation, and how a confirmation outcome maps to allow/deny.
 *
 * All logic here is pure so the classification and the default-deny behaviour
 * can be unit-tested without the `ExtensionAPI` or a real confirmation dialog.
 */

import type { CallOutcome, Confirmation } from './call-log.ts'

/**
 * Tool names that mutate state, matched by suffix so the `mcp_` prefix from
 * `mcp-client` is covered (`mcp_write_file`, `mcp_edit_file`, …). The bare forms
 * (`write`, `edit`) are matched too, so a tool registered without the prefix is
 * still gated.
 *
 * There is deliberately no entry for `bash` or any other execution tool: the
 * agent runs with `--no-builtin-tools` and no extension restores local
 * execution, so no such call can occur. Restoring one (see the deferred
 * exec-server option in `TODO.md`) means adding it here.
 */
const MUTATING_SUFFIXES = ['write', 'edit', 'write_file', 'edit_file', 'move_file', 'create_directory']

/**
 * Whether a tool call must be confirmed before it runs. Read-only tools
 * (`mcp_read_file`, `mcp_list_directory`, `mcp_search_files`, …) pass without a
 * prompt; anything that writes or edits is gated. Pure.
 */
export function requiresConfirmation (toolName: string): boolean {
  const lower = toolName.toLowerCase()
  return MUTATING_SUFFIXES.some((s) => lower === s || lower.endsWith(`_${s}`) || lower.endsWith(s))
}

/**
 * A short, human-readable summary of what is being confirmed — shown in the
 * approval prompt and recorded as the audit trail's `detail`. Covers the MCP
 * filesystem server's argument shapes, so a multi-file read or a move is not
 * logged as a bare tool name. Pure.
 *
 * A `command` branch was removed with the `audited-tools` extension. It
 * truncated at 120 characters, which meant an operator confirming a long shell
 * command could not see what they were approving past that point — worth
 * remembering if execution is ever reintroduced.
 */
export function describeCall (toolName: string, input: Record<string, unknown>): string {
  const path = typeof input.path === 'string' ? input.path : undefined
  if (path) return `${toolName}: ${path}`

  const source = typeof input.source === 'string' ? input.source : undefined
  const destination = typeof input.destination === 'string' ? input.destination : undefined
  if (source && destination) return `${toolName}: ${source} -> ${destination}`

  const paths = Array.isArray(input.paths) ? input.paths.filter((p) => typeof p === 'string') : []
  if (paths.length > 0) return `${toolName}: ${truncate(paths.join(', '), 120)}`

  return toolName
}

function truncate (s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/**
 * The raw outcome of actually asking the user, including the no-UI / timeout
 * cases. Derived from `Confirmation` so the two cannot drift: it is exactly the
 * subset that can come back from a prompt, excluding the two values that mean
 * no prompt was shown at all.
 */
export type ConfirmOutcome = Exclude<Confirmation, 'not-required' | 'not-offered'>

/** A gate decision: what happens to the call, and why. */
export interface GateDecision {
  outcome: CallOutcome
  confirmation: ConfirmOutcome
  /** Populated only when blocked; surfaced to the model and logged. */
  reason?: string
}

/**
 * Map a confirmation outcome to a gate decision. Default-deny: anything other
 * than an explicit approval blocks the call. Pure.
 *
 * Only ever called for a call that was actually prompted for — read-only
 * pass-throughs and sensitive-file refusals are decided before this point,
 * which is why its input type excludes them.
 */
export function decide (toolName: string, outcome: ConfirmOutcome): GateDecision {
  if (outcome === 'approved') {
    return { outcome: 'allowed', confirmation: 'approved' }
  }
  const why = outcome === 'rejected'
    ? 'user rejected'
    : outcome === 'timeout'
      ? 'confirmation timed out (default deny)'
      : 'no interactive UI to confirm (default deny)'
  return { outcome: 'blocked', confirmation: outcome, reason: `${toolName} blocked: ${why}` }
}
