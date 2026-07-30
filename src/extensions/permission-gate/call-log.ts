/**
 * Append-only log of every tool call the gate sees, plus the turn boundaries
 * between them.
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
 * writes twice the lines it used to. That cost was accepted deliberately — the
 * log grows without bound and nothing here ever deletes from it. This sink can
 * only APPEND, and that is a property to preserve: a cap or a rotation step
 * would put truncation logic inside the audited process, which is the one place
 * an accountability record should not be deletable from. Pruning is the
 * operator's, from the host. See "Retention" in this extension's README and in
 * src/infrastructure/README.md.
 *
 * TWO FURTHER LINE KINDS sit alongside those, neither carrying a `phase` — see
 * `TurnRecord` for why that field is deliberately absent from both:
 *
 *   kind: 'turn_start'        a turn began. Groups the calls that follow it, so
 *                             a reviewer need not correlate timestamps against a
 *                             session transcript on another volume.
 *   kind: 'provider_request'  a model request went out, reduced to its shape.
 *
 * Neither describes what it marks. A turn line does not say what was asked, and
 * a provider-request line does not say what was sent — only how much of it there
 * was. The event behind the second carries the entire conversation, so that
 * restraint is the whole design of the line rather than a detail of it.
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
import type { ProviderRequestShape } from './provider-request.ts'

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

/**
 * A turn boundary: one agent run, started by one instruction from the operator.
 *
 * Written from `before_agent_start`, which fires after a prompt is submitted and
 * before the agent loop runs. Every call line that follows belongs to this turn
 * until the next turn line appears, which is what makes "what did the agent do
 * in response to *that* instruction" answerable from this file alone.
 *
 * NOT `phase`. The three documented `jq` recipes in the runbook all select on
 * `.phase`, and a line without that field yields `null`, which matches neither
 * `"call"` nor `"result"` — so every existing query returns exactly what it did
 * before this line kind existed. Re-check that if a recipe is ever written which
 * selects lines by the ABSENCE of a field rather than by its value.
 *
 * NOT Pi's `turn_start` event, despite the name. That event fires once per model
 * request inside a single agent run, and its `turnIndex` resets to 0 on every
 * run, so it cannot serve as a grouping key. Pi's own `before_agent_start`
 * result type calls this boundary a turn too ("replace the system prompt for
 * this turn"), which is the naming followed here.
 *
 * The key set is CLOSED, and deliberately so: `before_agent_start` hands the
 * handler the user's prompt, the images attached to it, and the fully assembled
 * system prompt. None of that is recorded. This line says a turn began; letting
 * it grow into a record of what the turn was ABOUT would put the conversation
 * into the audit trail, which is the failure "paths, never content" exists to
 * prevent.
 */
export interface TurnRecord {
  ts: string
  kind: 'turn_start'
  /**
   * Which turn, counted by THIS process from 1. Not persisted and not derived
   * from the session, so a resumed session starts counting again — `ts` and file
   * order disambiguate. It is an ordinal for referring to a turn, not an id.
   */
  turn: number
  /**
   * Pi's session id, when the harness exposes one. This is what makes the
   * ordinal usable in a file that is appended to forever and across sessions:
   * without it, turn 1 of today is indistinguishable from turn 1 of last week.
   * Omitted rather than faked if unavailable.
   */
  session?: string
}

/**
 * One outbound model request, reduced to its shape.
 *
 * Written from `before_provider_request`, which fires once per model call — so
 * several of these can fall inside a single turn, and the turn line before them
 * is what groups them.
 *
 * SHAPE, NEVER CONTENT, and this is the line where that rule is load-bearing:
 * the event's payload is the whole conversation, including every file the agent
 * has read. `provider-request.ts` extracts named scalars from it and this record
 * carries only those. Every field is optional because the payload's shape
 * belongs to the provider; an absent field means the request did not carry it.
 *
 * Like `TurnRecord`, it carries no `phase` — see there for why.
 */
export interface ProviderRequestRecord extends ProviderRequestShape {
  ts: string
  kind: 'provider_request'
}

export type LogRecord =
  | CallAttemptRecord
  | CallResultRecord
  | TurnRecord
  | ProviderRequestRecord

/** Distributes `Omit` across the union, so each member keeps its own fields. */
type WithoutTimestamp<T> = T extends unknown ? Omit<T, 'ts'> : never

/** Render a log record as a newline-terminated JSON line. Pure. */
export function formatRecord (record: LogRecord): string {
  const ordered = 'kind' in record
    ? record.kind === 'turn_start'
      ? {
          ts: record.ts,
          kind: record.kind,
          turn: record.turn,
          ...(record.session !== undefined ? { session: record.session } : {}),
        }
      : {
          ts: record.ts,
          kind: record.kind,
          ...(record.model !== undefined ? { model: record.model } : {}),
          ...(record.messages !== undefined ? { messages: record.messages } : {}),
          ...(record.approx_bytes !== undefined ? { approx_bytes: record.approx_bytes } : {}),
        }
    : record.phase === 'call'
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

/** Build a log record, stamping it with the current time. Pure. */
export function makeRecord (
  fields: WithoutTimestamp<LogRecord>,
  now: Date = new Date()
): LogRecord {
  return { ts: now.toISOString(), ...fields } as LogRecord
}

/** Append-only sink for log records. */
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
  async record (record: LogRecord): Promise<void> {
    try {
      await this.ensureDir()
      await appendFile(this.filePath, formatRecord(record), { encoding: 'utf8' })
    } catch {
      /* Best-effort logging. */
    }
  }
}
