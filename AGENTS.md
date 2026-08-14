# Genie

My hardened agent harness, built around the [Pi coding agent](https://pi.dev)
(`@earendil-works/pi-coding-agent`). Each extension is a TypeScript module
that hooks into Pi's lifecycle events or registers tools, commands, or UI.

Extensions live under `src/extensions/<name>/`. They are never installed into a
host Pi. They are baked directly into the hardened container image at build time
by `COPY` lines in
[`src/infrastructure/pi-container/Dockerfile`](./src/infrastructure/pi-container/Dockerfile).
Pi runs the TypeScript directly. There is no build step.

`run/install` installs the HOST tooling – the `genie` CLI and the files it
needs to build and run the boundary – and installs no extension anywhere.

Non-extension infrastructure for the secure local agent architecture
(Docker images, compose files, the model proxy, MCP server wiring) lives
under `src/infrastructure/`. See [docs/solution.md](./docs/solution.md) for
the design, and [src/infrastructure/README.md](./src/infrastructure/README.md)
for the runbook.

The repository ships three extensions, forming the in-Pi half of the security
boundary:

- `mcp-client`: MCP client giving Pi mediated filesystem access through the
  Docker MCP Toolkit gateway.
- `secret-sentry`: Unattended security controls for away-from-keyboard use —
  absolute sensitive-filename refusal and secret redaction. No interactive
  confirmation. See pi's `permission-gate` for that.
- `audit-log`: The activity trail — every call and result, turn boundaries,
  and model-request shapes. Records; decides nothing.

See each extension's own README under `src/extensions/<name>/` for details.

The capitalized words REQUIRED, MUST, MUST NOT, RECOMMENDED, SHOULD,
SHOULD NOT, OPTIONAL, and MAY are to be interpreted as described in
[IETF RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

## Tech stack

- TypeScript, run directly by Pi and by Node's native type stripping – no
  compile or bundling step. Type *checking* is a separate gate (`tsc --noEmit`).
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

- `src/extensions/<name>/index.ts`. \
  An extension's entry point, with a default-exported factory
  `(pi: ExtensionAPI) => void`. Helper modules (eg. `messages.ts`)
  sit alongside it and are imported with explicit `.ts` extensions.

- `bin/genie`. \
  The host CLI. Parses arguments, then dispatches into `lib/fn/`. The only
  entry point an installed Genie has.

- `src/infrastructure/`. \
  Non-extension infrastructure for the secure local agent architecture
  (Docker, compose, model proxy, MCP server wiring).

- `test/extensions/<name>/`. \
  Tests for the Node test runner, mirroring the `src/extensions/`
  layout (`*.test.ts`). Kept out of `src/` so the Dockerfile's `COPY`
  lines never ship them.

- `run/`. \
  Dev scripts – `install`, `startup`, `log`, `lint`, `fix`, `typecheck`,
  `test`, `check`. `startup` and `log` are thin wrappers around `bin/genie`,
  so the dev loop and the installed CLI cannot drift.

- `tsconfig.json`. \
  TypeScript config for the `noEmit` type-check (NodeNext, strict,
  `.ts` import extensions allowed). Not a build config.

- `lib/fn/`. \
  Shared shell library, sourced by `bin/genie` and `run/install` –
  `statuses.sh` (status printers, all writing to stderr), `paths.sh` (XDG
  locations), `boundary.sh` (bring up, reuse, tear down), `agent.sh` (argument
  resolution and the two run modes), `logs.sh` (audit-trail tailing),
  `install.sh` (payload install).

- `lib/var/`. \
  Shared shell variables (ANSI codes, blanked when stderr is not a terminal).

- `docs/`. \
  Requirements, design decisions, and trade-offs for the hardened harness.

- `CONTRIBUTING.md`. \
  How to develop, lint, test, and check extensions and infrastructure.

- `eslint.config.js`, `package.json`. \
  Lint configuration and the `npm` script aliases.

- `.github/workflows/`. \
  CI – `check` (lint and test), `validate-commit-messages`, and `sync-labels`.

## Tools

- Run `./run/install [--link|--uninstall]` to install the host tooling: the
  payload to `~/.local/share/genie/`, the config to `~/.config/genie/env`, and
  a `genie` symlink in `~/.local/bin/`. `--link` points the payload at the
  working tree instead of copying, for development.

- Run `genie` (or `./bin/genie` from a checkout) to drive an agent inside the
  boundary: `-p/--prompt` for one prompt with the response on stdout, `--tui`
  for an interactive session, and `--up`/`--down`/`--status`/`--logs`/`--rebuild`
  for the stack. `--project` scopes the agent and defaults to the working
  directory. The stack is PERSISTENT. It is reused across invocations until
  `--down`.

- Run `./run/startup` to open an interactive session from a checkout. A thin
  wrapper around `genie --tui`. It no longer tears the stack down on exit.

- Run `./run/log [audit|security|all]` to tail the audit trail. A thin wrapper
  around `genie --logs`.

- Run `./run/lint` and `./run/fix` to lint and auto-fix with ESLint.

- Run `./run/typecheck` to type-check with `tsc --noEmit` (extra args
  forwarded, eg. `--watch`).

- Run `./run/test` to run the test suite (extra arguments are forwarded
  to `node --test`, eg. `--watch`).

- Run `./run/check` to run the linter, then the type-check, then the tests.
  This is the command CI runs, and the one to run before committing.

- Run `shellcheck bin/genie run/install run/startup run/log run/lint run/fix
  run/test run/check run/typecheck lib/**/*.sh` to lint the shell scripts.

Each `run/` script except `install`, `startup`, and `log` is also exposed as an
`npm run` alias (`lint`, `fix`, `typecheck`, `test`, `check`).

## Rules

- MUST author each extension as a directory `src/extensions/<name>/` with an
  `index.ts` entry point that default-exports a factory function
  `(pi: ExtensionAPI) => void`.

- MUST import Pi's types from `@earendil-works/pi-coding-agent`, and import
  local helper modules with their explicit `.ts` extension. Both Pi and
  Node's type stripping require it.

- MUST add a `COPY` line to
  [`src/infrastructure/pi-container/Dockerfile`](./src/infrastructure/pi-container/Dockerfile)
  to ship a new or updated extension inside the hardened image, or it will
  not reach the agent.

- MUST keep tests under `test/extensions/<name>/`, mirroring the
  `src/extensions/` layout, and never inside `src/`, so the Dockerfile's
  `COPY` lines never ship them.

- MUST keep non-extension infrastructure under `src/infrastructure/`.
  Infrastructure is not a Pi extension and is never `COPY`'d as one.

- MUST add any new path the installed CLI needs at runtime to the
  `payload_paths` allowlist in `lib/fn/install.sh`. That list is what gets
  installed. A file outside it exists in the repository and nowhere else, and
  the failure is a `genie` that works from a checkout and breaks once
  installed.

- MUST NOT let the security-critical launch flags migrate out of `start-pi`.
  `--no-builtin-tools`, `--model`, and the project-trust decision live inside
  the hardened image so no host-side caller can drop them. `bin/genie`
  chooses only the role (via `PI_MODEL`) and the prompt. A `pi` flag added on
  the host would be a control that a replaced command could silently remove.

- MUST keep every status and progress message on stderr (use the helpers in
  `lib/fn/statuses.sh`, never a bare `echo`). `genie`'s stdout is the agent's
  response, and a single stray `echo` corrupts it for every scripted caller.

- MUST give any `curl` against `LITELLM_HOST` an explicit
  `--connect-timeout`. That address is `agent-net`'s gateway and does not exist
  until compose creates the network, so the "nothing is up" case is unroutable
  rather than refused, and curl's default is to retry for about two minutes.

- MUST run `./run/check` and get a clean pass before committing. CI runs the
  same command on every push and pull request. `check` includes `typecheck`,
  so the build must type-check as well as lint and test.

- SHOULD avoid `as never` / `as any` at the `registerTool` and event-handler
  seams. Where Pi's types expect a TypeBox `TSchema` but a plain JSON Schema
  is passed at runtime, an escape hatch is sometimes unavoidable. Keep it to
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

## References

The following technical standards (TS) govern this project. Fetch and ingest
the relevant standards as-and-when required for the task at hand.

- [**TS-32: Bash**](https://kieranpotts.com/standards/032) \
  Use when authoring or modifying scripts that target Bash specifically, and
  which use Bash extensions ("Bashisms").

- [**TS-36: ECMAScript (JavaScript/TypeScript)**](https://kieranpotts.com/standards/036) \
  Use when writing or reviewing JavaScript or TypeScript source code. Covers
  syntax, modules, async programming, functional patterns, and testing.

- [**TS-58: Docker**](https://kieranpotts.com/standards/058) \
  Use when designing Dockerfiles, building Docker images, or running Docker
  containers.

- [**TS-60: GitHub Actions**](https://kieranpotts.com/standards/060) \
  Use when designing, authoring, reviewing, or securing GitHub Actions workflows
  or custom actions.
