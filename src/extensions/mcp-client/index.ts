/**
 * Gives Pi an MCP client so it can drive a filesystem MCP server over the
 * Docker MCP Toolkit gateway. Pi has no native MCP support (verified against
 * the extension API), so on startup this connects to the gateway named in
 * `MCP_GATEWAY_URL`, lists the tools the server exposes, and registers each one
 * as a Pi tool. The agent then reaches project files only through these
 * mediated tools — never via a direct filesystem mount.
 *
 * Mediation, not bypass: this client only forwards `tools/call` requests to the
 * MCP server, which is what enforces the path and operation allowlist. The
 * client itself never touches the filesystem, so it adds no way around that
 * boundary.
 *
 * The wire protocol and the MCP↔Pi mapping live in pure, unit-tested helpers
 * (`mcp-client.ts`, `tool-mapping.ts`); this entry point is the thin glue to
 * the `ExtensionAPI`. Each registered tool passes the MCP input schema straight
 * through and flattens MCP result content back into Pi's tool-result shape.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { McpClient, McpError, type FetchLike } from './mcp-client.ts'
import {
  flattenContent,
  isErrorResult,
  mcpToolName,
  piToolName,
  toolDescription,
  toolParameters,
} from './tool-mapping.ts'

/** Where to reach the MCP gateway. Set by compose for the hardened container. */
const GATEWAY_URL_ENV = 'MCP_GATEWAY_URL'
/** Bearer token guarding the gateway's localhost SSE endpoint. */
const GATEWAY_TOKEN_ENV = 'MCP_GATEWAY_AUTH_TOKEN'

export default function (pi: ExtensionAPI): void {
  const url = process.env[GATEWAY_URL_ENV]
  if (!url) {
    /* No gateway configured — nothing to mediate. Stay silent rather than
       failing the agent; the model route still works without filesystem tools. */
    return
  }

  const client = new McpClient({
    url,
    fetch: globalThis.fetch as unknown as FetchLike,
    authToken: process.env[GATEWAY_TOKEN_ENV],
  })

  /* Connect and register tools once the session is starting, so registration
     failures surface in the session rather than at module load. */
  pi.on('session_start', async (_event, ctx) => {
    try {
      await client.initialize(ctx.signal)
      const tools = await client.listTools(ctx.signal)
      for (const tool of tools) {
        registerMcpTool(pi, client, tool.name, toolDescription(tool), toolParameters(tool))
      }
    } catch (err) {
      const message = err instanceof McpError ? err.message : String(err)
      if (ctx.hasUI) ctx.ui.notify(`MCP client: failed to connect to ${url}: ${message}`, 'error')
    }
  })
}

/** Register a single MCP tool as a Pi tool. Isolated so the loop stays clear. */
function registerMcpTool (
  pi: ExtensionAPI,
  client: McpClient,
  name: string,
  description: string,
  parameters: Record<string, unknown>
): void {
  pi.registerTool({
    name: piToolName(name),
    label: piToolName(name),
    description,
    // Plain JSON Schema, accepted structurally where Pi expects a TypeBox schema.
    parameters: parameters as never,
    execute: async (_toolCallId, params, signal) => {
      const result = await client.callTool(mcpToolName(name), (params ?? {}) as Record<string, unknown>, signal)
      const text = flattenContent(result)
      return {
        content: [{ type: 'text', text }],
        isError: isErrorResult(result),
      } as never
    },
  })
}
