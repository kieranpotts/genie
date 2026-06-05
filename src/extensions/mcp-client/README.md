# mcp-client

Gives Pi an MCP (Model Context Protocol) client so it can reach a filesystem MCP server through the Docker MCP Toolkit gateway. Pi has no native MCP support, so this extension is the in-Pi half of the secure local agent architecture: the agent gets project file access only through mediated MCP tools, never a direct filesystem mount.

See [docs/local-agent-architecture.md](../../../docs/local-agent-architecture.md).

## What it does

On `session_start`, the extension connects to the MCP gateway named in the `MCP_GATEWAY_URL` environment variable, runs the MCP `initialize` handshake, lists the tools the server exposes (`tools/list`), and registers each one as a Pi tool (`tools/call` on invocation). Tools are namespaced with an `mcp_` prefix (`read_file` → `mcp_read_file`) so they cannot collide with Pi's built-ins or other extensions.

If `MCP_GATEWAY_URL` is unset, the extension does nothing — the agent's model route still works; it simply has no MCP-mediated file tools. If the gateway is unreachable, a one-off error notice is shown and the session continues.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `MCP_GATEWAY_URL` | yes (to do anything) | The gateway's SSE endpoint, e.g. `http://mcp-gateway:8811/sse`. Set by `src/infrastructure/compose.yaml` for the hardened container. |

## Design notes

- **No npm dependency.** The MCP wire protocol (JSON-RPC over Server-Sent Events) is implemented directly with `fetch`, because this repo installs extensions by copying directories verbatim — there is no `node_modules` resolution in the install target, so the official MCP SDK could not be loaded. The surface needed is small (`initialize`, `tools/list`, `tools/call`).
- **Pure, tested core.** All wire-format and mapping logic lives in `mcp-client.ts` and `tool-mapping.ts` and is unit-tested against a faked `fetch`/payloads. `index.ts` is thin glue to the `ExtensionAPI`.
- **Mediation, not bypass.** The MCP server enforces the path/operation allowlist; this client only forwards calls. It does not itself touch the filesystem.

## Files

- `index.ts` — extension entry point; connects, lists, and registers tools.
- `mcp-client.ts` — minimal MCP-over-HTTP/SSE client (pure protocol logic + injected `fetch`).
- `tool-mapping.ts` — pure MCP↔Pi mapping helpers (naming, schema passthrough, result flattening).
