/**
 * Append-only audit logging for the audited tool replacements.
 *
 * Every tool invocation — allowed or denied — is recorded as one JSON line.
 * The record format is produced by a pure function (`formatEntry`) so it can be
 * asserted in tests; the sink (`AuditLog`) appends to a file and is the only
 * side-effecting part. The log is intended to live on a volume OUTSIDE the
 * agent's writable tree (see the architecture doc's audit-trail section).
 */

import { appendFile } from 'node:fs/promises'

/** One audit record. `status` distinguishes allowed/denied/errored calls. */
export interface AuditEntry {
  ts: string
  tool: string
  status: 'allowed' | 'denied' | 'error'
  /** The path argument, when the tool operates on one. */
  path?: string
  /** Denial or error reason. */
  reason?: string
}

/**
 * Render an audit entry as a single newline-terminated JSON line. Pure and
 * deterministic given its inputs (timestamp is supplied, not read from a clock).
 */
export function formatEntry (entry: AuditEntry): string {
  // Fixed key order keeps lines diff-friendly and greppable.
  const ordered: AuditEntry = {
    ts: entry.ts,
    tool: entry.tool,
    status: entry.status,
    ...(entry.path !== undefined ? { path: entry.path } : {}),
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  }
  return JSON.stringify(ordered) + '\n'
}

/** Build an entry, stamping it with the current time. */
export function makeEntry (
  tool: string,
  status: AuditEntry['status'],
  fields: { path?: string, reason?: string } = {},
  now: Date = new Date()
): AuditEntry {
  return {
    ts: now.toISOString(),
    tool,
    status,
    ...(fields.path !== undefined ? { path: fields.path } : {}),
    ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
  }
}

/** Append-only sink writing audit lines to a file. */
export class AuditLog {
  private readonly filePath: string

  constructor (filePath: string) {
    this.filePath = filePath
  }

  /** Append one entry. Never throws into the caller — logging must not break a
   * tool; a failed write is swallowed (the operation's own result still stands). */
  async record (entry: AuditEntry): Promise<void> {
    try {
      await appendFile(this.filePath, formatEntry(entry), { encoding: 'utf8' })
    } catch {
      /* Best-effort audit; do not fail the tool because logging failed. */
    }
  }
}
