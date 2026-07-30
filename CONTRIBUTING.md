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

There is no installer: extensions are not copied into a host Pi install.
A new extension is picked up only by being explicitly `COPY`'d into the
hardened image. Add a line to
[`src/infrastructure/pi-container/Dockerfile`](./src/infrastructure/pi-container/Dockerfile)
to ship it. To develop or test an extension against a local, unhardened Pi
install first, copy it manually — see [Usage](./README.md#-usage) in the
README.

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

## Versioning

The extensions and infrastructure are not versioned. There are no release
tags, version numbers, or changelog — the latest commit on the default branch
is the only supported state. Rebuild the image with `./run/startup` to pick
up changes.
