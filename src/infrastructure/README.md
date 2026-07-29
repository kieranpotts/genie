# Security hardening infrastructure

The Pi extensions are designed to be used in the context of a wider agent
harness infrastructure, provisioned through the configuration in this
directory. It is designed in
[../../docs/solution.md](../../docs/solution.md), which is the source of truth
for *why* the boundary is shaped as it is; this document is the operator's
entry point to the runnable pieces here.

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
half; the in-Pi controls are the `mcp-client` and `permission-gate` extensions
under `src/extensions/`.

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
the security boundary. Both in-Pi extensions (`mcp-client`, `permission-gate`)
are baked into the hardened image, so once it is built they are present in the
agent.

**1. Configure the host**

```sh
cp src/infrastructure/.env.example src/infrastructure/.env
# Edit src/infrastructure/.env:
#   - ANTHROPIC_API_KEY / OPENAI_API_KEY   (held by the proxy only)
#   - PROJECT_PATH=/absolute/path/to/the/one/project
#   - LITELLM_MASTER_KEY      = $(openssl rand -hex 32)
```

> [!NOTE]
> There is no `MCP_GATEWAY_AUTH_TOKEN`. The Docker MCP gateway enforces bearer
> auth only when bound to localhost outside a container; in the compose stack it
> logs `Authentication disabled (running in container)` and ignores any token
> set. Reachability of port 8811 is scoped by the private `agent-net` bridge
> instead — it is not published to the host, and the pi container is its only
> other member. If you have the variable in an existing `.env`, delete it.

`OLLAMA_HOST` is the address **the proxy** uses to reach Ollama, and the proxy
runs on the host — so it should point at your existing Ollama daemon on
loopback:

```sh
OLLAMA_HOST=http://127.0.0.1:11434
```

Nothing in a container ever talks to Ollama directly. The agent reaches models
only through LiteLLM, and reaches LiteLLM via `LITELLM_HOST` — which *is* the
bridge gateway. Only that one needs to be.

> [!WARNING]
> Do not start a second `ollama serve` bound to the bridge gateway to satisfy
> this. A second daemon runs under a different home directory, so it has its own
> (empty) model store and its own freshly generated `~/.ollama/id_ed25519` — an
> identity not associated with your ollama.com account. Requests to it fail with
> `{"error":"Unauthorized"}` for any `:cloud` model, which surfaces in the agent
> as a LiteLLM `APIConnectionError - OllamaException`. Check with:
>
> ```sh
> curl -s "$OLLAMA_HOST/api/tags"   # must list your models, not {"models":[]}
> ```

**2. Start the model proxy on the host**

```sh
set -a; . src/infrastructure/.env; set +a
litellm --config src/infrastructure/proxy/litellm.config.yaml \
        --host "$LITELLM_HOST" --port "$LITELLM_PORT"
```

Exposes one route per role — `computer-programmer`, `technical-lead`,
`technical-writer`, `security-analyst` — each backed by a capability-tuned
Ollama model from the [modelfiles][modelfiles] project. The agent never holds a
provider credential of any kind.

Those Ollama models must exist before the routes resolve:

```sh
ollama list   # expects computer-programming, technical-reasoning,
              #         prose-writing, security-analysis
```

If any are missing, build and create them from the modelfiles project. Whether
they are cloud-backed or local is that project's `profile` decision, and is
deliberately out of scope here:

```sh
./run/build                # cloud-backed models
./run/build workstation    # local models
ollama create <capability> -f ./dist/<profile>/<capability>/Modelfile
```

[modelfiles]: https://github.com/kieranpotts/modelfiles

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

Entering the container lands you in the hardened Pi harness, with your shell's
working directory set to the project at `/workspace`:

```sh
docker compose -f src/infrastructure/compose.yaml exec pi bash
```

```
pi-container:/workspace$
```

If you land in `~` instead, the shell says so on entry — the project volume is
not mounted, and `PROJECT_PATH` in `.env` is the thing to check. That directory
is the operator's, and is set by `PI_PROJECT_DIR`. The agent has no working
directory in this container at all — it has no shell and no local file tools.

The agent starts automatically. It is launched by the shell (`~/.bashrc` calls
`start-pi`) rather than being the container's main process, which is what makes
`/quit` useful: it returns you to a shell **inside** the container, with the
harness list printed, instead of stopping the container. Run `start-pi` to go
back in, or `harnesses` to re-show the list.

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ HARDENED AGENT CONTAINER                                                     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

`start-pi` supplies `--model` (the proxy route, from `PI_MODEL`),
`--no-builtin-tools`, so the `mcp_*` tools are the only file tools and the agent
has no shell, and `--no-approve` (see below). These flags live in the image, not
in `compose.yaml`, precisely so they cannot be lost by an override.

