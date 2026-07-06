# Local AI Agent Architecture Plan

## Goal

Isolate a local coding agent (Pi) from host system and user-level filesystem, while supporting a mix of local and cloud models.

---

## Extensions

- GitHub self-hosted action runners

- Session transcripts (for auditability)
- Checkpoints
- Plan mode
- TODO list
- Background bash?
- Sub-agents
- Built-in MCP
- A2A

## Landscape Note (2025–2026)

The tooling around agent sandboxing has consolidated this year:

- **MCP has become the de facto isolation boundary.** The emerging standard is that the agent does *not* touch the filesystem directly — it calls MCP servers that expose specific, scoped operations, and the (containerised) MCP server is the gatekeeper. This is exactly **Option D** below; the wider ecosystem now treats it as the default rather than one option among four. The catch for us: Pi is not MCP-native, so Option D requires building an MCP client extension for Pi (or using `--no-builtin-tools` + audited tool extensions as the functional equivalent — see Pi Security Analysis).
- **LiteLLM has become the de facto model proxy** for the mixed local/cloud case — keys on the host, single endpoint to the agent. Captured in Model Routing → Approach 2.
- **Docker MCP Toolkit** is the pragmatic, batteries-included way to run MCP servers in containers. Captured as a sub-approach under Option D.

**Still unsolved / immature:** granular *interactive* permission prompting (approve this write, deny that read) — most setups remain either fully open or fully closed. Promising directions like staging filesystems (copy-on-write layers you review before committing) exist but are not yet mainstream. This is the same gap the Pi Security Analysis flags: the permission-gate must be built, not configured.

We keep all four options documented below rather than collapsing to D, because Pi's lack of native MCP support and the simplicity of co-location (Option A) keep A–C genuinely viable for local single-user dev.

---

## Fixed Components

These are constant across all four options.

### Ollama (host)
- Runs on the host for GPU access and inference speed
- Bound to the Docker bridge gateway IP only (e.g. `172.17.0.1:11434`) — not `0.0.0.0`
- Not exposed to the wider network
- Reachable from containers via the `host-gateway` alias

### Cloud model API keys (host)
- Stored in host environment or keychain only
- Never baked into container images or mounted config files
- **Two delivery modes, applicable to every option below** (see Model Routing for detail):
  - **Injected** — keys passed into the agent container at runtime via `remoteEnv` or `--env`. Simplest; keys live inside the container.
  - **Proxied** — a host-side model proxy (e.g. LiteLLM) holds all keys; the container is given only the proxy endpoint and no credentials. Stronger isolation; recommended for regulated use.
- Each option below notes how it looks under both modes.

### Devcontainer hardening (all options)
- `workspaceMount` scoped to `${localWorkspaceFolder}` only — not `~` or any parent directory
- No mount of `~/.ssh`, `~/.config`, `~/.gitconfig`, or similar host dotfiles
- No `/var/run/docker.sock` mount unless explicitly required (see Option C)
- Non-root user inside the container
- `--cap-drop ALL` with only necessary capabilities restored
- `--security-opt no-new-privileges:true`
- Resource limits: `--memory`, `--cpus`, `--pids-limit`

---

## The Four Options

---

### Option A — Pi Inside the Devcontainer

Pi runs as a process within each project's devcontainer. The container boundary is both the project boundary and the agent boundary.

```
Host Machine
│
├── Ollama :11434 (bridge gateway only)
├── API keys — injected at container start, OR held by a host-side proxy
├── [optional] LiteLLM proxy :4000 (holds keys; container calls this instead)
│
└── Docker
    ├── project-a devcontainer
    │   ├── Pi process
    │   └── /workspace/project-a  ← bind mount, scoped to project
    │
    └── project-b devcontainer
        ├── Pi process
        └── /workspace/project-b  ← bind mount, scoped to project
```

**Pros**
- Simplest setup — no inter-container networking required
- Pi runs in the project's own environment, with the correct language runtimes, tools, and dependencies already present
- No Docker socket or exec access needed
- Fully compatible with standard devcontainer tooling (VS Code, JetBrains, etc.)
- Each project gets its own isolated Pi instance with independent session history

**Cons**
- Pi is re-installed or re-configured per devcontainer image
- Cannot work across multiple projects in a single session
- Pi's own config and session history are ephemeral unless explicitly persisted to a named volume
- Agent tooling is coupled to the project environment

