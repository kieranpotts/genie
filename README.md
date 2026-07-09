# Pi [![CI check pipeline status][ci-badge]][ci-workflow]

**🚧 Under construction.**

**My AI agent harness, built around the Pi coding agent framework.**

Pi is a minimal coding agent, a baseline framework for building your own
harness, rather a finished product. Out of the box it runs with full system
permissions and zero security controls. This project ships a suite of Pi
extensions, plus supporting infrastructure including a hardened container
and a gated MCP server, to compose a safe environment in which to run agents.

Together which my [agent skills][agent-skills] and [Modelfiles](ollama-modelfiles)
for Ollama, this is my custom AI agent harness.

> [!WARNING]
> These tools are built for my personal use and they are volatile. They
> may change, break, or be removed at any time. They carry no support or
> stability guarantees. You're welcome, of course, to fork this repository and
> use it as a basis for engineering your own agent harness around Pi. But I
> don't recommend you use these tools as-is.

## 📋 Requirements

The core requirement, of course, is the [Pi coding agent][pi], installed locally
and in your `PATH`:

```sh
npm install -g @earendil-works/pi-coding-agent
```

The installer warns if `pi` is not found, but still stages the extensions so
they are ready once Pi is installed.

The `./run/install` script requires Bash. If you don't have this, no worries,
you can just copy the extensions into `~/.pi/agent/extensions/` yourself.
See the manual installation instructions in the section below.

## 📦 Installation

make the `./run/instal` script executable:

```sh
chmod +x run/install
```

Then run it from the root of this repository:

```sh
./run/install
```

It copies extensions from this repository's `src/extensions/` directory into
Pi's extensions directory, `~/.pi/agent/extensions/`, where Pi will
auto-discover them next time it starts.

The same command can be used to update the installed extensions to the latest
versions. If an extension is already installed, it is first backed up to
`~/.pi/agent/extensions/<name>.backup.<timestamp>/` before overwriting.

With no arguments, every available extension is installed. You can target
specific extensions to install. Other options are:

| Invocation              | Effect                                |
| ----------------------- | ------------------------------------- |
| `./run/install`         | Install all available extensions.     |
| `./run/install <name>…` | Install one or more named extensions. |
| `./run/install -l`      | List available extensions and exit.   |
| `./run/install --list`  | Same as `-l`.                         |
| `./run/install -h`      | Show usage help and exit.             |
| `./run/install --help`  | Same as `-h`.                         |

Examples:

```sh
./run/install                             # Install all extensions.
./run/install pickling-penguins           # Install the picking penguins extension only.
./run/install mcp-client permission-gate  # Install these two extensions only.
./run/install --list                      # See what's available to install.
```

Alternatively, you can manually install extensions simply by copying them
over:

```sh
cp -R src/extensions/pickling-penguins ~/.pi/agent/extensions/pickling-penguins
```

After installing, start a fresh Pi session:

```sh
pi
```

Or, if you're already in Pi, use the `/reload` prompt to reload all
extensions, skills, etc.:

```sh
/reload
```

> [!TIP]
> `/reload` is also useful for hot-reloading extensions during their development.

## 🧭 Usage

### `pickling-penguins`

The `pickling-penguins` extension is cosmetic only. It simply replaces Pi's
default "Working..." status line with randomly composed nonsense, like
"Flambéing the singularity..." and "Pickling penguins".

[👉 README](../src/extensions/pickling-penguins/README.md).

### `audited-tools`

This extension instals audited replacements for Pi's built-in `read`, `write`,
`ls`, and `bash` tools.

For this to work. Pi MUST be run with the `--no-builtin-tools` option.

The audited filesystem tools are confined to an allowlisted workspace root and
refuse sensitive filenames (eg. `.env*`, `id_rsa`, `*.pem`). The `bash`
replacement tool rejects control operators and audits invoked program calls
against an allowlist.

Every call to every audited tool, whether the call is allowed or denied, is
appended to an audit log in the JSONL format. This can be configured via the
`AUDITED_TOOLS_ROOT`, `AUDITED_TOOLS_LOG`, and `AUDITED_BASH_ALLOWLIST`
environment variables.

