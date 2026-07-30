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
  The project is now mounted READ-ONLY at `/workspace` for the operator,
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
  node -e "require('fs').readFileSync('/workspace/.env','utf8')"
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
    out of `/workspace`, on a read-only rootfs. It could not run project
    tests or builds. Its main demonstrated capability was being the interpreter
    that defeated the fence — which is the thing that was removed.

  What this does **not** change, and must not be claimed:

  - **`--no-builtin-tools` stays.** This was the original motivation for the
    whole discussion and it does not survive contact. The flag exists because
    Pi's built-in `read`, `grep`, `find`, and `edit` operate directly on the
    container filesystem, which mounts the project at `/workspace`.
    Dropping it hands the agent an unmediated route to every project file,
    bypassing MCP entirely — a *wider* hole than the fence ever was, and one
    `permission-gate` would not catch (`policy.ts` gates `write`/`edit`/`bash`
    only; reads pass silently). The flag is required in every branch. It is also
    already free: `start-pi` bakes it into the image, so no operator types it.

  What was removed, found by grep across the repo:

  - **Deleted:** `src/extensions/audited-tools/` and
    `test/extensions/audited-tools/`.
  - **Infrastructure:** the four `AUDITED_*` variables, the fence rationale on
    the `project:/workspace:ro` mount, and the `pi-logs` comment in
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
  `readFileSync('/workspace/.env','utf8')` is `.env','utf8')`, which
  matches no pattern. It catches `cat .env`; it does not catch a payload.

- [ ] **Use the gateway's own controls — `--tools`.** *(`--verify-signatures`
  was the other half of this item and is now **declined**; see the sub-item
  below. Only the `--tools` allowlist remains open, and it is blocked on usage
  data rather than on a decision.)*

  Verified against the pinned image (`docker run --rm --entrypoint /docker-mcp
  docker/mcp-gateway@sha256:e3d6672… gateway run --help`), so this is the
  deployed surface, not the documented one.

  - `--tools strings` (and `--tools-config`) is a **tool-surface allowlist
    enforced at the boundary, out of process**. `compose.yaml` currently enables
    the `filesystem` server whole, so the agent gets every tool it exposes
    whether or not it needs them. Naming only the tools actually used is a real
    tightening, and a stronger one than anything `permission-gate` can offer,
    since that extension is cooperative and in-process.

    **The exposed surface, now measured** (`tools/list` against the running
    gateway, not guessed — the tool-surface check in the runbook reproduces it):

    ```
    read_file  read_multiple_files  list_directory  directory_tree
    search_files  get_file_info  list_allowed_directories
    write_file  edit_file  move_file  create_directory
    ```

    Eleven, not the larger set assumed above: this entry previously cited
    `read_media_file` as an example of the excess, and the pinned
    `mcp/filesystem` image does **not** expose it. Correcting that is the point
    of measuring.

    What remains is the *use* question, which the call log now answers: run
    `jq -r 'select(.phase=="call") | .tool' calls.jsonl | sort | uniq -c` after
    real work and drop what never appears. The phase filter matters — a call
    writes two lines, so an unfiltered count doubles everything.
    `list_allowed_directories` and `directory_tree` are the
    obvious first candidates. Note the honest ceiling — with all eleven being
    filesystem tools confined to `/workspace`, this is defence in depth, not a
    new boundary; the containment is already the MCP server's.

    **First real data, and it is not yet enough.** Four driven sessions
    produced 20 lines (10 calls), and the working set was exactly two tools:

    ```
      5 mcp_read_file
      5 mcp_list_directory
    ```

    Do **not** trim to those two on this evidence. The sessions were short,
    non-interactive (`--print`), and all ran on one role — the model chose
    list-then-read every time and never reached for `search_files`,
    `directory_tree`, or `get_file_info`, which a longer task plausibly would.
    Writes were never exercised at all: `--print` has no UI, so
    `permission-gate` denies mutating calls as `no-ui` before they run, meaning
    this sample cannot say anything about `write_file`, `edit_file`,
    `move_file`, or `create_directory`.

    What the sample *does* establish is that the measurement now works. Carry on
    accumulating across real interactive sessions — including ones that write —
    and re-run the `jq` line before deciding. The trap to avoid is treating a
    thin sample as a measured result, which is the same mistake as guessing,
    with better presentation.

    **A FIRST CUT IS NOW SHIPPED: eight of eleven.** `compose.yaml` carries
    `--tools` with `read_file`, `list_directory`, `search_files`,
    `list_allowed_directories`, `write_file`, `edit_file`, `move_file`,
    `create_directory`.

    This does **not** contradict the paragraph above, because it does not use
    the frequency data. Each omission is justified by a kept tool doing the same
    job, which is an argument that holds whatever the sample size:

    - `read_multiple_files` → `read_file`, N times. **This one also closes an
      audit gap** (see the new item below): `describeCall` truncates a joined
      `paths` list at 120 characters, so a multi-file read of deep paths records
      only the first few. Sequential single reads log one complete line each.
    - `directory_tree` → `list_directory`, plus `search_files` for a recursive
      look. It is the only tool in the set with unbounded output: one call can
      pull an entire tree into the model's context, which costs context and
      widens what a compromised model can extract per call.
    - `get_file_info` → nothing needs it that `list_directory` and `read_file`
      do not already answer.

    **`list_allowed_directories` is KEPT, reversing this item's earlier guess**
    that it was an obvious first candidate. Nothing tells the agent its project
    root: `start-pi` sets no system prompt and Pi's cwd is `/home/pi`, not
    `/workspace`, so this is the agent's only in-band way to discover where the
    project is. It returns one path and can read no content. Dropping it to save
    nothing risks an agent that cannot find the project — a confusing failure
    for no gain. If it is ever dropped, the root has to be stated in the system
    prompt in the same change.

    The asymmetry that makes shipping this early safe: guessing **inclusively**
    fails loudly and reversibly (the model reports having no such tool; add the
    name back), whereas guessing **exclusively** — trimming to the two tools the
    thin sample happened to show — is the mistake this item has warned about
    throughout.

    **Verified against the running stack**, not just parsed by compose. Brought
    up `mcp-gateway` + `pi` (no proxy needed for `tools/list`) and ran the
    runbook's tool-surface check:

    - The gateway's own startup log says `filesystem: (8 tools)`, and the check
      from inside the agent container lists exactly the eight named above and
      nothing else. So the comma-separated bare-name syntax is accepted — the
      names are not server-qualified.
    - **A withheld tool is unreachable, not merely hidden.** Absence from
      `tools/list` would also be satisfied by a tool that still worked when
      called directly, so all three were called: each returns
      `unknown tool "directory_tree"` and so on, refused at the gateway.
    - **Containment and the outcome axis are undisturbed.**
      `list_directory(/workspace)` still returns the listing;
      `read_file(/etc/passwd)` is still refused with `Access denied - path
      outside allowed directories` and `isError: true` — which re-confirms the
      `mcp-client` fix recorded further down, this time on the real gateway.
    - **A mistyped tool name is silently ignored**, measured rather than
      inferred: a throwaway gateway started with
      `--tools=read_file,definitely_not_a_tool` comes up normally, logs
      `filesystem: (1 tools)`, and emits no warning or error. So a typo here
      does not fail loudly — it quietly narrows the agent's surface, and the
      tool-surface check is the only thing that would catch it. That is now
      stated in the runbook, along with what "fewer than eight" and "all eleven"
      each indicate.

    The stack was torn down afterwards (`compose down`, volumes untouched).

    **Still open, and this is what the interactive data is for:** whether the
    *used* set is narrower than eight. The four write tools have never been
    exercised at all, and `search_files` has not been seen in use either — so the
    remaining question is unchanged in kind, only smaller.
  - **`--verify-signatures`: DECLINED, not deferred.** The instruction above was
    "close to free; turn it on unless it breaks the bring-up". Measured, it is
    neither free nor compatible, and the item is closed rather than left open.

    Two findings, in the order they appeared:

    1. **It breaks the bring-up as written.** The gateway crash-loops on
       `verifying docker images: getting Rekor public keys: creating cached
       local store: mkdir /root/.sigstore: read-only file system` — it wants a
       cache directory, and the gateway runs `read_only: true`. This part is
       fixable: adding `/root/.sigstore` to the service's `tmpfs` list makes
       verification succeed in about a second.
    2. **With that fixed, it needs outbound internet** — it fetches the sigstore
       TUF root from `https://tuf-repo-cdn.sigstore.dev`. On the now-`internal`
       `agent-net` that fails (`server misbehaving` from the embedded resolver)
       and the gateway crash-loops again. **`--verify-signatures` and the egress
       control are mutually exclusive as long as the gateway shares the agent's
       network.**

    The workaround was tested and rejected. Putting the gateway on a second,
    non-internal `egress-net` does work — verification succeeds, the agent stays
    sealed, `ENETUNREACH` on every external address. But the gateway then spawns
    **the filesystem MCP server onto `egress-net`**, confirmed in its own log
    line (`--network pi-secure-agent_egress-net`). That hands outbound internet
    to the one component holding a writable handle on the project, which is a
    worse position than the one being fixed, and the network it picks is not
    controllable from `compose.yaml`.

    So the trade is: **signature verification, or an egress boundary.** Egress
    wins, because the two are not comparable in strength. The images are already
    **digest-pinned**, which fixes image *identity* cryptographically — a digest
    cannot be re-pointed. Signatures would add *provenance* (who published it)
    on top of an identity that is already nailed down, and only at pull time.
    The egress boundary constrains the whole running system continuously. Paying
    for the former with the latter is a bad trade.

    Revisit only if the topology changes — specifically if the gateway stops
    sharing a network with the agent, or if the Toolkit gains a way to pin which
    network spawned servers attach to. Neither is true today.

