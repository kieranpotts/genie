# Contributing

> [!NOTE]
> Pull requests are turned off on this repository, and external contributions are not accepted. These notes are kept for the author's own benefit — and for AI agents let loose in this repo — not to solicit contributions. You are welcome to fork and adapt the project for your own use.

This page covers working on the extensions themselves. To just install and use them, see [Requirements](./docs/requirements.md) and [Installation](./docs/installation.md) instead.

The [Pi extension docs](https://pi.dev/docs/latest/extensions) are the primary reference for writing extensions — the `ExtensionAPI`, lifecycle events, custom tools, commands, and UI. The notes below cover the conventions specific to this repository.

## Prerequisites

Development needs [Node.js][node] (with `npm`) for the linting toolchain, in addition to the [runtime requirements](./docs/requirements.md). Install the dev dependencies once, from the repository root:

```sh
npm install
```

[node]: https://nodejs.org

## Project layout

Each extension lives in its own directory under `src/`, with an `index.ts` entry point:

```text
src/
└── <name>/
    └── index.ts
```

See the section on adding a new extension in the [installation instructions](./docs/installation.md) for details on how to register a new extension with the installer.

## Linting

Extensions are linted with [ESLint][eslint] using the [neostandard][neostandard] config in [`eslint.config.js`](./eslint.config.js). Two scripts wrap it:

```sh
./run/lint   # Report problems.
./run/fix    # Auto-fix what can be fixed, then report the rest.
```

Both forward any extra arguments to ESLint, eg. `./run/lint --quiet`). The commands can also be executed as `npm run lint` and `npm run fix`.

[eslint]: https://eslint.org
[neostandard]: https://github.com/neostandard/neostandard

## Testing

Tests use the [Node.js built-in test runner][node-test] (`node:test` and `node:assert`) and run TypeScript directly through Node's native type stripping, so there is no test framework to install and no build step. Node 22.18 or newer is required.

Test files live under `test/`, mirroring the `src/` layout, and are named `*.test.ts`. Keeping them out of `src/` means the installer never ships them with an extension.

```sh
./run/test            # Run all tests once.
./run/test --watch    # Re-run on change.
```

Extra arguments are forwarded to `node --test`, and the command is also exposed as `npm test`.

[node-test]: https://nodejs.org/api/test.html

## Running all checks

`./run/check` runs the linter and then the tests in sequence, stopping at the first failure. It is the single command to run before committing:

```sh
./run/check
```

It is also exposed as `npm run check`.

The [`Check`](./.github/workflows/check.yaml) GitHub Actions workflow runs this same command on every push and pull request, so changes are linted and tested automatically.

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

The extensions are not versioned. There are no release tags, version numbers, or changelog — the latest commit on the default branch is the only supported state. Reinstall with `./run/install` to pick up changes.
