# realize

A Pi extension that adds a `/realize` command. You point it at a specification, and the agent takes full responsibility for implementing it.

## What it does

`/realize <source>` hands a specification to the agent and instructs it to take full ownership of realizing it end to end. Rather than improvising, the agent is directed to work through the source using a set of software-development workflow skills, in lifecycle order: `specify`, `design`, `elaborate`, `plan`, `code`, `test`, and `review`. "Done" means every acceptance criterion is satisfied and verified with evidence.

Each argument is a source of the specification, which can be any of:

- A local file, eg. `/realize ./docs/spec.md`.
- A local directory of artifacts, eg. `/realize ./docs/spec/`.
- A `file://` URL, eg. `/realize file:///home/me/spec.md`.
- A URL, eg. `/realize https://example.com/spec`.
- A GitHub issue or pull request, eg. `/realize https://github.com/owner/repo/issues/42`.
- A GitHub file, eg. `/realize https://github.com/owner/repo/blob/main/spec.md`.
- The GitHub shorthand `owner/repo#42`, treated as an issue (use the full `/pull/` URL for a pull request).

You can pass several sources at once for a specification spread across more than one place, eg. `/realize ./docs/spec.md owner/repo#42`. Sources are separated by spaces, so an individual path that contains spaces must be passed on its own (quotes around it are tolerated and stripped).

The extension does not read the sources itself. It validates and classifies them, then builds a prompt that points the agent at each — so the agent reads the file, lists the directory, or fetches the URL using its own tools, and is never limited by what would fit in a single message.

When the source is a GitHub issue or pull request and the [`gh`](https://cli.github.com) CLI is installed, the agent is directed to read it (including the discussion) with `gh issue view` or `gh pr view`. A GitHub file (`/blob/`) URL is rewritten to its `raw.githubusercontent.com` form so the agent fetches the plain file. Any other URL — including a GitHub discussion, wiki, or repository root — is fetched like an ordinary web page.

## How it works

Three deliberate decisions shape the extension.

**It is a rigorous front door, not a lightweight shortcut.** `/realize` is the disciplined entry point to a full software development lifecycle, not a casual "just implement this" helper. The prompt frames the specification as a set of acceptance criteria the agent must satisfy, requires the agent to weigh options for any architecturally significant decision, and defines "done" as *every acceptance criterion verified with evidence* — not *the tests passed*! This rigor is always on; there is no "lightweight" mode. The point is to match the prompt to the promise of "full responsibility, end to end" rather than leave it as generic encouragement.

**It delegates to the installed workflow skills.** The prompt routes the agent through the author's own workflow skills, by name, in lifecycle order — `specify → design → elaborate → plan → code → test → review` — as the primary path. The methodology therefore lives in exactly one place, the [`skills`][skills] collection, and `realize` is the router that enters it with the supplied source as the starting artifact. Naming each phase is enough to invoke it, because Pi exposes installed skills to the model. Re-paraphrasing the lifecycle inside `realize` would create a second, drifting copy of the methodology; delegation keeps a single source of truth. (This is what makes the skills a prerequisite — see [Requirements](#requirements).)

**It defers to the target project's conventions.** `realize` adds no branch, commit, or process rules of its own. The prompt instructs the agent to discover and follow the conventions of the project it is running in — its `AGENTS.md`, its `CONTRIBUTING`, and its existing code and history. Baking such rules into `realize` would be wrong for any project whose conventions differ, and redundant for those that already declare them. Deferral is correct for the intended use — the author's own projects — and degrades gracefully when conventions are absent.

### The prompt

The prompt has two parts: a preamble naming each source and how to obtain it (one sentence for a single source, a numbered list for several), followed by the shared ownership instructions that encode the three decisions above. The ownership instructions — implemented in [`prompt.ts`](./prompt.ts), the source of truth — read:

> You are taking full ownership of realizing this specification — turning it into working, verified reality, end to end.
>
> Work through it using your installed workflow skills, in order, invoking each for its phase:
>
> 1. **specify** — Treat the supplied source material as the requirements input. Capture it as testable acceptance criteria. If it is already a rigorous specification, validate and adopt it; if it is informal, formalize it.
> 2. **design** — Explore options for any architecturally significant decision, and record the chosen approach and its rationale.
> 3. **elaborate** — Resolve ambiguities, gaps, and contradictions. Decide the ones where intent is clear and record your assumptions; ask only when a genuinely significant choice cannot reasonably be made on your own.
> 4. **plan** — Break the work into small, independently shippable steps.
> 5. **code** — Implement each step in full: code, configuration, tests, and documentation.
> 6. **test** — Verify the result against every acceptance criterion, with evidence. Run the relevant builds, tests, and checks.
> 7. **review** — Self-review the change for correctness, design, clarity, and completeness before finishing.
>
> Throughout, follow the conventions of the project you are working in — its branch and commit rules, its coding style, and any instructions in its `AGENTS.md` or `CONTRIBUTING`.
>
> Finish with a concise summary: what you built, the key decisions and assumptions you made, each acceptance criterion and how it was verified, and anything left outstanding.

### Architecture

The extension is three small modules, with a deliberately thin I/O edge and a pure core:

- [`index.ts`](./index.ts) — registers the `/realize` command, splits the argument into sources, resolves each, and dispatches. The only module that touches the Pi `ExtensionAPI`.
- [`source.ts`](./source.ts) — classifies each source token into a `ResolvedSource`. The only module that performs I/O (`stat` for paths, a `gh --version` probe for GitHub URLs). It never reads contents.
- [`prompt.ts`](./prompt.ts) — builds the message handed to the agent. Pure and side-effect free, so it is unit-tested without faking the API.

### Possible future directions

- **A plan-then-confirm gate.** Today the whole job runs autonomously once invoked. Pi's API could support pausing for approval after planning (`ctx.ui.confirm`, or a `--plan` flag via `registerFlag`), but the `plan` phase already provides a natural checkpoint, so this is deferred until the delegated lifecycle has been observed in practice.
- **A model-callable tool.** `realize` is a user command only. Exposing it as a tool (`registerTool`) as well would let the agent trigger realization mid-session. Out of scope for now.

## Requirements

This extension expects the [workflow skills][skills] it delegates to (`specify`, `design`, `elaborate`, `plan`, `code`, `test`, `review`) to be installed in Pi (`~/.pi/agent/skills/`). See the [requirements guide](../../docs/requirements.md#per-extension-requirements). If a named skill is not installed, Pi simply will not surface it and the agent runs that phase unaided — acceptable degradation, but the supported configuration is with the skills installed.

## Configuration

None. There are no settings. Once installed, invoke it as `/realize <source>` in Pi.

[skills]: https://github.com/kieranpotts/skills

## Installing

From this repository's root directory, run:

```sh
./run/install realize
```

See the [installation guide](../../docs/installation.md) for more details.
