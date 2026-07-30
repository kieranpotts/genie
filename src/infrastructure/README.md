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

- **Host:** Ollama (local inference) and the LiteLLM proxy (holds the keys).
  The proxy must bind to an address reachable from `agent-net` — which since
  that network became `internal: true` means **its gateway, `172.31.60.1`**, and
  no longer docker0's `172.17.0.1`. A proxy left on `127.0.0.1` was never
  reachable and still is not.

  > [!IMPORTANT]
  > If the agent cannot reach the model after an upgrade, this is the first
  > thing to check. The symptom is a connection failure to `host-gateway:4000`
  > from inside the pi container. `ECONNREFUSED` means the route is fine and
  > nothing is listening on that address (bind the proxy wider);
  > `ENETUNREACH` means the `extra_hosts` entry in `compose.yaml` has drifted
  > from the pinned `gateway:` on `agent-net`.
- **`agent-net`:** the pi-container (no keys, no FS, no socket) and the **mcp-gateway**, which is the agent's only MCP endpoint and which spawns the filesystem MCP server (the sole filesystem gatekeeper) through the Docker socket. The agent reaches files only through MCP tool calls and reaches models only through the proxy endpoint. Note that compose starts two containers here, not three: the MCP server is the gateway's child, which is why the socket grant below exists.

  The network is **`internal: true`**: no default route, no outbound NAT, so
  nothing on it can reach the internet. This also means the **gateway** has no
  egress, which is why `--verify-signatures` is not enabled — it needs the
  sigstore TUF mirror. Image pulls are unaffected: the gateway asks the *host
  daemon* to pull over the Docker socket, and the daemon has its own network.

See [../../docs/solution.md](../../docs/solution.md) for the full boundary
diagrams.

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
only through LiteLLM, and reaches LiteLLM via `LITELLM_HOST` — which is the
bridge gateway. Only that one needs to be.

`LITELLM_HOST` is the address the proxy **binds** to, and it must be
`agent-net`'s gateway:

```sh
LITELLM_HOST=172.31.60.1
```

> [!WARNING]
> This changed when `agent-net` became `internal: true`. It was previously
> docker0's `172.17.0.1`, which an internal network has no route to — so an
> older `.env` carrying that value produces an agent that starts cleanly and
> cannot reach a model. Keep it equal to the `gateway:` pinned on `agent-net` in
> `compose.yaml`, and to the `extra_hosts` entry on the `pi` service; the three
> are one address written in three places.
>
> Binding wider (`0.0.0.0`) also works and removes the coupling, but puts a
> proxy holding every cloud API key on every host interface, including your LAN.
> Don't.

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

**2. Check the model routes' prerequisites**

The proxy is started in step 5, *after* the boundary — see the note there for
why. What it will serve is one route per role — `computer-programmer`,
`technical-lead`, `technical-writer`, `security-analyst` — each backed by a
capability-tuned Ollama model from the [modelfiles][modelfiles] project. The
agent never holds a provider credential of any kind.

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

**5. Start the model proxy on the host**

```sh
set -a; . src/infrastructure/.env; set +a
litellm --config src/infrastructure/proxy/litellm.config.yaml \
        --host "$LITELLM_HOST" --port "$LITELLM_PORT"
```

