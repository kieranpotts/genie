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

**D1 — Build a separate, simpler `subagents` extension.** Isolation is achieved by running each expert as its own process. The capability is packaged as a standalone `subagents` extension; `realize` is one consumer. "Simpler" means: sequential only — no parallel or dynamic fan-out, no git-worktree isolation, no background runs, no intercom bridge, and no deep nesting. Kept: named experts, isolated context, per-expert tool allowlists, per-expert models, and captured output.

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

Two layers:

**`subagents` (reusable primitive).** Provides an agent-definition format and a `runExpert` function, plus a `/run <agent> "<task>"` command for manual use. It depends only on Pi being on `PATH`.

**`realize` (consumer).** Defines the seven workflow experts (each mapped to its matching skill, tool allowlist, and model) and runs the deterministic pipeline.

### `runExpert`

Conceptually:

```ts
runExpert(def: AgentDefinition, opts: { inputs: string[], task: string }): Promise<ExpertResult>
```

It builds the `pi -p` argv from the definition, passes `opts.inputs` as `@file` positionals, and `opts.task` as the message. It spawns the process and captures stdout and the exit code. A read-only expert's stdout becomes the handoff document; a write-capable expert (the coder) edits the working tree directly, and the diff is the handoff.

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

Model policy is **fully configurable per expert**. Each agent definition carries an optional `model` field; if unset, the expert inherits the model Pi was launched with. The two judgment gates (`design`, `review`, marked ◇) are recommended for higher-capability models if tiering is desired. Model identifiers depend on the Pi configuration (e.g., using `ollama` to map ◇ gates to `qwen3.5:35b` or `kimi-k2.6:cloud`). How per-run overrides are surfaced (e.g., via flags or a config block) remains an open item.

Two allowlist guarantees provide structural rigor: `review` is strictly read-only (no `write`/`edit`/`bash`), and `test` may run the suite (`bash`) but cannot patch source (no `write`/`edit`) — a fresh coder handles any fixing (D4). Document phases are write-capable so workflow skills can persist artifacts; `bash` is withheld to prevent execution unless a skill specifically requires it.

## Rigor levers

Isolation provides guarantees that instructions alone cannot:

- **Read-only enforcement**: A reviewer/tester *cannot* modify code, enforced by the tool allowlist.
- **Explicit roles**: Each expert's role is set per phase (`--system-prompt` + phase skill), avoiding prompt drift.
- **Tiered models**: Models can be chosen per phase (e.g., stronger models for design/review).
- **Fast boot**: Children omit the `subagents` extension to prevent recursive spawning and speed up startup.

## Caveats and constraints

- **Network**: Each expert is a separate `pi` process and must reach the model API.
- **Latency**: A full run involves several sequential `pi` boots. Mitigated by using `--no-extensions --no-themes --no-prompt-templates` on children.
- **No shared memory**: Decisions not written to artifacts are lost between phases. This forces high-quality artifacts, but prompts must insist that cross-phase decisions are recorded.

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
