/**
 * The default {@link ItemRunner}: runs each list item as a headless `pi`
 * process.
 *
 * This is the only module that spawns a child process. Each item runs in a
 * fresh, ephemeral `pi -p` invocation: extensions, themes, and prompt templates
 * are disabled for a fast boot and to stop `foreach` from recursively invoking
 * itself; the session is not persisted, and the item's own instruction/skill is
 * the only thing that carries over from one item to the next — nothing in the
 * subagent's context does, by design (see the README).
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ItemRunner, ItemResult } from './runner.ts'
import type { ParsedInstruction } from './instruction.ts'

const execFileAsync = promisify(execFile)

/** Settings for {@link PiCliRunner}, also consulted by {@link buildPiArgs}. */
export interface PiRunnerConfig {
  /** The `pi` executable to invoke. Defaults to `'pi'` (resolved on `PATH`). */
  bin?: string
  /** Working directory for each child process. Defaults to the parent's cwd. */
  cwd?: string
  /** Base directory of installed skills. Defaults to `~/.pi/agent/skills`. */
  skillsDir?: string
  /** Maximum time an item may run, in milliseconds. Unset means no limit. */
  timeoutMs?: number
  /** Largest stdout/stderr an item may produce, in bytes. */
  maxBufferBytes?: number
}

/** Default cap on a single item's captured output. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024

/**
 * Resolve a skill name to the directory holding its `SKILL.md`.
 *
 * @param skill - The skill name (eg. `'review'`).
 * @param skillsDir - An overriding base directory, if configured.
 * @returns The absolute path to the skill's directory.
 */
export function resolveSkillDir (skill: string, skillsDir?: string): string {
  return join(skillsDir ?? join(homedir(), '.pi', 'agent', 'skills'), skill)
}

/**
 * Build the `pi` argument vector (everything after the binary name) for
 * running one list item. Pure and side-effect free, so the flag translation is
 * unit-tested without spawning anything.
 *
 * Unlike a `realize` phase, an item carries no restricted tool set — a
 * `/foreach` instruction is a general-purpose task, not a specialized
 * lifecycle role — so no `-t` allowlist is passed and `pi` keeps its default
 * tools.
 *
 * @param instruction - The classified instruction for this run.
 * @param task - The message to hand to the subagent (built by {@link buildItemTask}).
 * @param config - Runner settings influencing skill resolution.
 * @returns The argv to pass to the `pi` binary.
 */
export function buildPiArgs (instruction: ParsedInstruction, task: string, config: PiRunnerConfig = {}): string[] {
  const args = [
    '-p',
    '--no-extensions',
    '--no-themes',
    '--no-prompt-templates',
    '--no-session'
  ]

  if (instruction.kind === 'skill') {
    args.push('--skill', resolveSkillDir(instruction.name, config.skillsDir))
  } else {
    args.push('--no-skills')
  }

  args.push(task)
  return args
}

/**
 * A {@link ItemRunner} that runs each item as a headless `pi -p` process.
 */
export class PiCliRunner implements ItemRunner {
  private readonly instruction: ParsedInstruction
  private readonly config: PiRunnerConfig

  /**
   * @param instruction - The instruction shared by every item in this run.
   * @param config - Runner settings.
   */
  constructor (instruction: ParsedInstruction, config: PiRunnerConfig = {}) {
    this.instruction = instruction
    this.config = config
  }

  async run (task: string): Promise<ItemResult> {
    const bin = this.config.bin ?? 'pi'
    const args = buildPiArgs(this.instruction, task, this.config)

    try {
      const { stdout } = await execFileAsync(bin, args, {
        cwd: this.config.cwd,
        timeout: this.config.timeoutMs,
        maxBuffer: this.config.maxBufferBytes ?? DEFAULT_MAX_BUFFER
      })
      return { ok: true, output: stdout }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      /* A non-zero exit, a timeout, or a spawn fault (eg. `pi` not on PATH) all
         land here; the loop treats this item as failed and continues. */
      return { ok: false, output: message }
    }
  }
}