**Model access:** Under *injected* mode, each devcontainer receives the cloud keys directly — simple, but every project's Pi instance holds them. Under *proxied* mode, the host runs a single LiteLLM proxy and each devcontainer is given only `http://host-gateway:4000` with no keys; this is the recommended hardening for Option A, since per-project key injection multiplies the blast radius.

**Best for:** Single-project workflows, simplicity, teams already using devcontainers as their primary dev environment.

---

### Option B — Pi in Its Own Container, Shared Named Volumes

Pi runs in a dedicated container. Project files live in named Docker volumes, shared between Pi and the relevant devcontainer.

```
Docker network: agent-net
│
├── pi-container
│   ├── Pi process
│   ├── /home/pi          ← Pi config + session history (named volume)
│   ├── /projects/proj-a  ← shared named volume (read/write)
│   └── /projects/proj-b  ← shared named volume (read/write)
│
├── project-a devcontainer
│   └── /workspace        ← same named volume as /projects/proj-a above
│
└── project-b devcontainer
    └── /workspace        ← same named volume as /projects/proj-b above
```

Pi mounts project volumes directly and operates on files natively, just as it would in Option A. The devcontainer mounts the same volume as its workspace.

**Pros**
- Pi is a single, persistent, well-configured instance across all projects
- Pi config, extensions, and session history are stable and centralised
- No Docker socket required — Pi has direct file access via shared volumes
- Pi and the devcontainer can work on the same files simultaneously

**Cons**
- Pi does not run in the project's environment — it may lack project-specific runtimes, compilers, or tools needed to run or test code
- Named volumes are opaque on the host (harder to browse/backup than bind mounts)
- Simultaneous writes from Pi and the developer could cause conflicts
- Cross-project access is controlled only by which volumes are mounted — requires discipline in configuration

**Model access:** The single pi-container makes proxying especially clean — only one container needs the proxy endpoint, and there is exactly one place keys could otherwise leak. Under *injected* mode the keys sit in the long-lived pi-container; under *proxied* mode they stay on the host and the pi-container holds none. Proxied is the natural fit here.

**Best for:** Multi-project workflows where Pi's own environment is sufficient, and project-specific tooling is not required for the agent to operate.

---

### Option C — Pi in Its Own Container, Exec-Based Access

Pi runs in a dedicated container but does not mount project filesystems. Instead, it executes commands inside target devcontainers via `docker exec` (or SSH), reading and writing files through the project container's own shell.

```
Docker network: agent-net
│
├── pi-container
│   ├── Pi process + SSH/exec extension
│   ├── /home/pi          ← Pi config + session history (named volume)
│   └── docker.sock (or restricted exec proxy)
│       ↓ exec / SSH
│
├── project-a devcontainer
│   └── /workspace/project-a  ← Pi never mounts this directly
│
└── project-b devcontainer
    └── /workspace/project-b  ← Pi never mounts this directly
```

Pi issues shell commands that run *inside* the target container and observes stdout/stderr. This is how tools like Claude Code and Cursor's remote mode operate.

**Pros**
- Pi executes in the correct project environment — runtimes, compilers, and tools are exactly as the developer configured them
- Cleanest separation: Pi has no direct filesystem access to any project
- Commands run with the devcontainer's user and permissions, not Pi's
- Pi can target multiple containers in sequence without remounting volumes

**Cons**
- Requires either mounting `docker.sock` into the Pi container (broad host Docker privilege) or building/running a restricted exec proxy
- More complex to set up and debug
- `docker.sock` access is a significant privilege — a compromised Pi container could control all containers on the host
- Latency per operation is higher (exec overhead vs. direct file I/O)

**Mitigating the docker.sock risk:** Rather than mounting the full socket, run a small proxy (e.g. [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)) that allowlists only the `exec` API endpoint for specific container names. Pi talks to the proxy, not the real socket.

**Model access:** Same as Option B — the pi-container is the only credential holder, so *proxied* mode keeps keys off it entirely. Worth noting the proxy and the docker-socket-proxy are independent host-side components solving different problems (model keys vs. exec scoping); a fully hardened Option C runs both.

**Best for:** Scenarios where running commands in the correct project environment is important (e.g. tests, builds, linters), or where stricter filesystem isolation is desired.

---

### Option D — Pi in Its Own Container, MCP Server as Mediator

Pi runs in a dedicated container and has no direct filesystem access or exec access to any project. Instead, a containerised MCP server sits between Pi and each devcontainer, exposing a structured, operation-scoped API over the project filesystem. Pi calls MCP tools (`read_file`, `write_file`, `list_directory`, `run_command`, etc.); the MCP server enforces what is permitted.

