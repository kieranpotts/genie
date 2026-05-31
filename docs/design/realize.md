# Design: `realize`

Design notes for the `realize` extension — the decisions behind it, their rationale, and the outstanding work. This complements the user-facing [`src/realize/README.md`](../../src/realize/README.md), which documents *what* the command does; this document records *why* it is shaped the way it is.

The capitalized words REQUIRED, MUST, MUST NOT, RECOMMENDED, SHOULD, SHOULD NOT, OPTIONAL, and MAY are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

## Purpose

`/realize <source>` hands a specification to the agent and makes it fully responsible for implementing that specification end to end.

The single argument is the *source* of the specification — a local file, a local directory of artifacts, a URL, or a GitHub issue or pull request. The extension classifies the source and builds a prompt that points the agent at it; the extension itself never reads the specification. The agent reads the file, lists the directory, or fetches the URL with its own tools, so it is never limited by what would fit in a single message.

## Architecture

The extension is three small modules, with a deliberately thin I/O edge and a pure core:

- [`index.ts`](../../src/realize/index.ts) — registers the `/realize` command, validates the argument, and dispatches. The only module that touches the Pi `ExtensionAPI`.
- [`source.ts`](../../src/realize/source.ts) — classifies the argument into a `ResolvedSource`. The only module that performs I/O (`stat` for paths, a `gh --version` probe for GitHub URLs). It never reads contents.
- [`prompt.ts`](../../src/realize/prompt.ts) — builds the message handed to the agent. Pure and side-effect free, so it is unit-tested without faking the API.

This separation is sound and is not under review. The design work below is about the *content* of the prompt and the *coverage* of source classification, not the module structure.

## Decisions

### D1 — `realize` is a rigorous front door, not a lightweight shortcut

`/realize` is the disciplined entry point to a full software-development lifecycle, not a casual "just implement this" helper.

The prompt MUST frame the specification as a set of acceptance criteria the agent must satisfy, MUST require the agent to weigh options for any architecturally significant decision, and MUST define "done" as *every acceptance criterion verified with evidence* — not merely "the tests ran". This is deliberately heavier than a generic implementation prompt.

*Rationale:* the README already promises "full responsibility … end to end". The original five-step prompt under-delivered on that promise by reading as generic encouragement. Matching the prompt to the stated ambition removes the gap. This rigor is always on; there is no lightweight mode.

### D2 — Delegate to the installed workflow skills

The prompt routes the agent through the author's workflow skills, by name, in lifecycle order, as the primary path: `specify → design → elaborate → plan → code → test → review`.

The methodology therefore lives in exactly one place — the [`skills`](https://github.com/kieranpotts/skills) collection — and `realize` is the router that enters it with the supplied source as the starting artifact. The prompt MUST name the phases so the agent pulls each `SKILL.md` as it reaches that phase. (Pi exposes installed skills to the model, so naming a phase is sufficient to invoke it.)

*Rationale:* the skills already encode this lifecycle and already build into Pi (the `skills` repo has a `build/pi` target; skills install to `~/.pi/agent/skills/`). Re-paraphrasing the lifecycle inside `realize` would create a second, drifting copy of the methodology. Delegation keeps a single source of truth.

*Consequence (see [C1](#c1--realize-now-depends-on-the-workflow-skills)):* this makes the workflow skills a prerequisite, which the requirements documentation must now state.

### D3 — Defer to the target project's conventions

`realize` adds no branch, commit, or process rules of its own. The prompt MUST instruct the agent to discover and follow the conventions of the project it is running in — its `AGENTS.md`, its `CONTRIBUTING`, and its existing code and history.

*Rationale:* `realize` is intended for the author's own projects, which carry their own conventions. Baking branch or commit rules into `realize` would be wrong for any project whose conventions differ, and redundant for those that already declare them. Deferral is correct for the intended use and degrades gracefully when conventions are absent.

## The prompt

The source-specific opening line says where the spec is and how to read it, per source kind. The shared ownership block — implemented in [`prompt.ts`](../../src/realize/prompt.ts), which is the source of truth — encodes [D1](#d1--realize-is-a-rigorous-front-door-not-a-lightweight-shortcut)–[D3](#d3--defer-to-the-target-projects-conventions). It reads:

> You are taking full ownership of realizing this specification — turning it into working, verified reality, end to end.
>
> Work through it using your installed workflow skills, in order, invoking each for its phase:
>
> 1. **specify** — Treat the source as the requirements input. Capture it as testable acceptance criteria. If the source is already a rigorous specification, validate and adopt it; if it is informal, formalize it.
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

## Consequences

### C1 — `realize` now depends on the workflow skills

[D2](#d2--delegate-to-the-installed-workflow-skills) makes the author's workflow skills a prerequisite for `realize` to behave as designed.

[`docs/requirements.md`](../requirements.md) and the [`realize` README](../../src/realize/README.md) document this: they list the workflow skills as a requirement and point to installing them into Pi (`~/.pi/agent/skills/`, via the `skills` repo's `build/pi` target).

If a named skill is not installed, Pi simply will not surface it; the agent will fall back to performing that phase unaided. This is acceptable degradation, not a guaranteed mode — the supported configuration is with the skills installed.

## Backlog

Ordered by priority. P0 (the decisions above) is settled, and P1 is implemented: the prompt rewrite to the seven-phase delegation, GitHub URL canonicalization, GitHub blob handling (`/blob/…` → raw, with discussions and other pages left to a generic fetch by design), and the requirements/README updates. What remains:

### P2 — Polish and robustness

P2 is implemented, except 2.2, which is resolved by decision:

- **2.1 — Multiple sources** *(done).* `/realize <a> <b> …` accepts several sources for a spec split across, say, an issue and a design doc. `index.ts` splits the argument on whitespace and resolves each token; `buildRealizePrompt` takes a `ResolvedSource[]` and, for more than one, enumerates them as a numbered list. Because sources are whitespace-separated, a path containing spaces must be passed on its own — a documented caveat.
- **2.2 — `gh auth` not checked** *(won't do).* The `gh --version` probe confirms the binary, not authentication; a private-repo URL fails at runtime. We accept that clear runtime error rather than add a slow `gh auth status` probe to every GitHub URL.
- **2.3 — `file://` URLs** *(done).* Converted to a filesystem path with `fileURLToPath` (which also decodes escapes like `%20`) and then classified like any other path.
- **2.4 — Argument hygiene** *(done).* A single matching pair of wrapping quotes or backticks is stripped from each source before classification.
- **2.5 — GitHub shorthand** *(done).* `owner/repo#42` expands to a canonical issue URL and flows through the normal GitHub URL handling. It is always treated as an issue (GitHub redirects to the PR view if the number is a PR); the full `/pull/<n>` URL targets a pull request explicitly.

## Open questions

- **Execution model — one-shot vs. plan-gate.** `sendUserMessage` fires the whole job autonomously today. Pi's API would support a gate (`ctx.ui.confirm`, `registerFlag`/`getFlag` for a `--plan` flag), but delegation to the `plan` skill already introduces a natural checkpoint, which lessens the need. Deferred until the delegated lifecycle has been observed in practice.
- **Should `realize` also be a model-callable tool** (`registerTool`), not only a user command, so the agent can trigger realization mid-session? Out of scope for now.
