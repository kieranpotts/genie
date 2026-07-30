/**
 * Append-only log of the security decisions THIS extension makes: a call
 * refused by name, and tool output a redaction rule fired against.
 *
 * This is deliberately NOT a general activity log. It was, once — this
 * extension used to record every tool call, allowed or blocked, plus turn
 * boundaries and model-request shapes. That generic trail now lives in the
 * separate `audit-log` extension, so that a security control and an activity
 * log are not one piece of code with two jobs. What stays here is narrower and
 * more specific: only the two things nobody but this extension can know,
 * because this extension is the one that decided them.
 *
 * TWO RECORD KINDS, and no `phase` — unlike `audit-log`'s two-line-per-call
 * shape, a blocked call and a redacted result are not two halves of the same
 * event. A blocked call never runs, so there is nothing to pair it with; a
 * redaction is a fact about a result that already has its own `ok`/`error`
 * line in `audit-log`'s file. Each line here stands alone:
 *
 *   kind: 'blocked'    a call was refused outright, before it ran.
 *   kind: 'redaction'  secret-shaped output was replaced before the model saw
 *                      it. Only written when at least one rule fired.
 *
 * Both carry `id` — Pi's `toolCallId` — so a reviewer who wants the complete
 * picture of one call can join this file against `audit-log`'s by that field.
 * A blocked call's `id` will have NO corresponding line in `audit-log`'s file
 * if that extension's `tool_call` handler never ran for it (see this
 * extension's README, and `audit-log`'s, for why that depends on an extension
 * load order Pi does not guarantee) — the absence there is not a gap, this
 * file is the authoritative record of the block regardless.
 *
 * The record is produced by a pure function (`formatRecord`) so it can be
 * asserted in tests; the sink (`SecurityLog`) is the only side-effecting part.
 *
 * Kept local to this extension rather than factored into a shared module,
 * because the verbatim-copy installer requires each extension directory to be
 * self-contained (no cross-directory imports survive installation).
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Fields common to both record kinds. */
interface RecordBase {
  ts: string
  /** Pi's `toolCallId` — present so this file can be joined against
   * `audit-log`'s by `id`, never so the two logs need to agree on anything
   * else. */
  id: string
  tool: string
}

/**
 * A call refused outright, before it ran. Written from `tool_call`, the
 * instant `findSensitiveArgument` names a match — there is no approval path to
 * wait on.
 */
export interface BlockedRecord extends RecordBase {
  kind: 'blocked'
  /** The sensitive path that matched, in full. Never truncated: a reviewer
   * must be able to see exactly what was named, however long the call. */
  path: string
  /** Human-readable reason, naming the rule and the file's basename. */
  reason: string
}

/**
 * Secret-shaped output was replaced before the model saw it. Written from
 * `tool_result`, and only when at least one rule fired — the field set says
 * "nothing matched" and "the redactor did not run" are the same absence,
 * deliberately: see `redaction.ts` for why a redaction failure fails open
 * rather than throwing.
 *
 * Deliberately carries NO content and no length. This is the sharpest case of
 * the no-content rule in this whole log: the record is specifically about a
 * secret, so it must describe it without carrying it.
 */
export interface RedactionRecord extends RecordBase {
  kind: 'redaction'
  /** How many secret-shaped spans were replaced in this result. */
  redactions: number
  /** Which redaction rules fired, by name — `github-token`, not the token. */
  rules: string[]
}

export type SecurityRecord = BlockedRecord | RedactionRecord

/** Distributes `Omit` across the union, so each member keeps its own fields. */
type WithoutTimestamp<T> = T extends unknown ? Omit<T, 'ts'> : never

/** Render a security record as a newline-terminated JSON line. Pure. */
export function formatRecord (record: SecurityRecord): string {
  const ordered = record.kind === 'blocked'
    ? {
        ts: record.ts,
        kind: record.kind,
        id: record.id,
        tool: record.tool,
        path: record.path,
        reason: record.reason,
      }
    : {
        ts: record.ts,
        kind: record.kind,
        id: record.id,
        tool: record.tool,
        redactions: record.redactions,
        rules: record.rules,
      }
  return JSON.stringify(ordered) + '\n'
}

/** Build a security record, stamping it with the current time. Pure. */
export function makeRecord (
  fields: WithoutTimestamp<SecurityRecord>,
  now: Date = new Date()
): SecurityRecord {
  return { ts: now.toISOString(), ...fields } as SecurityRecord
}

/** Append-only sink for security records. */
export class SecurityLog {
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
  async record (record: SecurityRecord): Promise<void> {
    try {
      await this.ensureDir()
      await appendFile(this.filePath, formatRecord(record), { encoding: 'utf8' })
    } catch {
      /* Best-effort logging. */
    }
  }
}