Pi does not include MCP support by default, so this option requires adding an MCP client extension to Pi.

```
Docker network: agent-net
│
├── pi-container
│   ├── Pi process + MCP client extension
│   ├── /home/pi              ← Pi config + session history (named volume)
│   └── (no project mounts, no docker.sock)
│       ↓ MCP protocol (HTTP/SSE or stdio)
│
├── mcp-server-container
│   ├── MCP server process
│   ├── /projects/proj-a      ← shared named volume (scoped read/write)
│   ├── /projects/proj-b      ← shared named volume (scoped read/write)
│   └── enforces: path allowlist, operation allowlist, per-project permissions
│
├── project-a devcontainer
│   └── /workspace            ← same named volume as /projects/proj-a above
│
└── project-b devcontainer
    └── /workspace            ← same named volume as /projects/proj-b above
```

The MCP server is the only component with filesystem access to project volumes. It enforces a path allowlist (e.g. no access above `/projects/proj-a`), an operation allowlist (e.g. no `rm -rf`, no access to `.env` files), and can log every read and write for auditability.

**Path enforcement must be in the server code, not just the volume mount.** A volume mount scoped to `/projects/proj-a` does *not* prevent a `../../` traversal inside the container if the server resolves paths naively. The server must canonicalise every requested path (`resolve()`) and verify it stays within the allowlisted root via a `relative()` comparison that rejects any result starting with `..` — this defeats both directory traversal and prefix-collision attacks (e.g. `/projects/proj-a-evil` vs. `/projects/proj-a`) across platforms. Allowlist, never blocklist.

**Two sub-approaches, both still to explore:**

- **Custom audited MCP server** — write your own server with explicit path/operation allowlists and structured logging. Maximum control; policy is version-controlled and reviewable; matches the regulated-environment requirements below. More to build and maintain.
- **Docker MCP Toolkit** — a free feature in Docker Desktop that runs MCP servers (200+ available) in isolated containers, with per-server secret/env configuration and built-in security checks on tool calls and outputs. Fastest path to a working setup; less bespoke policy control than a custom server.

These are not yet decided between — both warrant a prototype.

**Pros**
- Strongest filesystem isolation of all four options — Pi has zero direct filesystem access
- MCP server is an explicit, auditable policy enforcement point: every file operation is a named tool call with defined parameters
- All filesystem access is logged by default (MCP tool calls are observable)
- Permission boundaries are expressed in code (the MCP server), not just in Docker config
- Pi can be swapped for any other MCP-compatible agent without changing the isolation layer
- No `docker.sock` required

**Cons**
- Pi does not support MCP natively — requires building or installing an MCP client extension
- Highest setup complexity of all options
- MCP server must be kept up to date and correctly configured — it becomes a security-critical component
- Pi still lacks access to the project's runtime environment for executing code (same limitation as Option B); would need to be combined with Option C's exec approach for full fidelity
- Adds a network hop (Pi → MCP server → filesystem) with associated latency

**Mitigating the runtime environment gap:** If Pi needs to run project code (tests, builds), the MCP server can expose a `run_command` tool that executes inside the devcontainer via a restricted exec interface. This gives the structured mediation of Option D with the environment fidelity of Option C, at the cost of additional complexity.

**Model access:** Option D pairs naturally with *proxied* mode to reach the strongest overall posture: the pi-container then holds no filesystem access (mediated by the MCP server), no `docker.sock`, and no cloud keys (held by the host proxy). This is the only configuration where a fully compromised Pi process has neither project files nor credentials nor host Docker control. *Injected* mode is still possible but undercuts the point of choosing D — if you went to the trouble of the MCP boundary, put the keys behind the proxy too.

**Best for:** Scenarios requiring explicit, auditable, policy-enforced filesystem access — e.g. shared or team environments, regulated codebases, or where the agent's filesystem permissions need to be inspectable and version-controlled.

---

## Comparison Summary

