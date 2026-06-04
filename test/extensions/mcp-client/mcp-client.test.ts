import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRequest,
  McpClient,
  McpError,
  parseSseData,
  selectResponse,
  type FetchLike,
} from '../../../src/extensions/mcp-client/mcp-client.ts'

describe('buildRequest', () => {
  it('builds a JSON-RPC envelope and omits params when undefined', () => {
    assert.deepEqual(buildRequest(1, 'tools/list'), { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  })

  it('includes params when given', () => {
    assert.deepEqual(buildRequest(2, 'tools/call', { name: 'x' }), {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' },
    })
  })
})

describe('parseSseData', () => {
  it('extracts data: JSON frames and ignores other lines', () => {
    const body = [
      'event: message',
      'id: 1',
      'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      '',
      ': keep-alive comment',
      'data: [DONE]',
    ].join('\n')
    assert.deepEqual(parseSseData(body), [{ jsonrpc: '2.0', id: 1, result: { ok: true } }])
  })

  it('handles CRLF line endings and skips non-JSON data', () => {
    const body = 'data: not-json\r\ndata: {"jsonrpc":"2.0","id":5,"result":1}\r\n'
    assert.deepEqual(parseSseData(body), [{ jsonrpc: '2.0', id: 5, result: 1 }])
  })

  it('returns empty for a body with no data frames', () => {
    assert.deepEqual(parseSseData('event: ping\n\n'), [])
  })
})

describe('selectResponse', () => {
  it('returns the response matching the id', () => {
    const payloads = [
      { jsonrpc: '2.0', id: 1, result: 'a' },
      { jsonrpc: '2.0', id: 2, result: 'b' },
    ]
    assert.equal(selectResponse(payloads, 2).result, 'b')
  })

  it('throws McpError on a JSON-RPC error response', () => {
    const payloads = [{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'denied' } }]
    assert.throws(() => selectResponse(payloads, 1), (e: unknown) => e instanceof McpError && e.code === -32000 && /denied/.test((e as McpError).message))
  })

  it('throws when no response matches the id', () => {
    assert.throws(() => selectResponse([], 9), McpError)
  })

  it('ignores non-response payloads', () => {
    const payloads = [{ foo: 'bar' }, { jsonrpc: '2.0', id: 3, result: 'ok' }]
    assert.equal(selectResponse(payloads, 3).result, 'ok')
  })
})

/** Build a fake fetch returning a single SSE-framed JSON-RPC response. */
function fakeFetch (responseFor: (req: { id: number, method: string, params?: unknown }) => unknown, opts: { ok?: boolean, status?: number } = {}): FetchLike {
  return async (_url, init) => {
    const req = JSON.parse(init.body) as { id: number, method: string, params?: unknown }
    const result = responseFor(req)
    const frame = `data: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n\n`
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      text: async () => frame,
    }
  }
}

describe('McpClient', () => {
  it('initialize performs a round trip without throwing', async () => {
    const client = new McpClient({ url: 'http://gw/sse', fetch: fakeFetch(() => ({})) })
    await client.initialize()
  })

  it('listTools returns the tools array', async () => {
    const tools = [{ name: 'read_file', inputSchema: { type: 'object' } }]
    const client = new McpClient({ url: 'http://gw/sse', fetch: fakeFetch(() => ({ tools })) })
    assert.deepEqual(await client.listTools(), tools)
  })

  it('listTools tolerates a missing tools field', async () => {
    const client = new McpClient({ url: 'http://gw/sse', fetch: fakeFetch(() => ({})) })
    assert.deepEqual(await client.listTools(), [])
  })

  it('callTool forwards name and arguments and returns the result', async () => {
    let seen: unknown
    const client = new McpClient({
      url: 'http://gw/sse',
      fetch: fakeFetch((req) => { seen = req.params; return { content: [{ type: 'text', text: 'hi' }] } }),
    })
    const out = await client.callTool('read_file', { path: '/projects/active/x' })
    assert.deepEqual(seen, { name: 'read_file', arguments: { path: '/projects/active/x' } })
    assert.deepEqual(out, { content: [{ type: 'text', text: 'hi' }] })
  })

  it('assigns incrementing request ids across calls', async () => {
    const ids: number[] = []
    const client = new McpClient({
      url: 'http://gw/sse',
      fetch: async (_url, init) => {
        const req = JSON.parse(init.body) as { id: number }
        ids.push(req.id)
        return { ok: true, status: 200, text: async () => `data: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} })}\n\n` }
      },
    })
    await client.initialize()
    await client.listTools()
    assert.deepEqual(ids, [1, 2])
  })

  it('throws McpError on a non-ok HTTP status', async () => {
    const client = new McpClient({ url: 'http://gw/sse', fetch: fakeFetch(() => ({}), { ok: false, status: 502 }) })
    await assert.rejects(() => client.initialize(), (e: unknown) => e instanceof McpError && e.code === 502)
  })
})
