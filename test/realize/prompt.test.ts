import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRealizePrompt } from '../../src/realize/prompt.ts'

describe('buildRealizePrompt', () => {
  it('references a file path and tells the agent to read it', () => {
    const prompt = buildRealizePrompt({ kind: 'file', path: './spec.md' })
    assert.match(prompt, /`\.\/spec\.md`/)
    assert.match(prompt, /Read it in full/)
  })

  it('references a directory and its artifacts', () => {
    const prompt = buildRealizePrompt({ kind: 'directory', path: './spec' })
    assert.match(prompt, /directory `\.\/spec`/)
    assert.match(prompt, /artifacts/)
  })

  it('uses gh issue view for GitHub issues', () => {
    const url = 'https://github.com/owner/repo/issues/42'
    const prompt = buildRealizePrompt({ kind: 'github', subtype: 'issue', url })
    assert.match(prompt, /gh issue view/)
    assert.match(prompt, /--comments/)
    assert.ok(prompt.includes(url))
  })

  it('uses gh pr view for GitHub pull requests', () => {
    const prompt = buildRealizePrompt({ kind: 'github', subtype: 'pr', url: 'https://github.com/owner/repo/pull/7' })
    assert.match(prompt, /gh pr view/)
  })

  it('tells the agent to fetch a generic URL', () => {
    const prompt = buildRealizePrompt({ kind: 'url', url: 'https://example.com/spec' })
    assert.match(prompt, /Fetch and read it/)
    assert.ok(prompt.includes('https://example.com/spec'))
  })

  it('always includes the ownership instructions', () => {
    const prompt = buildRealizePrompt({ kind: 'file', path: 'x' })
    assert.match(prompt, /full ownership/)
    assert.match(prompt, /concise summary/)
  })

  it('delegates to the workflow skills, in lifecycle order', () => {
    const prompt = buildRealizePrompt({ kind: 'file', path: 'x' })
    /* Match the bolded phase markers, not bare words: "test" would otherwise
       also match "testable" in the specify phase and "tests" in the code phase. */
    const order = ['specify', 'design', 'elaborate', 'plan', 'code', 'test', 'review']
    let last = -1
    for (const skill of order) {
      const at = prompt.indexOf(`**${skill}**`)
      assert.ok(at > last, `expected **${skill}** to appear after the previous phase`)
      last = at
    }
  })

  it('defines done as evidence against acceptance criteria', () => {
    const prompt = buildRealizePrompt({ kind: 'file', path: 'x' })
    assert.match(prompt, /acceptance criteri/i)
    assert.match(prompt, /evidence/i)
  })

  it('tells the agent to follow the project conventions', () => {
    const prompt = buildRealizePrompt({ kind: 'file', path: 'x' })
    assert.match(prompt, /AGENTS\.md/)
  })
})