- [ ] **`describeCall` truncates a multi-file read's path list, so the audit
  trail loses which files were read.**
  Found while justifying the `--tools` first cut above, not from a failure —
  which is why it is recorded rather than quietly fixed alongside it.

  `policy.ts`:

  ```ts
  if (paths.length > 0) return `${toolName}: ${truncate(paths.join(', '), 120)}`
  ```

  `mcp_read_multiple_files` takes a `paths` array. Joined `/workspace/…` paths
  reach 120 characters after roughly two or three realistic entries, so a read of
  ten files records the first few and an ellipsis. **The audit trail then cannot
  say what was read**, which is precisely the question it exists to answer, and
  the omission is invisible in the log — an ellipsis reads like formatting, not
  like missing evidence.

  This is the same class of defect as the `command` truncation recorded above,
  which was made moot by deleting the `bash` tool rather than fixed. The parallel
  is exact and worth noting: a display cap borrowed for an audit record.

  **Currently unreachable, deliberately.** The `--tools` allowlist does not
  enable `read_multiple_files`, so nothing can produce a `paths` argument today.
  That is what makes this a recorded finding rather than an active bug — and it is
  also a **precondition on re-enabling that tool**: doing so without fixing this
  reintroduces the gap silently.

  The fix is small and worth doing anyway, because dead code that is wrong is a
  trap for whoever re-enables the tool: log every path in full, and let the
  confirmation *prompt* be the only thing that truncates. The two consumers of
  `describeCall` want different things — a dialog wants to fit on a screen, an
  audit record wants to be complete — and one string currently serves both. That
  is the actual design error; the cap is only its symptom.

- [x] **Record read-only tool calls in the audit trail.**
  `docs/requirements.md` asks for "full observability and auditability of every
  action the agent takes against the filesystem". Reads were not covered.

  **Done.** `permission-gate` now logs every call it sees. The read-only branch
  in `index.ts` records before returning instead of returning silently, so the
  entire `mcp_read_*` / `mcp_list_*` / `mcp_search_*` surface appears in the
  trail.

  The record was made **two-axis** rather than gaining a third `status` value:

  - `outcome` — `allowed` / `blocked`: did the call run.
  - `confirmation` — `not-required` / `not-offered` / `approved` / `rejected` /
    `timeout` / `no-ui`: was a human involved, and what did they say.

  A single enum would have left the *cause* of a denial legible only as prose in
  `reason`, so "refused outright by policy" and "the operator rejected it" could
  not be counted separately without parsing English. The two no-prompt values
  are distinct on purpose: `not-required` is a read-only call with nothing to
  approve, `not-offered` is the sensitive-file refusal, which has no approval
  path by design. `reason` is now carried only on blocked calls.

  Renamed in the same change, per the note that closed this item: `decision-log.ts`
  → `call-log.ts`, `DecisionLog`/`makeDecision`/`formatDecision`/`DecisionRecord`
  → `CallLog`/`makeRecord`/`formatRecord`/`CallRecord`, `PERMISSION_GATE_LOG` →
  `PERMISSION_GATE_CALL_LOG`, and `audit.jsonl` → `calls.jsonl`. The old
  `pi-logs` volume was removed to re-seed it — it was empty and root-owned, so
  nothing had ever been written to it anyway, which is the silent-failure mode
  the Dockerfile and both READMEs warn about, observed in the wild.

  > **Since closed.** The "still open" note here said this records what was
  > *attempted*, not what resulted. That gap is now shut: `tool_result` is
  > handled, and each call writes a second `phase:"result"` line joined by `id`.
  > See the hooks item under *Documentation fixes*. The `after:` interceptor
  > alternative discussed below was **not** taken — it would have added an exec
  > path to the `docker.sock`-holding gateway, which is the most privileged
  > component in the stack.

  This also produces the input the `--tools` allowlist item above is waiting
  for. The working set, measured rather than guessed — note the phase filter,
  without which every tool is counted twice:

  ```sh
  jq -r 'select(.phase=="call") | .tool' calls.jsonl | sort | uniq -c
  ```

  The runbook (`src/infrastructure/README.md`) carries that command.

  <details>
  <summary>Original analysis, kept for the parts still open</summary>

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

  </details>

