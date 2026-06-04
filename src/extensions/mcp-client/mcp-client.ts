/**
 * A minimal MCP (Model Context Protocol) client over HTTP/SSE.
 *
 * Pi has no native MCP support, so this implements just enough of the protocol
 * to drive a filesystem MCP server fronted by the Docker MCP Toolkit gateway:
 * the `initialize` handshake, `tools/list`, and `tools/call`. It is deliberately
 * dependency-free — the official MCP SDK cannot be shipped through this repo's
 * verbatim-copy installer (no `node_modules` resolution in the target), so the
 * JSON-RPC-over-SSE wire format is handled directly with `fetch`.
 *
 * All wire-format logic here is pure and synchronous where possible, so it can
 * be unit-tested without a live endpoint. The single side-effecting seam is the
 * injected `fetch`, which the tests fake.
 */

/** JSON-RPC 2.0 request envelope. */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

/** JSON-RPC 2.0 response envelope (success or error). */
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number, message: string, data?: unknown }
}

/** An MCP tool descriptor as returned by `tools/list`. */
export interface McpToolDescriptor {
  name: string
  description?: string
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>
}

/** The content payload returned by `tools/call`. */
export interface McpCallResult {
  content: Array<{ type: string, text?: string, [k: string]: unknown }>
  isError?: boolean
}

/** Build a JSON-RPC request envelope. Pure. */
export function buildRequest (id: number, method: string, params?: unknown): JsonRpcRequest {
  const req: JsonRpcRequest = { jsonrpc: '2.0', id, method }
  if (params !== undefined) req.params = params
  return req
}

/**
 * Extract JSON-RPC payloads from a raw SSE response body.
 *
 * The gateway speaks Server-Sent Events: lines like `data: {...}` separated by
 * blank lines, possibly interleaved with `event:` and `id:` lines we ignore.
 * Returns every parsed `data:` JSON object, in order. Pure.
 */
export function parseSseData (body: string): unknown[] {
  const out: unknown[] = []
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      out.push(JSON.parse(payload))
    } catch {
      /* Ignore keep-alive comments and non-JSON data frames. */
    }
  }
  return out
}

/**
 * Pull the JSON-RPC response matching `id` out of parsed SSE payloads, throwing
 * on a JSON-RPC error or a missing response. Pure.
 */
export function selectResponse (payloads: unknown[], id: number): JsonRpcResponse {
  for (const p of payloads) {
    if (isJsonRpcResponse(p) && p.id === id) {
      if (p.error) {
        throw new McpError(p.error.message, p.error.code, p.error.data)
      }
      return p
    }
  }
  throw new McpError(`No JSON-RPC response for id ${id}`, -1)
}

function isJsonRpcResponse (v: unknown): v is JsonRpcResponse {
  return typeof v === 'object' && v !== null && (v as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (v as { id?: unknown }).id === 'number'
}

/** Error raised for transport failures and JSON-RPC error responses. */
export class McpError extends Error {
  readonly code: number
  readonly data: unknown
  constructor (message: string, code: number, data?: unknown) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.data = data
  }
}

/** The minimal `fetch` shape this client needs. Lets tests inject a fake. */
export type FetchLike = (
  url: string,
  init: { method: string, headers: Record<string, string>, body: string, signal?: AbortSignal }
) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>

export interface McpClientOptions {
  /** Gateway SSE endpoint, e.g. http://mcp-gateway:8811/sse */
  url: string
  fetch: FetchLike
}

/**
 * A connected MCP client. One instance per gateway endpoint. Holds only an
 * incrementing request id; each call is a self-contained POST whose SSE body
 * carries the matching response.
 */
export class McpClient {
  private readonly url: string
  private readonly fetchImpl: FetchLike
  private nextId = 1

  constructor (opts: McpClientOptions) {
    this.url = opts.url
    this.fetchImpl = opts.fetch
  }

  /** Perform one JSON-RPC round trip and return its result payload. */
  private async rpc (method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++
    const req = buildRequest(id, method, params)
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(req),
      signal,
    })
    if (!res.ok) {
      throw new McpError(`MCP gateway HTTP ${res.status}`, res.status)
    }
    const payloads = parseSseData(await res.text())
    return selectResponse(payloads, id).result
  }

  /** MCP `initialize` handshake. Must precede tool calls. */
  async initialize (signal?: AbortSignal): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pi-mcp-client', version: '0.0.0' },
    }, signal)
  }

  /** List the tools the server exposes. */
  async listTools (signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    const result = await this.rpc('tools/list', {}, signal) as { tools?: McpToolDescriptor[] }
    return result.tools ?? []
  }

  /** Invoke a tool by name with the given arguments. */
  async callTool (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    return await this.rpc('tools/call', { name, arguments: args }, signal) as McpCallResult
  }
}