> [!IMPORTANT]
> **This comes after the boundary, not before it.** `LITELLM_HOST` is
> `agent-net`'s gateway address, and that interface does not exist on the host
> until compose creates the network in step 3. Run this first and it fails with
> `Cannot assign requested address`.
>
> Nothing in step 3 needs a model: the `pi` container's PID 1 is `sleep
> infinity`, so no agent exists until step 5. `./run/startup` performs these in
> the same order.

**6. Start an agent**

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

**7. Browse the project (as the operator)**

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

**8. Verify the boundary**

| Check | How | Expect |
|---|---|---|
| Agent holds no cloud keys | `docker compose -f src/infrastructure/compose.yaml exec pi env \| grep -i api_key` | no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| Project mount is read-only | `docker compose ... exec pi touch /workspace/x 2>&1` | `Read-only file system` |
| Agent has no Docker socket | `docker compose ... exec pi ls -l /var/run/docker.sock 2>&1` | no such file |
| Mediated read works | ask the agent to read a file in the project | returns content via an `mcp_*` tool |
| Agent has no local tools | ask it to run a shell command, or to read `/workspace/README.md` without MCP | it has no such tool to call; only `mcp_*` tools are offered |
| Traversal denied | ask it to read `../../etc/passwd` | denied at the MCP boundary |
| Sensitive file refused | ask it to read `.env` in the project | refused before the call runs; the call log shows `"phase":"call","outcome":"blocked","confirmation":"not-offered"` |
| Write requires approval | ask it to write a file | a confirmation prompt appears; on approve, write succeeds |
| Default-deny on timeout | ignore the prompt for 60s | the write is blocked; the call log shows `"confirmation":"timeout"` |
| Reads are recorded | ask it to read any ordinary project file | the call log gains a `"phase":"call","outcome":"allowed","confirmation":"not-required"` line naming the path |
| Results are recorded | ask it to read any ordinary project file | a second `"phase":"result"` line follows with the same `id` and `"result":"ok"` |
| Turns are delimited | give the agent two separate instructions, each causing a tool call | a `"kind":"turn_start"` line precedes each instruction's calls, with `turn` incrementing and the same `session`; the prompt text appears nowhere in the log |
| Secrets are redacted from tool output | put a fake credential in a project file (eg. `aws_access_key_id = AKIAIOSFODNN7EXAMPLE`) and ask the agent to read it and repeat it verbatim | the agent reports `[redacted: aws-access-key-id]` and cannot produce the value; the `result` line carries `"redactions":1,"rules":["aws-access-key-id"]`; the value appears neither in the call log nor in the session transcript on `pi-sessions` |
| Model requests are recorded, as shape only | ask the agent anything that makes it read a file | `"kind":"provider_request"` lines appear with `model`, `messages`, and `approx_bytes` climbing across the turn; no message text, no file content, and no system prompt anywhere in the log |
| A downstream refusal is visible as one | ask it to read `../../etc/passwd` | the `call` line says `"outcome":"allowed"` (the gate admitted it) and the `result` line says `"result":"error"` (the MCP server refused it). This pairing is the thing the trail could not express before. |
| Tool surface is the documented eleven | the tool-surface check below | exactly the eleven `mcp_*` tools listed in `docs/solution.md`; no `bash`, no Git, no web fetch |
| No network binaries | `docker compose ... exec pi sh -c 'for b in git curl wget nc ssh; do command -v $b \|\| echo "$b absent"; done'` | all five absent |
| Gateway starts hardened | `docker compose ... up` then `docker compose ... ps` | `mcp-gateway` is healthy with `cap_drop: ALL` + read-only rootfs. If it fails to start, relax `cap_drop` to the minimum it reports needing (see the compose comment). |
| Egress is blocked | the egress check below | the gateway and the proxy are reachable; every external address is `ENETUNREACH` and DNS does not resolve |

**The egress check.** `agent-net` is `internal: true`, and the hardening table
now claims that as an enforced control rather than an absence of capability — so
it has to be checkable. This uses `node`, because the hardened image
deliberately has no `curl`, `wget`, or `nc` (see the row above):

```sh
docker compose -f src/infrastructure/compose.yaml exec -T pi node -e '
const net = require("net");
const tests = [
  ["MCP gateway      (must work)", "mcp-gateway",  8811],
  ["LiteLLM proxy    (must work)", "host-gateway", 4000],
  ["1.1.1.1:443      (must fail)", "1.1.1.1",       443],
  ["8.8.8.8:53       (must fail)", "8.8.8.8",        53],
];
let i = 0;
(function run() {
  if (i >= tests.length) {
    return require("dns").lookup("registry.npmjs.org", (e, a) =>
      console.log("DNS npmjs        (must fail) => " + (e ? "FAILED(" + e.code + ")" : "RESOLVED " + a)));
  }
  const [label, host, port] = tests[i++];
  const s = net.connect({ host, port, timeout: 4000 });
  const done = (r) => { s.destroy(); console.log(label + " => " + r); run(); };
  s.on("connect", () => done("CONNECTED"));
  s.on("timeout", () => done("TIMEOUT"));
  s.on("error", (e) => done("FAILED(" + e.code + ")"));
})();
'
```

Expected:

```
MCP gateway      (must work) => CONNECTED
LiteLLM proxy    (must work) => CONNECTED
1.1.1.1:443      (must fail) => FAILED(ENETUNREACH)
8.8.8.8:53       (must fail) => FAILED(ENETUNREACH)
DNS npmjs        (must fail) => FAILED(EAI_AGAIN)
```

Read the failures precisely: `ENETUNREACH` on the external rows is the control
working. `ENETUNREACH` on the **LiteLLM** row is a misconfiguration — the
`extra_hosts` entry no longer matches the pinned `gateway:` on `agent-net`.
`ECONNREFUSED` there means the route is correct and the proxy is not listening
on that address.

**The tool-surface check.** `docs/solution.md` enumerates the agent's entire
tool surface, so that list has to be checkable rather than trusted. This asks
the gateway directly, using the same client the agent uses:

```sh
docker compose -f src/infrastructure/compose.yaml exec -T pi \
  sh -c 'node --input-type=module -e "$(cat)"' <<'EOF'
