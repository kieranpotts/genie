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

  The fence's limits were stated where they were enforced
  (`src/extensions/audited-tools/bash-policy.ts`) and in that extension's README:
  it was lexical (no symlink resolution), self-enforced (in the agent's own
  process, unlike the MCP server's containment), and only as strong as the
  allowlist — `node -e` defeated it, which is why every `bash` call was also
  operator-confirmed.

  > **Superseded.** The read-only mount stays, but the fence is gone with the
  > `audited-tools` extension — see the removal item below. Nothing needs
  > fencing now: the agent has no local tool that can read the mount at all.
  > This entry is kept as the record of why the mount was added.

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

- [x] **Decide whether interpreters stay on the default bash allowlist.**
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

  **Resolved by a fourth option: remove agent execution entirely** — see the
  item below. All three options above are attempts to make a *self-enforced*
  guard hold, which is the one thing it structurally cannot do. Deleting the
  tool closes the question rather than answering it: there is no allowlist to
  trim, no interpreter to vet, and no fence to make claims about, because
  nothing executes in the agent container at all.

  Keep this item's analysis. If execution is ever restored (see the deferred
  exec-server option below), the interpreter question returns exactly as
  written, and option 1 is the answer to carry forward.

- [x] **Remove the `audited-tools` extension; the agent gets no execution.**

  The extension had been reduced to `bash` alone, and its own documentation
  conceded the two limits that mattered: the guard was **lexical**, and it was
  **self-enforced**, running inside the agent's own process. It was a
  cooperative guard, not a boundary — so it could not be strengthened in place,
  only moved or removed.

  Removing it, rather than moving it, was the decision. The reasoning:

  - **MCP becomes genuinely the sole route to files.** That is the design's
    central claim (`docs/solution.md`), and it has not been true while a second,
    self-policed route existed alongside it.
  - **The audit trail becomes complete** for the first time, instead of being
    split between the gateway and a log the agent writes about itself.
  - **The fence and its caveats disappear** rather than being restated. No
    lexical resolution, no symlink assumption, no "only as strong as the
    allowlist".
  - **Nothing demonstrably depended on it.** The tool ran in `/home/pi`, fenced
    out of `/projects/active`, on a read-only rootfs. It could not run project
    tests or builds. Its main demonstrated capability was being the interpreter
    that defeated the fence — which is the thing that was removed.

  What this does **not** change, and must not be claimed:

  - **`--no-builtin-tools` stays.** This was the original motivation for the
    whole discussion and it does not survive contact. The flag exists because
    Pi's built-in `read`, `grep`, `find`, and `edit` operate directly on the
    container filesystem, which mounts the project at `/projects/active`.
    Dropping it hands the agent an unmediated route to every project file,
    bypassing MCP entirely — a *wider* hole than the fence ever was, and one
    `permission-gate` would not catch (`policy.ts` gates `write`/`edit`/`bash`
    only; reads pass silently). The flag is required in every branch. It is also
    already free: `start-pi` bakes it into the image, so no operator types it.

  What was removed, found by grep across the repo:

  - **Deleted:** `src/extensions/audited-tools/` and
    `test/extensions/audited-tools/`.
  - **Infrastructure:** the four `AUDITED_*` variables, the fence rationale on
    the `project:/projects/active:ro` mount, and the `pi-logs` comment in
    `compose.yaml`; the `COPY`, the `/var/log/pi/audited-tools` mkdir, the
    header note and the footer hardening block in the Dockerfile; the
    `AUDITED_BASH_CWD` comment in `bashrc`; the "audited tools only" greeting in
    `harnesses.sh`.
  - **`start-pi.sh` needed care.** The `--no-builtin-tools` flag *stayed*, but
    its comment justified it in terms of `audited-tools` shadowing built-ins by
    name. That rationale died with the extension, so it was replaced with the
    real one — built-in `read`/`grep`/`find`/`edit` reaching the project mount
    directly — plus an explicit warning not to remove the flag on the grounds
    that there is no longer an extension to shadow anything.
  - **Tooling:** the entry in `run/install` and the case branch in
    `run/inc/fn/extensions.sh`.
  - **Docs:** the Mermaid node and extension-list entry in `README.md` (the
    latter was already stale — it still described the `read`/`write`/`ls` tools
    removed earlier); the tool-overriding passage and both affected hardening
    table rows in `docs/solution.md`; the runbook, boundary-check table, and
    audit-trail section in `src/infrastructure/README.md`; and the body of
    `src/extensions/permission-gate/README.md`.
  - **`permission-gate` cross-references:** historical rationale in `index.ts`,
    `decision-log.ts`, `sensitive-files.ts`, and its README explained that the
    sensitive-file rule "used to live in `audited-tools`". The rule was kept and
    the provenance rewritten.

  **Dead code in `permission-gate` was removed in the same change.** With no
  `bash` tool and `--no-builtin-tools` in force, there is no tool call carrying
  a `command` argument and no built-in `write`/`edit`/`bash` to match:

  - `policy.ts`: `MUTATING_BUILTINS` (`write`, `edit`, `bash`) could never
    match; folded into the single suffix list.
  - `policy.ts`: the `command` branch of `describeCall`, and with it the
    truncation bug recorded below — made moot rather than fixed.
  - `sensitive-files.ts`: the `input.command` tokenising branch of
    `pathArguments`, which existed so `cat id_rsa` could be caught.

  These were deleted rather than left dormant, which is the honest choice and
  matches the reasoning for removing the extension. The tests that covered them
  were kept as *inverted* assertions — `requiresConfirmation('bash') === false`,
  `pathArguments({ command }) === []` — so reintroducing execution without also
  gating it fails in the suite rather than in production.

  Note the `:ro` project mount **stays**. It is for the operator, and with no
  agent execution there is nothing left to fence it against — the agent has no
  way to read through it once its only local tool is gone.

  **Deferred option: an exec MCP server.** If execution turns out to be needed,
  do not restore the extension — put it behind a process boundary instead: a
  container exposing a single `run_command` tool, carrying the same
  `shell: false` execution and control-operator rejection, with **no project
  mount** and `--block-network`. That is strictly stronger than what was
  removed, because a compromised agent cannot reach around it.

  Design work already done, should this be picked up:

  - **Deployment: a catalog entry**, not a sibling compose service. The gateway
    would spawn it from `mcp/toolkit/catalog.yaml` exactly as it does the
    filesystem server, keeping one endpoint and one audit path, and bringing
    `--tools` and `--interceptor` coverage for free. The deciding factor is
    `mcp-client`: `index.ts` reads a single `MCP_GATEWAY_URL`, so a sibling
    service would first need multi-endpoint support added there. Trade-off: the
    `docker.sock`-holding gateway would spawn a second image.
  - **Allowlist: the read-only inspection set** (`ls`, `cat`, `head`, `tail`,
    `grep`, `find`, `wc`, `file`, `pwd`, `echo`, `which`, `stat`, `diff`,
    `tree`, `sort`, `uniq`, `cut`, `basename`, `dirname`) — no interpreters, and
    no `git`, since there is no project mount for it to act on.
  - **Sequencing: build before delete** — moot now that deletion comes first,
    but it means restoring execution is a clean additive change with no window
    of unaudited execution.
  - **Unresolved, and the reason this was deferred:** with an inspection-only
    allowlist and no project mount, it is unclear what such a server would have
    to inspect. The filesystem MCP server already covers reading, searching, and
    listing project content. Do not build it until there is a concrete blocked
    task that names what it needs to run — that requirement is the input the
    design is missing, not a detail to be filled in later.

  Triggers worth revisiting on: the agent repeatedly needing to run project
  tests or builds; a task that genuinely needs process execution rather than
  file access; or the project mount becoming writable, which would change the
  calculus entirely.

