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

import { spawn, execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Access, Phase, PhaseRunner, PhaseTask, PhaseResult } from './runner.ts'

const execFileAsync = promisify(execFile)

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
  /**
   * A concrete model id to pass to `--model`, already resolved for this run.
   * When set, it takes precedence over the phase's tier — it is how a skill's
   * `x_preferred_model` preference, once matched against a loaded model, reaches
   * the argument vector. {@link buildPiArgs} treats it as authoritative and does
   * no matching of its own. Resolution (reading the skill and listing models)
   * happens in {@link PiCliRunner.run}, keeping `buildPiArgs` pure.
   */
  resolvedModel?: string
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

/** The frontmatter key by which a skill may declare its preferred model. It
 *  lives under the spec's `metadata:` map (the sanctioned extension point), so
 *  it is matched as an *indented* key rather than a top-level one. */
const PREFERRED_MODEL_KEY = 'preferred_model'

/**
 * Resolve a skill name to the directory holding its `SKILL.md`. The base is the
 * configured skills directory, or `~/.pi/agent/skills` by default. Shared so the
 * `--skill` flag and the preferred-model lookup agree on one location.
 *
 * @param skill - The skill name (eg. `'review'`).
 * @param skillsDir - An overriding base directory, if configured.
 * @returns The absolute path to the skill's directory.
 */
export function resolveSkillDir (skill: string, skillsDir?: string): string {
  return join(skillsDir ?? join(homedir(), '.pi', 'agent', 'skills'), skill)
}

/**
 * Read a skill's `metadata.preferred_model` preference from its `SKILL.md`
 * frontmatter.
 *
 * The lookup is deliberately forgiving: a skill with no `SKILL.md`, no
 * frontmatter, or no preference is the common case and yields `undefined`
 * rather than an error. Only the one key is extracted — this is not a general
 * YAML parser, just enough to read a single quoted-or-bare scalar from the
 * leading `---` fenced block.
 *
 * @param skillDir - The skill's directory (where its `SKILL.md` lives).
 * @returns The declared model id, or `undefined` if none is present.
 */
export async function readPreferredModel (skillDir: string): Promise<string | undefined> {
  let text: string
  try {
    text = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
  } catch {
    return undefined /* No SKILL.md (or unreadable) — no preference. */
  }
  return parsePreferredModel(text)
}

/**
 * Extract the `metadata.preferred_model` value from SKILL.md source. Split out
 * from the file read so the parsing is pure and unit-testable.
 *
 * @param source - The full text of a `SKILL.md` file.
 * @returns The declared model id, or `undefined`.
 */
export function parsePreferredModel (source: string): string | undefined {
  /* Isolate the leading frontmatter block: a `---` fence on its own line, up to
     the next such fence. Without one, there is no preference to read. */
  const fence = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
  if (fence === null) {
    return undefined
  }
  const block = fence[1]
  /* The key lives under the `metadata:` map, so it is *indented* (at least one
     space or tab). Requiring leading whitespace keeps a top-level key of the
     same name from matching, and is enough to scope it to the metadata block
     without a full YAML parse. */
  const line = new RegExp(`^[ \\t]+${PREFERRED_MODEL_KEY}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(block)
  if (line === null) {
    return undefined
  }
  /* Strip a single layer of matching quotes, if present. */
  const value = line[1].replace(/^(['"])(.*)\1$/, '$2').trim()
  return value === '' ? undefined : value
}

/**
 * Parse the set of loaded model ids from `pi --list-models` output.
 *
 * The output is a whitespace-aligned table: a header row
 * (`provider model context …`) followed by one row per loaded model. For each
 * data row this yields both the bare model id (the second column) and its
 * fully-qualified `provider/model` form, so an exact-id match succeeds whether
 * the skill named the model plainly or with its provider prefix.
 *
 * @param output - The captured stdout of `pi --list-models`.
 * @returns The set of recognised model identifiers.
 */
export function parseLoadedModels (output: string): Set<string> {
  const models = new Set<string>()
  const lines = output.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') {
      continue
    }
    const cols = line.split(/\s+/)
    const [provider, model] = cols
    /* Skip the header row and any malformed line lacking the two key columns. */
    if (provider === undefined || model === undefined || provider === 'provider') {
      continue
    }
    models.add(model)
    models.add(`${provider}/${model}`)
  }
  return models
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
    args.push('--skill', resolveSkillDir(phase.skill, config.skillsDir))
  } else {
    args.push('--no-skills')
  }

  /* Model selection. A resolved model (a skill's matched `x_preferred_model`)
     wins outright; otherwise a `strong` tier with a configured model overrides
     the default; otherwise the phase inherits pi's default model. */
  if (config.resolvedModel !== undefined) {
    args.push('--model', config.resolvedModel)
  } else if (phase.tier === 'strong' && config.strongModel !== undefined) {
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
   * Resolve the concrete model for a phase from its skill's `x_preferred_model`
   * preference, honouring "skill wins, else fall back to tier".
   *
   * The preference is consulted only for a phase that names a skill. When that
   * skill declares `x_preferred_model` *and* the named model is currently loaded
   * (an exact id match against `pi --list-models`), it is returned and overrides
   * the tier. An absent preference, an unmatched one, or any failure to read the
   * skill or list models yields `undefined`, leaving {@link buildPiArgs} to apply
   * the existing tier logic — so the feature is purely additive.
   *
   * @param phase - The phase whose model is being resolved.
   * @returns The model id to force, or `undefined` to defer to tier selection.
   */
  private async resolveModel (phase: Phase): Promise<string | undefined> {
    if (phase.skill === undefined) {
      return undefined
    }
    const preferred = await readPreferredModel(resolveSkillDir(phase.skill, this.config.skillsDir))
    if (preferred === undefined) {
      return undefined
    }
    let loaded: Set<string>
    try {
      const { stdout } = await execFileAsync(this.config.bin ?? 'pi', ['--list-models'])
      loaded = parseLoadedModels(stdout)
    } catch {
      return undefined /* Can't enumerate models — fall back to tier. */
    }
    return loaded.has(preferred) ? preferred : undefined
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
  async run (phase: Phase, task: PhaseTask): Promise<PhaseResult> {
    const bin = this.config.bin ?? 'pi'
    const resolvedModel = await this.resolveModel(phase)
    const args = buildPiArgs(phase, task, { ...this.config, resolvedModel })

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
