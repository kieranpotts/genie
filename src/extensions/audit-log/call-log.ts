/**
 * Append-only log of every tool call this extension sees, plus the turn
 * boundaries between them and the shape of every outbound model request.
 *
 * Every call is recorded, whether it mutates or only reads — nothing here is
 * ever confirmed by a human, so there is no smaller "prompted calls only"
 * subset to fall back to. `docs/requirements.md` asks for observability of
 * every action against the filesystem, and reads are actions.
 *
 * A call produces TWO LINES, joined by `id` (Pi's `toolCallId`):
 *
 *   phase: 'call'    the call was attempted, written before the tool runs.
 *   phase: 'result'  what the tool actually did, written after it runs.
 *
 * THIS EXTENSION HAS NO OPINION ON ADMISSION. It does not decide whether a call
 * proceeds — `secret-sentry` does that, in its own process, and a call it
 * refuses by name never reaches this extension's `tool_call` handler at all:
 * Pi's runner stops calling extensions for an event the instant any handler
 * returns `{ block: true }`. So the `call` line here carries no `outcome` or
 * `confirmation` field — unlike the single combined extension this was split
 * from, this log cannot say whether a call was ever admitted, only that it was
 * attempted and (if it ran) what happened. `secret-sentry`'s own
 * `security.jsonl` is the record of what it refused and why; see that
 * extension's README for the reasoning and for why a reviewer needs both
 * files, joined by `id`, for the complete picture.
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

/**
 * What the tool actually did. Observed AFTER it ran, from `tool_result`.
 *
 * A call this extension never sees a result for — because `secret-sentry`
 * refused it before it ran — simply has no `result` line. The absence is not
 * ambiguous: `secret-sentry`'s own log already says why.
 */
export type CallResult = 'ok' | 'error'

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

/** The attempt: a call reached this extension's `tool_call` hook, written
 * before the tool runs. */
export interface CallAttemptRecord extends RecordBase {
  phase: 'call'
  /** A short description of the call (the path, or paths). Never the content:
   * logging what was read would copy secrets out of the files and into the
   * audit trail, which is the opposite of the point. */
  detail?: string
}

/**
 * The result: what the tool actually did, written after it runs.
 *
 * Deliberately carries NO content. `tool_result` hands us the tool's entire
 * output — the file the agent just read — and copying that here would turn the
 * audit trail into a second copy of every secret the agent has touched. The
 * path is already on the `call` line; this line adds only the verdict.
 *
 * NO REDACTION FIELDS. Whether anything was redacted from this result is a
 * question only `secret-sentry` can answer — it is the extension that performs
 * the redaction — so that fact lives in `secret-sentry`'s own log, not here.
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
 * NOT `phase`. A line without that field yields `null` on a `.phase` selector,
 * which matches neither `"call"` nor `"result"` — so every query written
 * against those two lines keeps working unmodified once turn lines exist
 * alongside them.
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
          ...(record.detail !== undefined ? { detail: record.detail } : {}),
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
