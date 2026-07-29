/**
 * Append-only log of every tool call the gate sees.
 *
 * One JSON line per call — not per confirmation. Read-only calls, which are
 * never prompted for, are recorded too: `docs/requirements.md` asks for
 * observability of every action against the filesystem, and reads are actions.
 * The gate's `tool_call` hook is the only place in the harness that sees every
 * call, so its blind spots are the whole system's blind spots.
 *
 * The record is deliberately TWO-AXIS:
 *
 *   `outcome`      what happened to the call — did it proceed or not.
 *   `confirmation` whether a human was involved, and what they said.
 *
 * Collapsing these into one enum would leave the *cause* of a denial readable
 * only as prose in `reason`, so "refused by policy" and "the operator said no"
 * could not be told apart without parsing English. They are different events
 * with different meanings in a review, and they are counted separately.
 *
 * The record is produced by a pure function (`formatRecord`) so it can be
 * asserted in tests; the sink (`CallLog`) is the only side-effecting part.
 *
 * Kept local to this extension rather than factored into a shared module,
 * because the verbatim-copy installer requires each extension directory to be
 * self-contained (no cross-directory imports survive installation).
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Whether the call proceeded. */
export type CallOutcome = 'allowed' | 'blocked'

/**
 * Whether a human was asked, and what came back.
 *
 * `not-required` and `not-offered` both mean no prompt was shown, and the
 * distinction between them is the point:
 *
 *   `not-required`  read-only call, nothing to approve — pairs with `allowed`.
 *   `not-offered`   sensitive-file refusal. There is deliberately NO approval
 *                   path, so a model cannot socially engineer its way past it.
 *                   Pairs with `blocked`.
 */
export type Confirmation =
  | 'not-required'
  | 'not-offered'
  | 'approved'
  | 'rejected'
  | 'timeout'
  | 'no-ui'

export interface CallRecord {
  ts: string
  tool: string
  outcome: CallOutcome
  confirmation: Confirmation
  /** A short description of the call (the path, or paths). Never the content:
   * logging what was read would copy secrets out of the files and into the
   * audit trail, which is the opposite of the point. */
  detail?: string
  /** Why the call was blocked. Omitted when it was allowed — the two axes
   * already say everything there is to say about an allowed call. */
  reason?: string
}

/** Render a call record as a newline-terminated JSON line. Pure. */
export function formatRecord (record: CallRecord): string {
  const ordered: CallRecord = {
    ts: record.ts,
    tool: record.tool,
    outcome: record.outcome,
    confirmation: record.confirmation,
    ...(record.detail !== undefined ? { detail: record.detail } : {}),
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
  }
  return JSON.stringify(ordered) + '\n'
}

/** Build a call record, stamping it with the current time. Pure. */
export function makeRecord (
  fields: Omit<CallRecord, 'ts'>,
  now: Date = new Date()
): CallRecord {
  return { ts: now.toISOString(), ...fields }
}

/** Append-only sink for tool-call records. */
export class CallLog {
  private readonly filePath: string
  private dirEnsured = false

  constructor (filePath: string) {
    this.filePath = filePath
  }

  /** Create the log's parent directory if absent. Idempotent; the recursive
   * mkdir is a no-op once the directory exists, so we only attempt it once. */
  private async ensureDir (): Promise<void> {
    if (this.dirEnsured) return
    await mkdir(dirname(this.filePath), { recursive: true })
    this.dirEnsured = true
  }

  /** Append one record. Never throws into the caller — a failed write must not
   * change a tool's outcome (which has already been decided). */
  async record (record: CallRecord): Promise<void> {
    try {
      await this.ensureDir()
      await appendFile(this.filePath, formatRecord(record), { encoding: 'utf8' })
    } catch {
      /* Best-effort logging. */
    }
  }
}
