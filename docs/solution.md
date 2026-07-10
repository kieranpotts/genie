# The solution

I settled on an architecture that revolves around five components:

* Pi extensions.
* A containerized Pi instance.
* A containerized MCP server.
* A proxy for routing traffic to both remote and local models.
* A dedicated Docker network connecting the above.

```mermaid
flowchart LR
  subgraph Host["Host machine"]
    FS[("Project filesystem")]

    subgraph AgentContainer["Hardened container"]
      Pi["Pi agent"]
    end

    subgraph MCPContainer["MCP server container"]
      MCP["MCP server\n(path & operation allowlists,\ncall logging)"]
    end

    Proxy["Model proxy\n(holds API keys)"]
    LocalModel[("Local model\nmanager")]
  end

  RemoteModel[("Remote model\nhosting provider")]

  Pi -- "scoped file ops" --> MCP
  MCP -- "allowlisted access" --> FS
  Pi -- "model requests" --> Proxy
  Proxy -- "requests" --> LocalModel
  Proxy -- "authenticated requests" --> RemoteModel
```

The security profile offered by this architecture meets my
[requirements](./requirements.md). It suits the regulated industries
I work in, and it travels well between different development environments.

## Pi extensions

Out-of-the-box, Pi is a minimal coding agent harness with full system privileges
and no security controls. For example, Pi's built-in tools are run without any
permissions gates — so models can use them however they like, no restrictions.

Instead of building security controls into the core, Pi provides n extension
system that allows users to customize the harness's security profile to their
own specific requirements. This is the first layer of defense in a hardened
agent harness.

Extensions are TypeScript modules that can intercept every tool call, block
operations, modify results, and interact with the user.

The key security hooks available to extensions are:

- **`tool_call` event.** Fires before any tool executes. Can block with
  `{ block: true, reason: string }`. Receives the full tool name and input
  parameters, which are mutable. An extension can both inspect and modify
  arguments before execution. This is the place to implement path allowlists,
  command blocklists, and confirmation prompts.

- **`tool_result` event.** Fires after tool execution, before the result is
  returned to the model. Can modify the result. Handlers chain as middleware.
  Can be used to redact sensitive content from tool output before it enters
  the model context.

- **`before_provider_request` event.** Fires after the provider payload is
  built, immediately before the outbound model API call. Can inspect or replace
  the full payload. The correct hook for auditing all outbound model traffic.

- **`before_agent_start` event.** Fires before each agent turn. Can inject
  context, modify the system prompt, and record that a turn is beginning —
  useful for audit trail entries.

- **Tool overriding.** Extensions can replace built-in tools (`read`, `bash`,
  `edit`, `write`, `grep`, `find`, `ls`) entirely by registering a tool with
  the same name. Combined with `--no-builtin-tools` (which starts Pi with no
  built-in tools at all), this allows constructing a fully locked-down, audited
  tool surface from scratch, rather than layering restrictions on top of
  unrestricted defaults.

## Containerized Pi agent

Pi runs in its own dedicated, hardened container — one that has no direct
access to the host filesystem, no project mounts, no Docker socket
(`docker.sock`), and no cloud API keys or other secrets.

All interactions with the outside world happen via:

* The MCP server (for tools and data access).
* The model proxy (for inference requests).

In simple terms, this means that a compromised agent or a misbehaving model
cannot reach host files, cloud credentials, or sibling projects.

The user experience is unchanged. Users interact with Pi in the normal way.
Only the plumbing beneath the agent changes.

An alternative to Docker would be to use **OpenShell**. This provides a
sandboxed environment that keeps API credentials outside of the agent process.
However, Docker is acceptable if you have another strategy for handling secrets,
one that doesn't involve injecting them into the model's environment. A model
proxy solves this problem (see below).

## Containerized MCP server

Access to files, data, and tools is mediated by a containerized MCP server.
This is responsible for enforcing path and operation allowlists. It also logs
every call, providing full auditability.

Running MCP servers directly on the host machine would still give a model
access to the host filesystem, environment variables, and network. Putting
the MCP server in a Docker container keeps it isolated from the host
environment. Access to host files, secrets, and networks can thereby be
controlled.

For all operations that don't involve model inference, the agent issues MCP
tool calls. The containerized MCP server enforces what tool calls are allowed.
Thus, the MCP server becomes the gatekeeper to the host system. Access is
mediated using scoped allowlists. Every call is logged.

```mermaid
sequenceDiagram
  participant Pi as pi-container
  participant MCP as mcp-server (gatekeeper)
  participant FS as project-a volume

  Note over Pi,FS: Legitimate file write.
  Pi->>MCP: write_file("/projects/proj-a/src/x.ts", …)
  MCP->>MCP: resolve() + relative() within root? ✓
  MCP->>MCP: append audit log entry
  MCP->>FS: write bytes
  FS-->>MCP: ok
  MCP-->>Pi: { ok: true }

  Note over Pi,FS: Traversal attempt — denied at boundary.
  Pi->>MCP: read_file("/projects/project-a/../../etc/passwd")
  MCP->>MCP: resolve() escapes root → relative() starts with ".."
  MCP->>MCP: log denial
  MCP-->>Pi: { error: "path outside allowlist" }
  Note right of FS: filesystem not touched
```

