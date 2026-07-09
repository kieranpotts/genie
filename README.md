# Pi [![CI check pipeline status][ci-badge]][ci-workflow]

**🚧 Under construction.**

**My AI agent harness, built around the Pi coding agent framework.**

Pi is a minimal coding agent — a baseline framework for building your own
harness, not a finished product. Out of the box it runs with full system
permissions and zero security controls.

This repository fills that gap: TypeScript extensions for Pi, plus
surrounding infrastructure — a hardened container, a path-and-operation-gated
MCP server, audit logging, and a host-side model proxy. Combined with my
[agent skills][agent-skills], these compose my custom AI agent harness.

It's safe because the agent never touches the host filesystem directly —
access is mediated and logged through scoped allowlists, and credentials
stay out of its reach. That security profile suits the regulated industries
I work in, and travels well across the environments I move between as a
contractor.

It's predictable because reliable, consistently high-quality agentic
workflows aren't coaxed out of a model through careful prompting — that
stays fragile and non-deterministic. They're engineered into the harness:
structured lifecycle tasks encoded as explicit phases, each constraining
what the agent can do and see.

The goal, in short: make outcomes a property of the deterministic engineering
around the model, not of any single prompt or model's capabilities.

> [!WARNING]
> These tools are built for my personal use and they are volatile. They
> may change, break, or be removed at any time. They carry no support or
> stability guarantees. You are welcome to fork this repository and use it
> as a basis for engineering your own agent harness, but it is not recommended
> you use these tools as-is.

## 📋 Requirements

The core requirement, of course, is the [Pi coding agent][pi] installed and
on your `PATH`:

```sh
npm install -g @earendil-works/pi-coding-agent
```

The installer warns if `pi` is not found, but still stages the extensions so
they are ready once Pi is installed.

The `./run/install` script requires Bash. If you don't have this, no worries,
you'll just have to copy the extensions into `~/.pi/agent/extensions/` yourself.
See the [Pi docs][pi-docs].

### Per-extension requirements

None of the current extensions require more than Pi itself.

[pi]: https://pi.dev
[pi-docs]: https://pi.dev/docs/latest/extensions#extension-locations

## 📦 Installation

The `./run/install` script copies extensions from this repository's
`src/extensions/` directory into Pi's extensions directory in your home
directory, where Pi auto-discovers them.

### Running the installer

Make the script executable (once), then run it from anywhere:

```sh
chmod +x run/install
./run/install
```

With no arguments, every available extension is installed.

### Options

| Invocation              | Effect                                |
| ----------------------- | ------------------------------------- |
| `./run/install`         | Install all available extensions.     |
| `./run/install <name>…` | Install one or more named extensions. |
| `./run/install -l`      | List available extensions and exit.   |
| `./run/install --list`  | Same as `-l`.                         |
| `./run/install -h`      | Show usage help and exit.             |
| `./run/install --help`  | Same as `-h`.                         |

### Examples

```sh
./run/install                          # Install all.
./run/install pickling-penguins        # Install one.
./run/install pickling-penguins other  # Install multiple.
./run/install --list                   # See what is available.
```

Unknown extension names are reported and skipped; the rest of the run continues.

### What the installer does

For each extension it:

1.  Ensures Pi's extensions directory exists, creating `~/.pi/agent/extensions/`
    if necessary.

2.  Backs up any existing install of the same name to
    `~/.pi/agent/extensions/<name>.backup.<timestamp>/` before overwriting.

3.  Copies the extension's source directory (`src/extensions/<name>/`, entry
    point `index.ts`) to `~/.pi/agent/extensions/<name>/`, preserving the
    directory layout so multi-file extensions work.

### Manual installation

It's easy to install the extensions yourself. Just copy the extension
directory into `~/.pi/agent/extensions/`.

```sh
cp -R src/extensions/pickling-penguins ~/.pi/agent/extensions/pickling-penguins
```

### After installing

1. Start or restart Pi:

   ```sh
   pi
   ```

2. In Pi, reload extensions to pick up the new files:

   ```text
   /reload
   ```

Auto-discovered extensions in `~/.pi/agent/extensions/` can be hot-reloaded
with `/reload`; there is no need to restart Pi after the first launch.

### Adding a new extension

Each extension lives in its own directory under `src/`, with an `index.ts`
entry point:

```text
src/
└── <name>/
    └── index.ts
```

For the installer to offer it, add the directory name to the
`available_extensions` array in [`run/install`](../run/install), and
give it a description in `list_available_extensions`
([`run/inc/fn/extensions.sh`](../run/inc/fn/extensions.sh)).

## 🧭 Usage

How to use this repository day to day: getting the extensions installed,
running Pi inside the hardened container, and what each piece does once it's
running. This is a summary, not the full reference — each section links to the
README with the detail.

### Two ways to use this repository

- **Extensions only.** Install one or more extensions into a local
  (unsandboxed) Pi and use them as-is. This is the quick path, but least
  secure.

