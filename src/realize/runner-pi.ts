/**
 * The default {@link PhaseRunner}: runs each phase as a headless `pi` process.
 *
 * This is the only module that spawns a child process, and the only place that
 * knows how a {@link Phase}'s semantic `access` and `tier` map to `pi`'s own
 * command-line flags. Keeping that translation here means the pipeline — and any
 * alternative runner — never inherits `pi`'s tool or model vocabulary.
 *
 * Each phase runs in a fresh, ephemeral `pi -p` invocation: extensions, themes,
 * and prompt templates are disabled for a fast boot and to stop `realize` from
 * recursively invoking itself; the session is not persisted, since the artifacts
 * a phase reads and writes are the durable state.
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Access, Phase, PhaseRunner, PhaseTask, PhaseResult } from './runner.ts'

/**
 * Settings for {@link PiCliRunner}, also consulted by {@link buildPiArgs}.
 */
export interface PiRunnerConfig {
  /** The `pi` executable to invoke. Defaults to `'pi'` (resolved on `PATH`). */
  bin?: string
  /** Working directory for each child process. Defaults to the parent's cwd. */
  cwd?: string
  /** Model used for phases whose tier is `'strong'`. If unset, those phases fall back to the default model. */
  strongModel?: string
  /** Base directory of installed skills, used to resolve a phase's `skill` name to a path. Defaults to `~/.pi/agent/skills`. */
  skillsDir?: string
  /** Maximum time a phase may run, in milliseconds. Unset means no limit. */
  timeoutMs?: number
}

/**
 * Map a phase's semantic {@link Access} to the concrete `pi` built-in tool
 * allowlist. `full` returns `null`, meaning "pass no allowlist" so the phase
 * keeps `pi`'s default tool set.
 *
 * @param access - The capability level a phase declared.
 * @returns The tool names to pass to `-t`, or `null` for the default set.
 */
export function toolsForAccess (access: Access): string[] | null {
  switch (access) {
    case 'read-only':
      return ['read', 'grep', 'find', 'ls']
    case 'author':
      return ['read', 'grep', 'find', 'ls', 'write']
    case 'verify':
      return ['read', 'grep', 'find', 'ls', 'bash']
    case 'full':
      return null /* No allowlist: the phase keeps pi's full default tool set. */
  }
}

/**
 * Build the `pi` argument vector (everything after the binary name) for running
 * a phase. Pure and side-effect free, so the flag translation is unit-tested
 * without spawning anything.
 *
 * @param phase - The phase to run.
 * @param task - The inputs and instruction for this run.
 * @param config - Runner settings influencing model and skill resolution.
 * @returns The argv to pass to the `pi` binary.
 */
export function buildPiArgs (phase: Phase, task: PhaseTask, config: PiRunnerConfig = {}): string[] {
  const args = [
    '-p',
    /* Fast, deterministic boot: no extensions (so realize cannot recurse into
       itself), no themes or prompt templates, and an ephemeral session. */
    '--no-extensions',
    '--no-themes',
    '--no-prompt-templates',
    '--no-session',
    '--system-prompt', phase.systemPrompt
  ]

  /* Capability scope. `full` passes no allowlist, keeping pi's default tools. */
  const tools = toolsForAccess(phase.access)
  if (tools !== null) {
    args.push('-t', tools.join(','))
  }

  /* Skill loading. A phase that names a skill loads exactly that one; a phase
     without a skill disables skills entirely, keeping its context minimal (as
     the spike validated). NOTE: a skill-phase may still pick up other discovered
     skills — tightening that to *only* the named skill depends on how pi treats
     `--skill` alongside `--no-skills`, which must be confirmed against live pi. */
  if (phase.skill !== undefined) {
    const skillsDir = config.skillsDir ?? join(homedir(), '.pi', 'agent', 'skills')
    args.push('--skill', join(skillsDir, phase.skill))
  } else {
    args.push('--no-skills')
  }

  /* Model tier. Only `strong` with a configured model overrides the default. */
  if (phase.tier === 'strong' && config.strongModel !== undefined) {
    args.push('--model', config.strongModel)
  }

  /* Input artifacts are passed as `@file` positionals, ahead of the message. */
  for (const input of task.inputs) {
    args.push(`@${input}`)
  }

  /* The instruction itself is the trailing message. */
  args.push(task.task)

  return args
}

/**
 * A {@link PhaseRunner} that runs each phase as a headless `pi -p` process.
 */
export class PiCliRunner implements PhaseRunner {
  private readonly config: PiRunnerConfig

  constructor (config: PiRunnerConfig = {}) {
    this.config = config
  }

  /**
   * Run a phase to completion and capture its result.
   *
   * The child's stdin is closed so `pi` never blocks waiting for interactive
   * input. Standard output is captured as the phase's handoff text; on a
   * non-zero exit, standard error is appended so the failure carries diagnostics.
   *
   * @param phase - The phase to run.
   * @param task - The inputs and instruction for this run.
   * @returns The captured result.
   */
  run (phase: Phase, task: PhaseTask): Promise<PhaseResult> {
    const bin = this.config.bin ?? 'pi'
    const args = buildPiArgs(phase, task, this.config)

    return new Promise<PhaseResult>((resolve, reject) => {
      /* stdin is ignored (EOF) so pi does not wait for interactive input. */
      const child = spawn(bin, args, {
        cwd: this.config.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.config.timeoutMs
      })

      let stdout = ''
      let stderr = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { stdout += chunk })
      child.stderr?.on('data', (chunk: string) => { stderr += chunk })

      /* A spawn failure (eg. pi not on PATH) is an environment fault, not a
         phase result, so surface it as a rejection rather than `ok: false`. */
      child.on('error', reject)

      child.on('close', code => {
        const ok = code === 0
        /* Successful runs hand off their stdout; failures also include stderr so
           the reason is not lost. */
        const output = ok ? stdout : [stdout, stderr].filter(Boolean).join('\n')
        resolve({ ok, output })
      })
    })
  }
}