This aligns with emerging best practices for secure agent harnesses. MCP
(Model Context Protocol) has emerged as the _de facto_ isolation boundary for
agents, controlling an agent's access to filesystems, tools, and data, instead
of an agent having direct filesystem access.

Tooling in this solution space is mature. [Docker MCP Toolkit][docker-mcp-toolkit]
is a free feature of Docker Desktop that runs MCP servers in containers and
handles the plumbing to the agent client (whether that be Pi, LM Studio,
Claude Desktop, etc.). It is the pragmatic, batteries-included way to run
MCP servers in containers.

Docker MCP Toolkit can be configured with environment variables, API keys, and
other secret credentials required by the agent, so the agent doesn't need to
hold these things itself. It also provides security checks for both tool calls
and the resulting outputs.

Docker MCP Toolkit meets all of my requirements, negating the need for a custom
MCP server solution.

## Model traffic proxy

Another piece of the jigsaw is to have some sort of proxy between the agent
and the model servers. This proxy holds the access credentials required to
access the model provider, whether that provider is remote or local.

This design means that credentials and secrets are never injected into running
containers via environment variables, mounted into them via config files, or
baked into container images – and so are never read directly by models.
Instead, agent harnesses make inference calls to models via  a proxy that
holds all requires keys. The container is given only the proxy endpoint, and
no credentials.

This is an emerging pattern, and [LiteLLM][lite-llm] is emerging as the
_de facto_ standard. It is a lightweight model router, sitting between the agent
and the models the agent uses. LiteLLM presents a unified OpenAI-compatible API.

```mermaid
sequenceDiagram
  participant Pi as pi-container
  participant Proxy as LiteLLM proxy
  participant Cloud as cloud model

  Note over Pi,Cloud: Model call — credential never reaches agent
  Pi->>Proxy: completion request (no API key)
  Proxy->>Cloud: request + injected key
  Cloud-->>Proxy: completion
  Proxy-->>Pi: completion
```

Moreover, LiteLLM can route requests to different local or cloud models based
on rules you define, allowing for the configuration of dynamic model routing
in response to the task at hand. You can also configure LiteLLM with per-model
token budgets and rate limits.

```
agent
  └── model router - eg. LiteLLM, Ollama proxy
        ├── local: ollama - low latency, no data leaves machine
        └── cloud: Anthropic API - for frontier model access
```

LiteLLM runs directly on the host, rather than in its own container like Pi and
the MCP server. This is because the proxy needs host-level access to reach local
model servers such as Ollama. It holds all cloud API keys and other model
credentials, so they stay out of reach of the model, too.

## High-level design

The diagram below shows the trust boundaries and what crosses each.

```mermaid
flowchart TB
  subgraph Host["Host machine"]
    Ollama["<b>Ollama :11434</b><br/>(bridge gateway only)"]
    Proxy["<b>LiteLLM proxy :4000</b><br/>(holds cloud model API keys)"]
    Cloud["<b>Anthropic / OpenAI</b><br/>(cloud)"]
    Proxy -->|"capable"| Cloud
    Proxy -->|"fast / cheap"| Ollama
  end

  subgraph Net["Docker network: agent-net"]
    Pi["<b>pi-container</b><br/>Pi + MCP client extension<br/>(no FS, no docker.sock, no keys)"]
    MCP["<b>mcp-server-container</b><br/>path + operation allowlist, logging<br/>(only component with FS access)"]
    VolA[("proj-a volume")]
    VolB[("proj-b volume")]

    Pi -->|"MCP tool calls<br/>(HTTP/SSE or stdio)"| MCP
    MCP --> VolA
    MCP --> VolB
  end

  Pi -->|"model calls<br/>host-gateway:4000"| Proxy

  classDef danger fill:#fff0f0,stroke:#c0392b,color:#000;
  classDef guard fill:#f0fff4,stroke:#27ae60,color:#000;
  classDef agent fill:#f5f7ff,stroke:#2c5fb3,color:#000;
  class Proxy,MCP guard;
  class Pi agent;
  class Cloud danger;
```

The view below adds some concrete mount/volume detail:

```
Host Machine
│
├── Ollama :11434 - bound to bridge gateway only, not 0.0.0.0
├── LiteLLM proxy :4000 - holds cloud model API keys, dynamic routing
│     ├── routes "fast/cheap" → Ollama local model
│     └── routes "capable"    → Anthropic / OpenAI cloud
│
└── Docker network: agent-net
    │
    ├── pi-container
    │   ├── Pi process + MCP client extension
    │   └── /home/pi - Pi config + session history (named volume)
    │                  No project mounts, no docker.sock, no keys
    │
    └── mcp-server-container
        ├── MCP server process
        │   Enforces: path allowlist, operation allowlist, per-project perms, logging
        ├── /projects/proj-a - scoped named volume (read/write)
        └── /projects/proj-b - scoped named volume (read/write)
```

[docker-mcp-toolkit]: https://docs.docker.com/ai/mcp-catalog-and-toolkit/toolkit/
[lite-llm]: https://www.litellm.ai/
