# TODO

Findings from an audit of the implementation against the design described in
[docs/solution.md](./docs/solution.md).

The container, MCP, and proxy layers conform closely. The Pi-extensions layer
does not, and there are three places where the deployed configuration silently
does not do what the design says.

## Code fixes — the real posture is weaker than the design asserts

- [x] **Pass `--no-builtin-tools` to the agent.**
  Fixed by moving the launch flags out of the compose `command:` and into a
  `start-pi` launcher baked into the image. The container no longer starts an
  agent on `docker run`; it drops to a shell that lists the available harnesses,
  and `start-pi` is the supported way in — so `--model` and
  `--no-builtin-tools` can no longer be lost to an override.

- [ ] **Resolve the `AUDITED_TOOLS_ROOT` mismatch.**
  `compose.yaml:168` sets `AUDITED_TOOLS_ROOT=/projects/active`, but the `pi`
  service mounts only `pi-sessions` and `pi-logs` — deliberately no project
  mount. Every audited `read`/`write`/`ls` therefore resolves into a directory
  that does not exist, and `bash` sets `cwd` to it so spawns fail outright. The
  "even if the MCP boundary is bypassed" defence-in-depth claim
  (`src/extensions/audited-tools/index.ts:8-11`, and the first row of the
  hardening table) does not hold as deployed: all real file access is via
  `mcp_*`, and `audited-tools` guards nothing reachable. Either give the
  extension something to guard, or reclassify it in the design.

- [ ] **Enforce network egress control, or drop the claim.**
  The hardening table says the container "reaches the model only via the host
  proxy" and that "the only outbound network is the proxy and the MCP gateway".
  `agent-net` is a plain bridge with no `internal: true` and no egress rules, so
  the container has ordinary outbound internet via NAT. `PI_OFFLINE` stops Pi's
  own calls; nothing stops a tool, an extension, or `npx`. (Check `host-gateway`
  reachability before switching the network to `internal: true`.)

## Documentation fixes — the design overstates the build

- [ ] **Three of the four documented hooks are not used anywhere.**
  `docs/solution.md:41` says these hooks "are used to intercept tool and model
  calls". Only `tool_call` (`src/extensions/permission-gate/index.ts:33`) and
  `session_start` (`src/extensions/mcp-client/index.ts:52`) are used — and the
  latter is not in the design at all. There is no `tool_result` handler (so no
  output redaction), no `before_provider_request` handler (so no auditing of
  outbound model traffic, despite `docs/solution.md:58`), and no
  `before_agent_start` handler. Either implement them or rewrite the section as
  stated intent.

- [ ] **Document the `docker.sock` grant in `docs/solution.md`.**
  `compose.yaml:93` binds the host Docker socket into `mcp-gateway`.
  `src/infrastructure/README.md:118-136` documents and justifies this honestly
  and at length, but `docs/solution.md:76` says only "There's no access to
  Docker sockets either", and the hardening table reads as though no component
  holds one. `docs/requirements.md:11` names host Docker control explicitly, so
  this is the most important of the documentation gaps.

- [ ] **Reconcile multi-project diagrams with the single-project reality.**
  The diagrams and the mount view show `proj-a`/`proj-b` volumes and
  "per-project perms". Compose supports exactly one project (`PROJECT_PATH` →
  the `project` volume → `/projects/active`). The sequence-diagram paths
  (`/projects/proj-a/src/x.ts`) match nothing deployed.

## Hygiene

- [ ] **Pin the Pi package, per the project's own rule.**
  The hardening table requires third-party packages pinned to exact
  versions or commit hashes. All three container images are digest-pinned, but
  `src/infrastructure/pi-container/Dockerfile:36` is a bare
  `npm install -g @earendil-works/pi-coding-agent`, floating to latest at build
  time.

- [ ] **Fix stale cross-references.**
  `compose.yaml:4`, `src/infrastructure/pi-container/Dockerfile:16-17`, and
  `src/infrastructure/README.md:6` all cite `docs/local-agent-architecture.md`
  and `docs/local-agent-implementation-plan.md`, neither of which exists —
  `docs/` holds `problem.md`, `requirements.md`, `solution.md`, and
  `alternatives.md`. The Dockerfile also says `src/infra/` where the tree is
  `src/infrastructure/`, and several comments reference "step 3/4/…/8" of a
  plan that is not in the repository.

- [ ] **Copy-edit `docs/solution.md`.**
  - Line 90: "if you have another keeping secrets away from the model" — a word
    is missing.
  - Line 138: "to secrets never enter" → "so secrets never enter".
  - Line 141: "Docker MCP TOols" → "Docker MCP Toolkit".
  - Line 146: "so another proxy sites between" → "sits".
  - Lines 21, 24, 28: these Mermaid node labels use `\n` for line breaks where
    line 198 uses `<br/>`; current Mermaid renders `\n` literally.
