# realize

A Pi extension that adds a `/realize` command. You point it at a specification, and the agent takes full responsibility for implementing it end-to-end.

## What it does

`/realize <source>` instructs the agent to realize a specification using a rigorous software development workflow. Rather than improvising, the agent follows these lifecycle skills: `specify`, `design`, `elaborate`, `plan`, `code`, `test`, and `review`. "Done" means every acceptance criterion is satisfied and verified with evidence.

Each argument is a source of the specification, which can be:

- A local file: `/realize ./docs/spec.md`
- A local directory: `/realize ./docs/spec/`
- A `file://` URL: `/realize file:///home/me/spec.md`
- A URL: `/realize https://example.com/spec`
- A GitHub issue or pull request: `/realize https://github.com/owner/repo/issues/42`
- A GitHub file: `/realize https://github.com/owner/repo/blob/main/spec.md`
- The GitHub shorthand `owner/repo#42` (treated as an issue; use full URLs for PRs)

You can pass multiple sources separated by spaces: `/realize ./docs/spec.md owner/repo#42`.

The extension validates and classifies sources, then builds a prompt pointing the agent to them. The agent reads the files or fetches the URLs using its own tools.

When the source is a GitHub issue or PR and the [`gh`](https://cli.github.com) CLI is installed, the agent is directed to use `gh issue view` or `gh pr view`. GitHub file (`/blob/`) URLs are rewritten to `raw.githubusercontent.com` for plain-text fetching.

## How it works

Three core principles shape the extension:

**It is a rigorous process, not a shortcut.** `/realize` is a disciplined entry point to the full development lifecycle. The prompt frames the specification as acceptance criteria, requires rationale for architecturally significant decisions, and defines "done" as verification of each lifecycle step with evidence.

**It delegates to installed workflow skills.** The prompt routes the agent through the author's own workflow skills: specify → design → elaborate → plan → code → test → review`. The methodology lives in the [`skills`][skills] collection; `realize` simply acts as the router.

**It defers to project conventions.** `realize` does not impose its own branch or commit rules. It instructs the agent to discover and follow the target project's existing conventions, such as `AGENTS.md`, `CONTRIBUTING`, and historical code patterns.

### The prompt

The prompt consists of a preamble listing the sources and a set of ownership instructions. The instructions (implemented in [`prompt.ts`](./prompt.ts)) are:

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

The extension consists of three modules:

- [`index.ts`](./index.ts) — Registers the `/realize` command, resolves sources, and dispatches.
- [`source.ts`](./source.ts) — Classifies source tokens into `ResolvedSource` (handles `stat` and `gh --version` probes).
- [`prompt.ts`](./prompt.ts) — Builds the prompt. Pure and side-effect free for easy unit testing.

## Requirements

This extension expects the [workflow skills][skills] (`specify`, `design`, `elaborate`, `plan`, `code`, `test`, `review`) to be installed in Pi (`~/.pi/agent/skills/`). See the [requirements guide](../../docs/requirements.md#per-extension-requirements). If a skill is missing, the agent will perform that phase unaided.

## Configuration

None. Once installed, invoke it as `/realize <source>` in Pi.

[skills]: https://github.com/kieranpotts/skills

## Installing

From this repository's root directory, run:

```sh
./run/install realize
```

See the [installation guide](../../docs/installation.md) for more details.
