/**
 * Permission policy for the gate: which tool calls require explicit user
 * confirmation, and how a confirmation outcome maps to allow/deny.
 *
 * All logic here is pure so the classification and the default-deny behaviour
 * can be unit-tested without the `ExtensionAPI` or a real confirmation dialog.
 */

/** Tool names that mutate state and therefore require confirmation. */
const MUTATING_BUILTINS = new Set(['write', 'edit', 'bash'])

/**
 * Custom (extension) tools that mutate state. Our own audited/MCP tools use
 * these names; matched by suffix so the `mcp_` prefix from `mcp-client` is
 * covered (`mcp_write_file`, `mcp_edit_file`, …).
 */
const MUTATING_CUSTOM_SUFFIXES = ['write', 'edit', 'write_file', 'edit_file', 'move_file', 'create_directory']

/**
 * Whether a tool call must be confirmed before it runs. Read-only tools
 * (`read`, `ls`, `grep`, `find`, and their MCP equivalents) pass without a
 * prompt; anything that writes, edits, or executes is gated. Pure.
 */
export function requiresConfirmation (toolName: string): boolean {
  if (MUTATING_BUILTINS.has(toolName)) return true
  const lower = toolName.toLowerCase()
  return MUTATING_CUSTOM_SUFFIXES.some((s) => lower === s || lower.endsWith(`_${s}`) || lower.endsWith(s))
}

/**
 * A short, human-readable summary of what is being confirmed — shown in the
 * approval prompt and recorded as the audit trail's `detail`. Covers the MCP
 * filesystem server's argument shapes as well as the simple `path`/`command`
 * ones, so a multi-file read or a move is not logged as a bare tool name. Pure.
 */
export function describeCall (toolName: string, input: Record<string, unknown>): string {
  const command = typeof input.command === 'string' ? input.command : undefined
  if (command) return `${toolName}: ${truncate(command, 120)}`

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

/** The raw outcome of asking the user, including the no-UI / timeout cases. */
export type ConfirmOutcome = 'approved' | 'rejected' | 'timeout' | 'no-ui'

/** A gate decision: whether to block, and why (for the audit log + reason). */
export interface GateDecision {
  block: boolean
  status: 'approved' | 'denied'
  reason: string
}

/**
 * Map a confirmation outcome to a gate decision. Default-deny: anything other
 * than an explicit approval blocks the call. Pure.
 */
export function decide (toolName: string, outcome: ConfirmOutcome): GateDecision {
  if (outcome === 'approved') {
    return { block: false, status: 'approved', reason: 'user approved' }
  }
  const why = outcome === 'rejected'
    ? 'user rejected'
    : outcome === 'timeout'
      ? 'confirmation timed out (default deny)'
      : 'no interactive UI to confirm (default deny)'
  return { block: true, status: 'denied', reason: `${toolName} blocked: ${why}` }
}
