# realize

A Pi extension that adds a `/realize` command. You point it at a specification, and a multi-phase pipeline takes it through to a verified implementation.

## What it does

`/realize <source>` runs a specification through a rigorous software delivery pipeline — `specify → design → elaborate → plan → code → test → review` — finishing with a summary. Each phase runs in its own isolated context and hands off to the next through artifacts on disk, so no phase inherits the previous one's reasoning. "Done" means the change clears both verification and review.

Each argument is a source of the specification, which can be:

- A local file: `/realize ./docs/spec.md`
- A local directory: `/realize ./docs/spec/`
- A `file://` URL: `/realize file:///home/me/spec.md`
- A URL: `/realize https://example.com/spec`
- A GitHub issue or pull request: `/realize https://github.com/owner/repo/issues/42`
- A GitHub file: `/realize https://github.com/owner/repo/blob/main/spec.md`
- The GitHub shorthand `owner/repo#42` (treated as an issue; use full URLs for PRs)

You can pass multiple sources separated by spaces: `/realize ./docs/spec.md owner/repo#42`.

The extension validates and classifies the sources, then hands them to the first phase. It does not read the sources itself — the `specify` phase reads them with its own tools, so the pipeline is never limited by what fits in a single message.

Progress is shown in the status line as each phase runs. When the run finishes, the outcome and the artifact directory are reported. The artifacts — the specification, design, elaboration, plan, the change diff, the test and review reports, and a summary — are written under `.pi/realize/<run-id>/`.

## How it works

Four ideas shape the pipeline. The first three are the original `realize` principles; the fourth is what makes it a pipeline rather than a single prompt. The full design and its rationale are recorded in [SPEC.md](./SPEC.md).

**It is a rigorous process, not a shortcut.** `/realize` is a disciplined run through the full development lifecycle. The specification is framed as acceptance criteria, architecturally significant decisions require rationale, and "done" means verification and review both clear, with evidence.

**It delegates to installed workflow skills.** Each phase loads the matching workflow skill from the [`skills`][skills] collection and follows its methodology. The methodology lives in one place; `realize` is the router that drives the phases in order.

**It defers to project conventions.** `realize` imposes no branch or commit rules of its own. The phases discover and follow the target project's existing conventions — its `AGENTS.md`, `CONTRIBUTING`, and code patterns.

**Each phase runs in an isolated context.** Every phase is a separate, headless `pi` process with only the access it needs: the reviewer is strictly read-only, and the tester can run builds and checks but cannot edit source — so neither can quietly rewrite the code it is judging. Only the coder has unrestricted access. Phases communicate solely through artifacts, so the reviewer judges the change with fresh eyes rather than the coder's reasoning, and a failed check is sent back to a fresh coder — not the one that wrote the defect.

### The pipeline

The build phases run once, in order, each reading its predecessors' artifacts:

`specify` → `design` → `elaborate` → `plan` → `code`

Then a bounded rework loop verifies the result and sends it back when needed:

`test` → `review` → (if the gate fails) a fresh `code` pass → repeat

The gate passes only when verification passes **and** review does not request changes. If either is unsatisfied, the diff and the two reports go to a fresh coder, up to a small cycle limit (two by default). A final `summary` phase reports the outcome whether or not the gate cleared.

### Architecture

The extension is a thin I/O edge over a pure, deterministic core, behind two swappable ports:

- [`index.ts`](./index.ts) — registers the `/realize` command, classifies sources, and runs the pipeline.
- [`source.ts`](./source.ts) — classifies source tokens into `ResolvedSource` (a `stat` and a `gh --version` probe; the only source I/O).
- [`prompt.ts`](./prompt.ts) — builds the task text for the `specify` phase. Pure.
- [`phases.ts`](./phases.ts) — the eight phase definitions (role, access, model tier, skill) and the gate verdict parsers. Pure.
- [`runner.ts`](./runner.ts) — the `PhaseRunner` port: how a phase is executed, in semantic terms.
- [`runner-pi.ts`](./runner-pi.ts) — `PiCliRunner`, the port's `pi -p` implementation. The only module that spawns a process.
- [`workspace.ts`](./workspace.ts) — the `Workspace` port and its filesystem/git implementation: artifact storage and diff capture.
- [`pipeline.ts`](./pipeline.ts) — the deterministic orchestrator: the phase sequence, the gate, and the rework loop. Pure control flow over the two ports.

Unlike other agentic workflows, an agent is NOT used as the orchestrator. Instead the pipeline is driven by a deterministic, stateless orchestrator that calls each phase in sequence, evaluates the gate, and re-runs the loop if needed. It means control flow lives in code – so it is testable and predictable. The trade-off is the workflow doesn't adapt to circumstance. The phases of the lifecycle are literally hard-coded.

Each phase spawns an "expert" in a clean session, seeded with the diff and findings from the previous phase. This means there's a clean context starting at every phase boundary. This means increased cold-start cost, but it means each expert operates on the evolving artifacts using their own judgement – they're not influenced by prior discussion/context.

## Requirements

This extension expects the [workflow skills][skills] (`specify`, `design`, `elaborate`, `plan`, `code`, `test`, `review`) to be installed in Pi (`~/.pi/agent/skills/`). See the [requirements guide](../../docs/requirements.md#per-extension-requirements). Each phase is launched with its corresponding skill, so the skills must be installed for the pipeline to run as intended (the `summary` phase uses no skill).

## Limitations

Local file and directory sources are read directly by the `specify` phase. Remote sources — a URL, or a GitHub issue, pull request, or file — are classified, but the `specify` phase does not yet have the tools to retrieve them, so end-to-end support for remote sources is still pending.

## Configuration

None. Once installed, invoke it as `/realize <source>` in Pi.

[skills]: https://github.com/kieranpotts/skills

## Installing

From this repository's root directory, run:

```sh
./run/install realize
```

See the [installation guide](../../docs/installation.md) for more details.