| | Option A | Option B | Option C | Option D |
|---|---|---|---|---|
| **Pi location** | Inside devcontainer | Own container | Own container | Own container |
| **File access method** | Direct (co-located) | Shared named volume | `docker exec` / SSH | MCP server |
| **Project env available to Pi** | ✅ Full | ❌ Pi's own env only | ✅ Full | ❌ (unless MCP exposes exec) |
| **Pi config persistence** | ⚠️ Per container | ✅ Centralised | ✅ Centralised | ✅ Centralised |
| **Multi-project in one session** | ❌ | ✅ | ✅ | ✅ |
| **Docker socket required** | ❌ | ❌ | ⚠️ Yes (or proxy) | ❌ |
| **Setup complexity** | Low | Medium | High | Highest |
| **Filesystem isolation (Pi↔host)** | ✅ | ✅ | ✅ | ✅ |
| **Filesystem isolation (Pi↔project)** | ❌ By design | ❌ By design | ✅ Mediated | ✅ Strongly mediated |
| **Access auditability** | ❌ | ❌ | ⚠️ Shell logs only | ✅ Every tool call logged |
| **MCP extension required** | ❌ | ❌ | ❌ | ✅ |

---

## Key Tradeoffs

**Simplicity vs. separation.** Option A is the easiest to reason about and operate. Each subsequent option adds inter-container coordination in exchange for stronger or more explicit isolation.

**Project environment fidelity.** If Pi needs to run code — tests, builds, formatters — it needs the project's runtimes. Options A and C provide this natively. Options B and D do not, unless the MCP server (Option D) or a volume-accessible runner (Option B) is added to bridge the gap.

**Centralised vs. per-project Pi.** Options B, C, and D give you a single Pi instance with stable config, extensions, and history. Option A gives each project its own isolated Pi, which may be preferable for divergent project requirements or strong session isolation.

**The docker.sock decision.** Option C requires `docker.sock` access or a proxy. Options A, B, and D avoid this entirely. If `docker.sock` is used, a restrictive proxy (e.g. [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)) allowlisted to `exec`-only on named containers is strongly recommended.

**Implicit vs. explicit access control.** Options A, B, and C rely on Docker volume scoping and mount configuration for access control — correct but implicit. Option D makes access control explicit in the MCP server's tool definitions and allowlists, which are inspectable, testable, and version-controllable. This is the meaningful architectural distinction of Option D.

---

## Model Routing (all options)

There are two viable approaches. The native approach is the simpler default; the proxy approach is the regulated-environment upgrade. They are not mutually exclusive — you can start native and add a proxy later.

### Approach 1 — Native multi-provider routing (simple default)

Pi supports multiple providers natively. Configure per-container via environment variables:

```jsonc
// devcontainer.json (Option A) or pi-container config (Options B/C)
{
  "remoteEnv": {
    "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}",
    "OPENAI_API_KEY":    "${localEnv:OPENAI_API_KEY}",
    "OLLAMA_HOST":       "http://host-gateway:11434"
  }
}
```

- **Local models** via Ollama — fast, private, data never leaves the machine
- **Cloud models** — for higher-capability tasks; keys injected at runtime

Switch models mid-session with Pi's `/model` command or `Ctrl+L`. No extra infrastructure.

**Tradeoff:** Cloud API keys are injected into the agent container. A compromised Pi process or extension can read them. Acceptable for non-regulated local dev; not acceptable where key isolation is a requirement.

### Approach 2 — Host-side model proxy (regulated upgrade)