- [x] **`permission-gate` truncates the command it asks you to approve.**
  *(Resolved by removal, not by fixing. The `command` branch is gone with
  `audited-tools`, so no call reaches it. Kept as a record because the analysis
  is what justified deleting the branch rather than leaving it dormant — and
  because it returns intact if the deferred exec server is ever built.)*

  `policy.ts`'s `describeCall` runs `truncate(command, 120)`, and that string is
  both what the confirmation dialog shows and what lands in the audit trail as
  `detail`. So an operator approving a long `node -e "…"` payload cannot see
  past character 119, and the audit record of what was approved is equally
  truncated.

  This matters more than it looks, because operator confirmation is the control
  the fence's limits currently fall back on — the item above describes it as the
  thing that "stops the rest". A control that hides the second half of what it is
  confirming is not doing that job. Show the full command in the prompt (or at
  minimum a much higher cap), and log it in full regardless of what is displayed.

  Note also that the sensitive-filename refusal does not backstop this case:
  `sensitive-files.ts` whitespace-splits `command`, so the basename of
  `readFileSync('/projects/active/.env','utf8')` is `.env','utf8')`, which
  matches no pattern. It catches `cat .env`; it does not catch a payload.

- [ ] **Use the gateway's own controls — `--tools` and `--verify-signatures`.**
  Verified against the pinned image (`docker run --rm --entrypoint /docker-mcp
  docker/mcp-gateway@sha256:e3d6672… gateway run --help`), so this is the
  deployed surface, not the documented one.

  - `--tools strings` (and `--tools-config`) is a **tool-surface allowlist
    enforced at the boundary, out of process**. `compose.yaml` currently enables
    the `filesystem` server whole, so the agent gets `move_file`,
    `create_directory`, `read_media_file`, and the rest whether or not it needs
    them. Naming only the tools actually used is a real tightening, and a
    stronger one than anything `permission-gate` can offer, since that extension
    is cooperative and in-process. Establish the working set first — do not guess
    the list.
  - `--verify-signatures` is off. Largely redundant against digest pinning, but
    close to free; turn it on unless it breaks the bring-up.

