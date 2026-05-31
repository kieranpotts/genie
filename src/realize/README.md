# realize

A Pi extension that adds a `/realize` command. You point it at a specification, and the agent takes full responsibility for implementing it.

## What it does

`/realize <source>` hands a specification to the agent and instructs it to take full ownership of realizing it end to end. Rather than improvising, the agent is directed to work through the source using a set of software-development workflow skills, in lifecycle order: `specify`, `design`, `elaborate`, `plan`, `code`, `test`, and `review`. "Done" means every acceptance criterion is satisfied and verified with evidence.

The single argument is the source of the specification, which can be any of:

- A local file, eg. `/realize ./docs/spec.md`.
- A local directory of artifacts, eg. `/realize ./docs/spec/`.
- A URL, eg. `/realize https://example.com/spec`.
- A GitHub issue or pull request, eg. `/realize https://github.com/owner/repo/issues/42`.
- A GitHub file, eg. `/realize https://github.com/owner/repo/blob/main/spec.md`.

The extension does not read the source itself. It validates and classifies the source, then builds a prompt that points the agent at it — so the agent reads the file, lists the directory, or fetches the URL using its own tools, and is never limited by what would fit in a single message.

When the source is a GitHub issue or pull request and the [`gh`](https://cli.github.com) CLI is installed, the agent is directed to read it (including the discussion) with `gh issue view` or `gh pr view`. A GitHub file (`/blob/`) URL is rewritten to its `raw.githubusercontent.com` form so the agent fetches the plain file. Any other URL — including a GitHub discussion, wiki, or repository root — is fetched like an ordinary web page.

## Requirements

This extension expects the [workflow skills][skills] it delegates to (`specify`, `design`, `elaborate`, `plan`, `code`, `test`, `review`) to be installed in Pi. See the [requirements guide](../../docs/requirements.md#per-extension-requirements). Without them the command still works, but the agent runs each phase unaided.

## Configuration

None. There are no settings. Once installed, invoke it as `/realize <source>` in Pi.

[skills]: https://github.com/kieranpotts/skills

## Installing

From this repository's root directory, run:

```sh
./run/install realize
```

See the [installation guide](../../docs/installation.md) for more details.
