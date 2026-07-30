import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  findSensitiveArgument,
  isSensitiveFile,
  pathArguments,
} from '../../../src/extensions/secret-sentry/sensitive-files.ts'

describe('isSensitiveFile', () => {
  for (const name of ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519.pub', 'server.pem', 'private.key', 'cert.p12', 'cert.pfx', '.netrc', '.npmrc', '.pgpass', '.git-credentials', 'credentials']) {
    it(`refuses ${name}`, () => assert.equal(isSensitiveFile(`/workspace/${name}`), true))
  }

  for (const name of ['index.ts', 'README.md', 'env.example', 'keyboard.ts', 'package.json', 'credentials.md']) {
    it(`allows ${name}`, () => assert.equal(isSensitiveFile(`/workspace/${name}`), false))
  }

  it('matches case-insensitively', () => {
    assert.equal(isSensitiveFile('/workspace/ID_RSA'), true)
    assert.equal(isSensitiveFile('/workspace/Server.PEM'), true)
  })

  it('matches on the basename, not the directory', () => {
    assert.equal(isSensitiveFile('/workspace/.env/notes.txt'), false)
    assert.equal(isSensitiveFile('/home/pi/deep/nested/.env'), true)
  })

  it('accepts a bare filename with no directory', () => {
    assert.equal(isSensitiveFile('.env'), true)
  })
})

describe('pathArguments', () => {
  it('collects a single path argument', () => {
    assert.deepEqual(pathArguments({ path: '/workspace/x.ts' }), ['/workspace/x.ts'])
  })

  it('collects an array of paths (read_multiple_files)', () => {
    assert.deepEqual(
      pathArguments({ paths: ['/a/x.ts', '/a/y.ts'] }),
      ['/a/x.ts', '/a/y.ts']
    )
  })

  it('collects both ends of a move (move_file)', () => {
    assert.deepEqual(
      pathArguments({ source: '/a/x.ts', destination: '/a/y.ts' }),
      ['/a/x.ts', '/a/y.ts']
    )
  })

  /* `command` was tokenised when the agent had a `bash` tool. It has none now,
     so the key is treated like any other unrecognised one. See TODO.md. */
  it('ignores a command argument, which no tool takes', () => {
    assert.deepEqual(pathArguments({ command: 'cat id_rsa' }), [])
  })

  it('ignores non-string and non-path keys', () => {
    assert.deepEqual(pathArguments({ path: '/a/x.ts', pattern: '*.key', count: 3 }), ['/a/x.ts'])
  })

  it('returns nothing for an input with no path-shaped arguments', () => {
    assert.deepEqual(pathArguments({}), [])
  })
})

describe('findSensitiveArgument', () => {
  it('finds a sensitive path argument', () => {
    assert.equal(findSensitiveArgument({ path: '/workspace/.env' }), '/workspace/.env')
  })

  it('finds a sensitive entry inside an array of paths', () => {
    assert.equal(
      findSensitiveArgument({ paths: ['/a/ok.ts', '/a/id_rsa'] }),
      '/a/id_rsa'
    )
  })

  it('finds a sensitive destination as well as a source', () => {
    assert.equal(
      findSensitiveArgument({ source: '/a/ok.ts', destination: '/a/deploy.pem' }),
      '/a/deploy.pem'
    )
  })

  it('does not inspect a command argument, which no tool takes', () => {
    assert.equal(findSensitiveArgument({ command: 'cat /home/pi/.netrc' }), undefined)
  })

  it('does NOT fire on a search pattern that looks like a key file', () => {
    // `search_files` takes `pattern`, which is not a path — blocking it would
    // deny a legitimate search for key files by name.
    assert.equal(findSensitiveArgument({ path: '/workspace', pattern: '*.key' }), undefined)
  })

  it('returns undefined for an ordinary call', () => {
    assert.equal(findSensitiveArgument({ path: '/workspace/src/x.ts' }), undefined)
  })

  it('returns undefined for an empty input', () => {
    assert.equal(findSensitiveArgument({}), undefined)
  })
})