Run a model router/proxy (e.g. [LiteLLM](https://github.com/BerriAI/litellm)) on the host. It holds all cloud API keys and presents a single OpenAI-compatible endpoint. The agent container is given exactly one endpoint to call and **no cloud credentials**.

```
Host
├── Ollama        (bound to 172.17.0.1:11434)
├── LiteLLM proxy (bound to 172.17.0.1:4000, holds all cloud API keys)
│    ├── routes "fast/cheap" → Ollama local model
│    └── routes "capable"    → Anthropic / OpenAI cloud
│
└── agent container → calls only http://host-gateway:4000 (no keys inside)
```

**Benefits for the threat model:**
- The agent never holds cloud API keys — the proxy does, on the host. This is what closes the "keys enter the container" gap noted in the Pi Security Analysis for Plain Docker.
- All model calls are logged and auditable in one place.
- Per-model token budgets and rate limits enforced centrally.
- Routing rules change without touching agent config.

**Tradeoff:** Extra host-side component to run and keep configured; one more network hop.

This is the proxy referenced in the "Honest Assessment" conclusion (hardened Docker + host-side model proxy so keys never enter the container).

---

## What All Four Options Protect Against

| Concern | Protected? | Notes |
|---|---|---|
| Pi reading host dotfiles | ✅ | Not mounted in any option |
| Pi reading SSH keys | ✅ | `~/.ssh` not mounted |
| Pi writing to host filesystem | ✅ | No host paths mounted beyond workspace |
| Pi reading sibling projects | ✅ | Volume scoping enforces this |
| Pi exhausting host resources | ✅ | Memory, CPU, PID limits on all containers |
| Pi exfiltrating data via network | ⚠️ | Network open by default; add egress filtering if needed |
| Pi escaping via kernel exploit | ❌ | Shared kernel — accepted risk for local dev |
| Malicious Pi extension | ❌ | Pi has workspace access by design; audit extensions before installing |

---

## Out of Scope

- **MCP:** Pi does not include MCP by default. Option D is built around a containerised MCP server; if MCP is added to other options, each MCP server should run in its own container with explicit volume scoping.
- **Egress filtering:** Recommended for sensitive projects; not part of the baseline architecture here.
- **gVisor / VM-based isolation:** Not required for local dev; consider if running untrusted agent extensions or in a multi-user environment.

---

## Pi Security Analysis

### Baseline: Pi's Security Posture is Deliberately Minimal

Pi runs with all permissions by default. This is an explicit design choice. Pi deliberately omits permission popups, and its own documentation recommends running in a container or building a custom confirmation flow via extensions as the primary security mechanism.

**Pi ships with zero security controls enabled.** Everything in this section must be explicitly added or configured.

---

### What Pi Provides

#### Containerisation Patterns

Pi documents three containerisation patterns, in ascending order of security:

**Plain Docker** — the whole Pi process runs in a container. Simplest to set up. The limitation for regulated use: provider API keys enter the container. No credential isolation. Suitable for baseline filesystem isolation only.

**Gondolin** — a local Linux micro-VM extension. Pi runs on the host; only built-in tool execution is routed into the VM. The extension overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`. Pi's own process, config, and credentials remain on the host.

**OpenShell (NVIDIA)** — the most capable option for regulated environments. Provides policy-controlled sandboxing with filesystem, process, network, credential, and inference controls in one place. Runs sandboxes through a local gateway (Docker, Podman, or VM) or a remote Kubernetes gateway. Critically, OpenShell can keep raw model API keys entirely outside the sandbox — code inside the sandbox calls `https://inference.local` and the gateway injects credentials upstream. This is the only Pi-native pattern that provides full credential isolation.

#### The Extension System as a Security Layer

The extension system is Pi's most important security capability. Extensions are TypeScript modules that can intercept every tool call, block operations, modify results, and interact with the user for confirmation.

Key security hooks available to extensions:

**`tool_call` event** — fires before any tool executes. Can block with `{ block: true, reason: string }`. Receives the full tool name and input parameters, which are mutable — an extension can both inspect and modify arguments before execution. This is the correct place to implement path allowlists, command blocklists, and confirmation prompts.

**`tool_result` event** — fires after tool execution, before the result is returned to the model. Can modify the result. Handlers chain as middleware. Can be used to redact sensitive content from tool output before it enters the model context.

**`before_provider_request` event** — fires after the provider payload is built, immediately before the outbound model API call. Can inspect or replace the full payload. The correct hook for auditing all outbound model traffic.

**`before_agent_start` event** — fires before each agent turn. Can inject context, modify the system prompt, and record that a turn is beginning — useful for audit trail entries.

**Tool overriding** — extensions can replace built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) entirely by registering a tool with the same name. Combined with `--no-builtin-tools` (start Pi with no built-in tools at all), this allows constructing a fully locked-down, audited tool surface from scratch rather than layering restrictions on top of unrestricted defaults.

#### Session Storage

Sessions are stored as JSONL files. The storage location is configurable via `sessionDir` in `settings.json`, `PI_CODING_AGENT_SESSION_DIR`, or `--session-dir`. For regulated use, session files should be stored outside the working tree in a controlled, access-restricted location, as they contain the full conversation history including any file content the agent read during the session.

#### Telemetry and Network Calls

By default, Pi makes two categories of outbound startup calls: an anonymous install/update telemetry ping and a version check. Both can be disabled:

- `enableInstallTelemetry: false` in settings — disables the telemetry ping
- `PI_SKIP_VERSION_CHECK=1` — disables the version check
- `--offline` or `PI_OFFLINE=1` — disables all startup network operations

In a regulated environment, these should be disabled and all outbound network traffic should be proxied or allowlisted.

---

### Security Gaps — What Pi Does Not Provide

| Requirement | Pi's Posture | What Is Required |
|---|---|---|
| Filesystem access control | None by default | Containerisation + path-enforcing extension |
| Permission prompts / approval gates | Not built in | Custom `permission-gate.ts` extension |
| Audit log of tool calls | Not built in | `tool_call` / `tool_result` event hooks |
| API key isolation from agent | Keys enter container (Plain Docker / Gondolin) | OpenShell, or external proxy pattern |
| Extension vetting / signing | None — extensions run with full system permissions | Manual review; pin to exact versions |
| Network egress control | None | Docker network policy or host firewall |
| Session data retention / encryption | Files stored indefinitely in plaintext | External `sessionDir` with encryption at rest |
| Data classification awareness | None | Custom extension with content inspection |
| Prompt injection defence | None | Out of scope for Pi; a model-level concern |

---

### Recommended Approach for Regulated Environments

This is the minimum viable security stack based on what Pi's documentation describes. It is composed entirely of controls that must be built or configured — none are on by default.

#### 1. Sandbox with OpenShell (preferred) or hardened Docker

For regulated use, **OpenShell** is the appropriate sandbox because it is the only Pi-native pattern that keeps API credentials outside the agent process. Plain Docker is acceptable only if cloud API keys are handled by an external proxy (see Model Routing section) so that they never enter the container directly.

If using Plain Docker without OpenShell, apply the full container hardening described in the Devcontainer Configuration section above, and ensure no API keys are injected directly — route all model traffic through a host-side proxy that holds the keys.

#### 2. Disable built-in tools; provide audited replacements

Start Pi with `--no-builtin-tools` and provide extension-based replacements for each tool needed. Each replacement must:

- Enforce a path allowlist (project directory only; no traversal)
- Log every invocation with timestamp, tool name, arguments, and result status
- Refuse operations on sensitive filenames (`.env`, secrets files, key material)
- Enforce a command allowlist for `bash` rather than a blocklist

This is more robust than intercepting built-in tools via events, because it removes the default permissive surface entirely.

#### 3. Implement a permission-gate extension

Use Pi's `permission-gate.ts` example as the starting point. For regulated use, extend it to:

- Require explicit confirmation for all write and execute operations
- Time out confirmations and default to deny
- Log every confirmation decision (approved or denied) to an append-only audit file outside the container

#### 4. Audit all outbound model calls

Implement a `before_provider_request` handler that logs the full payload of every outbound model API call. This provides a record of what data was sent to external model providers. In combination with Option A (Pi inside the devcontainer), this log lives inside the container and should be written to a named volume that persists it outside the ephemeral container filesystem.

#### 5. Control session storage

Set `sessionDir` to a path outside the project directory — ideally on an encrypted volume. Session JSONL files contain the full conversation including all file content the agent read, so they must be treated as sensitive data with the same retention policy as the source material.

#### 6. Disable all telemetry and startup network calls

Set `PI_OFFLINE=1` in the container environment. All model traffic should go through a known, proxied endpoint. No other outbound network calls should be permitted.

#### 7. Treat the extension ecosystem as untrusted

Extensions run with full system permissions and can execute arbitrary code. For regulated use:

- No third-party Pi packages should be installed without code review
- Pin all extensions to exact versions (commit hash for git, exact version for npm)
- Global extensions (`~/.pi/agent/extensions/`) affect all projects — treat this directory as a high-privilege location
- Project-local extensions (`.pi/extensions/`) should be version-controlled and reviewed as part of normal code review

#### 8. Audit trail summary

A compliant Pi setup should produce the following audit records, all written outside the agent's writable container filesystem:

| Record | Source | Hook / Mechanism |
|---|---|---|
| Every tool call (name, args, timestamp) | Extension | `tool_call` event |
| Every tool result (status, output hash) | Extension | `tool_result` event |
| Every outbound model call (payload hash) | Extension | `before_provider_request` event |
| Every permission decision | Extension | `permission-gate` confirmation handler |
| Session transcripts | Pi | `sessionDir` on controlled volume |

---

### Honest Assessment

Pi is architecturally honest about its security posture: it deliberately externalises security policy to the operator via containerisation and extensions. This is a reasonable design philosophy for a developer tool, but it means that for regulated use, **you are building the security controls, not configuring them**. Pi provides the hooks; the implementation is your responsibility.

OpenShell is the closest to a batteries-included regulated solution that the Pi documentation describes, but it requires an external gateway and is primarily aimed at enterprise or team deployments. For a local developer setup in a regulated context, the realistic path is: hardened Docker with a host-side model proxy (so keys never enter the container) + `--no-builtin-tools` + audited tool extension + permission-gate extension + session storage on an encrypted volume outside the working tree.
