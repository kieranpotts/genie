import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CallLog,
  formatRecord,
  makeRecord,
  type CallAttemptRecord,
  type CallResultRecord,
  type TurnRecord,
} from '../../../src/extensions/permission-gate/call-log.ts'

describe('formatRecord — the attempt line', () => {
  it('renders a newline-terminated JSON line with fixed key order', () => {
    const line = formatRecord({
      ts: 'T',
      phase: 'call',
      id: 'tc_1',
      tool: 'write',
      outcome: 'allowed',
      confirmation: 'approved',
      detail: 'write: /p/x',
    })
    assert.equal(
      line,
      '{"ts":"T","phase":"call","id":"tc_1","tool":"write",' +
      '"outcome":"allowed","confirmation":"approved","detail":"write: /p/x"}\n'
    )
  })

  it('omits detail when absent', () => {
    const line = formatRecord({
      ts: 'T', phase: 'call', id: 'tc_1', tool: 'mcp_write_file', outcome: 'blocked', confirmation: 'timeout',
    })
    assert.equal(line.includes('detail'), false)
  })

  it('omits reason on an allowed call — the two axes say all there is to say', () => {
    const line = formatRecord({
      ts: 'T', phase: 'call', id: 'tc_1', tool: 'mcp_read_file', outcome: 'allowed', confirmation: 'not-required',
    })
    assert.equal(line.includes('reason'), false)
  })

  it('carries reason on a blocked call, after detail', () => {
    const line = formatRecord({
      ts: 'T',
      phase: 'call',
      id: 'tc_1',
      tool: 'mcp_read_file',
      outcome: 'blocked',
      confirmation: 'not-offered',
      detail: 'mcp_read_file: /workspace/.env',
      reason: 'sensitive file refused: .env',
    })
    assert.match(line, /"detail":"[^"]*","reason":"sensitive file refused: \.env"\}\n$/)
  })
})

describe('formatRecord — the result line', () => {
  it('renders the verdict and nothing else', () => {
    const line = formatRecord({ ts: 'T', phase: 'result', id: 'tc_1', tool: 'mcp_read_file', result: 'ok' })
    assert.equal(line, '{"ts":"T","phase":"result","id":"tc_1","tool":"mcp_read_file","result":"ok"}\n')
  })

  /* The result line must never become a second copy of the file the agent read.
     This asserts the shape is closed: only the five known keys, so a future
     edit that spreads the tool_result event into the record fails here. */
  it('carries no field beyond ts, phase, id, tool and result', () => {
    const line = formatRecord({ ts: 'T', phase: 'result', id: 'tc_1', tool: 'mcp_read_file', result: 'error' })
    assert.deepEqual(
      Object.keys(JSON.parse(line) as Record<string, unknown>),
      ['ts', 'phase', 'id', 'tool', 'result']
    )
  })
})

describe('formatRecord — the turn line', () => {
  it('renders the boundary with fixed key order', () => {
    const line = formatRecord({ ts: 'T', kind: 'turn_start', turn: 7, session: 's-01' })
    assert.equal(line, '{"ts":"T","kind":"turn_start","turn":7,"session":"s-01"}\n')
  })

  it('omits session when the harness gave no id', () => {
    const line = formatRecord({ ts: 'T', kind: 'turn_start', turn: 1 })
    assert.equal(line, '{"ts":"T","kind":"turn_start","turn":1}\n')
  })

  /* The turn line must never grow into a record of what the turn was ABOUT:
     `before_agent_start` hands the handler the prompt and the whole system
     prompt. This asserts the shape is closed, mirroring the result line. */
  it('carries no field beyond ts, kind, turn and session', () => {
    const line = formatRecord({ ts: 'T', kind: 'turn_start', turn: 3, session: 's-01' })
    assert.deepEqual(
      Object.keys(JSON.parse(line) as Record<string, unknown>),
      ['ts', 'kind', 'turn', 'session']
    )
  })

  /* The runbook's jq recipes all select on `.phase`. A turn line has no such
     field, so `.phase` yields null and matches neither "call" nor "result" —
     which is what keeps every documented query returning what it did before this
     line kind existed. */
  it('carries no phase, so the documented queries skip it', () => {
    const parsed = JSON.parse(formatRecord({ ts: 'T', kind: 'turn_start', turn: 1 })) as Record<string, unknown>
    assert.equal('phase' in parsed, false)
  })
})

