import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decide, describeCall, requiresConfirmation } from '../../../src/extensions/permission-gate/policy.ts'

describe('requiresConfirmation', () => {
  for (const t of ['write', 'edit', 'bash']) {
    it(`gates mutating builtin: ${t}`, () => assert.equal(requiresConfirmation(t), true))
  }

  for (const t of ['read', 'ls', 'grep', 'find']) {
    it(`allows read-only builtin: ${t}`, () => assert.equal(requiresConfirmation(t), false))
  }

  for (const t of ['mcp_write_file', 'mcp_edit_file', 'mcp_move_file', 'mcp_create_directory']) {
    it(`gates mutating MCP tool: ${t}`, () => assert.equal(requiresConfirmation(t), true))
  }

  for (const t of ['mcp_read_file', 'mcp_list_directory', 'mcp_search_files']) {
    it(`allows read-only MCP tool: ${t}`, () => assert.equal(requiresConfirmation(t), false))
  }
})

describe('describeCall', () => {
  it('summarises a command call', () => {
    assert.equal(describeCall('bash', { command: 'rm -rf /tmp/x' }), 'bash: rm -rf /tmp/x')
  })

  it('summarises a path call', () => {
    assert.equal(describeCall('write', { path: '/projects/active/x.ts' }), 'write: /projects/active/x.ts')
  })

  it('truncates a very long command', () => {
    const long = 'echo ' + 'a'.repeat(200)
    const out = describeCall('bash', { command: long })
    assert.equal(out.length <= 'bash: '.length + 120, true)
    assert.match(out, /…$/)
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

  it('prefers a command over a path when both are present', () => {
    assert.equal(describeCall('bash', { command: 'git status', path: '/a' }), 'bash: git status')
  })

  it('falls back to the tool name with no path or command', () => {
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
