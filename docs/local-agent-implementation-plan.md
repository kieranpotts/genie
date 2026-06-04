# Local agent architecture — implementation plan

Implementation plan for the architecture decided in
[local-agent-architecture.md](./local-agent-architecture.md). This is a
**planning artifact only** — no code is written here. It enumerates the
artifacts to build, sequences them into independently shippable steps, and
records the decisions and constraints that shape them.

## Decisions carried in from the design doc

- **Chosen architecture:** Option 4 (D) — Pi in a hardened container, filesystem
  access mediated by an MCP server, model traffic via a host-side proxy.
- **MCP server, first pass:** **Docker MCP Toolkit** (off-the-shelf) rather than
  a custom TypeScript server. The custom server stays an open alternative
  (tracked by the TODO in the design doc) and can drop in later behind the same
  agent-facing interface.
- **Model proxy:** LiteLLM on the host, holding all cloud API keys.
- **Infra location:** a new `src/infra/` tree (sibling to `src/extensions/`).
- **Primary objective:** security — filesystem isolation first, credential
  isolation second, auditability third. Portability across dev environments is a
  stated secondary requirement.

## Two classes of artifact

The architecture decomposes into two kinds of artifact, which live in different
places and follow different conventions:

1. **Pi extensions** (`src/extensions/<name>/`) — TypeScript controls that run
   *inside* Pi: the MCP client, audited tool replacements, the permission-gate,
   and audit-logging hooks. Installed by `run/install`, tested under `test/`,
   subject to the `AGENTS.md` extension rules.
2. **Infrastructure** (`src/infra/`) — Docker images, compose files, the LiteLLM
   proxy config, and Docker MCP Toolkit wiring. **Not** installable extensions;
   `run/install` must never copy these into `~/.pi/agent/extensions/`.

### Constraint: keep infra out of the installer

`run/install` installs only the names in its explicit `available_extensions`
array, and `src_dir` now points at `src/extensions` — so `src/infra/` is already
outside the install path. **MUST NOT** add any `src/infra/` entry to
`available_extensions`, and **MUST NOT** repoint `src_dir` at `src/`. A guard
test (or a comment in `run/install`) SHOULD record this so it is not undone by
accident.

## Target layout

```
src/
├── extensions/
│   ├── pickling-penguins/        (existing)
│   ├── realize/                  (existing — WIP, see note below)
│   ├── mcp-client/               NEW — gives Pi an MCP client (Pi is not MCP-native)
│   ├── audited-tools/            NEW — --no-builtin-tools replacements (allowlist + log)
│   └── permission-gate/          NEW — confirm writes/exec, default-deny, log decisions
│
└── infra/                        NEW
    ├── README.md                 how the pieces fit; quick-start
    ├── compose.yaml              agent-net, pi-container, mcp wiring, volumes
    ├── pi-container/
    │   └── Dockerfile            hardened image: non-root, cap-drop, no-new-privs
    ├── proxy/
    │   └── litellm.config.yaml   routing rules; keys via env, never committed
    ├── mcp/
    │   └── toolkit/              Docker MCP Toolkit config (filesystem server scoping)
    └── .env.example              documents required host env (API keys, paths)

test/
├── extensions/<name>/            tests mirror src/extensions/ (decided in Step 0)
└── infra/                        smoke/guard tests where feasible
```

## `realize` is WIP — dependency note

The `realize` extension is still work-in-progress. **No step in this plan
depends on `realize`**, and none of the new security artifacts should import from
or assume `realize`. They are independent. Where the two could eventually
interact (e.g. running `/realize` inside the hardened container), that is
explicitly out of scope here and parked in Open Questions.

## Sequenced steps

Each step is independently shippable and reversible, smallest blast-radius
first. Steps 1–4 stand up the infra boundary (the security objective); steps 5–7
add the in-Pi controls; step 8 ties it together.

### Step 0 — Conventions & guardrails ✅ DONE

- ✅ Updated `AGENTS.md`: extensions live under `src/extensions/<name>/`;
  introduced `src/infra/` and stated it is **not** installable (overview, repo
  structure, and a new MUST NOT rule).
- ✅ Test layout decided: **mirror** `src/extensions/` under
  `test/extensions/<name>/`. Moved the existing `test/realize/` and
  `test/pickling-gnomes/` accordingly and fixed import depth
  (`../../` → `../../../`).
- ✅ Added the "infra MUST NOT be installed" constraint to `AGENTS.md` rules.
- **Delivered:** agreed conventions, tests relocated. **Verified:**
  `./run/check` clean (117/117 tests, lint clean); `shellcheck run/install`
  clean; `./run/install --list` still shows exactly `pickling-penguins` and
  `realize`.

### Step 1 — `src/infra/` skeleton + README ✅ DONE

- ✅ Created `src/infra/` with `README.md` (components table, trust boundaries,
  quick-start, security notes) and `.env.example` documenting the full host-env
  contract (cloud keys, Ollama, proxy endpoint, project path, session dir,
  `PI_OFFLINE`) with no secrets.
