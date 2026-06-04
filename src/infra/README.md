# Secure local agent infrastructure

Infrastructure for running the Pi coding agent inside the secure local architecture decided in [docs/local-agent-architecture.md](../../docs/local-agent-architecture.md) and sequenced in [docs/local-agent-implementation-plan.md](../../docs/local-agent-implementation-plan.md). Those documents are the source of truth; this README is the operator's entry point to the runnable pieces.

> [!IMPORTANT]
> This directory is **not** a Pi extension and is **not** installable. `run/install` installs only the directories under `src/extensions/`. Nothing here is ever copied into `~/.pi/agent/extensions/`.

> [!WARNING]
> Work in progress. This is the Step 1 skeleton from the implementation plan. The subdirectories below are placeholders until their respective steps land — only this README and `.env.example` exist so far.

## What this provides

The goal is filesystem isolation first, credential isolation second, auditability third. A fully compromised Pi process should reach no project files outside its scope, no host files, no cloud credentials, and no host Docker control — and every filesystem action it takes should be logged.

The architecture has two halves. The infrastructure here is the host-and-container half; the in-Pi controls are separate extensions under [`src/extensions/`](../extensions/) (the `mcp-client`, `audited-tools`, and `permission-gate` extensions, added in later steps).

## Components

| Component | Location | Role | Plan step |
|---|---|---|---|
| Host env contract | `.env.example` | Documents every value the host must provide; the real `.env` is gitignored and holds the cloud keys | 1 (done) |
| LiteLLM proxy | `proxy/litellm.config.yaml` | Host-side model router holding ALL cloud API keys; the agent gets only its endpoint and a master key | 2 (done) |
| Hardened agent image | `pi-container/Dockerfile` | Non-root, no-keys, no-`docker.sock`, no-mounts Pi image; capability-drop and limits applied at runtime by compose | 3 (done) |
| MCP filesystem boundary | `compose.yaml` (`mcp-gateway`) | Docker MCP Toolkit gateway; spawns and fronts the `mcp/filesystem` server (scoped to one project volume) over SSE. Sole holder of filesystem access — and of the Docker socket (see trade-off below) | 4 (done) |
| Compose wiring | `compose.yaml` | `agent-net` network, the project volume, the gateway, and the runtime-hardened pi-container | 4 (done) |

## Trust boundaries

- **Host:** Ollama (local inference) and the LiteLLM proxy (holds the keys). Both bind to the Docker bridge gateway, not `0.0.0.0`.
- **`agent-net`:** the pi-container (no keys, no FS, no socket) and the MCP server (the sole filesystem gatekeeper). The agent reaches files only through MCP tool calls and reaches models only through the proxy endpoint.

See the architecture doc for the full boundary diagrams.

## Operator runbook

End-to-end procedure to bring the stack up against a real project and verify the
security boundary. The three in-Pi extensions (`mcp-client`, `audited-tools`,
`permission-gate`) are baked into the hardened image, so once it is built they
are present in the agent.

### 1. Configure the host

```sh
cp src/infra/.env.example src/infra/.env
# Edit src/infra/.env:
#   - ANTHROPIC_API_KEY / OPENAI_API_KEY   (held by the proxy only)
#   - PROJECT_PATH=/absolute/path/to/the/one/project
#   - LITELLM_MASTER_KEY      = $(openssl rand -hex 32)
#   - MCP_GATEWAY_AUTH_TOKEN  = $(openssl rand -hex 32)
```

Ensure Ollama is bound to the bridge gateway (`OLLAMA_HOST`), not `0.0.0.0`.

### 2. Start the model proxy on the host

```sh
set -a; . src/infra/.env; set +a
litellm --config src/infra/proxy/litellm.config.yaml \
        --host "$LITELLM_HOST" --port "$LITELLM_PORT"
```

Exposes `fast` (local Ollama) and `capable` (cloud); `capable` falls back to
`fast` when the cloud is unreachable. The proxy holds the cloud keys; the agent
never will.

### 3. Build the hardened agent image

```sh
docker build -f src/infra/pi-container/Dockerfile -t pi-agent:hardened .
```

No keys, no socket, no project source in the image. The three security
extensions are copied into `~/.pi/agent/extensions/` inside it.

### 4. Bring up the boundary

```sh
docker compose -f src/infra/compose.yaml --env-file src/infra/.env up
```

This starts `agent-net`, the project volume (bound to `PROJECT_PATH`), the
`mcp-gateway` (which spawns and fronts the `mcp/filesystem` server over SSE), and
the hardened `pi` container. Run Pi with `--no-builtin-tools` so the audited
replacements are the only file tools.

### 5. Verify the boundary

| Check | How | Expect |
|---|---|---|
| Agent holds no cloud keys | `docker compose -f src/infra/compose.yaml exec pi env \| grep -i api_key` | no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| Agent has no project mount | `docker compose ... exec pi ls /projects 2>&1` | absent / empty — files reached only via MCP |
| Agent has no Docker socket | `docker compose ... exec pi ls -l /var/run/docker.sock 2>&1` | no such file |
| Mediated read works | ask the agent to read a file in the project | returns content via `mcp_*`/audited `read` |
| Traversal denied | ask it to read `../../etc/passwd` | denied at the boundary; `audit.jsonl` shows a `denied` line |
| Sensitive file refused | ask it to read `.env` in the project | refused; `audit.jsonl` shows `sensitive file refused` |
| Write requires approval | ask it to write a file | a confirmation prompt appears; on approve, write succeeds |
| Default-deny on timeout | ignore the prompt for 60s | the write is blocked; `permissions.jsonl` shows `timed out (default deny)` |

### 6. Inspect the audit trail

Both logs live on the `pi-sessions` volume, outside the agent's read-only rootfs:

```sh
docker compose -f src/infra/compose.yaml exec pi cat /home/pi/sessions/audit.jsonl       # file ops
docker compose -f src/infra/compose.yaml exec pi cat /home/pi/sessions/permissions.jsonl # approvals
```

### The docker.sock trade-off (read this)

The Docker MCP Toolkit gateway **spawns and manages** the filesystem MCP server
itself, so it requires the Docker socket. The architecture confines that
privilege to the **gateway** — the agent (`pi`) still has no socket, no keys, and
no project mount. This is the deliberate, contained version of the Option C
docker.sock concern from the architecture doc: the privilege exists, but on a
component the agent cannot reach, not on the agent itself. If even that is
unacceptable for your environment, the alternative is to run `mcp/filesystem`
directly (stdio) without the Toolkit gateway and bridge it to the agent — at the
cost of the Toolkit's catalog/secret/network controls.

> [!NOTE]
> The gateway flags (`docker mcp gateway run --transport sse --oci-ref … --block-network`)
> were verified against the installed Toolkit. The catalog/secret model may
> still vary by Toolkit version; `--dry-run` is useful to validate config
> without listening.

## Security notes

- The real `.env` is gitignored (`.env`, `.env.*`, except `.env.example`). It holds cloud API keys; never commit it.
- Keys live only on the host (in the proxy). They are never injected into the pi-container and never baked into any image.
- The MCP server is the only component with filesystem access. Path enforcement lives in its configuration/code, not only in the volume mount (see the architecture doc on traversal and prefix-collision defence).
- Pi runs with `PI_OFFLINE=1` and a session directory on a controlled volume outside any project tree.
