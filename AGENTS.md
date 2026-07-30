# Genie

My hardened agent harness, built around the [Pi coding agent](https://pi.dev)
(`@earendil-works/pi-coding-agent`). Each extension is a TypeScript module
that hooks into Pi's lifecycle events or registers tools, commands, or UI.

Extensions live under `src/extensions/<name>/`. There is no host installer:
extensions are baked directly into the hardened container image at build time
by `COPY` lines in
[`src/infrastructure/pi-container/Dockerfile`](./src/infrastructure/pi-container/Dockerfile).
Pi runs the TypeScript directly – there is no build step.

Non-extension infrastructure for the secure local agent architecture
(Docker images, compose files, the model proxy, MCP server wiring) lives
under `src/infrastructure/`. See [docs/solution.md](./docs/solution.md) for
the design, and [src/infrastructure/README.md](./src/infrastructure/README.md)
for the runbook.

The repository ships two extensions, forming the in-Pi half of the security
boundary:

- `mcp-client`: MCP client giving Pi mediated filesystem access through the
  Docker MCP Toolkit gateway.
- `permission-gate`: Interactive, default-deny confirmation gate on mutating
  tool calls, sensitive-filename refusal, secret redaction, and the audit
  trail.

See each extension's own README under `src/extensions/<name>/` for details.

The capitalized words REQUIRED, MUST, MUST NOT, RECOMMENDED, SHOULD,
SHOULD NOT, OPTIONAL, and MAY are to be interpreted as described in
[IETF RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

## Tech stack

- TypeScript, run directly by Pi and by Node's native type stripping – no
  compile or bundling step. Type *checking* is a separate gate (`tsc --noEmit`);
  "no build" means nothing is emitted or bundled, not that types are unchecked.

- Node.js 22.18+ (development uses Node 24) for the tooling and the built-in
  test runner.

- ESLint with [neostandard](https://github.com/neostandard/neostandard)style,
  ie. single quotes and no semicolons.

- The Node.js built-in test runner (`node:test`, `node:assert`).

- Bash for the `run/` scripts, with ShellCheck for static analysis.

- Docker, Docker Compose, and LiteLLM for the hardened infrastructure.

- pre-commit for commit-message validation, and GitHub Actions for CI.

## Project structure

- **`src/extensions/<name>/index.ts`**:
  An extension's entry point, with a default-exported factory
  `(pi: ExtensionAPI) => void`. Helper modules (eg. `messages.ts`)
  sit alongside it and are imported with explicit `.ts` extensions.

- **`src/infrastructure/`**:
  Non-extension infrastructure for the secure local agent architecture
  (Docker, compose, model proxy, MCP server wiring).

- **`test/extensions/<name>/`**:
  Tests for the Node test runner, mirroring the `src/extensions/`
  layout (`*.test.ts`). Kept out of `src/` so the Dockerfile's `COPY`
  lines never ship them.

- **`run/`**:
  Dev scripts – `startup`, `lint`, `fix`, `typecheck`, `test`, `check`.

- **`tsconfig.json`**:
  TypeScript config for the `noEmit` type-check (NodeNext, strict,
  `.ts` import extensions allowed). Not a build config.

- **`run/inc/fn/`**:
  Shared shell helpers (status printers, infrastructure startup).

- **`run/inc/var/`**:
  Shared shell variables (ANSI codes).

- **`docs/`**:
  Requirements, design decisions, and trade-offs for the hardened harness.

- **`CONTRIBUTING.md`**:
  How to develop, lint, test, and check extensions and infrastructure.

- **`eslint.config.js`**, **`package.json`**:
  Lint configuration and the `npm` script aliases.

- **`.github/workflows/`**:
  CI – `check` (lint and test), `validate-commit-messages`, and `sync-labels`.

## Tools

- **`./run/startup`** to bring up the hardened infrastructure (proxy, image,
  compose boundary) and enter the container.

- **`./run/lint`** and **`./run/fix`** to lint and auto-fix with ESLint.

- **`./run/typecheck`** to type-check with `tsc --noEmit` (extra args
  forwarded, eg. `--watch`).

- **`./run/test`** to run the test suite (extra arguments are forwarded
  to `node --test`, eg. `--watch`).

- **`./run/check`** to run the linter, then the type-check, then the tests –
  the command CI runs, and the one to run before committing.

- **`shellcheck run/startup run/lint run/fix run/test run/check run/inc/**/*.sh`**
  to lint the shell scripts.

Each `run/` script except `startup` is also exposed as an `npm run` alias
(`lint`, `fix`, `typecheck`, `test`, `check`).

## Rules

- MUST author each extension as a directory `src/extensions/<name>/` with an
  `index.ts` entry point that default-exports a factory function
  `(pi: ExtensionAPI) => void`.

- MUST import Pi's types from `@earendil-works/pi-coding-agent`, and import
  local helper modules with their explicit `.ts` extension – both Pi and Node's
  type stripping require it.

- MUST add a `COPY` line to
  [`src/infrastructure/pi-container/Dockerfile`](./src/infrastructure/pi-container/Dockerfile)
  to ship a new or updated extension inside the hardened image, or it will
  not reach the agent.

- MUST keep tests under `test/extensions/<name>/`, mirroring the `src/extensions/`
  layout, and never inside `src/`, so the Dockerfile's `COPY` lines never ship
  them.

- MUST keep non-extension infrastructure under `src/infrastructure/`.
  Infrastructure is not a Pi extension and is never `COPY`'d as one.

- MUST run `./run/check` and get a clean pass before committing. CI runs the
  same command on every push and pull request. `check` includes `typecheck`,
  so the build must type-check as well as lint and test.

- SHOULD avoid `as never` / `as any` at the `registerTool` and event-handler
  seams. Where Pi's types expect a TypeBox `TSchema` but a plain JSON Schema
  is passed at runtime, an escape hatch is sometimes unavoidable; keep it to
  the single seam, comment why, and never use it to silence a genuine type
  error in the surrounding logic.

- MUST conform to the neostandard style enforced by ESLint. Run `./run/fix`
  rather than formatting by hand.

- MUST keep the `run/` shell scripts strict (`set -euo pipefail`) and
  passing ShellCheck.

- SHOULD keep pure, testable logic in helper modules (eg. `messages.ts`) so
  it can be unit-tested without faking the `ExtensionAPI`.

- SHOULD write documentation prose as one line per paragraph, with no hard
  wrapping, and let the editor soft-wrap.

## Skills

Skills that are specific to this project are installed in `./agents/skills/`.
None are defined yet.
