import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isUrl, parseGitHubTarget, parseGitHubBlob, resolveSource } from '../../src/realize/source.ts'

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

  it('canonicalizes an issue deep link, dropping the fragment', () => {
    assert.deepEqual(
      parseGitHubTarget('https://github.com/owner/repo/issues/42#issuecomment-1'),
      { type: 'issue', url: 'https://github.com/owner/repo/issues/42' }
    )
  })

  it('canonicalizes a PR deep link, dropping a trailing path', () => {
    assert.deepEqual(
      parseGitHubTarget('https://github.com/owner/repo/pull/7/files'),
      { type: 'pr', url: 'https://github.com/owner/repo/pull/7' }
    )
  })

  it('drops query strings', () => {
    assert.deepEqual(
      parseGitHubTarget('https://github.com/owner/repo/issues/42?foo=bar'),
      { type: 'issue', url: 'https://github.com/owner/repo/issues/42' }
    )
  })

  it('normalizes the pulls alias to pull', () => {
    assert.deepEqual(
      parseGitHubTarget('https://github.com/owner/repo/pulls/7'),
      { type: 'pr', url: 'https://github.com/owner/repo/pull/7' }
    )
  })

  it('normalizes the www host to github.com', () => {
    assert.deepEqual(
      parseGitHubTarget('https://www.github.com/owner/repo/issues/42'),
      { type: 'issue', url: 'https://github.com/owner/repo/issues/42' }
    )
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

describe('parseGitHubBlob', () => {
  it('rewrites a blob URL to its raw form', () => {
    assert.equal(
      parseGitHubBlob('https://github.com/owner/repo/blob/main/docs/spec.md'),
      'https://raw.githubusercontent.com/owner/repo/main/docs/spec.md'
    )
  })

  it('drops a line-number fragment and query', () => {
    assert.equal(
      parseGitHubBlob('https://github.com/owner/repo/blob/main/x.ts?plain=1#L5-L9'),
      'https://raw.githubusercontent.com/owner/repo/main/x.ts'
    )
  })

  it('returns null for non-blob GitHub URLs', () => {
    assert.equal(parseGitHubBlob('https://github.com/owner/repo/issues/42'), null)
    assert.equal(parseGitHubBlob('https://github.com/owner/repo/discussions/3'), null)
  })

  it('returns null for non-GitHub URLs and non-URLs', () => {
    assert.equal(parseGitHubBlob('https://example.com/owner/repo/blob/main/x'), null)
    assert.equal(parseGitHubBlob('./x'), null)
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

  it('resolves a GitHub blob URL to a raw url', async () => {
    /* A blob is not an issue/PR, so `gh` is never consulted — deterministic. */
    assert.deepEqual(
      await resolveSource('https://github.com/owner/repo/blob/main/spec.md'),
      { kind: 'url', url: 'https://raw.githubusercontent.com/owner/repo/main/spec.md' }
    )
  })
})