- **The hardened container.** Run Pi inside the full secure local agent
  architecture — no filesystem or Docker access on the agent, credentials held
  by a host-side proxy, mediated file access via MCP, and every operation
  audited. This is the setup for regulated or higher-trust-boundary work.
  See [local-agent-architecture.md](./local-agent-architecture.md) for the
  design and [`src/infrastructure/README.md`](../src/infrastructure/README.md)
  for the operator runbook.

The two are complementary: the container is the outer boundary; the
extensions (`mcp-client`, `audited-tools`, `permission-gate`) are the in-Pi
controls that the container's image bakes in.

### Installing extensions

```sh
./run/install                          # install everything
./run/install pickling-penguins        # install one
./run/install --list                   # see what's available
```

Copies from `src/extensions/<name>/` into `~/.pi/agent/extensions/<name>/`,
backing up any existing install first. After installing, start or restart Pi
and run `/reload` to pick up changes without a full restart.

Full detail, including manual installation and how to register a new extension:
[installation.md](./installation.md).

## 🧩 The extensions

### pickling-penguins

Cosmetic only. Replaces the "Working…" status line with randomly composed
nonsense ("Flambéing the singularity..."). No configuration, no commands —
install it and it just runs.

[👉 README](../src/extensions/pickling-penguins/README.md).

### audited-tools

Audited replacements for Pi's built-in `read`, `write`, `ls`, and `bash`, for
use with `--no-builtin-tools`. File tools are confined to an allowlisted
workspace root and refuse sensitive filenames (`.env*`, `id_rsa`, `*.pem`, …);
`bash` never touches a shell, rejects control operators, and checks the program
against an allowlist. Every call — allowed or denied — is appended to a JSONL
audit log. Configured via `AUDITED_TOOLS_ROOT`, `AUDITED_TOOLS_LOG`,
`AUDITED_BASH_ALLOWLIST`.

[👉 README](../src/extensions/audited-tools/README.md).

### permission-gate

Requires explicit, interactive confirmation before any mutating tool call
(`write`, `edit`, `bash`) runs. Read-only tools pass through silently.
Confirmation defaults to **deny** on timeout (60s) or when there's no
interactive UI. Every decision is logged. Complementary to `audited-tools`:
that extension enforces *where/what* is allowed; this one enforces
*whether the human agrees*. Configured via `PERMISSION_GATE_LOG`.

[👉 README](../src/extensions/permission-gate/README.md).

### mcp-client

Gives Pi an MCP client so it can reach a filesystem MCP server through the
Docker MCP Toolkit gateway, rather than mounting the project filesystem
directly. Tools the server exposes are registered under an `mcp_` prefix
(`read_file` → `mcp_read_file`). Does nothing unless `MCP_GATEWAY_URL` is set —
this is the extension the hardened container relies on for its filesystem
boundary.

[👉 README](../src/extensions/mcp-client/README.md).

## 🔒 Running inside the hardened container

The full stack — LiteLLM proxy, hardened `pi-container` image, MCP gateway,
compose wiring — lives under `src/infrastructure/`. It is NOT an extension and
is never installed by `run/install`.

Short version of the operator runbook (full detail, including the verification
checklist, in [`src/infrastructure/README.md`](../src/infrastructure/README.md)):

```sh
cp src/infrastructure/.env.example src/infrastructure/.env
# edit .env: API keys, PROJECT_PATH, LITELLM_MASTER_KEY, MCP_GATEWAY_AUTH_TOKEN

# 1. start the model proxy on the host
litellm --config src/infrastructure/proxy/litellm.config.yaml --host "$LITELLM_HOST" --port "$LITELLM_PORT"

# 2. build the hardened image (bakes in mcp-client, audited-tools, permission-gate)
docker build -f src/infrastructure/pi-container/Dockerfile -t pi-agent:hardened .

# 3. bring up the boundary
docker compose -f src/infrastructure/compose.yaml --env-file src/infrastructure/.env up
```

Run Pi inside the container with `--no-builtin-tools` so the audited
replacements are the only file/command tools available. Once up, verify the
boundary holds: the agent should have no cloud API keys in its environment,
no project mount, no Docker socket, and file access only through `mcp_*`/audited
tool calls, with `audit.jsonl` and `permissions.jsonl` on the `pi-sessions`
volume recording everything. The full verification table is in the
infrastructure README.

## 📓 Developer documentation

See the [contributing guidelines](./CONTRIBUTING.md).

-----

Copyright © 2020-present Kieran Potts, [MIT license](./LICENSE.txt)

Acknowledgements: The structure of this project was inspired by
Owain Lewis's [`pi-extensions`][owain-pi-extensions].
Owain's "funny status" extension was the direct inspiration for
[`pickling-penguins`](../src/extensions/pickling-penguins/README.md),
my first Pi extension. The [Pi example extensions][pi-example-extensions]
are another useful reference point.

[ci-badge]: https://github.com/kieranpotts/pi/actions/workflows/check.yaml/badge.svg
[ci-workflow]: https://github.com/kieranpotts/pi/actions/workflows/check.yaml
[agent-skills]: https://github.com/kieranpotts/skills
[owain-pi-extensions]: https://github.com/owainlewis/pi-extensions/
[pi-example-extensions]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/README.md