- [ ] **Record read-only tool calls in the audit trail.**
  `docs/requirements.md` asks for "full observability and auditability of every
  action the agent takes against the filesystem". Reads are not covered.

  `permission-gate` sees every tool call, but returns early for read-only ones
  (`index.ts`, the `requiresConfirmation` guard) and logs nothing. So every
  `mcp_read_file`, `mcp_read_multiple_files`, `mcp_list_directory`,
  `mcp_directory_tree`, `mcp_search_files`, and `mcp_get_file_info` — which is
  to say every read of project content, the whole reason the agent has
  filesystem access at all — leaves no entry in `/var/log/pi`. Writes and
  refusals are recorded; reads are invisible.

  This got sharper with the removal of `audited-tools`: `permission-gate` is now
  the *only* extension writing an audit trail, so its blind spot is the whole
  system's blind spot.

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

    There is a second mechanism, and it is arguably the better one. The gateway
    accepts `--interceptor when:type:path` (e.g. `after:exec:/bin/path`),
    verified present on the pinned image. An `after` interceptor runs
    gateway-side and sees the **outcome** of a call, not the attempt — exactly
    what this bullet is asking for, and it records it outside the agent's own
    process rather than relying on the agent to narrate itself.

    Two caveats. The gateway runs `read_only: true` with `cap_drop: [ALL]`, so
    the interceptor binary must be baked into an image or bind-mounted
    read-only. And the gateway is the one container holding `docker.sock`, so
    adding an exec path there adds surface to the most privileged component —
    weigh that against the honesty gained.
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

  This used to compound the bash allowlist item: an interpreter that could read a
  fenced file could also post it somewhere. Removing agent execution closed the
  second half of that pairing — there is no longer a local tool that can read a
  file *or* make an outbound request. What remains is the extension surface
  itself (`mcp-client` opens an HTTP connection) and anything Pi's own runtime
  does, so the claim in the hardening table is still unenforced and still worth
  either implementing or dropping.

## Documentation fixes — the design overstates the build

- [ ] **Three of the four documented hooks are not used anywhere.**
  `docs/solution.md:41` says these hooks "are used to intercept tool and model
  calls". Only `tool_call` (`src/extensions/permission-gate/index.ts:51`) and
  `session_start` (`src/extensions/mcp-client/index.ts:59`) are used — and the
  latter is not in the design at all. There is no `tool_result` handler (so no
  output redaction), no `before_provider_request` handler (so no auditing of
  outbound model traffic, despite `docs/solution.md:58`), and no
  `before_agent_start` handler. The `tool_result` gap is not only a documentation
  problem: the read-auditing item above needs that hook to record what a call
  actually *did* rather than what it attempted. Either implement them or rewrite the section as
  stated intent.

- [ ] **Document the `docker.sock` grant in `docs/solution.md`.**
  `compose.yaml:101` binds the host Docker socket into `mcp-gateway`.
  `src/infrastructure/README.md`'s "The docker.sock trade-off (read this)"
  section documents and justifies this honestly and at length, but
  `docs/solution.md` never mentions it: the diagram at line 213 labels the
  pi-container "no FS, docker.sock, or keys" and the hardening table at line 277
  says "no `docker.sock`" — both true of the *agent*, but together they read as
  though no component holds one. `docs/requirements.md:11` names host Docker
  control explicitly, so this is the most important of the documentation gaps.

- [ ] **Reconcile multi-project diagrams with the single-project reality.**
  The diagrams and the mount view show `proj-a`/`proj-b` volumes and
  "per-project perms". Compose supports exactly one project (`PROJECT_PATH` →
  the `project` volume → `/projects/active`). The sequence-diagram paths
  (`/projects/proj-a/src/x.ts`) match nothing deployed.

## Hygiene

- [ ] **Pin the Pi package, per the project's own rule.**
  The hardening table requires third-party packages pinned to exact
  versions or commit hashes. All three container images are digest-pinned, but
  `src/infrastructure/pi-container/Dockerfile:37` is a bare
  `npm install -g @earendil-works/pi-coding-agent`, floating to latest at build
  time.

- [ ] **Fix stale cross-references.**
  `compose.yaml:4`, `src/infrastructure/pi-container/Dockerfile:17-18`, and
  `src/infrastructure/README.md:6` all cite `docs/local-agent-architecture.md`
  and `docs/local-agent-implementation-plan.md`, neither of which exists —
  `docs/` holds `problem.md`, `requirements.md`, `solution.md`, and
  `alternatives.md`. The Dockerfile also says `src/infra/` where the tree is
  `src/infrastructure/`, and several comments reference "step 3/4/…/8" of a
  plan that is not in the repository.

- [ ] **Copy-edit `docs/solution.md`.**
  - Line 98: "if you have another keeping secrets away from the model" — a word
    is missing.
  - Line 146: "to secrets never enter" → "so secrets never enter".
  - Line 149: "Docker MCP TOols" → "Docker MCP Toolkit".
  - Line 155: "so another proxy sites between" → "sits".
  - Lines 21, 24, 25, 28: these Mermaid node labels use `\n` for line breaks
    where lines 205-207 use `<br/>`; current Mermaid renders `\n` literally.
