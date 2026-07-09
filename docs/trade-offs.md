# Trade-offs

This architecture is still lightweight and highly portable, but it adds some
complexity and a small performance hit — a network hop for every file
operation (Pi to the MCP server) and every model call (Pi to the proxy).
Acceptable for local development.

The costs below are accepted because the objective is security:

- **Setup complexity.** Two new long-lived components (MCP server, model
  proxy) plus a dedicated network.

- **Pi is not MCP-native.** Requires building or installing an MCP client
  extension for Pi, and depends on Pi's extension API staying stable. Until
  built, `--no-builtin-tools` + audited tools is the interim equivalent.

- **Environment fidelity gap.** Pi can't natively run project code. Mitigated
  by an MCP `run_command` tool that execs into the devcontainer — but that
  reintroduces some complexity, and privilege concerns if it needs
  `docker.sock`.

- **The MCP server becomes security-critical.** A bug or misconfiguration in
  the gatekeeper undermines the whole model, so it must be kept current and,
  if custom-built, reviewed as carefully as any security control.

- **Residual, accepted risks** (true of any local dev setup on a shared
  kernel):

  - **Kernel-exploit container escape.** — Accepted. Consider gVisor/VM
    isolation only for untrusted extensions or multi-user settings.

  - **Malicious Pi extension.** Extensions run with full container
    permissions; mitigated, not eliminated, by review and version pinning.

  - **Network egress / data exfiltration.** Network is open by default. Egress
    filtering is recommended for sensitive projects but out of scope
    for the baseline.

- **Technical debt / unknowns.** The MCP client extension and any custom MCP
  server are new code to maintain.
