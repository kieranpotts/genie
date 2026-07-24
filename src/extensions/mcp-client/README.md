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

## Configuration

The following environment variables must be exported into the environment in
which the Pi process is running — so, in the guest environment, if the agent is
containerized. The `compose.yaml` file for the hardened container does this.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_GATEWAY_URL` | Unset | The gateway's streamable-HTTP endpoint, eg. `http://mcp-gateway:8811/mcp`. |
