/**
 * Pure helpers mapping between MCP and Pi's tool surface.
 *
 * Kept separate from `index.ts` so the naming, prefixing, and result-flattening
 * rules can be unit-tested without the `ExtensionAPI` or a live MCP endpoint.
 */

import type { McpCallResult, McpToolDescriptor } from './mcp-client.ts'

/**
 * Namespace every MCP tool under a stable prefix so it cannot collide with
 * Pi's built-in tools or another extension's. `read_file` → `mcp_read_file`.
 */
export const TOOL_PREFIX = 'mcp_'

/** Derive the Pi-facing tool name from an MCP tool name. Pure. */
export function piToolName (mcpName: string): string {
  return TOOL_PREFIX + mcpName
}

/** Recover the MCP tool name from a Pi-facing name. Inverse of `piToolName`. */
export function mcpToolName (piName: string): string {
  return piName.startsWith(TOOL_PREFIX) ? piName.slice(TOOL_PREFIX.length) : piName
}

/**
 * A description for the LLM. MCP descriptions are optional; fall back to a
 * generated one so the tool is never presented without guidance. Pure.
 */
export function toolDescription (tool: McpToolDescriptor): string {
  const base = tool.description?.trim()
  const via = 'Mediated by the MCP filesystem server; access is confined to the project workspace.'
  return base ? `${base}\n\n${via}` : `MCP tool "${tool.name}". ${via}`
}

/**
 * The JSON Schema an MCP tool advertises for its arguments. Pi's `registerTool`
 * expects a TypeBox schema, but a plain JSON Schema object is structurally
 * accepted at runtime; we pass it through unchanged, guaranteeing at least a
 * valid empty object schema. Pure.
 */
export function toolParameters (tool: McpToolDescriptor): Record<string, unknown> {
  const schema = tool.inputSchema
  if (schema && typeof schema === 'object' && schema.type === 'object') return schema
  return { type: 'object', properties: {}, additionalProperties: true }
}

/**
 * Flatten an MCP call result's content array into a single string for Pi's
 * tool-result text. Concatenates text parts; notes non-text parts by type so
 * nothing is silently dropped. Pure.
 */
export function flattenContent (result: McpCallResult): string {
  const parts: string[] = []
  for (const item of result.content ?? []) {
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    } else {
      parts.push(`[${item.type} content omitted]`)
    }
  }
  return parts.join('\n')
}

/** Whether an MCP call result represents an error. Pure. */
export function isErrorResult (result: McpCallResult): boolean {
  return result.isError === true
}
