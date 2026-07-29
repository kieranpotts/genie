/**
 * Append-only log of every tool call the gate sees.
 *
 * Read-only calls, which are never prompted for, are recorded too:
 * `docs/requirements.md` asks for observability of every action against the
 * filesystem, and reads are actions. The gate's hooks are the only place in the
 * harness that sees every call, so their blind spots are the whole system's
 * blind spots.
 *
 * A call produces TWO LINES, joined by `id` (Pi's `toolCallId`):
 *
 *   phase: 'call'    what the gate decided, written before the tool runs.
 *   phase: 'result'  what the tool actually did, written after it runs.
 *
 * The second line exists because the first cannot be trusted as a record of
 * what *happened*. The gate decides admission; it does not perform the call. A
 * read of a path outside `/workspace` is `allowed` by the gate and then refused
 * by the MCP server, so a trail of attempts alone asserts reads that never
 * occurred — the exact overclaim this log is supposed to prevent.
 *
 * Two lines rather than one enriched line, deliberately. Buffering the attempt
 * until the result arrived would give one tidy line per call, but the record
 * would exist only in memory for the duration of the call — so a crash, a kill,
 * or an OOM between the two would erase the evidence that the call was ever
 * attempted. Append-on-observation means the trail is never less complete than
 * the events that have actually happened. The cost is volume: a busy session
 * writes twice the lines it used to, which is why retention is an open question
 * in TODO.md.
 *
 * The attempt line is also TWO-AXIS:
 *
 *   `outcome`      whether the gate let the call proceed.
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

/** Whether the gate let the call proceed. Decided BEFORE the tool runs. */
export type CallOutcome = 'allowed' | 'blocked'

/**
 * What the tool actually did. Observed AFTER it ran, from `tool_result`.
 *
 * This is the axis `outcome` cannot supply. The gate decides whether a call may
 * proceed; it does not perform the call, so it cannot know the result. An
 * `mcp_read_file` for a path outside `/workspace` is `allowed` here and then
 * refused by the MCP server — the trail claimed the read happened until this
 * existed.
 */
export type CallResult = 'ok' | 'error'

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

/** Fields common to both lines a call produces. */
interface RecordBase {
  ts: string
  /**
   * Pi's `toolCallId`, carried on both the `call` and `result` lines so they can
   * be joined. This is the whole reason the two-line shape works:
   *
   *   jq -s 'group_by(.id)' calls.jsonl
   */
  id: string
  tool: string
}

/** The attempt: what the gate decided, written before the tool runs. */
export interface CallAttemptRecord extends RecordBase {
  phase: 'call'
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

/**
 * The result: what the tool actually did, written after it runs.
 *
 * Deliberately carries NO content. `tool_result` hands us the tool's entire
 * output — the file the agent just read — and copying that here would turn the
 * audit trail into a second copy of every secret the agent has touched. The
 * path is already on the `call` line; this line adds only the verdict.
 */
export interface CallResultRecord extends RecordBase {
  phase: 'result'
  result: CallResult
}

export type CallRecord = CallAttemptRecord | CallResultRecord

/** Distributes `Omit` across the union, so each member keeps its own fields. */
type WithoutTimestamp<T> = T extends unknown ? Omit<T, 'ts'> : never

/** Render a call record as a newline-terminated JSON line. Pure. */
export function formatRecord (record: CallRecord): string {
  const ordered = record.phase === 'call'
    ? {
        ts: record.ts,
        phase: record.phase,
        id: record.id,
        tool: record.tool,
        outcome: record.outcome,
        confirmation: record.confirmation,
        ...(record.detail !== undefined ? { detail: record.detail } : {}),
        ...(record.reason !== undefined ? { reason: record.reason } : {}),
      }
    : {
        ts: record.ts,
        phase: record.phase,
        id: record.id,
        tool: record.tool,
        result: record.result,
      }
  return JSON.stringify(ordered) + '\n'
}

/** Build a call record, stamping it with the current time. Pure. */
export function makeRecord (
  fields: WithoutTimestamp<CallRecord>,
  now: Date = new Date()
): CallRecord {
  return { ts: now.toISOString(), ...fields } as CallRecord
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