An interactive shell aliases `pi` to `start-pi`, so the name an operator already
knows gets the security profile too. That alias is a convenience, not a control:
it exists only in interactive shells, so `docker compose exec pi pi …` never sees
it, and `\pi`, `command pi`, and `/usr/local/bin/pi` all step around it. Raw `\pi`
bypasses the profile — use it only when debugging the harness itself, and note
that doing so re-enables Pi's built-in `read`/`grep`/`find`/`edit` against the
project mount below.

### Project trust

Pi asks `Trust project folder?` whenever the working tree holds trust-requiring
resources — `.agents/skills` in the project **or any ancestor directory**, or a
`.pi/` config directory. Trust is not cosmetic: it lets Pi load project
settings, install missing project packages, and **execute project extensions
inside Pi's own process** — alongside `permission-gate` rather than behind it.

The harness therefore decides this up front rather than prompting, via
`PI_PROJECT_TRUST` (`compose.yaml`), which `start-pi` turns into Pi's
`--approve` / `--no-approve`:

| `PI_PROJECT_TRUST` | Flag           | Effect                                                          |
| ------------------ | -------------- | --------------------------------------------------------------- |
| `deny` (default)   | `--no-approve` | Project skills and settings are not loaded. No project code runs. |
| `approve`          | `--approve`    | Project skills and settings load. Project extensions execute.     |

Anything else is an error, so a typo fails closed rather than silently granting
trust.

Deciding it here is what makes a **non-interactive** run possible: the prompt
would otherwise block, and because the agent directory is a tmpfs that never
persists `trust.json`, it would block on *every* run rather than just the first.
Both flags short-circuit ahead of the trust store, so the decision is
deterministic either way.

To land in the shell without starting an agent — inspecting the boundary, or
running the checks below — set `PI_AUTOSTART=0`:

```sh
docker compose -f src/infrastructure/compose.yaml exec -e PI_AUTOSTART=0 pi bash
```

Note that the container's own main process is `sleep`, not an agent: `up -d`
has no operator attached, so nothing should be running there unwatched. Agents
exist only for the length of a session someone is actually sitting in.

**6. Browse the project (as the operator)**

The project is mounted **read-only** at `/workspace`, which is where your
shell starts — so `ls` shows exactly what the agent is working against. To look
without starting an agent at all:

```sh
docker compose -f src/infrastructure/compose.yaml exec -e PI_AUTOSTART=0 pi bash
```

This mount is for **you**, not the agent. The agent has no tool that can read it
— `--no-builtin-tools` removes Pi's own `read`, `grep`, `find`, and `edit`, and
no extension restores local file or shell access — so it still reaches project
files only through the `mcp_*` tools, where the access is mediated and logged.
Your own shell is unrestricted; you are not the threat model.

This used to be enforced by a path fence in an `audited-tools` extension, which
policed the same boundary from inside the agent's own process. That extension
was removed: a cooperative guard is weaker than not having the capability. See
`TODO.md`.

Because the mount is read-only, nothing in this container can modify the project
through it. The MCP filesystem server holds the only writable handle, which is
what keeps the change trail complete.

**7. Verify the boundary**

| Check | How | Expect |
|---|---|---|
| Agent holds no cloud keys | `docker compose -f src/infrastructure/compose.yaml exec pi env \| grep -i api_key` | no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| Project mount is read-only | `docker compose ... exec pi touch /workspace/x 2>&1` | `Read-only file system` |
| Agent has no Docker socket | `docker compose ... exec pi ls -l /var/run/docker.sock 2>&1` | no such file |
| Mediated read works | ask the agent to read a file in the project | returns content via an `mcp_*` tool |
| Agent has no local tools | ask it to run a shell command, or to read `/workspace/README.md` without MCP | it has no such tool to call; only `mcp_*` tools are offered |
| Traversal denied | ask it to read `../../etc/passwd` | denied at the MCP boundary |
| Sensitive file refused | ask it to read `.env` in the project | refused before the call runs; the call log shows `"outcome":"blocked","confirmation":"not-offered"` |
| Write requires approval | ask it to write a file | a confirmation prompt appears; on approve, write succeeds |
| Default-deny on timeout | ignore the prompt for 60s | the write is blocked; the call log shows `"confirmation":"timeout"` |
| Reads are recorded | ask it to read any ordinary project file | the call log gains an `"outcome":"allowed","confirmation":"not-required"` line naming the path |
| Gateway starts hardened | `docker compose ... up` then `docker compose ... ps` | `mcp-gateway` is healthy with `cap_drop: ALL` + read-only rootfs. If it fails to start, relax `cap_drop` to the minimum it reports needing (see the compose comment). |