- [x] **Decide retention for `permission-gate/calls.jsonl`.**
  **Decided: the log grows without bound. Nothing in the stack ever deletes a
  line. Pruning and archival are the operator's, from the host.** Recorded as a
  policy in three places — the runbook's new *Retention* section
  (`src/infrastructure/README.md`), the extension's README, and the `pi-logs`
  comment in `compose.yaml` — plus the header of `call-log.ts`, which is where
  a future cap would be tempting to add.

  The item asked for a stated decision rather than a default inherited from
  whatever tool was convenient, and the deciding input was a measurement that
  had not been taken. **A call costs ~316 bytes** across its two lines (a `call`
  line with a realistic deep path, 215 B, plus its `result` line, 101 B):

  | Tool calls | Log size |
  |---|---|
  | 1,000 | 0.3 MB |
  | 10,000 | 3.2 MB |
  | 100,000 | 32 MB |
  | 1,000,000 | 316 MB |

  That reframes the item that raised it. The growth *rate* doubled with
  `tool_result`, which is what prompted the concern, but the absolute number is
  small: a million tool calls is years of heavy single-operator use. Size-capped
  rotation would answer "how much disk" by discarding the oldest evidence, which
  is the wrong axis for a record whose entire purpose is answering questions
  about the past — and `docs/requirements.md` asks for auditability without
  naming a horizon, so there is no period to expire against either.

  **A second argument turned out to matter more than the disk one**, and it is
  the one that constrains future changes. The agent's rootfs is read-only, so
  rotation state would have to sit on the `pi-logs` volume itself, and an
  in-process cap in `permission-gate` would put truncation logic *inside the
  audited process*. `compose.yaml` already leans on the volume outliving the
  container so a compromised session cannot erase its own history; a rotation
  step running as the agent's uid would spend that property. Append-only is
  worth keeping as an invariant, not just as a current fact.

  Ship-then-truncate was rejected as the most machinery for the least present
  pressure — it needs a nominated durable destination before it means anything.
  The runbook instead documents the manual version (size check, and piping the
  log out to a dated `.gz` over the existing `exec` route, so there is no second
  image to pin), and is explicit that truncating afterwards is the operator's
  choice and not part of the supported flow.

  The `pi-logs` volume **stays a named Docker volume**; switching it to a host
  bind mount would have made operator pruning more ergonomic but was declined,
  keeping the audit trail out of casual reach and consistent with `pi-sessions`.

  Stated revisit triggers, so "unbounded" cannot quietly become permanent
  through inattention: the log passing **1 GB** or growth departing from the
  table above; the stack ceasing to be single-operator or the volume ceasing to
  be local; or a compliance obligation naming an actual retention period — in
  which case the replacement is that period and an expiry mechanism, not a size
  cap.

  Note what this does *not* resolve: a failure to write is still swallowed by
  design, so the failure mode remains a large file rather than a broken agent.

