# Usage

How to use this repository day to day: getting the extensions installed,
running Pi inside the hardened container, and what each piece does once it's
running. This is a summary, not the full reference — each section links to the
README with the detail.

## Two ways to use this repository

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

## Installing extensions

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

## The extensions

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

## Running inside the hardened container

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

## Where to look next

- Design rationale for the whole architecture: [local-agent-architecture.md](./local-agent-architecture.md)

- Requirements per extension: [requirements.md](./requirements.md)

- Installing extensions in detail: [installation.md](./installation.md)

- Contributing, linting, testing: [CONTRIBUTING.md](../CONTRIBUTING.md)
