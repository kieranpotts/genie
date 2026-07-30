# `mcp-client`

Pi has no native MCP (Model Context Protocol) support. This extension gives it
an MCP client, and maps tools to the MCP server. This is required to give the
agent profile file access only through mediated MCP tools, rather than a direct
filesystem mount — a key component of this project's hardened agent
infrastructure.

## What it does

On `session_start`, the extension connects to the MCP gateway named in the
`MCP_GATEWAY_URL` environment variable, runs the MCP `initialize` handshake
(latching the gateway's `Mcp-Session-Id` and sending the follow-up
`notifications/initialized`), lists the tools the server exposes (`tools/list`),
and registers each one as a Pi tool (`tools/call` on invocation).

Tools are namespaced with an `mcp_` prefix (`read_file` → `mcp_read_file`) so
they cannot collide with Pi's built-ins or other extensions.

If `MCP_GATEWAY_URL` is unset, the extension does nothing. The agent will simply
have no MCP-mediated file tools. If `MCP_GATEWAY_URL` is set but the gateway is
unreachable, a one-off error is shown and the session continues.

## How tool failures are signalled

**A failed MCP call is reported by THROWING out of the tool's `execute`, never
by returning `{ isError: true }`.** This is not a style preference — it is the
only channel Pi reads.

Pi derives the `tool_result` event's `isError` purely from whether `execute`
threw. In `agent-loop.js`:

```js
return { result, isError: false }                       // execute returned
catch (error) { return { result: …, isError: true } }   // execute threw
```

A returned `isError` is discarded at that point. This extension used to return
one, and the consequence was not cosmetic: `secret-sentry` records the
`tool_result` event's `isError` as the `result` field of its audit trail, so
**every failed MCP call was logged as `"result":"ok"`** — including reads the
filesystem server had refused for being outside `/workspace`. The audit trail
asserted successful reads that never happened, which is the exact failure the
two-line trail was built to prevent.

Found by running the stack, not by reading it: the unit tests passed and the
extension typechecked throughout.

The model still sees the failure. Pi's catch wraps the thrown message with
`createErrorToolResult`, so the MCP server's error text reaches the transcript
exactly as the returned content did.

## Configuration

The following environment variables must be exported into the environment in
which the Pi process is running — so, in the guest environment, if the agent is
containerized. The `compose.yaml` file for the hardened container does this.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_GATEWAY_URL` | Unset | The gateway's streamable-HTTP endpoint, eg. `http://mcp-gateway:8811/mcp`. |
