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

### Step 3 — Hardened `pi-container` image

- `src/infra/pi-container/Dockerfile`: non-root user, `--cap-drop ALL` (restore
  only what's needed), `no-new-privileges`, Pi installed, `PI_OFFLINE=1`,
  `sessionDir` pointed at a controlled volume. No keys, no `docker.sock`, no
  project mounts.
- **Delivers:** the agent container per the hardening checklist. **Test:**
  container builds; runs as non-root; cannot reach host paths; `env` shows no
  cloud keys; reaches the proxy at `host-gateway`.

### Step 4 — Docker MCP Toolkit filesystem boundary + `compose.yaml`

- Configure the Toolkit's filesystem MCP server scoped to a single project named
  volume; wire `agent-net`, the pi-container, and volumes in `compose.yaml`.
- **Delivers:** the mediated filesystem boundary — the core of Option 4.
  **Test (documented):** from inside pi-container, a path inside the project
  volume is readable/writable via the MCP server; a `../../` traversal and an
  out-of-scope path are denied; the agent has no direct mount.
- **Milestone:** end of Step 4 = a working, secure boundary using off-the-shelf
  pieces, no custom Pi code yet.

### Step 5 — `mcp-client` extension

- Give Pi an MCP client (Pi is not MCP-native) so it can call the Toolkit's
  filesystem tools. Factory `(pi) => void` per `AGENTS.md`; pure logic in helper
  modules for unit testing.
- **Delivers:** Pi can drive the MCP boundary. **Test:** unit tests for the
  client's request/response handling against a faked MCP endpoint.

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
- **MCP client extension — build vs. adopt** — is there prior art to adopt for
  Step 5, or is it in-house? Spike before committing Step 5's size.
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
