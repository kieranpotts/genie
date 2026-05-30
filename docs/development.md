# Development

This page covers working on the extensions themselves. To just install and use them, see [Requirements](./requirements.md) and [Installation](./installation.md) instead.

## Prerequisites

Development needs [Node.js][node] (with `npm`) for the linting toolchain, in addition to the [runtime requirements](./requirements.md). Install the dev dependencies once, from the repository root:

```sh
npm install
```

[node]: https://nodejs.org

## Project layout

Each extension lives in its own directory under `ext/`, with an `index.ts` entry point:

```text
ext/
└── <name>/
    └── index.ts
```

See the section on adding a new extension in the [installation instructions](./installation.md) for details on how to register a new extension with the installer.

## Linting

Extensions are linted with [ESLint][eslint] using the [neostandard][neostandard] config in [`eslint.config.js`](../eslint.config.js). Two scripts wrap it:

```sh
./run/lint   # Report problems.
./run/fix    # Auto-fix what can be fixed, then report the rest.
```

Both forward any extra arguments to ESLint, eg. `./run/lint --quiet`). The commands can also be executed as `npm run lint` and `npm run fix`.

[eslint]: https://eslint.org
[neostandard]: https://github.com/neostandard/neostandard

## Commit messages

Commit messages are validated by a [pre-commit][pre-commit] hook and again in CI.

```sh
# Run once globally:
pipx install pre-commit

# Run once in the root of this repository:
pre-commit install
```

[pre-commit]: https://pre-commit.com
