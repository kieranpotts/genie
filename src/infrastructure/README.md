# Security hardening infrastructure

The Pi extensions are designed to be used in the context of a wider agent
harness infrastructure, provisioned through the configuration in this
directory. It is defined in
[../../docs/local-agent-architecture.md](../../docs/local-agent-architecture.md),
which is the source of truth; this document is the operator's entry point to
the runnable pieces here.

> [!IMPORTANT]
> This directory is **not** a Pi extension and is **not** installable.
> `./run/install` installs only the directories under `src/extensions/`.
> Nothing under `src/infrastructure/` is ever copied into
> `~/.pi/agent/extensions/`.

Central to this infrastructure is a **hardened container**. The goal is
filesystem isolation first, credential isolation second, auditability third. A
fully compromised Pi process should reach no project files outside its scope,
no host files, no cloud credentials, and no host Docker control — and every
filesystem action it takes should be logged.

The architecture has two halves. This directory is the host-and-container
half; the in-Pi controls are the `mcp-client`, `audited-tools`, and
`permission-gate` extensions under `src/extensions/`.

## Components

| Component | Location | Role |
|---|---|---|
| Host env contract | `.env.example` | Documents every value the host must provide; the real `.env` is gitignored and holds the cloud keys |
| LiteLLM proxy | `proxy/litellm.config.yaml` | Host-side model router holding ALL cloud API keys; the agent gets only its endpoint and a master key |
| Hardened agent image | `pi-container/Dockerfile` | Non-root, no-keys, no-`docker.sock`, no-mounts Pi image; capability-drop and limits applied at runtime by compose |
| MCP filesystem boundary | `mcp/toolkit/catalog.yaml` + `compose.yaml` (`mcp-gateway`) | Catalog defines the `mcp/filesystem` server's allowed dir + mount (the actual boundary); the gateway spawns it from the catalog and fronts it over SSE. Sole holder of filesystem access — and of the Docker socket (see trade-off below) |
| Compose wiring | `compose.yaml` | `agent-net` network, the project volume, the gateway, and the runtime-hardened pi-container |

## Trust boundaries

- **Host:** Ollama (local inference) and the LiteLLM proxy (holds the keys). Both bind to the Docker bridge gateway, not `0.0.0.0`.
- **`agent-net`:** the pi-container (no keys, no FS, no socket) and the MCP server (the sole filesystem gatekeeper). The agent reaches files only through MCP tool calls and reaches models only through the proxy endpoint.

See the architecture doc for the full boundary diagrams.

## Operator runbook

End-to-end procedure to bring the stack up against a real project and verify
the security boundary. The three in-Pi extensions (`mcp-client`,
`audited-tools`, `permission-gate`) are baked into the hardened image, so once
it is built they are present in the agent.

**1. Configure the host**

```sh
cp src/infrastructure/.env.example src/infrastructure/.env
# Edit src/infrastructure/.env:
#   - ANTHROPIC_API_KEY / OPENAI_API_KEY   (held by the proxy only)
#   - PROJECT_PATH=/absolute/path/to/the/one/project
#   - LITELLM_MASTER_KEY      = $(openssl rand -hex 32)
#   - MCP_GATEWAY_AUTH_TOKEN  = $(openssl rand -hex 32)
```

Ensure Ollama is bound to the bridge gateway (`OLLAMA_HOST`), not `0.0.0.0`.

**2. Start the model proxy on the host**

```sh
set -a; . src/infrastructure/.env; set +a
litellm --config src/infrastructure/proxy/litellm.config.yaml \
        --host "$LITELLM_HOST" --port "$LITELLM_PORT"
```

Exposes `fast` (local Ollama) and `capable` (cloud); `capable` falls back to
`fast` when the cloud is unreachable. The proxy holds the cloud keys; the agent
never will.

**3. Build the hardened agent image**

```sh
docker build -f src/infrastructure/pi-container/Dockerfile -t pi-agent:hardened .
```

No keys, no socket, no project source in the image. The three security
extensions are copied into `~/.pi/agent/extensions/` inside it.

**4. Bring up the boundary**

```sh
docker compose -f src/infrastructure/compose.yaml --env-file src/infrastructure/.env up -d
```

This starts `agent-net`, the project volume (bound to `PROJECT_PATH`), the
`mcp-gateway` (which spawns and fronts the `mcp/filesystem` server over SSE),
and the hardened `pi` container.

**5. Start an agent**

The container does not start an agent by itself. Entering it drops you into a
shell that lists the harnesses available inside:

