import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  flattenContent,
  isErrorResult,
  mcpToolName,
  piToolName,
  TOOL_PREFIX,
  toolDescription,
  toolParameters,
} from '../../../src/extensions/mcp-client/tool-mapping.ts'

describe('tool name prefixing', () => {
  it('prefixes MCP names for Pi', () => {
    assert.equal(piToolName('read_file'), `${TOOL_PREFIX}read_file`)
  })

  it('round-trips through mcpToolName', () => {
    assert.equal(mcpToolName(piToolName('write_file')), 'write_file')
  })

  it('mcpToolName leaves an unprefixed name unchanged', () => {
    assert.equal(mcpToolName('plain'), 'plain')
  })
})

describe('toolDescription', () => {
  it('appends the mediation note to an existing description', () => {
    const d = toolDescription({ name: 'read_file', description: 'Read a file.', inputSchema: {} })
    assert.match(d, /^Read a file\./)
    assert.match(d, /MCP filesystem server/)
  })

  it('generates a description when none is provided', () => {
    const d = toolDescription({ name: 'list_dir', inputSchema: {} })
    assert.match(d, /list_dir/)
    assert.match(d, /confined to the project workspace/)
  })
})

describe('toolParameters', () => {
  it('passes through an object schema unchanged', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } } }
    assert.deepEqual(toolParameters({ name: 'x', inputSchema: schema }), schema)
  })

  it('falls back to a permissive object schema for a non-object schema', () => {
    assert.deepEqual(toolParameters({ name: 'x', inputSchema: { type: 'string' } }), {
      type: 'object', properties: {}, additionalProperties: true,
    })
  })
})

describe('flattenContent', () => {
  it('concatenates text parts with newlines', () => {
    const out = flattenContent({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })
    assert.equal(out, 'a\nb')
  })

  it('notes non-text parts without dropping them', () => {
    const out = flattenContent({ content: [{ type: 'image', data: '…' }] })
    assert.equal(out, '[image content omitted]')
  })

  it('handles an empty/missing content array', () => {
    assert.equal(flattenContent({ content: [] }), '')
  })
})

describe('isErrorResult', () => {
  it('is true only when isError is true', () => {
    assert.equal(isErrorResult({ content: [], isError: true }), true)
    assert.equal(isErrorResult({ content: [] }), false)
    assert.equal(isErrorResult({ content: [], isError: false }), false)
  })
})
