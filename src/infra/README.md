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
| MCP filesystem boundary | `compose.yaml` (`mcp-filesystem` + `mcp-gateway`) | Docker MCP Toolkit filesystem server scoped to one project volume; the only component with filesystem access, fronted by the gateway over HTTP/SSE | 4 (done) |
| Compose wiring | `compose.yaml` | `agent-net` network, the project volume, the MCP server + gateway, and the runtime-hardened pi-container | 4 (done) |

## Trust boundaries

- **Host:** Ollama (local inference) and the LiteLLM proxy (holds the keys). Both bind to the Docker bridge gateway, not `0.0.0.0`.
- **`agent-net`:** the pi-container (no keys, no FS, no socket) and the MCP server (the sole filesystem gatekeeper). The agent reaches files only through MCP tool calls and reaches models only through the proxy endpoint.

See the architecture doc for the full boundary diagrams.

## Quick start

> Not yet runnable end to end — this fills in as steps 2–4 land. The intended flow:

1. Copy the env contract and fill it in on the host:

   ```sh
   cp src/infra/.env.example src/infra/.env
   # edit src/infra/.env — add cloud API keys and PROJECT_PATH
   ```

2. Ensure Ollama is bound to the bridge gateway (see `OLLAMA_HOST` in `.env`).
3. Start the model proxy on the host (holds the keys; binds to the gateway):

   ```sh
   set -a; . src/infra/.env; set +a
   litellm --config src/infra/proxy/litellm.config.yaml \
           --host "$LITELLM_HOST" --port "$LITELLM_PORT"
   ```

   The proxy exposes `fast` (local Ollama) and `capable` (cloud), with `capable`
   falling back to `fast` when the cloud is unreachable.

4. Build the hardened agent image (build context is the repo root):

   ```sh
   docker build -f src/infra/pi-container/Dockerfile -t pi-agent:hardened .
   ```

   The image bakes in no keys, no socket, and no project source. Capability
   dropping, `no-new-privileges`, read-only rootfs, and resource limits are
   applied at runtime by compose (step 4).

5. Start the network, MCP boundary, and hardened agent:

   ```sh
   docker compose -f src/infra/compose.yaml --env-file src/infra/.env up
   ```

   This stands up `agent-net`, the project volume (bound to `PROJECT_PATH`,
   exposed to the agent only through the MCP server), the `mcp-filesystem`
   server + `mcp-gateway` (HTTP/SSE), and the hardened `pi` container with no
   keys, no socket, and no project mount.

6. Install the in-Pi security extensions into the agent container (steps 5–7).
   Until the `mcp-client` extension (step 5) exists, the agent has the model
   route working but cannot yet drive the MCP filesystem boundary.

> [!NOTE]
> The `docker/mcp-gateway` image name and its flags follow the Docker MCP
> Toolkit gateway pattern and may need adjusting to your installed Toolkit
> version. The `mcp/filesystem` server and the boundary semantics are stable;
> the gateway transport wiring is the part to verify on first run.

The full operator runbook — including how to inspect the audit log and confirm a denied operation — is delivered in step 8.

## Security notes

- The real `.env` is gitignored (`.env`, `.env.*`, except `.env.example`). It holds cloud API keys; never commit it.
- Keys live only on the host (in the proxy). They are never injected into the pi-container and never baked into any image.
- The MCP server is the only component with filesystem access. Path enforcement lives in its configuration/code, not only in the volume mount (see the architecture doc on traversal and prefix-collision defence).
- Pi runs with `PI_OFFLINE=1` and a session directory on a controlled volume outside any project tree.
