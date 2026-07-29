import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNotification,
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

describe('buildNotification', () => {
  it('builds a JSON-RPC notification with no id', () => {
    assert.deepEqual(buildNotification('notifications/initialized'), {
      jsonrpc: '2.0', method: 'notifications/initialized',
    })
  })

  it('includes params when given', () => {
    assert.deepEqual(buildNotification('x', { a: 1 }), { jsonrpc: '2.0', method: 'x', params: { a: 1 } })
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

/** A minimal `Headers`-like object exposing a case-insensitive `get()`. */
function headersWith (sessionId?: string): { get: (name: string) => string | null } {
  return { get: (name) => (name.toLowerCase() === 'mcp-session-id' ? (sessionId ?? null) : null) }
}

/** Build a fake fetch returning a single SSE-framed JSON-RPC response. */
function fakeFetch (
  responseFor: (req: { id?: number, method: string, params?: unknown }) => unknown,
  opts: { ok?: boolean, status?: number, sessionId?: string } = {},
): FetchLike {
  return async (_url, init) => {
    const req = JSON.parse(init.body) as { id?: number, method: string, params?: unknown }
    const result = responseFor(req)
    const frame = `data: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n\n`
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      headers: headersWith(opts.sessionId),
      text: async () => frame,
    }
  }
}

describe('McpClient', () => {
  it('initialize performs a round trip without throwing', async () => {
    const client = new McpClient({ url: 'http://gw/mcp', fetch: fakeFetch(() => ({})) })
    await client.initialize()
  })

  it('listTools returns the tools array', async () => {
    const tools = [{ name: 'read_file', inputSchema: { type: 'object' } }]
    const client = new McpClient({ url: 'http://gw/mcp', fetch: fakeFetch(() => ({ tools })) })
    assert.deepEqual(await client.listTools(), tools)
  })

  it('listTools tolerates a missing tools field', async () => {
    const client = new McpClient({ url: 'http://gw/mcp', fetch: fakeFetch(() => ({})) })
    assert.deepEqual(await client.listTools(), [])
  })

  it('callTool forwards name and arguments and returns the result', async () => {
    let seen: unknown
    const client = new McpClient({
      url: 'http://gw/mcp',
      fetch: fakeFetch((req) => { seen = req.params; return { content: [{ type: 'text', text: 'hi' }] } }),
    })
    const out = await client.callTool('read_file', { path: '/workspace/x' })
    assert.deepEqual(seen, { name: 'read_file', arguments: { path: '/workspace/x' } })
    assert.deepEqual(out, { content: [{ type: 'text', text: 'hi' }] })
  })

  it('sends both Accept types on every request', async () => {
    const accepts: string[] = []
    const client = new McpClient({
      url: 'http://gw/mcp',
      fetch: async (_url, init) => {
        accepts.push(init.headers.accept)
        const req = JSON.parse(init.body) as { id?: number }
        return { ok: true, status: 200, headers: headersWith(), text: async () => `data: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} })}\n\n` }
      },
    })
    await client.initialize()
    await client.listTools()
    assert.ok(accepts.length >= 3)
    assert.ok(accepts.every((a) => a === 'application/json, text/event-stream'))
  })

  it('initialize follows the response with a notifications/initialized notification', async () => {
    const methods: string[] = []
    const client = new McpClient({
      url: 'http://gw/mcp',
      fetch: fakeFetch((req) => { methods.push(req.method); return {} }),
    })
    await client.initialize()
    assert.deepEqual(methods, ['initialize', 'notifications/initialized'])
  })

  it('captures the Mcp-Session-Id from initialize and echoes it on later requests', async () => {
    const seenSession: Array<string | undefined> = []
    const client = new McpClient({
      url: 'http://gw/mcp',
      fetch: async (_url, init) => {
        seenSession.push(init.headers['mcp-session-id'])
        const req = JSON.parse(init.body) as { id?: number }
        return { ok: true, status: 200, headers: headersWith('SID-XYZ'), text: async () => `data: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [] } })}\n\n` }
      },
    })
    await client.initialize()
    await client.listTools()
    // The initialize request precedes the session id; every request after it carries it.
    assert.equal(seenSession[0], undefined)
    assert.ok(seenSession.slice(1).every((s) => s === 'SID-XYZ'))
  })

  it('assigns incrementing request ids across rpc calls (notifications consume no id)', async () => {
    const ids: number[] = []
    const client = new McpClient({
      url: 'http://gw/mcp',
      fetch: async (_url, init) => {
        const req = JSON.parse(init.body) as { id?: number }
        if (typeof req.id === 'number') ids.push(req.id)
        return { ok: true, status: 200, headers: headersWith(), text: async () => `data: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} })}\n\n` }
      },
    })
    await client.initialize()
    await client.listTools()
    assert.deepEqual(ids, [1, 2])
  })

  it('throws McpError on a non-ok HTTP status', async () => {
    const client = new McpClient({ url: 'http://gw/mcp', fetch: fakeFetch(() => ({}), { ok: false, status: 502 }) })
    await assert.rejects(() => client.initialize(), (e: unknown) => e instanceof McpError && e.code === 502)
  })

  it('sends a Bearer authorization header when a token is given', async () => {
    let auth: string | undefined
    const client = new McpClient({
      url: 'http://gw/mcp',
      authToken: 'secret-token',
      fetch: async (_url, init) => {
        auth = init.headers.authorization
        const req = JSON.parse(init.body) as { id?: number }
        return { ok: true, status: 200, headers: headersWith(), text: async () => `data: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} })}\n\n` }
      },
    })
    await client.initialize()
    assert.equal(auth, 'Bearer secret-token')
  })

  it('omits the authorization header when no token is given', async () => {
    let hasAuth = true
    const client = new McpClient({
      url: 'http://gw/mcp',
      fetch: async (_url, init) => {
        hasAuth = 'authorization' in init.headers
        const req = JSON.parse(init.body) as { id?: number }
        return { ok: true, status: 200, headers: headersWith(), text: async () => `data: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} })}\n\n` }
      },
    })
    await client.initialize()
    assert.equal(hasAuth, false)
  })
})