- [x] **Enforce network egress control, or drop the claim.**
  Enforced. `agent-net` is now `internal: true`, so Docker installs no default
  route and no masquerade rule: external addresses are `ENETUNREACH` and DNS
  does not resolve. The hardening table's claim is a control rather than an
  absence of capability for the first time.

  **The parenthetical warning in the original item was right, and the reason
  this needed measuring rather than just doing.** `internal: true` on its own
  breaks the model route. `host-gateway` resolves to the **docker0** address
  (172.17.0.1), which is a *different subnet* from `agent-net`; on a routed
  bridge the default route carries it, and on an internal network there is no
  default route, so every model call fails `ENETUNREACH`. Enabling the flag
  without noticing this would have produced an agent that looked hardened and
  could not reach a model.

  The host is still reachable, but only at **this network's own gateway**, which
  is a host interface. So the fix is two settings that must move together:

  - `agent-net` pins `subnet: 172.31.60.0/24` / `gateway: 172.31.60.1`, to make
    that address stable rather than assigned.
  - the pi service's `extra_hosts` maps `host-gateway` to `172.31.60.1`
    literally, instead of using Docker's alias.

  They are one setting written in two places and compose cannot derive one from
  the other, so both carry comments saying so.

  Verified on the real stack, not a synthetic one: gateway `CONNECTED`, proxy
  `CONNECTED`, `1.1.1.1:443` and `8.8.8.8:53` `ENETUNREACH`, DNS `EAI_AGAIN` —
  while `tools/list` still returned 11 tools, `list_directory(/workspace)`
  worked, and `read_file(/etc/passwd)` was still refused. The runbook carries
  that check as **the egress check**, including how to read the failure codes:
  `ENETUNREACH` on the proxy row means the two settings above have drifted,
  `ECONNREFUSED` there means the route is right and nothing is listening.

  **Operator-visible consequence, documented in the runbook.** The proxy must
  bind to `172.31.60.1` rather than docker0's `172.17.0.1`. This is a change of
  *which* non-loopback address it must answer on, not a new requirement — a
  proxy on `127.0.0.1` never worked.

  **`LITELLM_HOST` must change, and that exposed a startup-ordering bug.**
  `LITELLM_HOST` is the address passed to `litellm --host`, so it becomes
  `172.31.60.1`. But `run/startup` called `start_proxy` *before*
  `bring_up_boundary`, and that address does not exist on the host until compose
  creates the network — verified: binding it with the stack down fails
  `[Errno 99] Cannot assign requested address`, and succeeds once `up -d` has
  created `br-…`. So the naive `.env` edit would have produced a stack that
  fails at startup instead of one that silently cannot reach a model. Both were
  fixed:

  - `run/startup` now runs `bring_up_boundary` **before** `start_proxy`. Safe
    because nothing between them needs a model: the pi container's PID 1 is
    `sleep infinity`, so no agent exists until `enter_container`, which is last.
  - `cleanup` was reversed to match — stop the proxy, *then* tear down the
    network, rather than pulling the interface out from under a live process.
  - The runbook's manual sequence had the same order and was renumbered: the
    proxy is now step 5, after "Bring up the boundary".

  Three files now carry the same address — `compose.yaml`'s pinned `gateway:`,
  its `extra_hosts` entry, and `.env`'s `LITELLM_HOST`. All three say so.

  **Manual edit: DONE.** `src/infrastructure/.env.example` and `.env` needed
  `LITELLM_HOST=172.17.0.1` → `172.31.60.1`, and both sit in a
  permission-denied directory, so the change was made by the operator rather
  than here — and is recorded on that report, not on a check performed in this
  repository. Re-verify with the runbook's egress check if the model route ever
  fails at bring-up. An older `.env` left at the docker0 address fails at proxy
  startup, which is at least loud rather than silent.

  **What this does not cover.** The gateway is on the same network and therefore
  also has no egress — which is what rules out `--verify-signatures`, recorded
  under that item. Image pulls are unaffected: the gateway asks the *host
  daemon* over the Docker socket, and the daemon has its own network.

  Original reasoning, still accurate: this used to compound the bash allowlist
  item, since an interpreter that could read a fenced file could also post it
  somewhere. Removing agent execution closed the second half of that pairing;
  this closes the first. What remains reachable is the extension surface itself
  (`mcp-client`'s HTTP connection to the gateway) and Pi's own runtime, both of
  which are now confined to `agent-net`.

## Documentation fixes — the design overstates the build

- [x] **Three of the four documented hooks are not used anywhere.**
  Resolved by doing both things the item offered: **implementing** the one hook
  that was load-bearing, and **deleting the catalogue** that made claims about
  the rest.

  **`tool_result` implemented — this was never only a documentation problem.**
  It is the hook the audit trail needed to record what a call *did* rather than
  what was attempted. `permission-gate` now handles it. Verified against the
  pinned API before designing anything: `ToolResultEvent` carries `toolCallId`
  (so it joins to `tool_call`), `isError` (the missing outcome axis), and
  `content` (the tool's entire output — never logged; there is a test asserting
  the result line has exactly five keys, so a future edit that spreads the event
  into the record fails in the suite).

  A call now writes **two lines** joined by `id`:

  ```json
  {"ts":"…","phase":"call","id":"tc_09","tool":"mcp_read_file","outcome":"allowed","confirmation":"not-required","detail":"mcp_read_file: /workspace/../etc/passwd"}
  {"ts":"…","phase":"result","id":"tc_09","tool":"mcp_read_file","result":"error"}
  ```

  That pairing — admitted by the gate, refused by the MCP server — is precisely
  what the trail could not express before, and it is now a row in the runbook's
  verification table.

  **Two lines rather than one enriched line**, chosen deliberately. Buffering
  the attempt until the result arrived would give one tidy line per call, but
  the record would exist only in memory for the duration of the call, so a
  crash between the two would erase the evidence that the call was ever made.
  Appending on observation keeps the trail never less complete than reality.
  The cost is volume — roughly double — which sharpens the retention item above
  rather than creating a new problem.

  **The hooks section in `docs/solution.md` was deleted, not corrected.** It
  catalogued four hooks and described what each was "the place to implement",
  which reads as a description of the build and was not one. It is replaced by
  a list of the three hooks actually handled (`tool_call`, `tool_result`,
  `session_start` — the last was previously undocumented) and an explicit
  statement of what is *not* handled. The tool-overriding paragraph was
  rewritten in the same pass: this design does not use tool overriding, and the
  extension that did was removed.

  **The `README.md` overclaim is reworded, not implemented.**
  `before_provider_request` hands over `payload: unknown` — the entire
  conversation, including every file the agent has read. Logging it would copy
  the whole context into the audit trail, which is the failure "paths, not
  payloads" exists to prevent. Both places now say plainly that model requests
  are not logged here and that the host proxy is where that would live. A
  scoped, metadata-only version is a separate item below.

  > **Since implemented.** That separate item is now closed, so both wordings
  > have changed again: `README.md` and `docs/solution.md` say that model
  > requests are recorded as *shape* — model, message count, size — and that the
  > payload never is. The hazard described here was real and is why the
  > extraction lives in its own pure module with a closed-key-set test.

  Three follow-ups fell out of this and are recorded below rather than silently
  dropped: metadata-only model-request logging, tool-output redaction, and turn
  markers.

  > **Since extended, twice.** `before_agent_start` and
  > `before_provider_request` are both handled now (see the two items below), so
  > `docs/solution.md` lists **five** hooks across the two extensions. The
  > paragraph stating what is *not* handled stays, with `after_provider_response`
  > and `context` as the live examples.

  > ### The first live run falsified this, and the fix was in `mcp-client`
  >
  > Everything above shipped green — typecheck, 123 tests, the extension loading
  > inside the image, handlers verified against a stubbed `ExtensionAPI`. Driven
  > for real against Ollama and the MCP gateway, **the outcome axis did not
  > work**: a read of a missing file logged `"result":"ok"` while the agent
  > correctly reported `ENOENT`.
  >
  > The chain checked out at every point except one. The MCP filesystem server
  > returns `isError: true` (verified over the wire, for both a missing file and
  > a traversal). `mcp-client` mapped it faithfully with
  > `isError: isErrorResult(result)`. But **Pi derives the `tool_result` event's
  > `isError` solely from whether `execute` threw** — `agent-loop.js` returns
  > `{ result, isError: false }` on a normal return and sets `true` only in its
  > catch. A *returned* flag is discarded there, so the event said `false` and
  > the gate dutifully recorded success.
  >
  > Fixed in `mcp-client/index.ts`: an MCP error result now **throws** with the
  > flattened error text. Re-verified on a rebuilt image — the same read now
  > logs `"outcome":"allowed"` then `"result":"error"`, which is the pairing
  > this whole item exists to produce. The model still sees the message, because
  > Pi's catch wraps it with `createErrorToolResult`.
  >
  > Two things worth carrying forward:
  >
  > - **The failure mode was silent and in the audit trail.** Not a crash, not a
  >   wrong answer to the user — a log that quietly asserted reads which had been
  >   refused. That is the specific thing this trail exists to prevent, so it
  >   would have been believed.
  > - **No amount of unit testing would have caught it.** The bug was in an
  >   assumption about a harness contract, and both sides of that contract were
  >   stubbed in the tests. The regression guard now lives in
  >   `tool-mapping.test.ts` and in `mcp-client/README.md`, but what actually
  >   found it was running the thing.

- [x] **Log model requests as metadata only, or leave them to the proxy.**
  **Decided: metadata-only, here, in `permission-gate`. The proxy option is
  declined rather than deferred**, and the reasons are below — they are about the
  proxy's actual state today, not about the principle, which stands.

  `before_provider_request` is handled. One line per model call, shape only:

  ```json
  {"ts":"…","kind":"provider_request","model":"computer-programmer","messages":34,"approx_bytes":18422}
  ```

  **Why not the proxy, measured rather than assumed.** The instinct recorded
  below — that the host proxy is the stronger place because it is outside the
  agent's process — is correct in principle and was checked against what is
  actually deployed. Three findings, and together they close the option:

  1. **The proxy has no durable log at all.** `run/startup` starts it with its
     stdout going to `$(mktemp -t litellm-proxy.XXXXXX.log)` — a temp file that
     is abandoned when the run ends. What exists today is operational output, not
     a record, so "the proxy does it" could not be closed by documenting and
     verifying an existing behaviour. It would mean building one.
  2. **Building one means a Python callback and a trail outside this stack.**
     LiteLLM 1.93.0 offers `--log_config` (a Python logging dictConfig) and
     `json_logs`, both of which shape *operational* logs; a per-request metadata
     record needs a custom callback module, and per-request persistence
     otherwise wants the database this deployment does not run. That is Python in
     a TypeScript repository, pinned against a callback API that moves between
     versions, writing to a host path outside the `pi-logs` volume — so outside
     the retention policy just settled and outside every check in the runbook.
  3. **The proxy cannot attribute a request to a turn or a session.** It sees
     HTTP bodies. Turn boundaries and session ids exist only inside Pi, so a
     proxy-side record could not answer "what did the agent send in response to
     *that* instruction" — which is the question the turn markers were added to
     make answerable. The in-process record lands in the same file, already
     grouped by those boundaries. This is the argument the original item could
     not have made, because turn markers did not exist when it was written.

  So the trade is: **independence, or attribution and one trail.** Attribution
  wins here, and unlike the `--verify-signatures` decision the loss is smaller
  than it looks — this log has never been independent of the agent's process.
  `permission-gate` writes all of it, which is stated plainly in three places
  rather than being quietly true. The proxy remains the right home for an
  independent record if one is ever needed; the revisit trigger is a compliance
  requirement for a trail the agent's process cannot influence, at which point
  the answer is a proxy-side record *in addition to* this one, not instead of it.

  **The hazard the item named turned out to be the real work.** Extraction lives
  in a new pure module, `provider-request.ts`, which reads named scalars and
  never spreads; `model` is taken from the outbound body rather than from Pi's
  own state, so the line says what was *sent*; and each field is omitted when
  absent, because a `0` would be a claim about the request. Three tests guard
  it: the key set is closed, no message content survives extraction, and a
  payload it cannot read yields an empty shape rather than an error.

  **One contract detail that would have been a silent, serious bug.**
  `runner.js` does `if (handlerResult !== undefined) currentPayload =
  handlerResult` — so any non-undefined return from this hook **replaces the
  payload sent to the provider**. A logging handler that returned, say, `true`
  would rewrite every model request in the session. The handler returns
  `undefined` explicitly, there is a test asserting it, and the reason is
  recorded in `index.ts` and the extension README, because nothing in the type
  signature (`BeforeProviderRequestEventResult = unknown`) would stop the next
  edit.

  **Deliberately not done: the response side.** `after_provider_response` carries
  status and headers, and was considered for the same call/result honesty
  argument that justified `tool_result`. It does not apply: a request line claims
  only that a request was sent, which is true — unlike a bare `tool_call` line,
  which asserted reads the MCP server went on to refuse. There is also no id in
  either event to join a reply to its request. Left unhandled, and stated as a
  limit in the runbook rather than left to be inferred.

  **Driven for real.** Two instructions against a local model with one file read
  produced this, trimmed to the `kind` lines:

  ```json
  {"kind":"turn_start","turn":1,"session":"019fb13a-…"}
  {"kind":"provider_request","model":"qwen2.5:14b","messages":2,"approx_bytes":4507}
  {"kind":"provider_request","model":"qwen2.5:14b","messages":4,"approx_bytes":5798}
  {"kind":"provider_request","model":"qwen2.5:14b","messages":6,"approx_bytes":7370}
  {"kind":"provider_request","model":"qwen2.5:14b","messages":8,"approx_bytes":8839}
  {"kind":"provider_request","model":"qwen2.5:14b","messages":10,"approx_bytes":10319}
  {"kind":"turn_start","turn":2,"session":"019fb13a-…"}
  {"kind":"provider_request","model":"qwen2.5:14b","messages":12,"approx_bytes":11127}
  ```

  Three things that run established. The payload really is the OpenAI-completions
  body on this route, so `model` and `messages` populate. **`approx_bytes`
  climbing is the useful signal** — 4.5 KB to 11 KB across one turn is file
  content accumulating in the context and being re-sent on every subsequent call,
  which is visible here without the context being recorded. And the shape of the
  trail is legible in a way it was not before: five model requests inside turn 1
  against four tool calls, all four reading the *same* file — a small model
  looping, which the trail now shows rather than implies. Two new `jq` recipes in
  the runbook were checked against that file, along with both existing ones, which
  are unaffected because these lines carry no `.phase`.

  A provider-request line is **126 bytes**, roughly one per model call, so the
  retention table is unchanged for the same reason turn lines left it unchanged.

  <details>
  <summary>Original reasoning, which the decision above follows</summary>

  Raised by the item above, which reworded the claim rather than implementing
  the hook. The gap is real: nothing in this repository records what was sent to
  a model.

  The reason it was not just implemented is the payload shape.
  `BeforeProviderRequestEvent` is `{ type, payload: unknown }`, and that payload
  is the **whole conversation** — system prompt, every message, and the contents
  of every file the agent has read this session. Logging it wholesale would put
  a complete copy of everything the agent has touched into the audit trail,
  which is worse than the gap it closes and directly contradicts the
  "paths, never content" rule the rest of the trail is built on.

  So the only version worth building is metadata-only:

  ```json
  {"ts":"…","kind":"provider_request","model":"litellm/computer-programmer","messages":34,"approx_bytes":18422}
  ```

  Shape, never content. If it is built, the hazard to guard is that
  `payload: unknown` makes it *easy* to serialise the lot by accident — the
  handler should extract named scalars, never spread, and should carry a test
  like the `result`-line one that asserts the record's key set is closed.

  Worth deciding first whether this belongs here at all. The host LiteLLM proxy
  sees the same traffic, already holds the credentials, and is outside the
  agent's process — which makes it the stronger place to log from, for the same
  reason the MCP gateway is a stronger boundary than an in-process guard. If the
  answer is "the proxy does it", then this item closes by documenting and
  verifying that, not by writing an extension.

  </details>

- [x] **Redact secret-shaped content from tool output.**
  **Done.** Six rules in a new pure module (`redaction.ts`), applied in the
  `tool_result` handler, replacing each match with `[redacted: <rule>]` before
  the output reaches the model. All three constraints the item set were treated
  as binding, and each shaped the result:

  - **False positives.** No entropy heuristic, and this is the design decision
    rather than a scoping compromise. Every rule anchors on a distinctive
    literal: a PEM delimiter, or an issuer's key prefix. The reasoning that
    settled it is that redaction is *silent* — it changes what the model reads
    without telling the operator at the time — so a false positive is not
    cosmetic, it is corrupted input surfacing as a confusing failure elsewhere.
    Twelve tests assert the specific shapes an entropy test would fire on
    (commit shas, UUIDs, `sha512-` integrity digests, bcrypt hashes, minified
    code, base64 fixtures, PUBLIC KEY and CERTIFICATE blocks) survive untouched.
    Only the matched span is replaced, so even a false positive costs one value
    rather than a whole file.
  - **Not a content log.** The `result` line gains exactly two fields, and only
    when something fired: `redactions` (a count) and `rules` (which rules
    matched, from a fixed code-defined vocabulary). Not the value, not its
    length, not its position. The closed-key-set test on that line was **widened
    deliberately** from five keys to seven rather than deleted — the invariant it
    protects is "no content", not "no new fields".
  - **Low-ambiguity shapes first.** The four the item named, plus Slack tokens
    and `sk-ant-`/`sk-proj-` keys, the last because `.env` here is documented as
    holding `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`. `openai-api-key` is the weakest
    anchor of the set (`sk-` is three characters) and so demands 32 more; that is
    stated in the README rather than glossed.

  **The mechanism was verified before anything was designed**, because a
  `tool_result` handler whose returned content Pi ignored would have made this a
  silent no-op — the exact shape of the `isError` bug recorded above. The chain
  holds: `runner.js` collects the returned `content`, `agent-session.js` passes it
  through, and `agent-loop.js:494` does `content: afterResult.content ??
  result.content` before `createToolResultMessage` builds the message. So the
  replacement reaches the model **and the session transcript** — a redacted
  secret is absent from the history that would be re-sent on resume. That was
  confirmed by grepping the transcript, not inferred.

  **Two deliberate choices worth carrying forward:**

  - **A patch is returned only when something was redacted.** Returning content
    unconditionally would rewrite every tool result in the session, in the
    transcript as well, to no purpose.
  - **It fails open.** A throw in the redactor leaves the original output intact
    and records the result without redaction fields, so a bug here cannot break
    tool execution. The cost is honest and stated: such a bug is a quiet loss of
    this control rather than a loud one. There is also no environment variable to
    disable redaction — a control switchable from the environment is a weaker
    control, and the `rules` field names the culprit if one ever misfires.

  **Driven for real, against the adversarial case.** A scratchpad file was given
  a fake GitHub token and a fake AWS key id, and the model was asked to read it
  and repeat every credential **verbatim**:

  > The file contains redacted credentials which are marked as sensitive
  > information. […] A GitHub token used for authentication by CI runner
  > (redacted: github-token) […] These values have been intentionally hidden.

  It could not produce either value. The log recorded
  `"result":"ok","redactions":2,"rules":["aws-access-key-id","github-token"]`,
  neither secret appears anywhere in the log, and a grep of the session
  transcript found only the two `[redacted: …]` markers. The model also explained
  the redaction to the user unprompted, which is the argument for naming the rule
  in the replacement rather than truncating silently.

  **The ceiling is unchanged and must not be overstated**, which is why it is
  restated in three places: this narrows what reaches the model, but the agent
  can still be induced to read a file and act on what it says without any
  recognised shape appearing. Non-text content parts are untouched, so a key in a
  screenshot is not covered. A database password or a prefix-less internal token
  is not matched, and could not be without accepting false positives. It is
  defence in depth, not a boundary — and nothing here makes it safe to keep
  secrets in a project the agent can read.

  <details>
  <summary>Original analysis, which the work above follows</summary>

  Deferred from the hooks work above; `tool_result` is the hook for it and is
  now handled, so the wiring exists and only the policy is missing.

  The gap: `sensitive-files.ts` refuses calls that *name* a secret file — `.env`,
  `id_rsa`, `*.pem`. It matches on filename, so a key pasted into
  `notes.txt`, a token in a config sample, or a credential in a log excerpt
  passes through untouched and enters the model context. For an
  away-from-keyboard agent in a regulated setting that is a real exfiltration
  path the filename rule cannot see.

  What makes this non-trivial, and why it is an item rather than a patch:

  - **False positives are expensive.** High-entropy strings are also hashes,
    UUIDs, minified code, and base64 test fixtures. Redacting those silently
    corrupts what the model reads and produces confusing failures downstream.
  - **It must not become a content log.** Whatever detects a secret must not
    record it while reporting it. The record should say *that* redaction
    happened and in which call, never what was redacted.
  - **Scope it to shapes with low ambiguity first** — PEM blocks, `AKIA…` AWS
    keys, `ghp_`/`github_pat_` tokens, `-----BEGIN … PRIVATE KEY-----` — rather
    than a general entropy heuristic.

  Note the honest ceiling before building it: this narrows what reaches the
  model, but the agent could still be induced to read a file and act on it
  without the content appearing in output the redactor sees. It is
  defence-in-depth, not a boundary.

  </details>

- [x] **Add turn markers to the call log.**
  **Done.** `permission-gate` handles `before_agent_start` and appends one line
  per agent run, so every `call` line belongs to the turn whose boundary most
  recently preceded it:

  ```json
  {"ts":"…","kind":"turn_start","turn":7,"session":"01936f2e-6b2a-7c31-9e4d-8f1a2b3c4d5e"}
  {"ts":"…","phase":"call","id":"tc_21","tool":"mcp_read_file", …}
  {"ts":"…","phase":"result","id":"tc_21", …}
  ```

  It was small and low-risk as predicted — it records a boundary, not content —
  but three details were decided rather than assumed, and each is the kind of
  thing that reads as a detail and is not:

  - **`session` was added to the sketch, and it is what makes the marker work.**
    A bare ordinal is nearly useless in a file that is appended to forever: the
    counter is per-process and restarts at 1 on every Pi start, so "turn 1" of
    today is indistinguishable from "turn 1" of last week — which is the
    timestamp-correlation problem this item exists to remove, reintroduced one
    level down. `ctx.sessionManager.getSessionId()` (a UUIDv7) is the grouping
    key; `turn` is the ordinal for referring to one within it. The id is read
    defensively and omitted rather than faked if the context will not give one
    up: a marker is worth less than a working agent.

  - **`before_agent_start`, not Pi's `turn_start` event.** Pi has an event
    literally named `turn_start`, and it is the wrong one: `agent-session.js`
    resets `turnIndex` to 0 on every `agent_start`, so it counts model requests
    *within* one run and cannot group anything. `before_agent_start` fires once
    per submitted prompt, which is the boundary the item's own question
    ("in response to *that* instruction") is about. The line keeps the name
    `turn_start` because four documents already promise "turn markers" and Pi's
    own `BeforeAgentStartEventResult` calls this boundary a turn — the clash is
    resolved by stating it in `call-log.ts` rather than by a private
    vocabulary.

  - **One boundary per agent run is not quite one per message.** A steer or
    follow-up queued while the agent is already streaming is consumed by the run
    in flight and fires no `before_agent_start`, so its calls are attributed to
    the turn in progress. Verified in `agent-session.js` (`prompt()` returns
    early to `_queueSteer`/`_queueFollowUp` when `isStreaming`), and documented
    in the extension README rather than left as a surprise for whoever first
    counts markers against instructions.

  Both carried-over constraints held. The handler appends and does nothing else
  — no buffering until the turn ends — and the key set is closed by a test
  mirroring the `result` line's, asserting exactly `ts`, `kind`, `turn`,
  `session`. That test matters more here than on the result line:
  `before_agent_start` hands the handler `prompt`, `images`, **and** the fully
  assembled `systemPrompt`, so this is the one hook where logging the event
  naively would write the entire conversation into the audit trail. There is a
  wiring test asserting neither the prompt nor the system prompt reaches the
  file.

  The compatibility point checked out and is now also a test: a turn line has no
  `.phase`, so all four `jq` recipes in the runbook return exactly what they did
  before. Measured while there: a turn line is **112 bytes**, against ~316 B per
  call, and it is emitted per instruction rather than per call — so the retention
  table stands unchanged, as predicted.

  One rename fell out of it: the record union in `call-log.ts` is now
  `LogRecord` rather than `CallRecord`, since one of its members is not a call.

  **Driven for real, not just tested.** The last hooks change shipped green and
  was falsified by the first live run, so this one was run against the real
  harness before being called done: Pi 0.82.0 in `--print` mode against a local
  Ollama model, with only this extension loaded and two prompts in one process.
  The log came out as the item asked for:

  ```json
  {"ts":"…","kind":"turn_start","turn":1,"session":"019fb130-40c8-7dd7-b6e5-ef7bf1557f26"}
  {"ts":"…","phase":"call","id":"call_qz82hv3s","tool":"read","outcome":"allowed","confirmation":"not-required","detail":"read: /…/sample.jsonl"}
  {"ts":"…","phase":"result","id":"call_qz82hv3s","tool":"read","result":"error"}
  {"ts":"…","kind":"turn_start","turn":2,"session":"019fb130-40c8-7dd7-b6e5-ef7bf1557f26"}
  ```

  Four things that only a live run could establish: the hook fires in `--print`
  mode (`print-mode.js` calls the same `session.prompt()` the TUI does, so the
  runbook's non-interactive verification sessions do produce markers); the
  ordinal increments across prompts within one process; `session` populates with
  a real UUIDv7 rather than being silently omitted; and both `jq` recipes — the
  new turn-attribution one and the existing tool-frequency count — return the
  right answers against that file, the second still counting one call rather
  than two or three.

  Not done, deliberately: the marker records *that* a turn began, never what it
  was about. Reading the instruction still means going to the session
  transcript. The trail answers what the agent did in response, which is the
  question it is for.

- [x] **Document the `docker.sock` grant in `docs/solution.md`.**
  `compose.yaml` binds the host Docker socket into `mcp-gateway`.
  `src/infrastructure/README.md`'s "The docker.sock trade-off (read this)"
  section documented and justified this honestly and at length, but
  `docs/solution.md` never mentioned it: the trust-boundary diagram labelled the
  pi-container "no agent file tools, no docker.sock, no keys" and the hardening
  table said "no `docker.sock`" — both true of the *agent*, but together they
  read as though no component holds one.

  **Done.** The gap turned out to be structural, not just a missing label: both
  diagrams drew `pi-container → mcp-server-container` **directly**, when the
  gateway sits between them and *spawns* that server through the socket. So the
  diagrams were not merely quiet about the privilege — they depicted a topology
  in which it has no reason to exist. Fixed in four places:

  - **New section**, "The gateway, and the `docker.sock` trade-off", under
    *Containerized MCP server*: the gateway spawns the filesystem server, which
    is why it needs the socket; the privilege is **confined, not absent**; and
    the requirement in `docs/requirements.md` is met at the boundary that matters
    (the agent), not by the stack holding no privilege anywhere. Carries both
    escape hatches (socket-proxy, stdio) with a pointer to the runbook.
  - **Trust-boundary diagram**: `mcp-gateway` and the host Docker daemon added,
    with the spawn edge and the socket grant drawn explicitly. The gateway is
    styled `danger` — it is the one component holding host privilege, and the
    diagram should say so. The transport label was also wrong (`HTTP/SSE or
    stdio`); the deployed stack is HTTP streaming on :8811.
  - **Mount view**: `mcp-gateway` added with its three mounts, the socket among
    them, and `mcp-server-container` re-labelled "spawned BY THE GATEWAY, not by
    compose". The agent's `/var/log/pi` audit volume was missing too, and is now
    shown.
  - **Hardening table**: the "Container hardening" row is now explicitly scoped
    to the agent, and a new **"Host Docker control"** row states the grant, its
    justification, and its confinement.

  `README.md` gained a one-clause qualifier for the same reason — its claim
  ("no Docker control") was already scoped to the agent and therefore accurate,
  but invited exactly the inference this item exists to prevent.

  **Not restated as fact:** the draft of the new section originally said the
  agent's "entire outbound surface is MCP tool calls and inference requests".
  That was the very claim the then-open network-egress item flagged as
  unenforced, so it was rewritten to say only what is true — the agent has no
  local execution tool and its `mcp_*` tools resolve in another container.
  Documenting one gap is not a licence to reassert another.

  > **Since resolved.** The egress item is now closed: `agent-net` is
  > `internal: true`, so that original sentence would in fact be accurate today.
  > It has deliberately **not** been restored — the wording that replaced it is
  > still true and is grounded in the tool surface rather than the network, so
  > it stays correct independently of the network config. The point of this note
  > is the sequencing, not the sentence.

- [x] **Reconcile multi-project diagrams with the single-project reality.**
  The diagrams and the mount view showed `proj-a`/`proj-b` volumes and
  "per-project perms"; compose supports exactly one project. Resolved by
  committing to single-project as the ARCHITECTURE rather than by redrawing the
  diagrams to match an accident of the build.

  Single-project is now a stated requirement (`docs/requirements.md`) with its
  reasoning: multi-project would mean the agent could name a second project's
  path, which turns "outside the project scope" from one directory boundary into
  a per-project permission model the MCP filesystem server does not implement.
  The sequence diagram, the trust-boundary diagram, and the mount view now show
  one volume, and the hardening table gained a "Project scoping" row. Two
  projects means two stacks with different `PROJECT_PATH` values.

  The mount was renamed `/projects/active` → `/workspace` in the same pass. The
  old path was the residue of the multi-project design: a `/projects/` parent
  holding exactly one child called `active` — a slot with nothing to distinguish
  it from — whose empty, root-owned parent directory was a live source of
  confusion when traversing the container. Renamed across `compose.yaml` (both
  services), `catalog.yaml` (both the `command` boundary arg and the `volumes`
  entry), the `Dockerfile`, `start-pi.sh`, `bashrc`, both READMEs, and the tests.

## Hygiene

- [x] **Pin the Pi package, per the project's own rule.**
  The hardening table requires third-party packages pinned to exact versions or
  commit hashes. All three container images were digest-pinned, but the
  Dockerfile had a bare `npm install -g @earendil-works/pi-coding-agent`,
  floating to latest at build time.

  **The float had already bitten.** The image was installing **0.82.0** while
  `package.json` declared `^0.75.5` — so the extensions were being type-checked
  against one `ExtensionAPI` and executed against another, seven minor versions
  apart. That is the actual cost of the floating install, and it was invisible
  because both halves independently "worked".

  Pinned to **0.82.0** in both places, chosen because it is the version the
  verified stack actually runs. The devDependency is now an exact `0.82.0`
  rather than a caret range, so the two cannot drift again without someone
  editing both.

  The install is also **hash-verified**, matching how the base image and gateway
  are digest-pinned: `npm pack` fetches the tarball, `sha512sum -c` checks it
  against `PI_SHA512`, and only then does `npm install -g` run. `PI_SHA512` is
  the hex form of the registry's `dist.integrity` — the same digest
  `package-lock.json` records in base64, so the two can be checked against each
  other. Both values sit in `ARG`s with a re-pinning recipe in the comment.

  Verified two ways: the build passes (`…tgz: OK`), and a build forced with a
  wrong `PI_SHA512` **fails** before `npm install` runs — so it is a control,
  not decoration. Typecheck, lint, and 114 tests pass against 0.82.0, and the
  gate was re-driven on the rebuilt image with all seven cases correct.

  **Left open deliberately:** `npm audit` reports two high-severity DoS
  advisories (`brace-expansion`, `js-yaml`). Most are in the eslint toolchain,
  but `brace-expansion` also sits inside Pi's own dependencies and therefore
  ships in the image. `npm audit fix` was NOT run: it works against the pin just
  established, and a DoS-class issue in a single-operator local tool is a
  different risk calculus from the confidentiality controls this project is
  built around. Worth a decision of its own.

- [x] **Fix stale cross-references.**
  `compose.yaml`, the Dockerfile, and `src/infrastructure/README.md` all cited
  `docs/local-agent-architecture.md` and `docs/local-agent-implementation-plan.md`,
  neither of which exists. All now point at `docs/solution.md` (the design) and
  `src/infrastructure/README.md` (the runbook). `src/infra/` → `src/infrastructure/`
  in two Dockerfile comments, and the "step 3/4" citations of the absent plan are
  gone. `AGENTS.md` had the same dead link and was not in the original list.

  A systematic check of every relative Markdown link — rather than re-reading the
  audit — found three more the audit had missed:

  - `README.md` linked the three extension READMEs as `../src/extensions/…` from
    the repository root, so all four links resolved outside the repo.
  - `CONTRIBUTING.md` cited `docs/installation.md` twice; the file does not exist
    and never has. Installation lives in the README's Usage section.
  - `CONTRIBUTING.md`'s "Project layout" showed extensions at `src/<name>/` when
    the tree is `src/extensions/<name>/`, and pointed at the non-existent doc for
    how to register a new extension. Replaced with the real procedure, verified
    against the installer: the `available_extensions` array in `run/install`, the
    `case` branch in `run/inc/fn/extensions.sh`, and the `COPY` line in the
    Dockerfile for shipping it inside the container.

  Worth keeping: that link check is three lines of shell and found more than the
  manual audit did.

  **Reopened once, then finished.** The first pass matched *filenames*, so five
  PROSE references to "the architecture doc" survived it — a dead pointer is
  still dead when it is spelled out in words. Found by re-sweeping on the phrase
  rather than the path:

  - `compose.yaml` ×2 — the `docker.sock` rationale and the socket-proxy note.
    Both now point at the new trade-off section in `docs/solution.md` and at
    `docs/alternatives.md` respectively.
  - `src/infrastructure/README.md` ×3 — the boundary-diagram pointer, the
    "Option C" reference, and a traversal/prefix-collision reference.

  Two of those were more than broken links:

  - **"Option C" does not exist anywhere.** `docs/alternatives.md` lists three
    alternatives as unlettered bullets; the `docker.sock` one is the third.
    Both citations now name it that way, and say what the connection actually is
    — the concern that got it rejected is the concern this design confines
    rather than eliminates.
  - **"See the architecture doc on traversal and prefix-collision defence"
    promised documentation that has never existed** in any doc, for a topic
    nothing here covers. Rewritten to say the truth: the allowed directory is
    the catalog `command` argument, how the upstream `mcp/filesystem` server
    defends that boundary internally is its implementation and is not documented
    in this repository, and the runbook's traversal check is the functional
    proof — to be re-run when the pinned image or catalog schema changes.

  The runbook's own trust-boundary summary also had the structural gap fixed in
  `docs/solution.md`: it listed `agent-net` as holding the pi-container and "the
  MCP server", when it holds the pi-container and the **gateway**, whose child
  the MCP server is. Corrected, with the note that compose starts two containers
  and not three — which is precisely why the socket grant exists.

  One rename leftover, same class: `run/inc/fn/extensions.sh` described
  `permission-gate` as "logging every decision". It logs every call now.

- [x] **Copy-edit `docs/solution.md`.**
  All five fixed — the missing word after "if you have another", "to" → "so"
  secrets never enter, "Docker MCP TOols" → "Toolkit", "sites" → "sits", and the
  four Mermaid labels using `\n` where current Mermaid renders it literally, now
  `<br/>` to match the diagrams further down. (The audit's line numbers had gone
  stale; located by string instead.) A sweep for doubled words and common
  misspellings across the docs found nothing further.