[👉 README](../src/extensions/audited-tools/README.md).

### `permission-gate`

Requires explicit, interactive confirmation before any mutating tool call
(`write`, `edit`, `bash`) runs. Read-only tools pass through silently.

Confirmation defaults to deny on timeout (60s) or when there's no
interactive UI.

Every decision is logged, configured via `PERMISSION_GATE_LOG`.

This extension is complementary to `audited-tools`. While that extension
*where/what* is allowed, this one enforces *whether the human agrees*.

[👉 README](../src/extensions/permission-gate/README.md).

### `mcp-client`

Gives Pi an MCP client so it can reach a filesystem MCP server through the
Docker MCP Toolkit gateway, rather than mounting the project filesystem
directly.

Tools the server exposes are registered under an `mcp_` prefix (`read_file` →
`mcp_read_file`).

This extension does nothing unless the `MCP_GATEWAY_URL` environment variable
is set.

[👉 README](../src/extensions/mcp-client/README.md).

### 🔒 Running Pi inside the hardened container

The Pi extensions are designed to be used in the context of a wider agent
harness infrastructure, which can be provisioned through configuration in
this repository. It is defined in
[docs/local-agent-architecture.md](./docs/local-agent-architecture.md), which
is the source of truth; this section is the operator's entry point to the
runnable pieces under `src/infrastructure/`.

> [!IMPORTANT]
> The `src/infrastructure/` directory is **not** a Pi extension and is **not**
> installable. `./run/install` installs only the directories under
> `src/extensions/`. Nothing under `src/infrastructure/` is ever copied into
> `~/.pi/agent/extensions/`.

Central to this infrastructure is a **hardened container**. The goal is
filesystem isolation first, credential isolation second, auditability third. A
fully compromised Pi process should reach no project files outside its scope,
no host files, no cloud credentials, and no host Docker control — and every
filesystem action it takes should be logged.

The architecture has two halves. The infrastructure under
`src/infrastructure/` is the host-and-container half; the in-Pi controls are
the `mcp-client`, `audited-tools`, and `permission-gate` extensions described
above.

#### Components

| Component | Location | Role |
|---|---|---|
| Host env contract | `src/infrastructure/.env.example` | Documents every value the host must provide; the real `.env` is gitignored and holds the cloud keys |
| LiteLLM proxy | `src/infrastructure/proxy/litellm.config.yaml` | Host-side model router holding ALL cloud API keys; the agent gets only its endpoint and a master key |
| Hardened agent image | `src/infrastructure/pi-container/Dockerfile` | Non-root, no-keys, no-`docker.sock`, no-mounts Pi image; capability-drop and limits applied at runtime by compose |
| MCP filesystem boundary | `src/infrastructure/mcp/toolkit/catalog.yaml` + `compose.yaml` (`mcp-gateway`) | Catalog defines the `mcp/filesystem` server's allowed dir + mount (the actual boundary); the gateway spawns it from the catalog and fronts it over SSE. Sole holder of filesystem access — and of the Docker socket (see trade-off below) |
| Compose wiring | `src/infrastructure/compose.yaml` | `agent-net` network, the project volume, the gateway, and the runtime-hardened pi-container |

#### Trust boundaries

- **Host:** Ollama (local inference) and the LiteLLM proxy (holds the keys). Both bind to the Docker bridge gateway, not `0.0.0.0`.
- **`agent-net`:** the pi-container (no keys, no FS, no socket) and the MCP server (the sole filesystem gatekeeper). The agent reaches files only through MCP tool calls and reaches models only through the proxy endpoint.

See the architecture doc for the full boundary diagrams.

