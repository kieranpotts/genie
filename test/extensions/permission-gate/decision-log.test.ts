import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DecisionLog, formatDecision, makeDecision } from '../../../src/extensions/permission-gate/decision-log.ts'

describe('formatDecision', () => {
  it('renders a newline-terminated JSON line with fixed key order', () => {
    const line = formatDecision({ ts: 'T', tool: 'write', status: 'approved', reason: 'user approved', detail: 'write: /p/x' })
    assert.equal(line, '{"ts":"T","tool":"write","status":"approved","reason":"user approved","detail":"write: /p/x"}\n')
  })

  it('omits detail when absent', () => {
    const line = formatDecision({ ts: 'T', tool: 'bash', status: 'denied', reason: 'timed out' })
    assert.equal(line.includes('detail'), false)
  })
})

describe('makeDecision', () => {
  it('stamps the supplied time', () => {
    const d = makeDecision('bash', 'denied', 'user rejected', 'bash: ls', new Date('2026-06-04T00:00:00Z'))
    assert.deepEqual(d, { ts: '2026-06-04T00:00:00.000Z', tool: 'bash', status: 'denied', reason: 'user rejected', detail: 'bash: ls' })
  })
})

describe('DecisionLog.record', () => {
  it('appends one JSON line per decision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'permgate-'))
    const file = join(dir, 'permissions.jsonl')
    try {
      const log = new DecisionLog(file)
      await log.record(makeDecision('write', 'approved', 'user approved', 'write: /p/a', new Date('2026-01-01T00:00:00Z')))
      await log.record(makeDecision('bash', 'denied', 'user rejected', 'bash: rm', new Date('2026-01-01T00:00:01Z')))
      const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
      assert.equal(lines.length, 2)
      assert.equal(JSON.parse(lines[0]).status, 'approved')
      assert.equal(JSON.parse(lines[1]).tool, 'bash')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not throw when the target path is unwritable', async () => {
    const log = new DecisionLog('/nonexistent-dir/permissions.jsonl')
    await log.record(makeDecision('write', 'denied', 'x'))
    assert.ok(true)
  })
})