const { McpClient } = await import('/opt/pi/agent/extensions/mcp-client/mcp-client.ts')
const c = new McpClient({ url: process.env.MCP_GATEWAY_URL, fetch: globalThis.fetch })
await c.initialize()
const tools = await c.listTools()
console.log(`${tools.length} tools the agent can call:`)
for (const t of tools) console.log('  mcp_' + t.name)
EOF
```

Expect exactly eleven, all `mcp_*`, all filesystem. Anything else — especially
anything that executes, fetches a URL, or reaches outside `/workspace` — means
the surface has grown and `docs/solution.md` is out of date. Re-run this after
changing the gateway's `--servers`/`--tools` flags, the catalog, or the pinned
`mcp/filesystem` image.

**9. Inspect the audit trail**

The log lives on the `pi-logs` volume, outside the agent's read-only rootfs. It
records **every** tool call the agent makes — reads included, which are never
prompted for:

```sh
docker compose -f src/infrastructure/compose.yaml exec pi cat /var/log/pi/permission-gate/calls.jsonl
```

**A call writes two lines, joined by `id`.** This is the first thing to know
before querying it, because every naive count is otherwise doubled:

| `phase` | Written | Says |
|---|---|---|
| `call` | before the tool runs | what the **gate** decided: `outcome` (`allowed` / `blocked`) and `confirmation` (whether a human was involved, and what they said) |
| `result` | after the tool runs | what the **tool** did: `result` (`ok` / `error`), plus `redactions` and `rules` when a secret-shaped value was replaced in the output |

Both are needed. The gate admits calls but does not perform them, so a read of a
path outside `/workspace` is `allowed` on the `call` line and `error` on the
`result` line — the MCP server refused it, and only the second line knows.
Keeping `outcome` and `confirmation` apart on the first line is likewise what
lets a review separate a policy refusal from an operator's rejection by field
rather than by reading prose.

Neither line ever carries tool *content*. `detail` is the path; the file's
contents are never copied into the trail.

**Two further line kinds carry `kind` rather than `phase`**, so the queries below
are unaffected by either:

```json
{"ts":"…","kind":"turn_start","turn":7,"session":"01936f2e-6b2a-7c31-9e4d-8f1a2b3c4d5e"}
{"ts":"…","kind":"provider_request","model":"computer-programmer","messages":34,"approx_bytes":18422}
```

A `provider_request` line records one outbound model call as **shape only** —
which model, how many messages, how many bytes of serialised body. Never the
payload, which is the entire conversation including every file the agent has
read. Expect several per turn: the agent loops until it stops calling tools, and
`approx_bytes` climbing across those lines is the cheapest available signal that
context is accumulating.

Every `call` line belongs to the turn whose boundary most recently preceded it,
which is what makes "what did the agent do in response to *that* instruction"
answerable from this file rather than by correlating timestamps against a session
transcript on the `pi-sessions` volume. `turn` is an ordinal counted by the
running Pi process from 1 — it starts again at 1 after a restart, `--resume`
included, so `session` and file order are what identify a turn; the number is for
referring to one. The prompt that opened the turn is deliberately **not**
recorded.

The image has no `jq` — it is a hardened runtime, not an analysis box — so pipe
the log out to the host and query it there:

```sh
LOG='docker compose -f src/infrastructure/compose.yaml exec -T pi cat /var/log/pi/permission-gate/calls.jsonl'

# Everything the gate refused, and why — by cause, not by grepping English.
$LOG | jq -r 'select(.phase=="call" and .outcome=="blocked") | [.confirmation, .tool, .detail] | @tsv'

# Refused outright by policy: no approval path was ever offered.
$LOG | jq 'select(.confirmation=="not-offered")'

# Admitted by the gate, then refused downstream by the MCP server. These are
# the calls a trail of attempts alone would have wrongly reported as reads.
$LOG | jq -s '
  (map(select(.phase=="result" and .result=="error")) | map(.id)) as $failed
  | map(select(.phase=="call" and (.id | IN($failed[])) and .outcome=="allowed"))
  | .[] | [.tool, .detail] | @tsv' -r

