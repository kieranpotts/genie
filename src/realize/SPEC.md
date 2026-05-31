# realize — Specification: per-phase context isolation

Status: **proposed** (design + validated substrate; not yet implemented). This document specifies the next evolution of the `realize` extension. The current, shipped behaviour is described in [README.md](./README.md); this spec layers on top of it and supersedes its "Possible future directions" notes once built.

## Summary

Today `/realize` hands a specification to a single agent that works through the whole lifecycle — `specify → design → elaborate → plan → code → test → review` — in one continuous context. The context grows monotonically, so by the time the agent reaches `review` it is judging its own work with all of its own reasoning and rationalisations still in view.

This spec changes that: each lifecycle phase is handled by a **distinct expert running in a clean, isolated context**, with explicit handoffs between them — mirroring the way real teams pass work between specialists (a coder, a tester, a reviewer). The phases communicate through durable artifacts on disk rather than through a shared conversation.

## Motivation

The idea is adapted from two existing Pi extensions, but goes further than either.

- [`owainlewis/pi-extensions` → `context-workflow`](https://github.com/owainlewis/pi-extensions/tree/main/extensions/context-workflow) resets context between phases, but only *softly*: it fires a single `ctx.compact({ customInstructions })` before the review phase to give the model "fresh eyes", and restores context afterwards. The methodology is delivered as instructions to one continuous agent.
- [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) is a full subagent framework (markdown agent definitions, tool allowlists, model overrides, parallel fan-out, worktrees, background runs, nested delegation). It is the richer-than-we-need reference for *how* to run isolated experts.

We want the rigour of genuinely separate contexts (not a lossy summary, not advisory cleanup) with a much smaller, purpose-built mechanism than `pi-subagents`.

## Design decisions

These five decisions are settled. Each is followed by its rationale.

**D1 — Build a separate, simpler `subagents` extension.** Rather than compaction or session-tree summarisation, isolation is achieved by running each expert as its own process. The capability is packaged as a standalone, reusable `subagents` extension; `realize` is one consumer of it. "Simpler than `pi-subagents`" means: sequential only — no parallel fan-out, no dynamic fan-out, no git-worktree isolation, no background/async runs, no intercom bridge, no deep nesting. Kept: named experts, isolated context, per-expert tool allowlist, per-expert model, and an output captured back to the caller.

**D2 — Reset at every phase boundary.** Every phase is a distinct expert in a fresh context, not a single agent that resets only before review. The mental model is a real-world handoff chain: each specialist receives the prior specialist's output, does their part, and hands on. This is deliberately more aggressive than the prior art.

**D3 — Deterministic pipeline orchestration.** `realize`'s own TypeScript drives the experts in a fixed lifecycle order and encodes the rework loop explicitly (bounded retries). Control flow lives in inspectable, testable code rather than in a model's judgement. The trade-off accepted: the route cannot adapt per specification (e.g. it cannot decide to skip a phase) — that rigidity is the point.

**D4 — Stateless respawn on rework.** When `test` or `review` sends work back, the fix is performed by a **brand-new** coder expert, seeded only with the current diff and the findings. No expert is a long-lived session that work is handed back into. This is the purest expression of "clean context at every boundary" and keeps each invocation reproducible.

**D5 — File-based artifact handoff (a forced consequence of D2 + D4).** Because nothing carries across an isolated boundary in conversation, all state crosses as durable artifacts on disk. This is a feature, not a tax: it forces the lifecycle to emit real `spec` / `design` / `plan` documents (which the workflow skills already produce), and it makes the *document*, not the chatter, the interface between phases. It also dovetails with the existing `realize` decision to delegate methodology to the installed workflow skills — `realize` remains the router; the skills remain the single source of truth for *how* each phase is done.

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

- **Headless run** — exit 0, completed in roughly 75s.
- **Per-expert role** — with `--system-prompt` the model behaved as a reviewer, not a coder.
- **Read-only scoping** — with `-t read,grep,find,ls` the expert had no `write`/`edit`/`bash`; the working tree was **byte-identical before and after**. The read-only guarantee is structural, not advisory.
- **Result capture** — an 837-byte review came back on **stdout**, ending in a parseable `VERDICT: PASS` line.
- **Artifact seeding** — `@change.diff` fed the diff in and it was reviewed correctly.

One operational caveat surfaced: the child `pi` needs network access to the model API. It runs cleanly in a normal terminal (and when `realize` runs inside `pi`), but a sandboxed shell that blocks egress will cause it to hang. This is an environment constraint, not a design flaw, and there is no auth problem — `~/.pi/settings/auth.json` and `models.json` are configured and working.

## Architecture

Two layers.

**`subagents` (reusable primitive).** Provides an agent-definition format and a `runExpert` function, plus a `/run <agent> "<task>"` command for exercising a single expert by hand. It depends only on Pi being on `PATH`.

**`realize` (consumer).** Defines the seven workflow experts (each pointed at its matching skill, with an appropriate tool allowlist and model) and runs the deterministic pipeline over them.

### `runExpert`

The whole primitive, conceptually:

```ts
runExpert(def: AgentDefinition, opts: { inputs: string[], task: string }): Promise<ExpertResult>
```

It builds the `pi -p` argv from the definition (system prompt, `-t` allowlist, `--model`, `--no-extensions` etc.), passes `opts.inputs` as `@file` positionals, passes `opts.task` as the message, spawns the process, and captures stdout plus the exit code. A read-only expert never writes its own artifact — the orchestrator captures its stdout and *that becomes the handoff document*. A write-capable expert (the coder) edits the working tree directly, and the diff is the handoff.

### Agent-definition format

Markdown with YAML frontmatter, deliberately a minimal subset of the `pi-subagents` shape:

```yaml
---
name: reviewer
description: Read-only code reviewer; judges a diff against acceptance criteria.
model: <optional model pattern; inherits default if omitted>
tools: read, grep, find, ls          # optional allowlist; omit for default tools
skill: review                         # optional: the workflow skill this phase loads
---
<the system prompt body — the expert's role>
```

## The pipeline

Seven experts, run in lifecycle order. Artifacts live in a run-scoped directory (`.pi/realize/<run-id>/` by default; final `spec`/`design`/`plan` documents may be promoted into the repo where the target project's conventions ask for it).

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

Each line is a clean `runExpert` call. The fix coder in the loop is a brand-new expert seeded only with the diff and the findings.

### The loop gate

The `break` condition composes two complementary signals:

- **Deterministic check** — the orchestrator itself runs the project's verification command and reads the exit code (Owain-style; cannot be talked into "looks fine").
- **Expert verdict** — the `test`/`review` experts emit a parseable verdict (a `VERDICT:` line, or `--mode json`) plus the richer acceptance-criterion-by-criterion evidence.

Recommended split: the orchestrator runs the deterministic check for the *gate*; the experts produce the *evidence report*.

### Per-expert configuration

Built-in tools are `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Each expert's allowlist is passed via `-t`; the `code` expert takes Pi's default tool set (no `-t`).

| Expert | Tools (`-t`) | Model | Notes |
|---|---|---|---|
| `specify` | `read, grep, find, ls, write` | default | writes the spec document |
| `design` | `read, grep, find, ls, write` | stronger ◇ | judgment gate — architecturally significant decisions |
| `elaborate` | `read, grep, find, ls, write` | default | writes the elaboration document |
| `plan` | `read, grep, find, ls, write` | default | writes the plan document |
| `code` | *(default set)* `read, write, edit, bash, grep, find, ls` | default | the only mutator |
| `test` | `read, grep, find, ls, bash` | default | runs builds/tests; **no `write`/`edit`** |
| `review` | `read, grep, find, ls` | stronger ◇ | judgment gate — strictly read-only |

Model policy — **fully configurable per expert**. Each agent definition carries an optional `model` field; when it is unset (the `default` rows above), the expert inherits the model Pi is launched with, so out of the box every phase runs on your current session model and nothing surprising happens. The two judgment gates (`design`, `review`, marked ◇) are the recommended places to assign a higher-capability model *if* you want tiering — they are still just configuration, not baked in. Model identifiers are whatever your Pi is set up for; the current configuration uses the `ollama` provider, so a tiered setup might map the ◇ gates to a stronger model such as `qwen3.5:35b` or `kimi-k2.6:cloud` and leave the rest on the session default (these are illustrative, not prescribed). How a per-run override is surfaced (a `--model`-style flag, or a small phase→model config block) is an open item below.

Two allowlist guarantees are deliberate rigor levers: `review` is strictly read-only (no `write`/`edit`/`bash`, proven enforceable by the spike), and `test` may run the suite (`bash`) but can never patch source (no `write`/`edit`) — a fresh coder does any fixing (D4). The four document phases are write-capable so the workflow skills can persist their artifacts naturally; `bash` is withheld from them to keep them out of execution, and can be granted per phase if a skill needs it.

## Rigor levers

Isolation buys guarantees that instructions alone cannot:

- A read-only reviewer/tester *cannot* modify code — enforced by the tool allowlist, proven by the spike.
- Each expert's role is set explicitly per phase (`--system-prompt` + the phase skill), not paraphrased inside one growing prompt.
- Models can be chosen per phase (cheaper for mechanical phases, stronger for design/review).
- Children omit the `subagents` extension, so an expert cannot recursively spawn experts, and boot is faster.

## Caveats and constraints

- **Network** — each expert is a separate `pi` process and must reach the model API. A non-issue when `realize` runs inside `pi`; relevant only in sandboxed shells that block egress.
- **Latency** — a full run is several sequential `pi` boots (seven phases plus rework cycles). Mitigate with `--no-extensions --no-themes --no-prompt-templates` on children.
- **No shared memory** — any decision made in one phase that is not written into its artifact is lost to the next phase. This is intended (it forces good artifacts), but the experts' prompts must insist that cross-phase decisions are recorded.

## Open questions

- Exact `--mode json` result schema versus relying on artifact files plus exit codes.
- How per-phase model overrides are surfaced: the optional `model` field on each agent definition is the baseline; whether to also add a `realize`-level phase→model config block or flags.
- Final artifact location: scratch `.pi/realize/<run-id>/` versus promoting `spec`/`design`/`plan` into the repo — tied to the existing "defer to the target project's conventions" decision.
- Whether `realize` should expose itself as a model-callable tool (`registerTool`) in addition to the `/realize` command.

## Build order

1. Spike a read-only `review` expert to validate the substrate. **(Done — passed.)**
2. Build the `subagents` extension: agent-definition format, `runExpert`, and a `/run <agent> "<task>"` command for manual use.
3. Wire `realize`'s `review` phase to a real expert — the smallest end-to-end win.
4. Generalise to the full deterministic pipeline: the run-scoped artifact directory and the bounded rework loop.
5. Add per-phase tool-scoping and model selection.