**8. Inspect the audit trail**

The log lives on the `pi-logs` volume, outside the agent's read-only rootfs. It
records **every** tool call the agent makes — reads included, which are never
prompted for — one JSON line each:

```sh
docker compose -f src/infrastructure/compose.yaml exec pi cat /var/log/pi/permission-gate/calls.jsonl
```

Each line carries two independent fields: `outcome` (`allowed` / `blocked`) says
whether the call ran, and `confirmation` says whether a human was involved and
what they said. Keeping them apart is what lets a review separate a policy
refusal from an operator's rejection by field rather than by reading prose:

The image has no `jq` — it is a hardened runtime, not an analysis box — so pipe
the log out to the host and query it there:

```sh
LOG='docker compose -f src/infrastructure/compose.yaml exec -T pi cat /var/log/pi/permission-gate/calls.jsonl'

# Everything that did not run, and why — by cause, not by grepping English.
$LOG | jq -r 'select(.outcome=="blocked") | [.confirmation, .tool, .detail] | @tsv'

# Refused outright by policy: no approval path was ever offered.
$LOG | jq 'select(.confirmation=="not-offered")'

# Which MCP tools are actually in use — the working set for the gateway's
# `--tools` allowlist, which should be established from this, not guessed.
$LOG | jq -r .tool | sort | uniq -c | sort -rn
```

Two limits to know before relying on it:

- **It records attempts, not results.** The `tool_call` hook fires before the
  call runs, so a read the MCP server then refuses — traversal, or a path
  outside the allowed directory — appears here as `allowed`. Closing that needs
  the `tool_result` hook or a gateway-side `after:` interceptor; see `TODO.md`.
- **Paths, never content.** `detail` carries the path a call named and nothing
  it returned. Logging what was read would copy the secrets out of the files and
  into the audit trail.

> [!IMPORTANT]
> The `pi-logs` volume must be owned by the agent's uid (1001) or the log fails
> **silently** — the sink swallows write errors so a logging failure cannot change
> a tool's outcome. Ownership is seeded from the image, so a volume created
> before that layer existed is still `root:root`. Fix it once:
>
> ```sh
> docker compose -f src/infrastructure/compose.yaml down
> docker volume rm pi-secure-agent_pi-logs
> ```

## Troubleshooting

**The agent prints its reasoning, then stops.** Typically after something like
*"I should explore the directory structure"*, with no error and no further
output. This is a tool-calling failure, not a hang: the model asked for a tool
and the request never became a tool call, so there was nothing to run and
nothing to report.

The usual cause is a `ollama/` prefix in `proxy/litellm.config.yaml` where
`ollama_chat/` is required. That integration drops tool-call deltas when
streaming, and delivers the call as assistant text instead — the agent shows a
bare JSON object like `{"name": "mcp_list_directory", "arguments": {…}}` and
stops. See the warning in that file.

What makes this one expensive to diagnose is that every layer looks healthy, and
the obvious checks all pass:

| Check | What it shows |
|---|---|
| `docker logs pi-secure-agent-mcp-gateway-1` | gateway up, 11 tools listed, client initialized — but no `Calling tool …` lines |
| `/var/log/pi/permission-gate/calls.jsonl` | absent or stale: no tool call reached an extension |
| a `curl` tool test against the proxy | **passes** — non-streaming works under both prefixes |
| the session transcript | one assistant message, `"stopReason":"stop"`, thinking only, no `tool_call` entry |

The transcripts under `/home/pi/sessions/` are the fastest way in: if no session
has ever contained a `tool_call` entry, the problem is upstream of every
security control in this repo. Reproduce it directly with a streaming request:

```sh
docker compose -f src/infrastructure/compose.yaml exec pi node -e '
fetch("http://host-gateway:4000/v1/chat/completions", { method: "POST",
  headers: { "content-type": "application/json",
             authorization: "Bearer " + process.env.LITELLM_MASTER_KEY },
  body: JSON.stringify({ model: "computer-programmer", stream: true,
    messages: [{ role: "user", content: "List /tmp. Use the tool." }],
    tools: [{ type: "function", function: { name: "list_directory",
      parameters: { type: "object", properties: { path: { type: "string" } } } } }] })
}).then(r => r.text()).then(t => console.log(
  t.includes("tool_calls") ? "OK: tool_call deltas present" : "BROKEN: no tool_call deltas"))'
```

**Verifying the extensions are loaded.** `pi list` is *not* the check — it lists
installed packages, and these extensions are auto-discovered from
`~/.pi/agent/extensions/*/index.ts` instead, so it correctly reports "No
packages installed" on a healthy container. Confirm loading by the tools the
model is offered, or by watching for audit-log entries.

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
