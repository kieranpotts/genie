import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { authorize, checkPath, isSensitiveFile } from '../../../src/extensions/audited-tools/path-guard.ts'

const ROOT = '/projects/active'

describe('checkPath — allowed', () => {
  it('allows the root itself', () => {
    const d = checkPath(ROOT, '/projects/active')
    assert.equal(d.allowed, true)
    assert.equal(d.allowed && d.path, '/projects/active')
  })

  it('allows a file directly under the root', () => {
    const d = checkPath(ROOT, '/projects/active/src/x.ts')
    assert.equal(d.allowed, true)
    assert.equal(d.allowed && d.path, '/projects/active/src/x.ts')
  })

  it('resolves a relative path against the root', () => {
    const d = checkPath(ROOT, 'src/x.ts')
    assert.equal(d.allowed, true)
    assert.equal(d.allowed && d.path, '/projects/active/src/x.ts')
  })

  it('normalises a benign inner traversal that stays within root', () => {
    const d = checkPath(ROOT, '/projects/active/src/../lib/y.ts')
    assert.equal(d.allowed, true)
    assert.equal(d.allowed && d.path, '/projects/active/lib/y.ts')
  })
})

describe('checkPath — denied (traversal)', () => {
  it('denies a parent-escaping traversal', () => {
    const d = checkPath(ROOT, '/projects/active/../../etc/passwd')
    assert.equal(d.allowed, false)
  })

  it('denies a relative traversal that escapes', () => {
    const d = checkPath(ROOT, '../secrets')
    assert.equal(d.allowed, false)
  })

  it('denies an absolute path outside the root', () => {
    const d = checkPath(ROOT, '/etc/passwd')
    assert.equal(d.allowed, false)
  })
})

describe('checkPath — denied (prefix collision)', () => {
  it('denies a sibling sharing the root as a string prefix', () => {
    // `/projects/active-evil` starts with `/projects/active` as a string but is
    // NOT inside it — the classic prefix-collision attack.
    const d = checkPath(ROOT, '/projects/active-evil/x')
    assert.equal(d.allowed, false)
  })

  it('denies the prefix-collision sibling directory itself', () => {
    const d = checkPath(ROOT, '/projects/active-evil')
    assert.equal(d.allowed, false)
  })
})

describe('isSensitiveFile', () => {
  for (const name of ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519.pub', 'server.pem', 'private.key', 'cert.p12', '.netrc', '.npmrc', '.git-credentials', 'credentials']) {
    it(`refuses ${name}`, () => assert.equal(isSensitiveFile(`/projects/active/${name}`), true))
  }

  for (const name of ['index.ts', 'README.md', 'env.example', 'keyboard.ts', 'package.json']) {
    it(`allows ${name}`, () => assert.equal(isSensitiveFile(`/projects/active/${name}`), false))
  }
})

describe('authorize — combined gate', () => {
  it('allows an in-root non-sensitive file', () => {
    assert.equal(authorize(ROOT, '/projects/active/src/x.ts').allowed, true)
  })

  it('denies a sensitive file even when inside the root', () => {
    const d = authorize(ROOT, '/projects/active/.env')
    assert.equal(d.allowed, false)
    assert.equal(d.allowed === false && /sensitive/.test(d.reason), true)
  })

  it('denies an out-of-root path before considering sensitivity', () => {
    assert.equal(authorize(ROOT, '/etc/passwd').allowed, false)
  })
})