- ✅ Placeholder subdirs `proxy/`, `pi-container/`, `mcp/toolkit/` (with
  `.gitkeep`) for steps 2–4.
- ✅ Hardened `.gitignore`: `.env` and `.env.*` ignored, `.env.example` tracked
  — closes the risk of committing host API keys in a security-focused repo.
- **Delivered:** a home for infra and the host contract. **Verified:**
  `git check-ignore` confirms `.env` ignored / `.env.example` tracked;
  `./run/install --list` shows only the two extensions and `./run/install infra`
  is rejected (`Unknown extension: infra`); `./run/check` clean (117/117).

### Step 2 — LiteLLM proxy config (credential isolation) ✅ DONE

- ✅ `src/infra/proxy/litellm.config.yaml`: `fast` → Ollama (local), `capable` →
  cloud (Anthropic), plus explicit provider models (`ollama/llama3.1`,
  `claude-sonnet-4-6`, `gpt-4o`). All keys via `os.environ/` only; Ollama
  `api_base` from `OLLAMA_HOST`. `capable` falls back to `fast` when cloud is
  unreachable (keeps the agent working offline without leaking data).
- ✅ Proxy gated by `master_key` (`os.environ/LITELLM_MASTER_KEY`) — a low-value
  rotatable token the agent holds *instead of* cloud keys; added to
  `.env.example`.
- ✅ README quick-start updated with the host-side proxy launch command.
- **Delivered:** the host-side credential holder. **Verified:** config parses as
  valid YAML; routing aliases + fallback resolve; every `api_key`/`master_key`
  is `none` or `os.environ/` — **no literal secret in any committed file**.
  Runtime startup (`litellm --config …`) deferred — `litellm` is not installed
  on this host; documented in the quick-start and step-8 runbook.
- **Why early:** credential isolation is the second objective and is independent
  of the filesystem boundary — provable on its own.

### Step 3 — Hardened `pi-container` image ✅ DONE

- ✅ `src/infra/pi-container/Dockerfile`: `node:24-bookworm-slim`, dedicated
  non-root `pi` user (uid/gid 1001), global Pi install, `PI_OFFLINE=1` +
  `PI_SKIP_VERSION_CHECK=1`, session dir `/home/pi/sessions` on a `VOLUME`
  (sensitive transcripts kept outside any project tree), `USER pi` before
  `ENTRYPOINT ["pi"]`. Bakes in no keys, no `docker.sock`, no project source.
- ✅ Runtime-only hardening (cap-drop, no-new-privileges, read-only rootfs,
  resource limits) documented in a footer block for the compose wiring in step
  4 — a Dockerfile cannot set these itself.
- ✅ Security extensions install is staged: `realize` (WIP) is deliberately NOT
  shipped; the three security extensions are COPY'd in by name as steps 5-7 land
  (placeholders recorded in the Dockerfile), avoiding baking WIP code.
- ✅ Added `.dockerignore` (build context is repo root): excludes `.git`,
  `node_modules`, all `.env*` (keeps secrets out of image layers), docs, tests,
  and `src/infra` itself.
- **Delivered:** the hardened agent image. **Verified:** `docker build --check`
  passes clean (no warnings) against real `node:24-bookworm-slim` metadata;
  instruction order correct (USER before ENTRYPOINT); secret/socket scan finds
  none baked in. Full `npm install -g` build deferred to runtime (network fetch;
  documented in quick-start).

### Step 4 — Docker MCP Toolkit filesystem boundary + `compose.yaml` ✅ DONE

- ✅ `src/infra/compose.yaml`: `agent-net` bridge network; a `project` named
  volume bound to `PROJECT_PATH` (the single allowed dir); `mcp-filesystem`
  (`mcp/filesystem`, allowed path `/projects/active`) as the sole FS holder;
  `mcp-gateway` (`docker/mcp-gateway`) fronting it over **HTTP/SSE** on
  agent-net (transport decision: networked, not stdio — matches the
  separate-container design); and the runtime-hardened `pi` service built from
  the step-3 Dockerfile.
- ✅ Runtime hardening applied per service (the Dockerfile footer): `cap_drop:
  ALL`, `no-new-privileges`, `read_only` + tmpfs, mem/pids limits, explicit
  non-root `user`.
- ✅ pi reaches files only via `MCP_GATEWAY_URL` and models only via
  `AGENT_MODEL_ENDPOINT` + `LITELLM_MASTER_KEY` — **no cloud keys, no
  docker.sock, no project mount** (only the `pi-sessions` volume).
- **Delivered:** the mediated filesystem boundary — the core of Option 4.
  **Verified:** `docker compose config` resolves cleanly; the resolved spec
  confirms (1) pi has no `*_API_KEY`, (2) the project volume mounts only on
  `mcp-filesystem`, (3) no `docker.sock` anywhere, (4) cap_drop +
  no-new-privileges on all three services. Live up/traversal-denial test
  deferred to the step-8 runbook (needs real images pulled + the step-5 client).
