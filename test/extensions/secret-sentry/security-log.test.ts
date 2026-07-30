import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SecurityLog,
  formatRecord,
  makeRecord,
} from '../../../src/extensions/secret-sentry/security-log.ts'

describe('formatRecord — a blocked call', () => {
  it('renders a newline-terminated JSON line with fixed key order', () => {
    const line = formatRecord({
      ts: 'T',
      kind: 'blocked',
      id: 'tc_1',
      tool: 'mcp_read_file',
      path: '/workspace/.env',
      reason: 'mcp_read_file blocked: sensitive file refused: .env',
    })
    assert.equal(
      line,
      '{"ts":"T","kind":"blocked","id":"tc_1","tool":"mcp_read_file",' +
      '"path":"/workspace/.env","reason":"mcp_read_file blocked: sensitive file refused: .env"}\n'
    )
  })

  it('carries no field beyond ts, kind, id, tool, path and reason', () => {
    const line = formatRecord({
      ts: 'T', kind: 'blocked', id: 'tc_1', tool: 'mcp_read_file', path: '/a/.env', reason: 'x',
    })
    assert.deepEqual(
      Object.keys(JSON.parse(line) as Record<string, unknown>),
      ['ts', 'kind', 'id', 'tool', 'path', 'reason']
    )
  })
})

describe('formatRecord — a redaction', () => {
  it('renders the count and the rules that fired, and nothing else', () => {
    const line = formatRecord({
      ts: 'T',
      kind: 'redaction',
      id: 'tc_5',
      tool: 'mcp_read_file',
      redactions: 2,
      rules: ['aws-access-key-id', 'github-token'],
    })
    assert.equal(
      line,
      '{"ts":"T","kind":"redaction","id":"tc_5","tool":"mcp_read_file",' +
      '"redactions":2,"rules":["aws-access-key-id","github-token"]}\n'
    )
    assert.deepEqual(
      Object.keys(JSON.parse(line) as Record<string, unknown>),
      ['ts', 'kind', 'id', 'tool', 'redactions', 'rules']
    )
  })

  /* This is the sharpest case of the no-content rule in this whole log: the
     record is specifically about a secret, so it must never carry the value,
     its length, or its position — only that a rule fired and which one. */
  it('never carries the matched value in any field', () => {
    const secret = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz'
    const line = formatRecord({
      ts: 'T', kind: 'redaction', id: 'tc_1', tool: 'mcp_read_file', redactions: 1, rules: ['github-token'],
    })
    assert.equal(line.includes(secret), false)
  })
})

describe('makeRecord', () => {
  it('stamps the supplied time on a blocked record', () => {
    const r = makeRecord(
      { kind: 'blocked', id: 'tc_1', tool: 'mcp_read_file', path: '/a/.env', reason: 'x' },
      new Date('2026-06-04T00:00:00Z')
    )
    assert.deepEqual(r, {
      ts: '2026-06-04T00:00:00.000Z',
      kind: 'blocked',
      id: 'tc_1',
      tool: 'mcp_read_file',
      path: '/a/.env',
      reason: 'x',
    })
  })

  it('stamps the supplied time on a redaction record', () => {
    const r = makeRecord(
      { kind: 'redaction', id: 'tc_2', tool: 'mcp_read_file', redactions: 1, rules: ['github-token'] },
      new Date('2026-06-04T00:00:01Z')
    )
    assert.deepEqual(r, {
      ts: '2026-06-04T00:00:01.000Z',
      kind: 'redaction',
      id: 'tc_2',
      tool: 'mcp_read_file',
      redactions: 1,
      rules: ['github-token'],
    })
  })
})

describe('SecurityLog.record', () => {
  it('appends one JSON line per security decision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'secret-sentry-security-'))
    const file = join(dir, 'security.jsonl')
    try {
      const log = new SecurityLog(file)
      await log.record(makeRecord(
        { kind: 'blocked', id: 'tc_1', tool: 'mcp_read_file', path: '/a/.env', reason: 'x' },
        new Date('2026-01-01T00:00:00Z')
      ))
      await log.record(makeRecord(
        { kind: 'redaction', id: 'tc_2', tool: 'mcp_read_file', redactions: 1, rules: ['github-token'] },
        new Date('2026-01-01T00:00:01Z')
      ))
      const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
      assert.equal(lines.length, 2)
      assert.equal(JSON.parse(lines[0]!).kind, 'blocked')
      assert.equal(JSON.parse(lines[1]!).kind, 'redaction')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('creates the parent directory if it does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'secret-sentry-security-'))
    const file = join(dir, 'nested', 'deeper', 'security.jsonl')
    try {
      const log = new SecurityLog(file)
      await log.record(makeRecord({ kind: 'blocked', id: 'tc_1', tool: 'mcp_write_file', path: '/a/.env', reason: 'x' }))
      const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
      assert.equal(lines.length, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not throw when the target path is unwritable', async () => {
    const log = new SecurityLog('/nonexistent-dir/secret-sentry/security.jsonl')
    await log.record(makeRecord({ kind: 'blocked', id: 'tc_1', tool: 'mcp_write_file', path: '/a/.env', reason: 'x' }))
    assert.ok(true)
  })
})
