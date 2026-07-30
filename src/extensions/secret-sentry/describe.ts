/**
 * A human-readable description of a tool call, for the audit trail's `detail`
 * field.
 *
 * Pure so it can be unit-tested without the `ExtensionAPI`.
 */

/**
 * A COMPLETE, human-readable description of what a call names — recorded as
 * the audit trail's `detail`. Covers the MCP filesystem server's argument
 * shapes, so a multi-file read or a move is not logged as a bare tool name.
 * Pure.
 *
 * NEVER TRUNCATED. This once capped a joined `paths` list at 120 characters —
 * about two or three realistic `/workspace/…` entries — so a ten-file
 * `read_multiple_files` recorded the first few and an ellipsis. A trail that
 * cannot say which files were read has lost the question it exists to answer,
 * and the loss is invisible in the log: an ellipsis reads like formatting,
 * not like missing evidence.
 *
 * The consequence is accepted deliberately: a line is as long as the call
 * was. Completeness beats line length for a record that is append-only and
 * unbounded by policy anyway (see `call-log.ts`).
 *
 * There is no capped counterpart here, unlike pi's `permission-gate`: this
 * extension never shows a call to a human, so there is no dialog to fit on a
 * screen — only the log, which must be complete.
 */
export function describeCall (toolName: string, input: Record<string, unknown>): string {
  const path = typeof input.path === 'string' ? input.path : undefined
  if (path) return `${toolName}: ${path}`

  const source = typeof input.source === 'string' ? input.source : undefined
  const destination = typeof input.destination === 'string' ? input.destination : undefined
  if (source && destination) return `${toolName}: ${source} -> ${destination}`

  const paths = Array.isArray(input.paths) ? input.paths.filter((p) => typeof p === 'string') : []
  if (paths.length > 0) return `${toolName}: ${paths.join(', ')}`

  return toolName
}
