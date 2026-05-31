import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPiArgs, toolsForAccess, PiCliRunner } from '../../src/realize/runner-pi.ts'
import type { Phase } from '../../src/realize/runner.ts'

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
