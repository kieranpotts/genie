# TODO

Findings from an audit of the implementation against the design described in
[docs/solution.md](./docs/solution.md), plus items raised since.

The container, MCP, and proxy layers conform closely. The Pi-extensions layer
was where the deployed configuration silently did not do what the design said;
the remaining open items are listed below, each stating the gap between what is
claimed and what is enforced.

## Code fixes — the real posture is weaker than the design asserts

- [x] **Pass `--no-builtin-tools` to the agent.**
  Fixed by moving the launch flags out of the compose `command:` and into a
  `start-pi` launcher baked into the image. The container no longer starts an
  agent on `docker run`; it drops to a shell that lists the available harnesses,
  and `start-pi` is the supported way in — so `--model` and
  `--no-builtin-tools` can no longer be lost to an override.

- [x] **Give the operator sight of the project.**
  The no-mount rule was written for the agent, but it took the operator's
  visibility with it — a shell in the container could see only `/home/pi`, so
  "is the project loaded correctly?" was unanswerable from inside the boundary.
  The project is now mounted READ-ONLY at `/projects/active` for the operator,
  and a path fence in the bash policy (`AUDITED_BASH_FENCE`) refuses any agent
  command reaching into it, so the agent's route to project files is still the
  MCP server. `:ro` means the MCP server keeps the only writable handle, so the
  change trail stays complete regardless of how the fence fares.

  The fence's limits are stated where they are enforced
  (`src/extensions/audited-tools/bash-policy.ts`) and in that extension's README:
  it is lexical (no symlink resolution), self-enforced (in the agent's own
  process, unlike the MCP server's containment), and only as strong as the
  allowlist — `node -e` defeats it, which is why every `bash` call is also
  operator-confirmed. Trim `AUDITED_BASH_ALLOWLIST` if the fence needs to hold on
  its own.

- [x] **Resolve the `AUDITED_TOOLS_ROOT` mismatch.**
  Resolved by reclassifying the extension rather than making its file tools work,
  which would have meant a writable project mount and contradicted the design's
  central claim. The audited `read`/`write`/`ls` and their path guard were
  removed:
  they were rooted at a path that exists only in the MCP filesystem server's
  container, so every call failed while being audited as *allowed*. MCP is now
  the sole, honest route to files. `bash` remains, re-rooted to `AUDITED_BASH_CWD`
  (`/home/pi`) and documented as a guard on local execution only.

  The one control the removed tools carried that the MCP server does not
  replicate — refusing sensitive filenames — was lifted into `permission-gate`
  (`sensitive-files.ts`), whose `tool_call` hook sees every call including the
  `mcp_*` ones. Net effect: a strictly wider guarantee than the one that was
  claimed but not delivered. `mcp_read_file` on a project's `.env` was possible
  before this change and is refused now.

- [x] **Make the audit trails actually write.**
  The `pi-logs` volume mounted at `/var/log/pi` was owned `root:root` while the
  agent runs as uid 1001, so neither extension could create its log directory —
  and both swallow write failures by design, so the audit trail was silently
  absent rather than erroring. The image now creates `/var/log/pi/{audited-tools,
  permission-gate}` owned by `pi`, which Docker uses to seed a new named volume.
  An existing volume keeps its old ownership and must be removed once to re-seed.

- [x] **Drop the inert `MCP_GATEWAY_AUTH_TOKEN`.**
  The gateway enforces bearer auth only when bound to localhost outside a
  container; in the compose stack it logs `Authentication disabled (running in
  container)` and ignores the token. It was a control in name only. Removed from
  both services, the startup preflight, and the runbook; reachability is scoped
  by the private `agent-net` bridge, which is now stated as the actual control.
  The `mcp-client` still sends the header if the variable is ever set.

- [ ] **Decide whether interpreters stay on the default bash allowlist.**
  The path fence added with the read-only project mount is only as strong as the
  allowlist it sits behind, and the default allowlist includes `node`, `npm`,
  `npx`, `python`, `python3`, `pip`, `make`, `cargo`, and `go`. Each is a
  general-purpose interpreter, so the fence — which inspects command *tokens* —
  sees nothing to object to:

  ```
  node -e "require('fs').readFileSync('/projects/active/.env','utf8')"
  ```

  One allowlisted program, no shell operators, no token resolving into a fenced
  root. It reads the file, unmediated and outside the MCP audit trail. `python3
  -c` is the same shape, and `make` will run whatever a fenced `Makefile` says.
  The `:ro` mount still prevents writes, so this is a **read** and
  **exfiltration** exposure, not a tampering one — the change trail stays
  complete either way.

  What stops it today is the operator, not the fence: `permission-gate` requires
  confirmation for every `bash` call, so a `node -e "…"` is shown before it runs.
  That is a real control, but it is human vigilance on a string that may be long,
  minified, or boring on the hundredth prompt — precisely the conditions under
  which approval fatigue sets in. For an away-from-keyboard agent in a regulated
  context (`docs/requirements.md`), that is thin.

  The options, in the order they are worth considering:

  1. **Trim the default allowlist to the read-only inspection set** (`ls`, `cat`,
     `head`, `grep`, `find`, …), dropping every interpreter. The fence then holds
     on its own. Costs the agent the ability to run anything — but note it
     already cannot run project tests or builds, because the project is mounted
     read-only and most toolchains need to write. So the practical loss may be
     smaller than it looks. **Check what the interpreters are actually being used
     for before assuming otherwise.**
  2. **Keep them and drop the fence's claim to being a control**, describing it
     honestly as an ergonomic guardrail that keeps the model pointed at the
     `mcp_*` tools, with operator confirmation as the actual boundary.
  3. **Vet interpreter invocations specifically** — reject `-e`/`-c`/`--eval`
     and their equivalents, so the interpreters can only run files, which the
     fence *can* see. Narrows the hole without removing the tools, but it is an
     allowlist of flags per interpreter, which is the kind of thing that is
     wrong six months later when a flag is added.

  Option 1 is the recommendation unless the interpreters are earning their place.
  Whichever is chosen, the fence's limits are already stated where they are
  enforced (`src/extensions/audited-tools/bash-policy.ts`) and in that
  extension's README — those need updating to match the decision.

- [ ] **Record read-only tool calls in the audit trail.**
  `docs/requirements.md` asks for "full observability and auditability of every
  action the agent takes against the filesystem". Reads are not covered.

  `permission-gate` sees every tool call, but returns early for read-only ones
  (`index.ts`, the `requiresConfirmation` guard) and logs nothing. `audited-tools`
  logs only `bash`. So every `mcp_read_file`, `mcp_read_multiple_files`,
  `mcp_list_directory`, `mcp_directory_tree`, `mcp_search_files`, and
  `mcp_get_file_info` — which is to say every read of project content, the whole
  reason the agent has filesystem access at all — leaves no entry in
  `/var/log/pi`. Writes, refusals, and bash are recorded; reads are invisible.

  Two partial records exist, and neither is an audit trail. The gateway logs
  `Calling tool …` to its own container stdout with `--log-calls`, which is
  unstructured, lives in a different container, and dies with it. Session
  transcripts under `/home/pi/sessions` contain the calls and their results, but
  that is the agent's own narrative on a volume with different retention — a
  transcript, not an independent accountability record. For a regulated context,
  "we can reconstruct what was read from the chat log" is not the answer.

  The fix is small: have the gate log every call it sees, with the outcome as the
  `status` (`approved` / `denied` / `allowed` for the read-only pass-through).
  Two things to decide while doing it:

  - **Calls or actions?** Logging at `tool_call` records what was *attempted*. A
    read that the MCP server then refuses (traversal, outside the allowed
    directory) would appear as allowed, because the gate cannot see the outcome.
    A truthful trail needs the unused `tool_result` hook too — which is already
    an open item below, and this is the strongest argument for implementing it.
  - **Paths, not payloads.** Record the path and the outcome, never the content.
    Logging what was read would copy the secrets out of the files and into the
    audit trail, which is the opposite of the point.

  Renaming is worth considering too: once it records every call rather than every
  confirmation, `permission-gate/audit.jsonl` is a tool-call log, and the
  extension's README describes it as a decision log.

- [ ] **Enforce network egress control, or drop the claim.**
  The hardening table says the container "reaches the model only via the host
  proxy" and that "the only outbound network is the proxy and the MCP gateway".
  `agent-net` is a plain bridge with no `internal: true` and no egress rules, so
  the container has ordinary outbound internet via NAT. `PI_OFFLINE` stops Pi's
  own calls; nothing stops a tool, an extension, or `npx`. (Check `host-gateway`
  reachability before switching the network to `internal: true`.)

  This compounds the allowlist item above: an interpreter that can read a fenced
  file can also post it somewhere. Either fix alone reduces the exposure —
  closing egress means a read cannot leave; trimming the allowlist means there is
  nothing to read with — so they are worth weighing together rather than in turn.

## Documentation fixes — the design overstates the build

- [ ] **Three of the four documented hooks are not used anywhere.**
  `docs/solution.md:41` says these hooks "are used to intercept tool and model
  calls". Only `tool_call` (`src/extensions/permission-gate/index.ts:33`) and
  `session_start` (`src/extensions/mcp-client/index.ts:52`) are used — and the
  latter is not in the design at all. There is no `tool_result` handler (so no
  output redaction), no `before_provider_request` handler (so no auditing of
  outbound model traffic, despite `docs/solution.md:58`), and no
  `before_agent_start` handler. The `tool_result` gap is not only a documentation
  problem: the read-auditing item above needs that hook to record what a call
  actually *did* rather than what it attempted. Either implement them or rewrite the section as
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