#### Operator runbook

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
docker compose -f src/infrastructure/compose.yaml --env-file src/infrastructure/.env up
```

This starts `agent-net`, the project volume (bound to `PROJECT_PATH`), the
`mcp-gateway` (which spawns and fronts the `mcp/filesystem` server over SSE),
and the hardened `pi` container. Run Pi with `--no-builtin-tools` so the
audited replacements are the only file tools.

**5. Verify the boundary**

| Check | How | Expect |
|---|---|---|
| Agent holds no cloud keys | `docker compose -f src/infrastructure/compose.yaml exec pi env \| grep -i api_key` | no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| Agent has no project mount | `docker compose ... exec pi ls /projects 2>&1` | absent / empty — files reached only via MCP |
| Agent has no Docker socket | `docker compose ... exec pi ls -l /var/run/docker.sock 2>&1` | no such file |
| Mediated read works | ask the agent to read a file in the project | returns content via `mcp_*`/audited `read` |
| Traversal denied | ask it to read `../../etc/passwd` | denied at the boundary; `audit.jsonl` shows a `denied` line |
| Sensitive file refused | ask it to read `.env` in the project | refused; `audit.jsonl` shows `sensitive file refused` |
| Write requires approval | ask it to write a file | a confirmation prompt appears; on approve, write succeeds |
| Default-deny on timeout | ignore the prompt for 60s | the write is blocked; `permissions.jsonl` shows `timed out (default deny)` |
| Gateway starts hardened | `docker compose ... up` then `docker compose ... ps` | `mcp-gateway` is healthy with `cap_drop: ALL` + read-only rootfs. If it fails to start, relax `cap_drop` to the minimum it reports needing (see the compose comment). |

**6. Inspect the audit trail**

Both logs live on the `pi-sessions` volume, outside the agent's read-only rootfs:

```sh
docker compose -f src/infrastructure/compose.yaml exec pi cat /home/pi/sessions/audit.jsonl       # file ops
docker compose -f src/infrastructure/compose.yaml exec pi cat /home/pi/sessions/permissions.jsonl # approvals
```

#### The docker.sock trade-off (read this)

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
> **The boundary is defined in `src/infrastructure/mcp/toolkit/catalog.yaml`, not in `compose.yaml`.**
> The gateway learns the filesystem server's allowed directory (its `command`
> arg) and what it can see (its `volumes`) from that catalog entry — `--oci-ref`
> alone does not carry them. The gateway flags
> (`docker mcp gateway run --transport sse --catalog … --servers filesystem --block-network`)
> and the catalog schema were checked against the installed Toolkit, but the
> catalog format varies by Toolkit version and **must be verified on first
> bring-up**: run with `--dry-run` to validate config without listening, and use
> the traversal test in the verification table as the functional proof that the
> boundary holds. All three images are digest-pinned (re-pin commands are in the
> respective files).

#### Security notes

- The real `.env` is gitignored (`.env`, `.env.*`, except `.env.example`). It holds cloud API keys; never commit it.
- Keys live only on the host (in the proxy). They are never injected into the pi-container and never baked into any image.
- The MCP server is the only component with filesystem access. Path enforcement lives in its configuration/code, not only in the volume mount (see the architecture doc on traversal and prefix-collision defence).
- Pi runs with `PI_OFFLINE=1` and a session directory on a controlled volume outside any project tree.

## 📓 Developer documentation

See the [contributing guidelines](./CONTRIBUTING.md).

## 🎨 Design docs

See the [docs/](./docs/) directory for design decisions and trade-offs.

-----

Copyright © 2020-present Kieran Potts, [MIT license](./LICENSE.txt)

Acknowledgements: The structure of this project was inspired by
Owain Lewis's [`pi-extensions`][owain-pi-extensions].
Owain's "funny status" extension was the direct inspiration for
[`pickling-penguins`](../src/extensions/pickling-penguins/README.md),
my first Pi extension. The [Pi example extensions][pi-example-extensions]
are another useful reference point.

[agent-skills]: https://github.com/kieranpotts/skills
[ci-badge]: https://github.com/kieranpotts/pi/actions/workflows/check.yaml/badge.svg
[ci-workflow]: https://github.com/kieranpotts/pi/actions/workflows/check.yaml
[ollama-modelfiles]: https://github.com/kieranpotts/modelfiles
[owain-pi-extensions]: https://github.com/owainlewis/pi-extensions/
[pi]: https://pi.dev/
[pi-example-extensions]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/README.md
