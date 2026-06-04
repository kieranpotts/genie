import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPiArgs,
  toolsForAccess,
  PiCliRunner,
  parsePreferredModel,
  parseLoadedModels,
  resolveSkillDir
} from '../../../src/extensions/realize/runner-pi.ts'
import type { Phase } from '../../../src/extensions/realize/runner.ts'

/**
 * Build a phase with sensible defaults, overriding only the fields a test cares
 * about.
 */
function makePhase (overrides: Partial<Phase> = {}): Phase {
  return {
    name: 'review',
    systemPrompt: 'You are a reviewer.',
    access: 'read-only',
    tier: 'default',
    ...overrides
  }
}

/** Return the argument that follows `flag`, or `undefined` if it is absent. */
function valueOf (args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

describe('toolsForAccess', () => {
  it('maps read-only to inspection tools', () => {
    assert.deepEqual(toolsForAccess('read-only'), ['read', 'grep', 'find', 'ls'])
  })

  it('adds write for author', () => {
    assert.deepEqual(toolsForAccess('author'), ['read', 'grep', 'find', 'ls', 'write'])
  })

  it('adds bash for verify', () => {
    assert.deepEqual(toolsForAccess('verify'), ['read', 'grep', 'find', 'ls', 'bash'])
  })

  it('returns null for full (pi default tool set)', () => {
    assert.equal(toolsForAccess('full'), null)
  })
})

describe('buildPiArgs', () => {
  it('always includes the fast, ephemeral boot flags', () => {
    const args = buildPiArgs(makePhase(), { inputs: [], task: 'go' })
    for (const flag of ['-p', '--no-extensions', '--no-themes', '--no-prompt-templates', '--no-session']) {
      assert.ok(args.includes(flag), `expected ${flag}`)
    }
  })

  it('passes the system prompt', () => {
    const args = buildPiArgs(makePhase({ systemPrompt: 'ROLE' }), { inputs: [], task: 'go' })
    assert.equal(valueOf(args, '--system-prompt'), 'ROLE')
  })

  it('translates access into a -t allowlist', () => {
    assert.equal(valueOf(buildPiArgs(makePhase({ access: 'read-only' }), { inputs: [], task: 'go' }), '-t'), 'read,grep,find,ls')
    assert.equal(valueOf(buildPiArgs(makePhase({ access: 'author' }), { inputs: [], task: 'go' }), '-t'), 'read,grep,find,ls,write')
    assert.equal(valueOf(buildPiArgs(makePhase({ access: 'verify' }), { inputs: [], task: 'go' }), '-t'), 'read,grep,find,ls,bash')
  })

  it('omits -t for full access', () => {
    const args = buildPiArgs(makePhase({ access: 'full' }), { inputs: [], task: 'go' })
    assert.ok(!args.includes('-t'))
  })

  it('disables skills when the phase names none', () => {
    const args = buildPiArgs(makePhase({ skill: undefined }), { inputs: [], task: 'go' })
    assert.ok(args.includes('--no-skills'))
    assert.ok(!args.includes('--skill'))
  })

  it('loads a named skill from the default skills directory', () => {
    const args = buildPiArgs(makePhase({ skill: 'review' }), { inputs: [], task: 'go' })
    assert.match(valueOf(args, '--skill') ?? '', /[/\\]\.pi[/\\]agent[/\\]skills[/\\]review$/)
    assert.ok(!args.includes('--no-skills'))
  })

  it('resolves a named skill against a configured skills directory', () => {
    const args = buildPiArgs(makePhase({ skill: 'design' }), { inputs: [], task: 'go' }, { skillsDir: '/opt/skills' })
    assert.equal(valueOf(args, '--skill'), join('/opt/skills', 'design'))
  })

  it('adds --model only for a strong tier with a configured model', () => {
    assert.equal(valueOf(buildPiArgs(makePhase({ tier: 'strong' }), { inputs: [], task: 'go' }, { strongModel: 'qwen3.5:35b' }), '--model'), 'qwen3.5:35b')
  })

  it('omits --model for the default tier', () => {
    const args = buildPiArgs(makePhase({ tier: 'default' }), { inputs: [], task: 'go' }, { strongModel: 'qwen3.5:35b' })
    assert.ok(!args.includes('--model'))
  })

  it('omits --model for a strong tier when no strong model is configured', () => {
    const args = buildPiArgs(makePhase({ tier: 'strong' }), { inputs: [], task: 'go' })
    assert.ok(!args.includes('--model'))
  })

  it('a resolved model wins over the default tier', () => {
    const args = buildPiArgs(makePhase({ tier: 'default' }), { inputs: [], task: 'go' }, { resolvedModel: 'qwen3.5:9b' })
    assert.equal(valueOf(args, '--model'), 'qwen3.5:9b')
  })

  it('a resolved model wins over a configured strong model', () => {
    const args = buildPiArgs(makePhase({ tier: 'strong' }), { inputs: [], task: 'go' }, { resolvedModel: 'qwen3.5:9b', strongModel: 'qwen3.5:35b' })
    assert.equal(valueOf(args, '--model'), 'qwen3.5:9b')
  })

  it('passes inputs as @file positionals before the task, in order', () => {
    const args = buildPiArgs(makePhase(), { inputs: ['/a/spec.md', '/b/design.md'], task: 'GO' })
    const a = args.indexOf('@/a/spec.md')
    const b = args.indexOf('@/b/design.md')
    const t = args.indexOf('GO')
    assert.ok(a >= 0 && b >= 0, 'both inputs present')
    assert.ok(a < b, 'inputs keep order')
    assert.ok(b < t, 'inputs precede the task')
  })

  it('ends with the task message', () => {
    const args = buildPiArgs(makePhase(), { inputs: [], task: 'the instruction' })
    assert.equal(args[args.length - 1], 'the instruction')
  })
})

describe('parsePreferredModel', () => {
  it('reads a value nested under metadata', () => {
    const src = '---\nname: code\nmetadata:\n  preferred_model: claude-opus-4-8\n---\nbody'
    assert.equal(parsePreferredModel(src), 'claude-opus-4-8')
  })

  it('strips surrounding quotes', () => {
    assert.equal(parsePreferredModel('---\nmetadata:\n  preferred_model: "qwen3.5:35b"\n---\n'), 'qwen3.5:35b')
    assert.equal(parsePreferredModel("---\nmetadata:\n  preferred_model: 'ollama/qwen3.5:9b'\n---\n"), 'ollama/qwen3.5:9b')
  })

  it('returns undefined when the key is absent', () => {
    assert.equal(parsePreferredModel('---\nname: code\n---\nbody'), undefined)
  })

  it('ignores a top-level key of the same name (must be nested under metadata)', () => {
    assert.equal(parsePreferredModel('---\nname: code\npreferred_model: claude-opus-4-8\n---\n'), undefined)
  })

  it('returns undefined when there is no frontmatter block', () => {
    assert.equal(parsePreferredModel('# code\n\nmetadata:\n  preferred_model: claude-opus-4-8\n'), undefined)
  })

  it('returns undefined for an empty value', () => {
    assert.equal(parsePreferredModel('---\nmetadata:\n  preferred_model:\n---\n'), undefined)
  })
})

describe('parseLoadedModels', () => {
  const table = [
    'provider  model             context  max-out  thinking  images',
    'ollama    qwen3.5:9b        262.1K   16.4K    yes       yes   ',
    'ollama    qwen3.5:35b       262.1K   16.4K    yes       yes   '
  ].join('\n')

  it('skips the header and collects each model id', () => {
    const models = parseLoadedModels(table)
    assert.ok(models.has('qwen3.5:9b'))
    assert.ok(models.has('qwen3.5:35b'))
    assert.ok(!models.has('model'))
  })

  it('also recognises the provider/model form', () => {
    const models = parseLoadedModels(table)
    assert.ok(models.has('ollama/qwen3.5:9b'))
  })

  it('tolerates blank lines and trailing whitespace', () => {
    const models = parseLoadedModels(`\n${table}\n\n`)
    assert.ok(models.has('qwen3.5:35b'))
  })

  it('yields an empty set for empty output', () => {
    assert.equal(parseLoadedModels('').size, 0)
  })
})

describe('resolveSkillDir', () => {
  it('joins the skill onto a configured base', () => {
    assert.equal(resolveSkillDir('review', '/opt/skills'), join('/opt/skills', 'review'))
  })

  it('defaults to ~/.pi/agent/skills', () => {
    assert.match(resolveSkillDir('code'), /[/\\]\.pi[/\\]agent[/\\]skills[/\\]code$/)
  })
})

describe('PiCliRunner model resolution', () => {
  /**
   * Write a fake `pi` that records its own argv to a file and reports the loaded
   * models on `--list-models`, so a test can assert which `--model` (if any) the
   * runner forwarded.
   */
  async function fakePi (dir: string, loaded: string[]): Promise<string> {
    const bin = join(dir, 'fake-pi')
    const argsLog = join(dir, 'args.txt')
    const listing = ['provider  model', ...loaded.map(m => `ollama    ${m}`)].join('\\n')
    await writeFile(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--list-models" ]; then',
      `  printf '${listing}\\n'`,
      '  exit 0',
      'fi',
      `printf '%s\\n' "$@" > "${argsLog}"`,
      'printf "DONE\\n"'
    ].join('\n'))
    await chmod(bin, 0o755)
    return argsLog
  }

  /** Create a skill dir with a SKILL.md declaring the given preferred model. */
  async function skillWithPreference (skillsDir: string, name: string, model: string | null): Promise<void> {
    const dir = join(skillsDir, name)
    await mkdir(dir, { recursive: true })
    const fm = model === null ? `---\nname: ${name}\n---\n` : `---\nname: ${name}\nmetadata:\n  preferred_model: ${model}\n---\n`
    await writeFile(join(dir, 'SKILL.md'), fm)
  }

  async function modelArg (argsLog: string): Promise<string | undefined> {
    const lines = (await readFile(argsLog, 'utf8')).split('\n')
    const i = lines.indexOf('--model')
    return i >= 0 ? lines[i + 1] : undefined
  }

  it('forwards a preferred model that is loaded, overriding tier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realize-model-'))
    try {
      const argsLog = await fakePi(dir, ['qwen3.5:9b'])
      const skillsDir = join(dir, 'skills')
      await skillWithPreference(skillsDir, 'review', 'qwen3.5:9b')

      const runner = new PiCliRunner({ bin: join(dir, 'fake-pi'), skillsDir, strongModel: 'qwen3.5:35b' })
      const result = await runner.run(makePhase({ skill: 'review', tier: 'strong' }), { inputs: [], task: 'go' })
      assert.equal(result.ok, true)
      assert.equal(await modelArg(argsLog), 'qwen3.5:9b')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to tier when the preferred model is not loaded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realize-model-'))
    try {
      const argsLog = await fakePi(dir, ['qwen3.5:35b'])
      const skillsDir = join(dir, 'skills')
      await skillWithPreference(skillsDir, 'review', 'claude-opus-4-8')

      const runner = new PiCliRunner({ bin: join(dir, 'fake-pi'), skillsDir, strongModel: 'qwen3.5:35b' })
      await runner.run(makePhase({ skill: 'review', tier: 'strong' }), { inputs: [], task: 'go' })
      assert.equal(await modelArg(argsLog), 'qwen3.5:35b')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to tier when the skill declares no preference', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realize-model-'))
    try {
      const argsLog = await fakePi(dir, ['qwen3.5:9b'])
      const skillsDir = join(dir, 'skills')
      await skillWithPreference(skillsDir, 'plan', null)

      const runner = new PiCliRunner({ bin: join(dir, 'fake-pi'), skillsDir })
      await runner.run(makePhase({ skill: 'plan', tier: 'default' }), { inputs: [], task: 'go' })
      assert.equal(await modelArg(argsLog), undefined)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('PiCliRunner.run', () => {
  it('captures stdout and reports success on a zero exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realize-runner-'))
    try {
      const bin = join(dir, 'fake-pi')
      await writeFile(bin, '#!/bin/sh\nprintf "REVIEW OK\\n"\n')
      await chmod(bin, 0o755)

      const result = await new PiCliRunner({ bin }).run(makePhase(), { inputs: [], task: 'go' })
      assert.equal(result.ok, true)
      assert.match(result.output, /REVIEW OK/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports failure and includes stderr on a non-zero exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realize-runner-'))
    try {
      const bin = join(dir, 'fake-pi')
      await writeFile(bin, '#!/bin/sh\nprintf "partial\\n"\nprintf "boom\\n" 1>&2\nexit 3\n')
      await chmod(bin, 0o755)

      const result = await new PiCliRunner({ bin }).run(makePhase(), { inputs: [], task: 'go' })
      assert.equal(result.ok, false)
      assert.match(result.output, /boom/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
