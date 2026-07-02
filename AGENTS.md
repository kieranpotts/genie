# Pi

## Project overview

Personal and experimental extensions for the [Pi coding agent](https://pi.dev) (`@earendil-works/pi-coding-agent`). Each extension is a TypeScript module that hooks into Pi's lifecycle events or registers tools, commands, or UI.

Extensions live under `src/extensions/<name>/` and are installed into Pi's extensions directory (`~/.pi/agent/extensions/`) by `run/install`, which copies each extension directory verbatim. Pi runs the TypeScript directly – there is no build step.

Non-extension infrastructure for the secure local agent architecture (Docker images, compose files, the model proxy, MCP server wiring) lives under `src/infrastructure/`. This is **not** installable and `run/install` MUST NOT copy it into Pi's extensions directory. See [docs/local-agent-architecture.md](./docs/local-agent-architecture.md).

The repository ships several extensions, including `pickling-penguins`, which replaces the default "Working…" status with randomly composed nonsense. See each extension's own README under `src/extensions/<name>/` for details.

## Tech stack

- TypeScript, run directly by Pi and by Node's native type stripping – no compile or bundling step. Type *checking* is a separate gate (`tsc --noEmit`); "no build" means nothing is emitted or bundled, not that types are unchecked.
- Node.js 22.18+ (development uses Node 24) for the tooling and the built-in test runner.
- ESLint with [neostandard](https://github.com/neostandard/neostandard)style, ie. single quotes and no semicolons.
- The Node.js built-in test runner (`node:test`, `node:assert`).
- Bash for the `run/` scripts, with ShellCheck for static analysis.
- pre-commit for commit-message validation, and GitHub Actions for CI.

## Repository structure

- `src/extensions/<name>/index.ts`: An extension's entry point, with a default-exported factory `(pi: ExtensionAPI) => void`. Helper modules (eg. `messages.ts`) sit alongside it and are imported with explicit `.ts` extensions.
- `src/infrastructure/`: Non-extension infrastructure for the secure local agent architecture (Docker, compose, model proxy, MCP server wiring). Not installable – see the rule below.
- `test/extensions/<name>/`: Tests for the Node test runner, mirroring the `src/extensions/` layout (`*.test.ts`). Kept out of `src/` so the installer never ships them.
- `run/`: Dev scripts – `install`, `lint`, `fix`, `typecheck`, `test`, `check`.
- `tsconfig.json`: TypeScript config for the `noEmit` type-check (NodeNext, strict, `.ts` import extensions allowed). Not a build config.
- `run/inc/fn/`: Shared shell helpers (status printers, banners, extension install and list helpers).
- `run/inc/var/`: Shared shell variables (ANSI codes).
- `docs/`: Requirements and installation docs.
- `CONTRIBUTING.md`: How to develop, lint, test, and check extensions.
- `eslint.config.js`, `package.json`: Lint configuration and the `npm` script aliases.
- `.github/workflows/`: CI – `check` (lint and test), `validate-commit-messages`, and `sync-labels`.

## Tools

- `./run/install [name…]` to install extensions into `~/.pi/agent/extensions/` (no arguments installs all; `--list` and `--help` are also available).
- `./run/lint` and `./run/fix` to lint and auto-fix with ESLint.
- `./run/typecheck` to type-check with `tsc --noEmit` (extra args forwarded, eg. `--watch`).
- `./run/test` to run the test suite (extra arguments are forwarded to `node --test`, eg. `--watch`).
- `./run/check` to run the linter, then the type-check, then the tests – the command CI runs, and the one to run before committing.
- `shellcheck run/install run/lint run/fix run/test run/check run/inc/**/*.sh` to lint the shell scripts.

Each `run/` script is also exposed as an `npm run` alias (`lint`, `fix`, `typecheck`, `test`, `check`).

## Rules

The capitalized words REQUIRED, MUST, MUST NOT, RECOMMENDED, SHOULD, SHOULD NOT, OPTIONAL, and MAY, in the context of this document and agent skills/instructions/rules, are to be interpreted as described in [IETF RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

- MUST author each extension as a directory `src/extensions/<name>/` with an `index.ts` entry point that default-exports a factory function `(pi: ExtensionAPI) => void`.

- MUST import Pi's types from `@earendil-works/pi-coding-agent`, and import local helper modules with their explicit `.ts` extension – both Pi and Node's type stripping require it.

- MUST register a new extension in the `available_extensions` array in `run/install` and add a matching description arm to `list_available_extensions` in `run/inc/fn/extensions.sh`, or the installer will not offer it.

- MUST keep tests under `test/extensions/<name>/`, mirroring the `src/extensions/` layout, and never inside `src/`, because `run/install` copies each extension directory verbatim and would otherwise ship them.

- MUST keep non-extension infrastructure under `src/infrastructure/` and MUST NOT add it to the `available_extensions` array in `run/install`, nor repoint `src_dir` away from `src/extensions`. Infrastructure is not an installable Pi extension.

- MUST run `./run/check` and get a clean pass before committing. CI runs the same command on every push and pull request. `check` now includes `typecheck`, so the build must type-check as well as lint and test.

- SHOULD avoid `as never` / `as any` at the `registerTool` and event-handler seams. Where Pi's types expect a TypeBox `TSchema` but a plain JSON Schema is passed at runtime, an escape hatch is sometimes unavoidable; keep it to the single seam, comment why, and never use it to silence a genuine type error in the surrounding logic.

- MUST conform to the neostandard style enforced by ESLint. Run `./run/fix` rather than formatting by hand.

- MUST keep the `run/` shell scripts strict (`set -euo pipefail`) and passing ShellCheck.

- SHOULD keep pure, testable logic in helper modules (eg. `messages.ts`) so it can be unit-tested without faking the `ExtensionAPI`.

- SHOULD write documentation prose as one line per paragraph, with no hard wrapping, and let the editor soft-wrap.

## Skills

Skills that are specific to this project are installed in `./agents/skills/`. None are defined yet.
