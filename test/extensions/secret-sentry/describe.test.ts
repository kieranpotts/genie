import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { describeCall } from '../../../src/extensions/secret-sentry/describe.ts'

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
     TODO.md. */
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
