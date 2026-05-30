import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isUrl, parseGitHubTarget, resolveSource } from '../../src/realize/source.ts'

describe('isUrl', () => {
  it('recognizes http and https URLs', () => {
    assert.equal(isUrl('http://example.com'), true)
    assert.equal(isUrl('https://example.com/a/b'), true)
    assert.equal(isUrl('HTTPS://EXAMPLE.COM'), true)
  })

  it('rejects non-URL sources', () => {
    assert.equal(isUrl('./spec.md'), false)
    assert.equal(isUrl('/abs/path/spec'), false)
    assert.equal(isUrl('ftp://example.com'), false)
    assert.equal(isUrl('spec.md'), false)
  })
})

describe('parseGitHubTarget', () => {
  it('parses issue URLs', () => {
    assert.deepEqual(
      parseGitHubTarget('https://github.com/owner/repo/issues/42'),
      { type: 'issue', url: 'https://github.com/owner/repo/issues/42' }
    )
  })

  it('parses pull request URLs', () => {
    assert.deepEqual(
      parseGitHubTarget('https://github.com/owner/repo/pull/7'),
      { type: 'pr', url: 'https://github.com/owner/repo/pull/7' }
    )
  })

  it('ignores trailing path and query segments', () => {
    const target = parseGitHubTarget('https://github.com/owner/repo/issues/42#issuecomment-1')
    assert.equal(target?.type, 'issue')
  })

  it('returns null for non-issue GitHub URLs', () => {
    assert.equal(parseGitHubTarget('https://github.com/owner/repo'), null)
    assert.equal(parseGitHubTarget('https://github.com/owner/repo/blob/main/x.ts'), null)
  })

  it('returns null for non-GitHub URLs and non-URLs', () => {
    assert.equal(parseGitHubTarget('https://example.com/owner/repo/issues/1'), null)
    assert.equal(parseGitHubTarget('./issues/1'), null)
  })
})

describe('resolveSource', () => {
  it('classifies an existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realize-'))
    try {
      const file = join(dir, 'spec.md')
      await writeFile(file, '# Spec\n')
      assert.deepEqual(await resolveSource(file), { kind: 'file', path: file })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('classifies an existing directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realize-'))
    try {
      assert.deepEqual(await resolveSource(dir), { kind: 'directory', path: dir })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('throws for a missing path', async () => {
    await assert.rejects(resolveSource(join(tmpdir(), 'realize-does-not-exist-xyz')))
  })

  it('treats a non-GitHub URL as a generic url', async () => {
    /* Not a GitHub issue/PR, so `gh` is never consulted — the result is
       deterministic regardless of whether `gh` is installed. */
    assert.deepEqual(
      await resolveSource('https://example.com/spec'),
      { kind: 'url', url: 'https://example.com/spec' }
    )
  })
})
