# References and notes

## Landscape (2025–2026)

MCP has become the de facto isolation boundary for agents; the agent calls
scoped MCP servers rather than touching the filesystem directly. LiteLLM has
become the de facto model proxy for the mixed local/cloud case (keys on host,
single endpoint). Docker MCP Toolkit is the pragmatic, batteries-included way
to run MCP servers in containers. The [chosen architecture](./solution.md)
aligns the local setup with this consolidation.

## Model routing

Local models via Ollama (fast, private, data never leaves the machine); cloud
models for higher-capability tasks. The proxy is the recommended
credential-isolation mechanism in every [alternative](./alternatives.md), and
compounds most with the chosen architecture.

## Pi's own containerization patterns

Of Pi's own documented containerization patterns, OpenShell is the only one
that natively keeps API keys outside the agent (via an upstream-injecting
gateway). Where OpenShell is not used, the host-side proxy in this
architecture provides the equivalent credential isolation for Plain Docker.

## Links

- [LiteLLM](https://github.com/BerriAI/litellm) — model router/proxy.
- [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) —
  relevant to the Option 3 mitigation discussed in
  [alternatives](./alternatives.md).
- Docker MCP Toolkit — Docker Desktop feature for running MCP servers in
  containers.
- Model Context Protocol (MCP) — the agent–tool protocol underpinning the
  chosen architecture.
