# realize — Specification: per-phase context isolation

Status: **proposed** (design + validated substrate; not yet implemented). This document specifies the next evolution of the `realize` extension. The current behavior is described in [README.md](./README.md); this spec layers on top of it and supersedes its "Possible future directions" notes.

## Summary

Today `/realize` hands a specification to a single agent that works through the whole lifecycle — `specify → design → elaborate → plan → code → test → review` — in one continuous context. As the context grows, the agent eventually judges its own work with its own reasoning and rationalisations still in view.

This spec changes that: each lifecycle phase is handled by a **distinct expert in an isolated context**, with explicit handoffs between them — mirroring how real teams pass work between specialists (e.g., a coder, a tester, a reviewer). Phases communicate through durable artifacts on disk rather than a shared conversation.

## Motivation

The idea is adapted from two existing Pi extensions, but goes further.

- [`owainlewis/pi-extensions` → `context-workflow`](https://github.com/owainlewis/pi-extensions/tree/main/extensions/context-workflow) resets context before the review phase to give the model "fresh eyes", but the methodology is delivered as instructions to one continuous agent.
- [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) is a full subagent framework (markdown definitions, tool allowlists, model overrides, parallel fan-out, worktrees, background runs, nested delegation). It is the reference for *how* to run isolated experts.

We want the rigor of separate contexts with a smaller, purpose-built mechanism than `pi-subagents`.

## Design decisions

These five decisions are settled. Each is followed by its rationale.

**D1 — An internal module of `realize`, behind a swappable runner port.** Isolation is achieved by running each expert as its own process. This capability is *not* a separate, general-purpose extension: nothing other than `realize` will consume it, so an extension boundary (discovery paths, an agent-definition file format, a `/run` command, install registration) would serve a generality we do not want. It lives inside `src/realize/` as ordinary modules. To preserve the option of changing *how* an expert executes later (e.g. away from `pi -p`), the one thing that knows the execution mechanism is isolated behind a single `ExpertRunner` port (ports-and-adapters); the pipeline depends only on that interface. Scope stays deliberately small: sequential only — no parallel or dynamic fan-out, no git-worktree isolation, no background runs, no intercom bridge, no deep nesting. Kept: named experts, isolated context, per-expert capability scope, per-expert model tier, and captured output.

**D2 — Reset at every phase boundary.** Every phase is a distinct expert in a fresh context. The mental model is a real-world handoff chain: each specialist receives the prior specialist's output, does their part, and hands it on.

**D3 — Deterministic pipeline orchestration.** `realize`'s TypeScript drives experts in a fixed lifecycle order and encodes the rework loop explicitly (bounded retries). Control flow lives in testable code rather than model judgment. The route cannot adapt per specification (e.g., it cannot skip a phase) — that rigidity is the point.

**D4 — Stateless respawn on rework.** When `test` or `review` sends work back, the fix is performed by a **brand-new** coder expert, seeded only with the current diff and findings. No expert is a long-lived session. This ensures each invocation is reproducible.

**D5 — File-based artifact handoff.** Because nothing carries across an isolated boundary in conversation, all state crosses as durable artifacts on disk. This forces the lifecycle to emit real `spec` / `design` / `plan` documents and makes the *document*, not the chatter, the interface between phases. It also aligns with delegating methodology to installed workflow skills — `realize` remains the router; the skills remain the source of truth for *how* each phase is done.

## Platform substrate (verified, Pi v0.77.0)

Pi has **no subagent abstraction in its extension API** — it is built here. The mechanism is **out-of-process**: each expert is a single headless `pi` invocation. This was chosen over the in-process session API (`newSession` / `fork` / `withSession`) because every rigor lever we need is a first-class CLI flag, isolation is free, and the orchestrator stays a plain process sequencer.

The relevant headless flags (`pi --help`, v0.77.0):

- `--print, -p` — non-interactive: process the prompt and exit.
- `--system-prompt <text>` / `--append-system-prompt <text|file>` — the expert's role (replaces or augments the default coding prompt).
- `--tools, -t <allowlist>` / `--exclude-tools, -xt <denylist>` / `--no-builtin-tools` — per-expert tool scoping (e.g. a read-only reviewer).
- `--model <pattern>` / `--provider <name>` — per-expert model.
- `--skill <path>` / `--no-skills` — load only the phase's skill, or none.
- `--extension, -e <path>` / `--no-extensions` — omit the `subagents` extension from children (prevents recursion; speeds boot).
- `--no-session` — ephemeral; `--session-id` / `--session-dir` / `--fork <id>` for controlled persistence.
- `--mode text|json|rpc` — `json` for structured/parseable result capture.
- `@file …` positionals — seed the child's initial message with artifact files.

The in-process session toolkit (`newSession`, `fork`, `switchSession`, `navigateTree`, `waitForIdle`, `compact`, all on `ExtensionCommandContext`, with `withSession` callbacks yielding a `ReplacedSessionContext` that can `sendUserMessage`) remains available as a fallback, but is not the chosen path.

## Spike validation

The out-of-process substrate was validated end to end on 2026-05-31 with a read-only **review** expert run against a real 19 KB diff:

```sh
pi -p --no-extensions --no-skills --no-prompt-templates --no-themes --no-session \
   -t read,grep,find,ls \
   --system-prompt "$(cat reviewer.md)" \
   @change.diff \
   "Review the attached diff (the change under review); end with the VERDICT line. Do not modify anything."
```

Results:

- **Headless run** — exit 0, completed in ~75s.
- **Per-expert role** — `--system-prompt` ensured the model behaved as a reviewer, not a coder.
- **Read-only scoping** — `-t read,grep,find,ls` prevented `write`/`edit`/`bash`; the working tree remained **byte-identical**. This guarantee is structural, not advisory.
- **Result capture** — an 837-byte review returned on **stdout**, ending in a parseable `VERDICT: PASS` line.
- **Artifact seeding** — `@change.diff` correctly fed the diff for review.

One operational caveat: the child `pi` process requires network access to the model API. This is an environment constraint, not a design flaw; `~/.pi/settings/auth.json` and `models.json` are configured and working.

## Architecture

All modules live inside `src/realize/`:

```
index.ts        the /realize command (existing)
source.ts       source classification (existing)
prompt.ts       per-phase prompt / task construction
phases.ts       the seven Phase definitions (in-code objects)
runner.ts       the PhaseRunner port + its value types    ← stable seam
runner-pi.ts    PiCliRunner — the pi -p adapter            ← the only process-spawning code
pipeline.ts     the deterministic orchestrator + rework loop
```

The pipeline depends only on the port, never on `pi`. Each phase is described semantically (what access and model *tier* it needs); the adapter alone knows how those map to `pi` flags. This keeps the execution mechanism swappable: a future in-process `SessionRunner`, or a `FakeRunner` for tests, drops in without the pipeline changing.

### The runner port

```ts
type Access = 'read-only' | 'author' | 'verify' | 'full'
type Tier   = 'default' | 'strong'

interface Phase {
  name: string             // e.g. 'review'
  systemPrompt: string     // the role
  access: Access           // capability intent — the adapter maps it to tools
  tier: Tier               // model intent — the adapter maps it to a model
  skill?: string           // the workflow skill this phase loads, if any
}

interface PhaseTask {
  inputs: string[]         // artifact paths handed to the phase
  task: string             // the instruction
}

interface PhaseResult {
  ok: boolean              // success signal (e.g. exit code 0)
  output: string           // the handoff text (captured stdout)
}

interface PhaseRunner {
  run (phase: Phase, task: PhaseTask): Promise<PhaseResult>
}
```

`PiCliRunner` implements the port over `pi -p`: it translates `access` to a `-t` allowlist and `tier` to a configured model, passes `skill` as `--skill`, the `inputs` as `@file` positionals, and the `task` as the message; then spawns the process and captures stdout and the exit code. It is the only module that imports `node:child_process`. A read-only or verify phase's stdout becomes the handoff document; the `full` (coder) phase edits the working tree directly, and the diff is the handoff.

### Semantic vocabulary

The port speaks intent, not `pi` vocabulary, so no non-`pi` adapter inherits `pi`'s tool or model naming. The `pi` adapter translates:

| `access` | Used by | `pi` adapter maps to (`-t`) | Capability |
|---|---|---|---|
| `read-only` | `review` | `read, grep, find, ls` | inspect only |
| `author` | `specify`, `design`, `elaborate`, `plan` | `read, grep, find, ls, write` | write artifact docs; no exec |
| `verify` | `test` | `read, grep, find, ls, bash` | run builds/tests; cannot patch |
| `full` | `code` | *(pi default set — no `-t`)* | the only mutator |

`tier` is `default` (inherit the model Pi was launched with) or `strong` (a configured higher-capability model). The mapping from `strong` to a concrete model ID lives in the adapter, not the expert.

## The pipeline

Seven experts run in lifecycle order. Artifacts live in a run-scoped directory (`.pi/realize/<run-id>/` by default), and final documents may be promoted to the repo per project conventions.

```
specify(@sources)             -> spec.md
design(@spec)                 -> design.md
elaborate(@spec,@design)      -> elaboration.md
plan(@spec,@design,@elab)     -> plan.md
code(@plan, …)                -> edits the working tree (the diff)

loop i in 1..N:                         # orchestrator owns the counter (max N)
  test(@spec,@plan + diff)    -> test-report.md      # read-only + test runner
  review(@spec + diff)        -> review-report.md     # read-only
  if gate(test, review): break
  code(@diff,@test-report,@review-report)             # FRESH coder (D4 stateless respawn)

summary(all artifacts)
```

Each line is a `runExpert` call. The fix coder in the loop is a brand-new expert seeded only with the diff and findings.

### The loop gate

The `break` condition composes two signals:

- **Deterministic check** — the orchestrator runs the project's verification command and reads the exit code (cannot be talked into "looks fine").
- **Expert verdict** — `test`/`review` experts emit a parseable verdict (a `VERDICT:` line, or `--mode json`) and detailed evidence.

Recommended split: the orchestrator handles the *gate*; the experts produce the *evidence report*.

### Per-expert configuration

Each phase declares only its semantic `access` and `tier` (see the vocabulary table above); the `pi` adapter resolves these to concrete tools and a model.

| Phase | `access` | `tier` | Notes |
|---|---|---|---|
| `specify` | `author` | default | writes the spec document |
| `design` | `author` | strong ◇ | judgment gate — architecturally significant decisions |
| `elaborate` | `author` | default | writes the elaboration document |
| `plan` | `author` | default | writes the plan document |
| `code` | `full` | default | the only mutator |
| `test` | `verify` | default | runs builds/tests; cannot patch source |
| `review` | `read-only` | strong ◇ | judgment gate — strictly read-only |

The two judgment gates (`design`, `review`, marked ◇) are the recommended places to assign `strong` if model tiering is wanted; everything else inherits the session model. What `strong` resolves to depends on the Pi configuration (the current setup uses the `ollama` provider, so it might map to `qwen3.5:35b` or `kimi-k2.6:cloud` — illustrative, not prescribed). How a per-run override is surfaced remains an open item.

Two `access` guarantees provide structural rigor: `review` is strictly read-only, and `test` may run the suite but cannot patch source — a fresh coder handles any fixing (D4). `author` phases can write their artifact docs but cannot execute (`bash` withheld), keeping them out of side effects unless a phase is later promoted to a wider access level.

## Rigor levers

Isolation provides guarantees that instructions alone cannot:

- **Read-only enforcement**: A reviewer/tester *cannot* modify code, enforced by the tool allowlist.
- **Explicit roles**: Each expert's role is set per phase (`--system-prompt` + phase skill), avoiding prompt drift.
- **Tiered models**: Models can be chosen per phase (e.g., stronger models for design/review).
- **Fast boot**: Children run with `--no-extensions` (so realize cannot recursively invoke itself) and skip themes and prompt templates, speeding startup.

## Caveats and constraints

- **Network**: Each expert is a separate `pi` process and must reach the model API.
- **Latency**: A full run involves several sequential `pi` boots. Mitigated by using `--no-extensions --no-themes --no-prompt-templates` on children.
- **No shared memory**: Decisions not written to artifacts are lost between phases. This forces high-quality artifacts, but prompts must insist that cross-phase decisions are recorded.

## Open questions

- Exact `--mode json` result schema versus relying on artifact files plus exit codes.
- How per-phase model overrides are surfaced: each expert's `tier` is the baseline; what `strong` resolves to, and whether to let the user remap the tier→model assignment per run (a config block or flags).
- Final artifact location: scratch `.pi/realize/<run-id>/` versus promoting `spec`/`design`/`plan` into the repo — tied to the existing "defer to the target project's conventions" decision.
- Whether `realize` should expose itself as a model-callable tool (`registerTool`) in addition to the `/realize` command.
- Remote-source retrieval: the `specify` phase has `author` access (read/write, no `bash` or fetch), so URL and GitHub sources cannot be fetched by it. Options: widen `specify`'s access for retrieval, pre-fetch sources in the command, or add a retrieval tool. Local file/directory sources work today.

## Build order

1. Spike a read-only `review` phase to validate the substrate. **(Done — passed.)**
2. Define the `PhaseRunner` port and value types (`runner.ts`). **(Done.)**
3. Implement `PiCliRunner` (`runner-pi.ts`): the `access`/`tier`/`skill` → `pi -p` argv mapping, spawn, and stdout/exit capture. The only process-spawning module. **(Done — `buildPiArgs` is pure and unit-tested; spawn covered with a fake `pi`.)**
4. Wire `realize`'s `review` phase to a real phase through the port — the smallest end-to-end win. **(Done — `phases.ts` defines the `review` phase, its skill-delegating role, and `parseVerdict`; proven through the port against a `FakeRunner`.)**
5. Generalise to the full deterministic pipeline (`pipeline.ts`): the remaining six phases (in `phases.ts`), the run-scoped artifact directory, and the bounded rework loop — all unit-tested against the fake runner, no spawning. **(Done — `phases.ts` defines all eight phases; `workspace.ts` provides the `Workspace` port + filesystem/git implementation; `pipeline.ts` runs the build then the bounded `test → review → code` rework loop behind a two-signal `gate`. Fully fake-tested; 103 tests green.)**

What is built so far is the *engine*, exercised only through unit tests. Still to do before `/realize` actually uses it:

6. **Wire the engine to the command.** **(Done — `/realize` now runs `runPipeline`.)** The existing command was switched over (no separate opt-in): `index.ts` classifies sources, builds the `specify` task via `buildSpecifyTask`, constructs a real `PiCliRunner` (with `cwd`) + `FileWorkspace`, runs the pipeline, and surfaces per-phase progress through `ctx.ui.setStatus` with the outcome via `ctx.ui.notify`. The single-shot ownership prompt was retired (`buildRealizePrompt`/`OWNERSHIP_INSTRUCTIONS` removed; `prompt.ts` now builds only the specify task). README updated. 100 tests green.
7. **First live run.** Install the seven workflow skills into `~/.pi/agent/skills/` (currently empty), choose what `strong` resolves to for the configured provider, and confirm an end-to-end run against a real specification. Resolve the deferred live caveats: the `--skill X` + `--no-skills` interaction, untracked-file visibility in `captureDiff`, and remote-source retrieval (the `specify` phase has `author` access — no `bash`/fetch — so URL/GitHub sources are classified but not yet retrievable; local file/directory sources work).