# Which MCP tools are actually in use — the working set for the gateway's
# `--tools` allowlist, which should be established from this, not guessed.
# NOTE the phase filter: without it every tool is counted twice.
$LOG | jq -r 'select(.phase=="call") | .tool' | sort | uniq -c | sort -rn

# Every call attributed to the turn that caused it: session, turn, outcome,
# tool, path. Turn lines carry the boundary forward onto the calls that follow
# them, which is the whole point of recording them.
$LOG | jq -rs '
  reduce .[] as $l ({turn: null, session: null, rows: []};
    if $l.kind == "turn_start" then .turn = $l.turn | .session = $l.session
    elif $l.phase == "call" then .rows += [[.session, .turn, $l.outcome, $l.tool, $l.detail]]
    else . end)
  | .rows[] | @tsv'

# Secrets the redactor caught on their way to the model: which call, which rule.
# The value is deliberately not recoverable from this log — go to the file named
# on the matching `call` line if you need to know what is in it.
$LOG | jq -r 'select(.redactions) | [.id, .tool, .redactions, (.rules | join(","))] | @tsv'

# Model requests, and how the context grew: one row per call to the model.
# Watch approx_bytes climb — that is file content accumulating in the context and
# being re-sent on every subsequent request.
$LOG | jq -r 'select(.kind=="provider_request") | [.model, .messages, .approx_bytes] | @tsv'

# Model requests per turn, which is how much the agent had to think.
$LOG | jq -rs '
  reduce .[] as $l ({turn: null, counts: {}};
    if $l.kind == "turn_start" then .turn = $l.turn
    elif $l.kind == "provider_request"
      then .counts[.turn | tostring] += 1
    else . end)
  | .counts | to_entries[] | [.key, .value] | @tsv'
```

Limits to know before relying on it:

- **Paths, never content.** `detail` carries the path a call named and nothing
  it returned. Logging what was read would copy the secrets out of the files and
  into the audit trail. That holds most strictly for the redaction fields: they
  say a credential was replaced and which rule matched, and cannot say what it
  was — a record that named the value would be a convenient way to leak precisely
  what the redactor exists to protect.
- **Model requests are recorded as shape, not content.** A `provider_request`
  line says which model was called, with how many messages, at what size — never
  what was sent. It is also written in the agent's own process, so it is evidence
  rather than a boundary; an independent record would come from the host proxy,
  which is deliberately not built (see `TODO.md`). Nothing records the provider's
  *reply*, either: `after_provider_response` is not handled.
- **It grows without bound, and that is the stated policy, not an oversight.**
  Nothing in the stack rotates, caps, or prunes it. See *Retention* below for
  the reasoning and for the operator's part in it.
- **Turn boundaries, not turn contents.** A `kind:"turn_start"` line says a turn
  began and which one; the instruction that opened it is not recorded, so reading
  *what was asked* still means going to the session transcript. The trail says
  what the agent did in response.

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

### Retention

**The policy: the call log grows without bound. Nothing in the stack ever
deletes a line from it. Pruning and archival are the operator's, done from the
host, deliberately.**

This is a decision, not a default inherited from whichever tool was convenient.
The reasoning, in the order it matters:

- **Deletion is data loss from an accountability record.** `docs/requirements.md`
  asks for auditability of every filesystem action and does not put a horizon on
  it. Size-capped rotation answers "how much disk" by discarding the oldest
  evidence, which is the wrong axis to optimise for a log whose purpose is
  answering questions about the past.

- **The volume pressure it would relieve is not there.** Measured against the
  real record format — a `call` line with a deep path plus its `result` line —
  a call costs about **316 bytes**:

  | Tool calls | Log size |
  |---|---|
  | 1,000 | 0.3 MB |
  | 10,000 | 3.2 MB |
  | 100,000 | 32 MB |
  | 1,000,000 | 316 MB |

  A million tool calls is years of heavy single-operator use. Paying real
  accountability loss to avoid a few hundred megabytes over that horizon is a
  bad trade, and it stays a bad trade until the numbers move. The two `kind`
  lines do not move them: a turn line is ~112 bytes with one per instruction, and
  a provider-request line ~126 bytes with roughly one per model call — a few
  percent on top of the calls they describe.

- **A cap would have to live in the wrong place.** The agent's rootfs is
  read-only, so rotation state would have to sit on the `pi-logs` volume itself,
  and an in-process cap in `permission-gate` would put truncation logic inside
  the audited process — the one place from which an accountability record should
  not be deletable. Today the extension can only append; `compose.yaml` notes
  that the volume outliving the container is what stops a session erasing its
  own history. Adding a delete path would spend that property.

**What the operator does.** Check the size when it is worth knowing:

```sh
docker compose -f src/infrastructure/compose.yaml exec -T pi \
  wc -c /var/log/pi/permission-gate/calls.jsonl
