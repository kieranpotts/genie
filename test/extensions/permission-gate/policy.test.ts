import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decide, describeCall, describeForPrompt, requiresConfirmation } from '../../../src/extensions/permission-gate/policy.ts'

describe('requiresConfirmation', () => {
  for (const t of ['write', 'edit']) {
    it(`gates unprefixed mutating tool: ${t}`, () => assert.equal(requiresConfirmation(t), true))
  }

  for (const t of ['read', 'ls', 'grep', 'find']) {
    it(`allows read-only builtin: ${t}`, () => assert.equal(requiresConfirmation(t), false))
  }

  /* The agent has no execution tool: `--no-builtin-tools` removes Pi's `bash`
     and nothing restores it. Asserted so that reintroducing execution without
     also gating it fails here rather than in production. See TODO.md. */
  it('does not gate `bash`, which cannot occur', () => {
    assert.equal(requiresConfirmation('bash'), false)
  })

  for (const t of ['mcp_write_file', 'mcp_edit_file', 'mcp_move_file', 'mcp_create_directory']) {
    it(`gates mutating MCP tool: ${t}`, () => assert.equal(requiresConfirmation(t), true))
  }

  for (const t of ['mcp_read_file', 'mcp_list_directory', 'mcp_search_files']) {
    it(`allows read-only MCP tool: ${t}`, () => assert.equal(requiresConfirmation(t), false))
  }
})

describe('describeCall', () => {
  it('summarises a path call', () => {
    assert.equal(describeCall('write', { path: '/workspace/x.ts' }), 'write: /workspace/x.ts')
  })

  it('ignores a command argument, which no tool takes', () => {
    assert.equal(describeCall('mcp_write_file', { command: 'rm -rf /tmp/x' }), 'mcp_write_file')
  })

  it('summarises a move as source -> destination', () => {
    assert.equal(
      describeCall('mcp_move_file', { source: '/a/x.ts', destination: '/a/y.ts' }),
      'mcp_move_file: /a/x.ts -> /a/y.ts'
    )
  })

  it('summarises a multi-file read', () => {
    assert.equal(
      describeCall('mcp_read_multiple_files', { paths: ['/a/x.ts', '/a/y.ts'] }),
      'mcp_read_multiple_files: /a/x.ts, /a/y.ts'
    )
  })

  /* The audit record is never truncated. This asserted the opposite until the
     cap was found to drop most of a ten-file read's paths — the trail could not
     say what was read, which is the question it exists to answer. Inverted
     rather than deleted, so restoring a cap here fails in the suite. See
     TODO.md and `describeForPrompt`. */
  it('records every path in a long list, without truncating', () => {
    const paths = Array.from({ length: 40 }, (_, i) => `/workspace/deeply/nested/path/file-${i}.ts`)
    const out = describeCall('mcp_read_multiple_files', { paths })
    for (const p of paths) assert.equal(out.includes(p), true, `missing ${p}`)
    assert.equal(out.includes('…'), false)
  })

  it('does not cap the description at any length', () => {
    const paths = Array.from({ length: 500 }, (_, i) => `/workspace/file-${i}.ts`)
    const out = describeCall('mcp_read_multiple_files', { paths })
    assert.equal(out.endsWith('/workspace/file-499.ts'), true)
  })

  it('uses the path when a command is also present', () => {
    assert.equal(describeCall('mcp_write_file', { command: 'git status', path: '/a' }), 'mcp_write_file: /a')
  })

  it('falls back to the tool name with no recognised argument', () => {
    assert.equal(describeCall('write', {}), 'write')
  })
})

describe('describeForPrompt — the display cap, and only here', () => {
  it('passes a normal description through untouched', () => {
    const detail = 'mcp_write_file: /workspace/src/extensions/permission-gate/policy.ts'
    assert.equal(describeForPrompt(detail), detail)
  })

  /* Everything the gate actually prompts for takes a single path or a
     source/destination pair, so the cap should never fire in practice. If this
     starts failing, a tool with a large argument has been gated and the cap is
     doing real work — which is what it is there for. */
  it('leaves every currently gated shape uncapped', () => {
    for (const detail of [
      describeCall('mcp_write_file', { path: '/workspace/' + 'a/'.repeat(60) + 'x.ts' }),
      describeCall('mcp_move_file', { source: '/workspace/' + 'a/'.repeat(60) + 'x.ts', destination: '/workspace/' + 'b/'.repeat(60) + 'y.ts' }),
      describeCall('mcp_create_directory', { path: '/workspace/' + 'a/'.repeat(60) }),
    ]) {
      assert.equal(describeForPrompt(detail), detail)
    }
  })

  it('caps an oversized description', () => {
    const detail = 'mcp_write_file: ' + 'x'.repeat(5000)
    const out = describeForPrompt(detail)
    assert.equal(out.length < detail.length, true)
    assert.equal(out.startsWith('mcp_write_file: xxx'), true)
  })

  /* An ellipsis reads like formatting. A prompt that hides half of what it is
     confirming has to admit it, and say where the rest is — the prompt is the
     control, so an operator must know when they are seeing a summary. */
  it('says how much it withheld, and where the rest is', () => {
    const detail = 'mcp_write_file: ' + 'x'.repeat(5000)
    const out = describeForPrompt(detail)
    assert.match(out, /\[\d+ more characters not shown — the audit log records this call in full\]$/)

    /* The count must be the real one. A marker that says "some" would be no
       better than the ellipsis it replaced. */
    const reported = Number(/\[(\d+) more/.exec(out)?.[1])
    const shown = out.slice(0, out.indexOf('\n\n['))
    assert.equal(shown.length + reported, detail.length)
  })

  /* The point of the split: whatever the dialog shows, the record is complete. */
  it('never shortens what describeCall produced for the log', () => {
    const paths = Array.from({ length: 200 }, (_, i) => `/workspace/file-${i}.ts`)
    const detail = describeCall('mcp_read_multiple_files', { paths })
    assert.equal(describeForPrompt(detail).length < detail.length, true)
    for (const p of paths) assert.equal(detail.includes(p), true)
  })
})

describe('decide — default deny', () => {
  it('allows on explicit approval, with no reason to give', () => {
    const d = decide('write', 'approved')
    assert.deepEqual(d, { outcome: 'allowed', confirmation: 'approved' })
  })

  it('denies on rejection', () => {
    const d = decide('write', 'rejected')
    assert.equal(d.outcome, 'blocked')
    assert.equal(d.confirmation, 'rejected')
    assert.match(d.reason ?? '', /user rejected/)
  })

  it('denies on timeout', () => {
    const d = decide('mcp_write_file', 'timeout')
    assert.equal(d.outcome, 'blocked')
    assert.equal(d.confirmation, 'timeout')
    assert.match(d.reason ?? '', /timed out/)
  })

  it('denies when no UI is available', () => {
    const d = decide('edit', 'no-ui')
    assert.equal(d.outcome, 'blocked')
    assert.equal(d.confirmation, 'no-ui')
    assert.match(d.reason ?? '', /no interactive UI/)
  })

  /* The confirmation axis carries the cause of a denial as a field, so the three
     ways a call can be blocked at this point stay distinguishable in the log
     without parsing `reason`. */
  it('reports a distinct confirmation value for each way of being denied', () => {
    const causes = (['rejected', 'timeout', 'no-ui'] as const).map((o) => decide('write', o).confirmation)
    assert.deepEqual(causes, ['rejected', 'timeout', 'no-ui'])
    assert.equal(new Set(causes).size, 3)
  })
})
