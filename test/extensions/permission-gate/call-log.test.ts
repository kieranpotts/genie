import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CallLog, formatRecord, makeRecord } from '../../../src/extensions/permission-gate/call-log.ts'

describe('formatRecord', () => {
  it('renders a newline-terminated JSON line with fixed key order', () => {
    const line = formatRecord({
      ts: 'T', tool: 'write', outcome: 'allowed', confirmation: 'approved', detail: 'write: /p/x',
    })
    assert.equal(
      line,
      '{"ts":"T","tool":"write","outcome":"allowed","confirmation":"approved","detail":"write: /p/x"}\n'
    )
  })

  it('omits detail when absent', () => {
    const line = formatRecord({ ts: 'T', tool: 'mcp_write_file', outcome: 'blocked', confirmation: 'timeout' })
    assert.equal(line.includes('detail'), false)
  })

  it('omits reason on an allowed call — the two axes say all there is to say', () => {
    const line = formatRecord({ ts: 'T', tool: 'mcp_read_file', outcome: 'allowed', confirmation: 'not-required' })
    assert.equal(line.includes('reason'), false)
  })

  it('carries reason on a blocked call, after detail', () => {
    const line = formatRecord({
      ts: 'T',
      tool: 'mcp_read_file',
      outcome: 'blocked',
      confirmation: 'not-offered',
      detail: 'mcp_read_file: /workspace/.env',
      reason: 'sensitive file refused: .env',
    })
    assert.match(line, /"detail":"[^"]*","reason":"sensitive file refused: \.env"\}\n$/)
  })
})

describe('makeRecord', () => {
  it('stamps the supplied time', () => {
    const r = makeRecord(
      { tool: 'mcp_list_directory', outcome: 'allowed', confirmation: 'not-required', detail: 'mcp_list_directory: /w' },
      new Date('2026-06-04T00:00:00Z')
    )
    assert.deepEqual(r, {
      ts: '2026-06-04T00:00:00.000Z',
      tool: 'mcp_list_directory',
      outcome: 'allowed',
      confirmation: 'not-required',
      detail: 'mcp_list_directory: /w',
    })
  })
})

/* The two axes exist so that a reviewer can separate a policy refusal from an
   operator's rejection by field, not by parsing the prose in `reason`. These
   assert that separation holds for the pairings the gate actually emits. */
describe('the two axes distinguish the reasons a call did not run', () => {
  const at = new Date('2026-06-04T00:00:00Z')

  it('a sensitive-file refusal is blocked with no approval path', () => {
    const r = makeRecord(
      { tool: 'mcp_read_file', outcome: 'blocked', confirmation: 'not-offered', reason: 'x' }, at
    )
    assert.equal(r.outcome, 'blocked')
    assert.equal(r.confirmation, 'not-offered')
  })

  it('an operator rejection is blocked after being offered', () => {
    const r = makeRecord({ tool: 'mcp_write_file', outcome: 'blocked', confirmation: 'rejected', reason: 'x' }, at)
    assert.equal(r.confirmation, 'rejected')
  })

  it('a read-only pass-through is allowed without a prompt', () => {
    const r = makeRecord({ tool: 'mcp_read_file', outcome: 'allowed', confirmation: 'not-required' }, at)
    assert.equal(r.outcome, 'allowed')
    assert.equal(r.confirmation, 'not-required')
  })
})

describe('CallLog.record', () => {
  it('appends one JSON line per call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'permgate-'))
    const file = join(dir, 'calls.jsonl')
    try {
      const log = new CallLog(file)
      await log.record(makeRecord(
        { tool: 'mcp_read_file', outcome: 'allowed', confirmation: 'not-required', detail: 'mcp_read_file: /p/a' },
        new Date('2026-01-01T00:00:00Z')
      ))
      await log.record(makeRecord(
        { tool: 'mcp_write_file', outcome: 'blocked', confirmation: 'rejected', reason: 'user rejected' },
        new Date('2026-01-01T00:00:01Z')
      ))
      const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
      assert.equal(lines.length, 2)
      assert.equal(JSON.parse(lines[0]).outcome, 'allowed')
      assert.equal(JSON.parse(lines[0]).confirmation, 'not-required')
      assert.equal(JSON.parse(lines[1]).tool, 'mcp_write_file')
      assert.equal(JSON.parse(lines[1]).outcome, 'blocked')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('creates the parent directory if it does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'permgate-'))
    const file = join(dir, 'nested', 'deeper', 'calls.jsonl')
    try {
      const log = new CallLog(file)
      await log.record(makeRecord({ tool: 'mcp_write_file', outcome: 'allowed', confirmation: 'approved' }))
      const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
      assert.equal(lines.length, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not throw when the target path is unwritable', async () => {
    const log = new CallLog('/nonexistent-dir/permission-gate/calls.jsonl')
    await log.record(makeRecord({ tool: 'mcp_write_file', outcome: 'blocked', confirmation: 'timeout', reason: 'x' }))
    assert.ok(true)
  })
})