describe('formatRecord — the provider-request line', () => {
  it('renders the shape with fixed key order', () => {
    const line = formatRecord({
      ts: 'T',
      kind: 'provider_request',
      model: 'computer-programmer',
      messages: 34,
      approx_bytes: 18422,
    })
    assert.equal(
      line,
      '{"ts":"T","kind":"provider_request","model":"computer-programmer",' +
      '"messages":34,"approx_bytes":18422}\n'
    )
  })

  /* The line this rule matters most on: the event behind it carries the whole
     conversation. Asserting the key set is closed is what stops a future edit
     spreading the payload into the record. */
  it('carries no field beyond ts, kind, model, messages and approx_bytes', () => {
    const line = formatRecord({
      ts: 'T', kind: 'provider_request', model: 'm', messages: 1, approx_bytes: 2,
    })
    assert.deepEqual(
      Object.keys(JSON.parse(line) as Record<string, unknown>),
      ['ts', 'kind', 'model', 'messages', 'approx_bytes']
    )
  })

  it('omits the fields the payload did not carry', () => {
    const line = formatRecord({ ts: 'T', kind: 'provider_request', approx_bytes: 9 })
    assert.equal(line, '{"ts":"T","kind":"provider_request","approx_bytes":9}\n')
  })

  it('carries no phase, so the documented queries skip it', () => {
    const parsed = JSON.parse(
      formatRecord({ ts: 'T', kind: 'provider_request', model: 'm' })
    ) as Record<string, unknown>
    assert.equal('phase' in parsed, false)
  })

  /* Two `kind` values now share the field, and they must stay distinguishable:
     a query selecting turns must not match model requests. */
  it('is distinguishable from a turn line by kind alone', () => {
    const turn = JSON.parse(formatRecord({ ts: 'T', kind: 'turn_start', turn: 1 })) as Record<string, unknown>
    const request = JSON.parse(formatRecord({ ts: 'T', kind: 'provider_request' })) as Record<string, unknown>
    assert.equal(turn.kind, 'turn_start')
    assert.equal(request.kind, 'provider_request')
    assert.equal('turn' in request, false)
  })
})

