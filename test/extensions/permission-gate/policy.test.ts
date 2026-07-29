import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decide, describeCall, requiresConfirmation } from '../../../src/extensions/permission-gate/policy.ts'

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
    assert.equal(describeCall('write', { path: '/projects/active/x.ts' }), 'write: /projects/active/x.ts')
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

  it('truncates a very long path list', () => {
    const paths = Array.from({ length: 40 }, (_, i) => `/projects/active/file-${i}.ts`)
    const out = describeCall('mcp_read_multiple_files', { paths })
    assert.equal(out.length <= 'mcp_read_multiple_files: '.length + 120, true)
    assert.match(out, /…$/)
  })

  it('uses the path when a command is also present', () => {
    assert.equal(describeCall('mcp_write_file', { command: 'git status', path: '/a' }), 'mcp_write_file: /a')
  })

  it('falls back to the tool name with no recognised argument', () => {
    assert.equal(describeCall('write', {}), 'write')
  })
})

describe('decide — default deny', () => {
  it('allows on explicit approval', () => {
    const d = decide('write', 'approved')
    assert.deepEqual(d, { block: false, status: 'approved', reason: 'user approved' })
  })

  it('denies on rejection', () => {
    const d = decide('write', 'rejected')
    assert.equal(d.block, true)
    assert.equal(d.status, 'denied')
    assert.match(d.reason, /user rejected/)
  })

  it('denies on timeout', () => {
    const d = decide('bash', 'timeout')
    assert.equal(d.block, true)
    assert.match(d.reason, /timed out/)
  })

  it('denies when no UI is available', () => {
    const d = decide('edit', 'no-ui')
    assert.equal(d.block, true)
    assert.match(d.reason, /no interactive UI/)
  })
})
