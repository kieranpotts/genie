import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSpecifyTask } from '../../../src/extensions/realize/prompt.ts'

describe('buildSpecifyTask', () => {
  it('references a file path and tells the phase to read it', () => {
    const task = buildSpecifyTask([{ kind: 'file', path: './spec.md' }])
    assert.match(task, /`\.\/spec\.md`/)
    assert.match(task, /Read it in full/)
  })

  it('references a directory and its artifacts', () => {
    const task = buildSpecifyTask([{ kind: 'directory', path: './spec' }])
    assert.match(task, /directory `\.\/spec`/)
    assert.match(task, /artifacts/)
  })

  it('uses gh issue view for GitHub issues', () => {
    const task = buildSpecifyTask([{ kind: 'github', subtype: 'issue', url: 'https://github.com/owner/repo/issues/42' }])
    assert.match(task, /gh issue view/)
    assert.match(task, /--comments/)
    assert.ok(task.includes('https://github.com/owner/repo/issues/42'))
  })

  it('uses gh pr view for GitHub pull requests', () => {
    const task = buildSpecifyTask([{ kind: 'github', subtype: 'pr', url: 'https://github.com/owner/repo/pull/7' }])
    assert.match(task, /gh pr view/)
  })

  it('tells the phase to fetch a generic URL', () => {
    const task = buildSpecifyTask([{ kind: 'url', url: 'https://example.com/spec' }])
    assert.match(task, /Fetch and read it/)
    assert.ok(task.includes('https://example.com/spec'))
  })

  it('enumerates several sources as a numbered list', () => {
    const task = buildSpecifyTask([
      { kind: 'file', path: './spec.md' },
      { kind: 'github', subtype: 'issue', url: 'https://github.com/owner/repo/issues/42' }
    ])
    assert.match(task, /1\. The file/)
    assert.match(task, /2\. GitHub issue/)
  })
})