describe('makeRecord', () => {
  it('stamps the supplied time on an attempt', () => {
    const r = makeRecord(
      {
        phase: 'call',
        id: 'tc_9',
        tool: 'mcp_list_directory',
        outcome: 'allowed',
        confirmation: 'not-required',
        detail: 'mcp_list_directory: /w',
      },
      new Date('2026-06-04T00:00:00Z')
    )
    assert.deepEqual(r, {
      ts: '2026-06-04T00:00:00.000Z',
      phase: 'call',
      id: 'tc_9',
      tool: 'mcp_list_directory',
      outcome: 'allowed',
      confirmation: 'not-required',
      detail: 'mcp_list_directory: /w',
    })
  })

  it('stamps the supplied time on a turn boundary', () => {
    const r = makeRecord(
      { kind: 'turn_start', turn: 2, session: 's-01' },
      new Date('2026-06-04T00:00:02Z')
    ) as TurnRecord
    assert.deepEqual(r, {
      ts: '2026-06-04T00:00:02.000Z',
      kind: 'turn_start',
      turn: 2,
      session: 's-01',
    })
  })

  it('stamps the supplied time on a result', () => {
    const r = makeRecord(
      { phase: 'result', id: 'tc_9', tool: 'mcp_list_directory', result: 'ok' },
      new Date('2026-06-04T00:00:01Z')
    )
    assert.deepEqual(r, {
      ts: '2026-06-04T00:00:01.000Z',
      phase: 'result',
      id: 'tc_9',
      tool: 'mcp_list_directory',
      result: 'ok',
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
      {
        phase: 'call',
        id: 'tc_1',
        tool: 'mcp_read_file',
        outcome: 'blocked',
        confirmation: 'not-offered',
        reason: 'x',
      }, at
    ) as CallAttemptRecord
    assert.equal(r.outcome, 'blocked')
    assert.equal(r.confirmation, 'not-offered')
  })

  it('an operator rejection is blocked after being offered', () => {
    const r = makeRecord({
      phase: 'call', id: 'tc_2', tool: 'mcp_write_file', outcome: 'blocked', confirmation: 'rejected', reason: 'x',
    }, at) as CallAttemptRecord
    assert.equal(r.confirmation, 'rejected')
  })

  it('a read-only pass-through is allowed without a prompt', () => {
    const r = makeRecord({
      phase: 'call', id: 'tc_3', tool: 'mcp_read_file', outcome: 'allowed', confirmation: 'not-required',
    }, at) as CallAttemptRecord
    assert.equal(r.outcome, 'allowed')
    assert.equal(r.confirmation, 'not-required')
  })
})

/* The gap the result line closes: the gate admits a call, the MCP server then
   refuses it. Before the second line existed, the trail asserted a read that
   never happened. */
describe('attempt and result are joined by id', () => {
  const at = new Date('2026-06-04T00:00:00Z')

  it('an allowed attempt whose result errored is legible as a refusal downstream', () => {
    const attempt = makeRecord({
      phase: 'call',
      id: 'tc_42',
      tool: 'mcp_read_file',
      outcome: 'allowed',
      confirmation: 'not-required',
      detail: 'mcp_read_file: /workspace/../etc/passwd',
    }, at) as CallAttemptRecord
    const result = makeRecord({
      phase: 'result', id: 'tc_42', tool: 'mcp_read_file', result: 'error',
    }, at) as CallResultRecord

    assert.equal(attempt.id, result.id)
    assert.equal(attempt.outcome, 'allowed')
    assert.equal(result.result, 'error')
  })
})

describe('CallLog.record', () => {
  it('appends one JSON line per observation, two per completed call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'permgate-'))
    const file = join(dir, 'calls.jsonl')
    try {
      const log = new CallLog(file)
      await log.record(makeRecord(
        {
          phase: 'call',
          id: 'tc_1',
          tool: 'mcp_read_file',
          outcome: 'allowed',
          confirmation: 'not-required',
          detail: 'mcp_read_file: /p/a',
        },
        new Date('2026-01-01T00:00:00Z')
      ))
      await log.record(makeRecord(
        { phase: 'result', id: 'tc_1', tool: 'mcp_read_file', result: 'ok' },
        new Date('2026-01-01T00:00:01Z')
      ))
      await log.record(makeRecord(
        {
          phase: 'call',
          id: 'tc_2',
          tool: 'mcp_write_file',
          outcome: 'blocked',
          confirmation: 'rejected',
          reason: 'user rejected',
        },
        new Date('2026-01-01T00:00:02Z')
      ))
      const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
      assert.equal(lines.length, 3)
      assert.equal(JSON.parse(lines[0]).phase, 'call')
      assert.equal(JSON.parse(lines[0]).outcome, 'allowed')
      assert.equal(JSON.parse(lines[1]).phase, 'result')
      assert.equal(JSON.parse(lines[1]).id, 'tc_1')
      assert.equal(JSON.parse(lines[2]).tool, 'mcp_write_file')
      assert.equal(JSON.parse(lines[2]).outcome, 'blocked')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('creates the parent directory if it does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'permgate-'))
    const file = join(dir, 'nested', 'deeper', 'calls.jsonl')
    try {
      const log = new CallLog(file)
      await log.record(makeRecord({
        phase: 'call', id: 'tc_1', tool: 'mcp_write_file', outcome: 'allowed', confirmation: 'approved',
      }))
      const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
      assert.equal(lines.length, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not throw when the target path is unwritable', async () => {
    const log = new CallLog('/nonexistent-dir/permission-gate/calls.jsonl')
    await log.record(makeRecord({
      phase: 'call', id: 'tc_1', tool: 'mcp_write_file', outcome: 'blocked', confirmation: 'timeout', reason: 'x',
    }))
    assert.ok(true)
  })
})
