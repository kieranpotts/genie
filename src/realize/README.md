# realize

A Pi extension that adds a `/realize` command. You point it at a specification, and the agent takes full responsibility for implementing it.

## What it does

`/realize <source>` hands a specification to the agent and instructs it to realize that specification end to end: understand it, resolve ambiguities, plan, implement (code, configuration, tests, and documentation), verify against the spec, and report back.

The single argument is the source of the specification, which can be any of:

- A local file, eg. `/realize ./docs/spec.md`.
- A local directory of artifacts, eg. `/realize ./docs/spec/`.
- A URL, eg. `/realize https://example.com/spec`.
- A GitHub issue or pull request, eg. `/realize https://github.com/owner/repo/issues/42`.

The extension does not read the source itself. It validates and classifies the source, then builds a prompt that points the agent at it — so the agent reads the file, lists the directory, or fetches the URL using its own tools, and is never limited by what would fit in a single message.

When the source is a GitHub issue or pull request and the [`gh`](https://cli.github.com) CLI is installed, the agent is directed to read it (including the discussion) with `gh issue view` or `gh pr view`. Without `gh`, a GitHub URL is fetched like any other web page.

## Configuration

None. There are no settings. Once installed, invoke it as `/realize <source>` in Pi.

## Installing

From this repository's root directory, run:

```sh
./run/install realize
```

See the [installation guide](../../docs/installation.md) for more details.
