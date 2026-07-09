import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AuditLog, formatEntry, makeEntry } from '../../../src/extensions/audited-tools/audit-log.ts'

describe('formatEntry', () => {
  it('renders a newline-terminated JSON line with fixed key order', () => {
    const line = formatEntry({ ts: '2026-01-01T00:00:00.000Z', tool: 'read', status: 'allowed', path: '/p/x' })
    assert.equal(line, '{"ts":"2026-01-01T00:00:00.000Z","tool":"read","status":"allowed","path":"/p/x"}\n')
  })

  it('omits absent optional fields', () => {
    const line = formatEntry({ ts: 'T', tool: 'ls', status: 'denied', reason: 'nope' })
    assert.equal(line, '{"ts":"T","tool":"ls","status":"denied","reason":"nope"}\n')
    assert.equal(line.includes('path'), false)
  })
})

describe('makeEntry', () => {
  it('stamps the supplied time and carries fields', () => {
    const now = new Date('2026-06-04T12:00:00.000Z')
    const e = makeEntry('write', 'allowed', { path: '/p/y' }, now)
    assert.deepEqual(e, { ts: '2026-06-04T12:00:00.000Z', tool: 'write', status: 'allowed', path: '/p/y' })
  })
})

describe('AuditLog.record', () => {
  it('appends one JSON line per record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const file = join(dir, 'audit.jsonl')
    try {
      const log = new AuditLog(file)
      await log.record(makeEntry('read', 'allowed', { path: '/p/a' }, new Date('2026-01-01T00:00:00Z')))
      await log.record(makeEntry('write', 'denied', { path: '/p/.env', reason: 'sensitive' }, new Date('2026-01-01T00:00:01Z')))
      const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
      assert.equal(lines.length, 2)
      assert.equal(JSON.parse(lines[0]).status, 'allowed')
      assert.equal(JSON.parse(lines[1]).reason, 'sensitive')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('creates the parent directory if it does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const file = join(dir, 'nested', 'deeper', 'audit.jsonl')
    try {
      const log = new AuditLog(file)
      await log.record(makeEntry('read', 'allowed', { path: '/p/a' }))
      const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
      assert.equal(lines.length, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not throw when the target path is unwritable', async () => {
    const log = new AuditLog('/nonexistent-dir/audited-tools/audit.jsonl')
    await log.record(makeEntry('read', 'allowed', { path: '/p/a' }))
    // Reaching here without throwing is the assertion.
    assert.ok(true)
  })
})
