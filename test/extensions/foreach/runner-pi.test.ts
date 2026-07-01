import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { buildPiArgs, resolveSkillDir } from '../../../src/extensions/foreach/runner-pi.ts'

describe('resolveSkillDir', () => {
  it('resolves under the configured skills dir', () => {
    assert.equal(resolveSkillDir('review', '/skills'), join('/skills', 'review'))
  })
})

describe('buildPiArgs', () => {
  it('boots fast, extension-free, and session-free for every item', () => {
    const args = buildPiArgs({ kind: 'freeform', text: 'Summarize this' }, 'owner/repo#42')
    assert.ok(args.includes('--no-extensions'))
    assert.ok(args.includes('--no-themes'))
    assert.ok(args.includes('--no-prompt-templates'))
    assert.ok(args.includes('--no-session'))
  })

  it('disables skills for a freeform instruction', () => {
    const args = buildPiArgs({ kind: 'freeform', text: 'Summarize this' }, 'item')
    assert.ok(args.includes('--no-skills'))
    assert.ok(!args.includes('--skill'))
  })

  it('loads exactly the named skill for a skill instruction', () => {
    const args = buildPiArgs({ kind: 'skill', name: 'review' }, 'item', { skillsDir: '/skills' })
    const i = args.indexOf('--skill')
    assert.ok(i >= 0)
    assert.equal(args[i + 1], join('/skills', 'review'))
    assert.ok(!args.includes('--no-skills'))
  })

  it('passes the task as the trailing message', () => {
    const args = buildPiArgs({ kind: 'freeform', text: 'x' }, 'the task text')
    assert.equal(args[args.length - 1], 'the task text')
  })
})
