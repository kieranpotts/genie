# Genie [![CI check pipeline status][ci-badge]][ci-workflow]

**🚧 Under construction.**

**My hardened agent harness, built around the Pi coding agent framework.**

Pi is a minimal coding agent, a baseline framework for building your own
harness, rather a finished product. Out of the box it runs with full system
permissions and zero security controls. Genie wraps it with a hardened
container, a gated MCP server, and a host-side model proxy, to compose a
safe, controlled environment in which to run agents in Pi.

The objective of this project is to compose a secure coding agent framework,
isolated from the host system, with full audit trails for every action
performed by agents, and seamlessly supporting a mix of both local
and cloud models.

Together with my [agent skills][agent-skills] and [Modelfiles](ollama-modelfiles)
for Ollama, this is my custom AI agent harness. For eyes-on, at-keyboard
extensions to Pi itself (no hardening, just conveniences), see my
[`pi`][pi-repo] repository instead.

> [!WARNING]
> These tools are built for my personal use and they are volatile. They
> may change, break, or be removed at any time. They carry no support or
> stability guarantees. You're welcome, of course, to fork this repository and
> use it as a basis for engineering your own agent harness around Pi. But I
> don't recommend you use these tools as-is.

## 🎯 Intended use: away-from-keyboard

This harness is built for **away-from-keyboard agentic workflows** — an agent
working with minimal human oversight, where nobody is reading each tool call as
it happens. Every design decision follows from that one premise, and the
[requirements](./docs/requirements.md) state it first for that reason.

The cost is real and deliberate. Inside the hardened container the agent has no
shell, no Git, no network tools, and no route to the filesystem except a
mediated MCP server that logs every call — so it **cannot run your tests, build
the project, or install a dependency**. That is capability traded for
accountability, and the trade only pays when there is no human in the loop to
notice something going wrong.

**If you are at the keyboard, watching what the agent does, you do not need
this.** Eyes-on AI-assisted development in a normal editor is well served by a
much more minimal harness — Pi in a devcontainer with a mounted workspace, for
instance. You keep the agent's ability to run tests and builds, and *you* are
the control that this infrastructure otherwise has to reconstruct out of a
boundary and an audit trail. [Alternative designs](./docs/alternatives.md)
covers that setup and why it was rejected **for this use case** — not in
general; it is a perfectly reasonable way to work when someone is watching.

You can of course drive Pi interactively inside the hardened container, and the
operator affordances exist for exactly that: a read-only project mount to browse,
and an approval prompt before every write. But that is the harness being *usable*
by a human, not the case it was designed around.

## ☑️ Requirements

The following tools are required to build and run the hardened infrastructure:

- [Docker][docker] and the [Docker MCP Toolkit][docker-mcp-toolkit]
- [LiteLLM][lite-llm], **with the proxy extra**:

  ```sh
  pipx install 'litellm[proxy]'
  ```

  The `[proxy]` extra is not optional here. A plain `pip install litellm`
  installs the SDK but no `litellm` command, and `./run/startup` needs the
  proxy server on `PATH`.

The [Pi coding agent][pi] itself is baked into the hardened container image at
build time — you do not need it installed locally to use Genie.

## 🧭 Usage

Genie has two halves:

* Two Pi extensions — `mcp-client` and `secret-sentry` — that run inside the
  hardened container and form the in-Pi half of the security boundary.

* Supporting infrastructure: a hardened container, a gated MCP server, and a
  host-side model proxy, which together compose the boundary the extensions
  run inside.

Together, both halves form a cohesive, robust agent harness architecture.

```mermaid
flowchart LR
  subgraph Container["<b>Hardened container</b>"]
    subgraph Pi["<b>Pi</b>"]
      Core["Pi core"]
      MC["mcp-client"]
      PG["secret-sentry"]
    end
  end

  MCP["Gated MCP server"]
  Proxy["Model proxy<br/>(holds API keys)"]
  FS[("Project files")]
  Models[("Local &amp; cloud models")]

  MC -->|"tool &amp; file calls"| MCP
  MCP -->|"allowlisted access"| FS
  Core -->|"model requests<br/>(no API keys)"| Proxy
  Proxy -->|"authenticated"| Models

  classDef guard fill:#f0fff4,stroke:#27ae60,color:#000;
  classDef agent fill:#f5f7ff,stroke:#2c5fb3,color:#000;
  class MCP,Proxy,Container guard;
  class Core,MC,PG agent;
```

### The Pi extensions

- [**`secret-sentry`**](./src/extensions/secret-sentry/README.md): \
  Unattended security controls for away-from-keyboard sessions — an absolute
  refusal of sensitive filenames on every call, and redaction of secret-shaped
  values from tool output before the model sees them. No interactive
  confirmation: writes proceed unprompted, and this is the system's audit
  trail instead.

- [**`mcp-client`**](./src/extensions/mcp-client/README.md): \
  MCP client giving Pi mediated filesystem access through the Docker MCP Toolkit
  gateway.

These extensions are not installed on the host. They are baked directly into
the hardened container image at build time — see the `COPY` lines in
[`src/infrastructure/pi-container/Dockerfile`](./src/infrastructure/pi-container/Dockerfile).
If you want to develop or test them against a local, unhardened Pi install,
copy them over manually. There is no build step.

```sh
cp -R src/extensions/secret-sentry ~/.pi/agent/extensions/secret-sentry
```

New and updated extensions will be loaded next time you run `pi`. If you're
already in Pi, use the `/reload` prompt to reload all extensions, skills, etc.:

```sh
/reload
```

### Security hardening infrastructure

Beyond the extensions above, this repository provisions a wider agent harness
infrastructure: a hardened container, a gated MCP filesystem server, and a
host-side model proxy. This is the part built for
[away-from-keyboard use](#-intended-use-away-from-keyboard) — if you are working
eyes-on, it buys you less than it costs you.

The effect of this hardened infrastructure is that a compromised agent or a
misbehaving model will have no access to host files, API keys or other secrets,
and no Docker control. (The MCP gateway does hold a host Docker socket, because
it spawns the MCP server — confined to a component the agent cannot reach. See
[the trade-off](./docs/solution.md#the-gateway-and-the-dockersock-trade-off).)

Plus every tool call an agent makes is logged — both what it attempted and what
the call actually did. Since the agent's only tools are filesystem tools, that
is every filesystem action it takes. The same log marks each turn boundary, so
calls are attributable to the instruction that caused them, and records the
**shape** of every model request: which model, how many messages, how many
bytes. Never the content of any of it — that is the rule the log is built on.

`./run/startup` automates bringing the boundary up. See the
[**infrastructure runbook**](./src/infrastructure/README.md) for the full
operator workflow, including the manual verification and teardown steps.

## 📓 Developer documentation

See the [contributing guidelines](./CONTRIBUTING.md).

See also the [docs/](./docs/) directory for design decisions and trade-offs.

-----

Copyright © 2020-present Kieran Potts, [MIT license](./LICENSE.txt)

[agent-skills]: https://github.com/kieranpotts/skills
[ci-badge]: https://github.com/kieranpotts/genie/actions/workflows/check.yaml/badge.svg
[ci-workflow]: https://github.com/kieranpotts/genie/actions/workflows/check.yaml
[docker]: https://docker.com/
[docker-mcp-toolkit]: https://docs.docker.com/ai/mcp-catalog-and-toolkit/toolkit/
[lite-llm]: https://www.litellm.ai/
[ollama-modelfiles]: https://github.com/kieranpotts/modelfiles
[pi]: https://pi.dev/
[pi-repo]: https://github.com/kieranpotts/pi
