# Pi

## Project overview

Personal and experimental extensions for the [Pi coding agent](https://pi.dev) (`@earendil-works/pi-coding-agent`). Each extension is a TypeScript module that hooks into Pi's lifecycle events or registers tools, commands, or UI.

Extensions live under `ext/<name>/` and are installed into Pi's extensions directory (`~/.pi/agent/extensions/`) by `run/install`, which copies each extension directory verbatim. Pi runs the TypeScript directly – there is no build step.

The repository currently ships one extension, `pickling-gnomes`, which replaces the default "Working…" status with randomly composed nonsense.

## Tech stack

- TypeScript, run directly by Pi and by Node's native type stripping – no compile or bundling step.
- Node.js 22.18+ (development uses Node 24) for the tooling and the built-in test runner.
- ESLint with [neostandard](https://github.com/neostandard/neostandard)style, ie. single quotes and no semicolons.
- The Node.js built-in test runner (`node:test`, `node:assert`).
- Bash for the `run/` scripts, with ShellCheck for static analysis.
- pre-commit for commit-message validation, and GitHub Actions for CI.

## Repository structure

- `ext/<name>/index.ts`: An extension's entry point, with a default-exported factory `(pi: ExtensionAPI) => void`. Helper modules (eg. `messages.ts`) sit alongside it and are imported with explicit `.ts` extensions.
- `test/`: Tests for the Node test runner, mirroring the `ext/` layout (`*.test.ts`). Kept out of `ext/` so the installer never ships them.
- `run/`: Dev scripts – `install`, `lint`, `fix`, `test`, `check`.
- `run/inc/fn/`: Shared shell helpers (status printers, banners, extension install and list helpers).
- `run/inc/var/`: Shared shell variables (ANSI codes).
- `docs/`: Requirements, installation, and development docs.
- `eslint.config.js`, `package.json`: Lint configuration and the `npm` script aliases.
- `.github/workflows/`: CI – `check` (lint and test), `validate-commit-messages`, and `sync-labels`.

## Tools

- `./run/install [name…]` to install extensions into `~/.pi/agent/extensions/` (no arguments installs all; `--list` and `--help` are also available).
- `./run/lint` and `./run/fix` to lint and auto-fix with ESLint.
- `./run/test` to run the test suite (extra arguments are forwarded to `node --test`, eg. `--watch`).
- `./run/check` to run the linter and then the tests – the command CI runs, and the one to run before committing.
- `shellcheck run/install run/lint run/fix run/test run/check run/inc/**/*.sh` to lint the shell scripts.

Each `run/` script is also exposed as an `npm run` alias (`lint`, `fix`, `test`, `check`).

## Rules

The capitalized words REQUIRED, MUST, MUST NOT, RECOMMENDED, SHOULD, SHOULD NOT, OPTIONAL, and MAY, in the context of this document and agent skills/instructions/rules, are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

- MUST author each extension as a directory `ext/<name>/` with an `index.ts` entry point that default-exports a factory function `(pi: ExtensionAPI) => void`.

- MUST import Pi's types from `@earendil-works/pi-coding-agent`, and import local helper modules with their explicit `.ts` extension – both Pi and Node's type stripping require it.

- MUST register a new extension in the `available_extensions` array in `run/install` and add a matching description arm to `list_available_extensions` in `run/inc/fn/extensions.sh`, or the installer will not offer it.

- MUST keep tests under `test/`, never inside `ext/`, because `run/install` copies each extension directory verbatim and would otherwise ship them.

- MUST run `./run/check` and get a clean pass before committing. CI runs the same command on every push and pull request.

- MUST conform to the neostandard style enforced by ESLint. Run `./run/fix` rather than formatting by hand.

- MUST keep the `run/` shell scripts strict (`set -euo pipefail`) and passing ShellCheck.

- SHOULD keep pure, testable logic in helper modules (eg. `messages.ts`) so it can be unit-tested without faking the `ExtensionAPI`.

- SHOULD write documentation prose as one line per paragraph, with no hard wrapping, and let the editor soft-wrap.

- SHOULD add an "[Unreleased]" entry to `CHANGELOG.md` when adding, removing, or materially changing an extension.

## Skills

Skills that are specific to this project are installed in `./agents/skills/`. None are defined yet.