```sh
docker compose -f src/infrastructure/compose.yaml exec pi bash
```

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ HARDENED AGENT CONTAINER                                                     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

Then start Pi with the security profile applied:

```sh
start-pi
```

`start-pi` supplies `--model` (the proxy route, from `PI_MODEL`) and
`--no-builtin-tools`, so the audited replacements are the only file tools. These
flags live in the image, not in `compose.yaml`, precisely so they cannot be lost
by an override. Running `pi` directly bypasses them — use it only when debugging
the harness itself. Re-show the harness list at any time with `harnesses`.

To skip the shell and go straight into a throwaway agent session:

```sh
docker compose -f src/infrastructure/compose.yaml run --rm pi start-pi
```

**6. Verify the boundary**

| Check | How | Expect |
|---|---|---|
| Agent holds no cloud keys | `docker compose -f src/infrastructure/compose.yaml exec pi env \| grep -i api_key` | no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| Agent has no project mount | `docker compose ... exec pi ls /projects 2>&1` | absent / empty — files reached only via MCP |
| Agent has no Docker socket | `docker compose ... exec pi ls -l /var/run/docker.sock 2>&1` | no such file |
| Mediated read works | ask the agent to read a file in the project | returns content via `mcp_*`/audited `read` |
| Traversal denied | ask it to read `../../etc/passwd` | denied at the boundary; `audit.jsonl` shows a `denied` line |
| Sensitive file refused | ask it to read `.env` in the project | refused; the audited-tools log shows `sensitive file refused` |
| Write requires approval | ask it to write a file | a confirmation prompt appears; on approve, write succeeds |
| Default-deny on timeout | ignore the prompt for 60s | the write is blocked; the permission-gate log shows `timed out (default deny)` |
| Gateway starts hardened | `docker compose ... up` then `docker compose ... ps` | `mcp-gateway` is healthy with `cap_drop: ALL` + read-only rootfs. If it fails to start, relax `cap_drop` to the minimum it reports needing (see the compose comment). |

**7. Inspect the audit trail**

Both logs live on the `pi-logs` volume, outside the agent's read-only rootfs:

```sh
docker compose -f src/infrastructure/compose.yaml exec pi cat /var/log/pi/audited-tools/audit.jsonl    # file ops
docker compose -f src/infrastructure/compose.yaml exec pi cat /var/log/pi/permission-gate/audit.jsonl  # approvals
```

## The docker.sock trade-off (read this)

The Docker MCP Toolkit gateway **spawns and manages** the filesystem MCP server
itself, so it requires the Docker socket. The architecture confines that
privilege to the **gateway** — the agent (`pi`) still has no socket, no keys, and
no project mount. This is the deliberate, contained version of the Option C
docker.sock concern from the architecture doc: the privilege exists, but on a
component the agent cannot reach, not on the agent itself.

The gateway is still hardened as far as its role allows: `cap_drop: [ALL]`,
`no-new-privileges`, a read-only rootfs with in-memory tmpfs, and resource
limits. The socket is the irreducible privilege; everything else is locked down.
For stricter environments, replace the raw socket bind with a
[docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)
allowlisting only the container APIs the gateway needs.

If even the proxied socket is unacceptable, the alternative is to run `mcp/filesystem`
directly (stdio) without the Toolkit gateway and bridge it to the agent — at the
cost of the Toolkit's catalog/secret/network controls.

> [!IMPORTANT]
> **The boundary is defined in `mcp/toolkit/catalog.yaml`, not in `compose.yaml`.**
> The gateway learns the filesystem server's allowed directory (its `command`
> arg) and what it can see (its `volumes`) from that catalog entry — `--oci-ref`
> alone does not carry them. The gateway flags
> (`docker mcp gateway run --transport streaming --catalog … --servers filesystem --block-network`)
> and the catalog schema were checked against the installed Toolkit, but the
> catalog format varies by Toolkit version and **must be verified on first
> bring-up**: run with `--dry-run` to validate config without listening, and use
> the traversal test in the verification table as the functional proof that the
> boundary holds. All three images are digest-pinned (re-pin commands are in the
> respective files).

## Security notes

- The real `.env` is gitignored (`.env`, `.env.*`, except `.env.example`). It holds cloud API keys; never commit it.
- Keys live only on the host (in the proxy). They are never injected into the pi-container and never baked into any image.
- The MCP server is the only component with filesystem access. Path enforcement lives in its configuration/code, not only in the volume mount (see the architecture doc on traversal and prefix-collision defence).
- Pi runs with `PI_OFFLINE=1` and a session directory on a controlled volume outside any project tree.
