# Hardening

This section summarizes the custom security hardening built-in to my agent
harness infrastructure.

| Requirement                         | Hardening solution                                                                                                                                                      |
|-------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Filesystem access control           | File access mediated by MCP server, connected by `mcp-client` extension. Plus `audited-tools` extension enforces a path allowlist and blocks access to sensitive files. |
| Command execution control           | `bash` replacement (via `audited-tools`) never invokes a shell, rejects control operators, and runs only allowlisted programs.                                          |
| Permission prompts / approval gates | `permission-gate` extension requires interactive confirmation for writes/edits/execution (`tool_call` events). Denies access by default.                                |
| Audit log of tool calls             | Append-only JSONL logs, on a dedicated volume, for every fs/bash call and every tool approve/deny decision.                                                             |
| API key isolation from agent        | Host-side LiteLLM proxy holds API keys (eg. `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`). Agent container gets a proxy endpoint + low-value rotatable proxy token.             |
| Extension vetting / signing         | Extensions require manual review. Third-party packages pinned to exact versions/commit hashes.                                                                          |
| Network egress control              | Container has no host networking. Reaches the model only via the host proxy over a private bridge network.                                                              |
| Container hardening                 | Non-root user, `--cap-drop ALL`, `no-new-privileges`, read-only rootfs with tmpfs `/tmp`, memory/CPU/PIDs limits, no `docker.sock`, no project or host-dotfile mounts.  |
| Startup telemetry / network calls   | `PI_OFFLINE=1` / `PI_SKIP_VERSION_CHECK=1` disable Pi's built-in telemetry and version-check calls, so the only outbound network is the proxy and the MCP gateway.      |
| Session data retention              | `sessionDir` set to a named volume outside the project tree (`pi-sessions`). JSONL logs hold the full conversation, including file content reads.                       |
| Session data encryption at rest     | NOT IMPLEMENTED. Depends on the host volume back-end (eg. an encrypted disk).                                                                                           |
| Data classification                 | NOT IMPLEMENTED. No extension currently inspects tool content by sensitivity beyond the filename-pattern refusal in `path-guard.ts`.                                    |
| Prompt injection defense            | OUT-OF-SCOPE for the agent harness. This is a model-level concern.                                                                                                      |
