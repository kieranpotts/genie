/**
 * Append-only log of permission decisions.
 *
 * Every confirmation outcome — approved or denied — is recorded as one JSON
 * line to a file outside the agent's writable tree. The record is produced by a
 * pure function (`formatDecision`) so it can be asserted in tests; the sink
 * (`DecisionLog`) is the only side-effecting part.
 *
 * Kept local to this extension rather than shared with `audited-tools`, because
 * the verbatim-copy installer requires each extension directory to be
 * self-contained (no cross-directory imports survive installation).
 */

import { appendFile } from 'node:fs/promises'

export interface DecisionRecord {
  ts: string
  tool: string
  status: 'approved' | 'denied'
  reason: string
  /** A short description of the call (path or command), when available. */
  detail?: string
}

/** Render a decision as a newline-terminated JSON line. Pure. */
export function formatDecision (record: DecisionRecord): string {
  const ordered: DecisionRecord = {
    ts: record.ts,
    tool: record.tool,
    status: record.status,
    reason: record.reason,
    ...(record.detail !== undefined ? { detail: record.detail } : {}),
  }
  return JSON.stringify(ordered) + '\n'
}

/** Build a decision record, stamping it with the current time. */
export function makeDecision (
  tool: string,
  status: DecisionRecord['status'],
  reason: string,
  detail?: string,
  now: Date = new Date()
): DecisionRecord {
  return {
    ts: now.toISOString(),
    tool,
    status,
    reason,
    ...(detail !== undefined ? { detail } : {}),
  }
}

/** Append-only sink for permission decisions. */
export class DecisionLog {
  private readonly filePath: string

  constructor (filePath: string) {
    this.filePath = filePath
  }

  /** Append one decision. Never throws into the caller — a failed write must
   * not change the gate outcome (which has already been decided). */
  async record (record: DecisionRecord): Promise<void> {
    try {
      await appendFile(this.filePath, formatDecision(record), { encoding: 'utf8' })
    } catch {
      /* Best-effort logging. */
    }
  }
}
