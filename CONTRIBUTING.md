# Contributing

> [!NOTE]
> External contributions to this project are not accepted – this is a personal
> project. These contributing guidelines are for the benefit of the author.

This page covers working on the extensions and infrastructure themselves. To
just build and run the hardened harness, see the Requirements and Usage
sections of the [README](./README.md) instead.

The [Pi extension docs](https://pi.dev/docs/latest/extensions) are the primary
reference for writing extensions — the `ExtensionAPI`, lifecycle events, custom
tools, commands, and UI. The notes below cover the conventions specific to this
repository.

## Prerequisites

Development needs [Node.js][node] (with `npm`) for the linting toolchain, in
addition to the runtime requirements in the [README](./README.md). Install the
dev dependencies once, from the repository root:

```sh
npm install
```

[node]: https://nodejs.org

## Project layout

Each extension lives in its own directory under `src/extensions/`, with an
`index.ts` entry point:

```text
src/
└── extensions/
    └── <name>/
        └── index.ts
```

Everything else under `src/` is **not** an extension — `src/infrastructure/`
holds the container, compose, proxy, and MCP wiring.

Extensions are never copied into a host Pi install. A new extension is picked up
only by being explicitly `COPY`'d into the hardened image. Add a line to
[`src/infrastructure/pi-container/Dockerfile`](./src/infrastructure/pi-container/Dockerfile)
to ship it. To develop or test an extension against a local, unhardened Pi
install first, copy it manually — see [Usage](./README.md#-usage) in the
README.

`run/install` installs the **host** tooling, not extensions, so an extension
needs no registration with it.

## Host tooling

The `genie` CLI lives in `bin/genie`, with its implementation in `lib/fn/`:

```text
bin/genie           argument parsing, then dispatch
lib/fn/statuses.sh  status printers — all output goes to STDERR
lib/fn/paths.sh     XDG locations, and finding the config file
lib/fn/boundary.sh  bring the boundary up, reuse it, tear it down
lib/fn/agent.sh     resolve arguments; the TUI and headless run modes
lib/fn/logs.sh      tail the audit trail
lib/fn/install.sh   install the payload
```

`run/startup` and `run/log` are thin wrappers around `bin/genie`, so there is one
implementation of the bring-up and the dev loop cannot drift from the installed
tool.

Three constraints are easy to break and worth stating:

- **Stdout belongs to the agent.** `genie` without `--tui` prints the model's
  response on stdout and nothing else, so every message goes through the
  `lib/fn/statuses.sh` helpers, which write to stderr. A bare `echo` anywhere on
  that path corrupts the output of every scripted caller.

- **Security flags belong in the image.** `start-pi` inside the container owns
  `--no-builtin-tools`, `--model`, and the project-trust decision, precisely so
  no host-side caller can drop one. `genie` passes a role and a prompt; if you
  find yourself adding a `pi` flag on the host, it belongs in `start-pi` instead.

- **What the installer ships is an allowlist.** `payload_paths` in
  `lib/fn/install.sh` is what gets installed. A runtime file outside it works
  from a checkout and is missing once installed.

Install from a checkout with `./run/install --link`, which symlinks the payload
to the working tree so edits take effect on the next run without re-installing.

The shell scripts are linted with [ShellCheck][shellcheck], which `./run/check`
does not cover — so run it by hand before committing:

```sh
shellcheck bin/genie run/install run/startup run/log run/lint run/fix \
           run/test run/check run/typecheck lib/**/*.sh
```

## Linting

Extensions are linted with [ESLint][eslint] using the [neostandard][neostandard]
config in [`eslint.config.js`](./eslint.config.js). Two scripts wrap it:

```sh
./run/lint   # Report problems.
./run/fix    # Auto-fix what can be fixed, then report the rest.
```

Both forward any extra arguments to ESLint, eg. `./run/lint --quiet`). The
commands can also be executed as `npm run lint` and `npm run fix`.

[eslint]: https://eslint.org
[neostandard]: https://github.com/neostandard/neostandard

## Testing

Tests use the [Node.js built-in test runner][node-test] (`node:test` and
`node:assert`) and run TypeScript directly through Node's native type stripping,
so there is no test framework to install and no build step. Node 22.18 or newer
is required.

Test files live under `test/`, mirroring the `src/` layout, and are named
`*.test.ts`. Keeping them out of `src/` means the Dockerfile's `COPY` lines
never ship them into the image.

```sh
./run/test            # Run all tests once.
./run/test --watch    # Re-run on change.
```

Extra arguments are forwarded to `node --test`, and the command is also exposed
as `npm test`.

[node-test]: https://nodejs.org/api/test.html

## Running all checks

`./run/check` runs the linter and then the tests in sequence, stopping at the
first failure. It is the single command to run before committing:

```sh
./run/check
```

It is also exposed as `npm run check`.

The [`Check`](./.github/workflows/check.yaml) GitHub Actions workflow runs this
same command on every push and pull request, so changes are linted and tested
automatically.

## Commit messages

Commit messages are validated by a [pre-commit][pre-commit] hook and again in CI.

```sh
# Run once globally:
pipx install pre-commit

# Run once in the root of this repository:
pre-commit install
```

[pre-commit]: https://pre-commit.com
[shellcheck]: https://www.shellcheck.net

## Versioning

The extensions and infrastructure are not versioned. There are no release
tags, version numbers, or changelog — the latest commit on the default branch
is the only supported state, which is why `genie --version` reports the payload
path and the pinned Pi version rather than a version of its own.

To pick up changes:

- **Extensions or the Dockerfile** — `genie --rebuild`, which rebuilds the image
  and recreates the containers even when the boundary is already up. A plain
  `genie --up` reuses a running boundary and would not see the edit.
- **The host tooling** — `./run/install` again, or install once with
  `./run/install --link` and skip this step entirely.