- **Caveat:** the `docker/mcp-gateway` image name and flags follow the Toolkit
  gateway pattern and may need adjusting to the installed Toolkit version (noted
  in the README); the `mcp/filesystem` boundary semantics are stable.
- **Milestone reached:** a working, secure boundary using off-the-shelf pieces,
  no custom Pi code yet. ✅

### Step 5 — `mcp-client` extension ✅ DONE

- **Spike outcome:** verified Pi has **no** native MCP support (extension API
  exposes `registerTool`, `fetch`, `exec` only). Pi loads extensions via jiti
  with a fixed set of bundled virtual modules (`typebox`, `pi-ai`, `pi-tui`);
  the MCP SDK is not among them and the verbatim-copy installer has no
  `node_modules` resolution — so the SDK could not be shipped. Decision:
  **hand-roll** the MCP-over-HTTP/SSE client with `fetch`, no dependency.
- ✅ `src/extensions/mcp-client/`: `mcp-client.ts` (pure JSON-RPC/SSE protocol —
  `initialize`, `tools/list`, `tools/call` — with injected `fetch`),
  `tool-mapping.ts` (pure MCP↔Pi mapping: `mcp_` prefixing, schema passthrough,
  result flattening), `index.ts` (thin glue: on `session_start`, connect to
  `MCP_GATEWAY_URL`, list tools, register each via `pi.registerTool`), README.
- ✅ Registered in `run/install` (`available_extensions` + description arm in
  `extensions.sh`) per the AGENTS.md rule; Dockerfile now COPYs it into the
  image.
- **Delivered:** Pi can drive the MCP boundary. **Verified:** 26 new unit tests
  (request framing, SSE parse incl. CRLF/keep-alive/[DONE], id matching, error
  responses, HTTP errors, incrementing ids, name round-trip, description/schema
  mapping, content flattening) — full suite 143/143; lint + shellcheck clean;
  `docker build --check` clean; installer lists `mcp-client`. Built against the
  real Pi types (`registerTool`/`ToolDefinition`/`session_start`/`ExtensionContext`).
- **Note:** the repo has no `tsc` typecheck (ESLint only), and `parameters`/the
  tool result are passed with `as never` at the `registerTool` seam (plain JSON
  Schema where Pi types a TypeBox `TSchema`). Live wiring against a running
  gateway is exercised in the step-8 runbook.

### Step 6 — `audited-tools` extension (`--no-builtin-tools` replacements)

- Replacement tools for the surface Pi needs, each enforcing a path allowlist
  (with the `resolve()`/`relative()` traversal + prefix-collision defence from
  the design doc), refusing sensitive filenames, and logging every invocation.
- **Delivers:** locked-down tool surface even if the MCP boundary is bypassed —
  defence in depth. **Test:** unit tests for allowlist accept/deny, traversal,
  prefix-collision, sensitive-filename refusal, and that each call is logged.

### Step 7 — `permission-gate` extension

- Intercept writes/exec: explicit confirmation, timeout → deny, every decision
  logged to an append-only file outside the container.
- **Delivers:** interactive approval (the ecosystem gap the design doc notes).
  **Test:** unit tests for approve/deny/timeout paths and that decisions are
  logged.

### Step 8 — Integration & operator runbook

- A documented end-to-end runbook in `src/infra/README.md`: bring up proxy +
  network + MCP boundary + hardened Pi with the three extensions installed; run
  a real task against a project volume; show the audit log and a denied
  operation.
- **Delivers:** the reproducible, portable setup the requirements call for.
  **Test:** the runbook executed clean on a fresh machine; audit artifacts
  present.

## Build order rationale

- Infra before extensions: the security boundary (steps 1–4) is the objective
  and is provable with off-the-shelf tooling before any bespoke Pi code exists.
- Within extensions: `mcp-client` (reach the boundary) → `audited-tools`
  (defence in depth) → `permission-gate` (interactive control), each adding a
  layer without depending on the next.
- Custom MCP server is deliberately deferred — the Toolkit-first decision lets
  steps 1–8 complete without it; it can replace Step 4's server later behind the
  same interface.

## Open questions (carried forward / new)

- **Custom vs. Toolkit MCP server** — Toolkit first this pass; revisit once the
  boundary is proven and policy-control needs are clearer (design-doc TODO).
- **`run_command` / exec into devcontainers** — include the runtime-execution
  path now, or ship file-only mediation first? Affects whether any
  `docker.sock`-equivalent privilege re-enters the design. Default: defer.
- **`realize` interaction** — running `/realize` inside the hardened container is
  out of scope until `realize` stabilises; revisit after it lands.
- **Egress filtering** — recommended for sensitive projects; still out of scope
  for the baseline. Decide whether Step 8's runbook includes it.

## References

- [local-agent-architecture.md](./local-agent-architecture.md) — the RFC this
  plan implements.
- [PLAN.md](../PLAN.md) — fuller working analysis behind the RFC.
- `AGENTS.md` — extension authoring rules this plan's extensions must follow.
- `run/install` — installer; the infra-exclusion constraint applies to it.