```

Archive by piping it out to the host — the same route the queries above use, so
there is no second image to pin and nothing new to trust:

```sh
docker compose -f src/infrastructure/compose.yaml exec -T pi \
  cat /var/log/pi/permission-gate/calls.jsonl \
  | gzip > "calls-$(date +%Y%m%d).jsonl.gz"
```

JSONL concatenates, so dated archives can be `cat`-ed back together in order and
queried as one file. Truncating the live log after archiving is a choice
available to the operator and is **not** part of the supported flow — if you do
it, the archive is the record, so put it somewhere durable first.

**Revisit this if any of these changes**, because each one breaks an assumption
above rather than merely making the file bigger:

- the log passes **1 GB**, or growth stops looking like the table above;
- the stack stops being single-operator, or the volume stops being local — a
  shipped, multi-tenant trail is a different retention problem;
- a compliance obligation names an actual retention period, at which point
  "unbounded" needs replacing with that period and an expiry mechanism, not with
  a size cap.

## Troubleshooting

**The agent prints its reasoning, then stops.** Typically after something like
*"I should explore the directory structure"*, with no error and no further
output. This is a tool-calling failure, not a hang: the model asked for a tool
and the request never became a tool call, so there was nothing to run and
nothing to report.

There are **two** causes with an identical symptom. Rule out the second before
touching the config, because it is the cheaper check.

**Cause 1 — the wrong LiteLLM prefix.** An `ollama/` prefix in
`proxy/litellm.config.yaml` where `ollama_chat/` is required. That integration
drops tool-call deltas when streaming and delivers the call as assistant text
instead — the agent shows a bare JSON object like
`{"name": "mcp_list_directory", "arguments": {…}}` and stops. See the warning in
that file.

**Cause 2 — the model does not emit tool calls, whatever it advertises.**
Observed with `qwen2.5-coder:14b`, the base of the `workstation` profile's
`computer-programming` capability. Ollama reports `"capabilities": ["completion",
"tools", "insert"]` for it, and it still returns the call as ordinary content.
The config is irrelevant here; no prefix change helps.

Isolate it by asking Ollama directly, bypassing the proxy and the agent
entirely — `tool_calls` must be non-null:

```sh
curl -s http://127.0.0.1:11434/api/chat -d '{
  "model":"computer-programming","stream":false,
  "messages":[{"role":"user","content":"List the entries of /workspace."}],
  "tools":[{"type":"function","function":{"name":"mcp_list_directory",
    "description":"List directory contents",
    "parameters":{"type":"object","properties":{"path":{"type":"string"}},
    "required":["path"]}}}]}' | jq '.message.tool_calls'
```

`null` means the model is the problem. Swap the capability's base model in the
modelfiles project — `qwen2.5:14b`, `llama3.1:8b`, `qwen3.6:27b` and
`gpt-oss:20b` were all verified to emit proper `tool_calls` — or drive the
session on a role whose capability uses one of those (`--model
litellm/technical-lead` maps to `technical-reasoning`, which is `qwen2.5:14b`).

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
no project mount. This is the deliberate, contained version of the concern that
got the third alternative in [../../docs/alternatives.md](../../docs/alternatives.md)
rejected — granting broad host privilege via `docker.sock`: the privilege
exists, but on a component the agent cannot reach, not on the agent itself.
[../../docs/solution.md](../../docs/solution.md) carries the same trade-off in
the design's own terms.

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
- The MCP server is the only component with filesystem access. Path enforcement lives in its configuration/code, not only in the volume mount — the allowed directory is the `command` argument in `mcp/toolkit/catalog.yaml`. How the upstream `mcp/filesystem` server defends that boundary internally (traversal, prefix collisions such as `/workspace` vs `/workspace-evil`) is **its** implementation and is not documented in this repository; the traversal check in the verification table above is the functional proof that it holds, and it should be re-run whenever the pinned image or the catalog schema changes.
- Pi runs with `PI_OFFLINE=1` and a session directory on a controlled volume outside any project tree.
