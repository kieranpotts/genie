# foreach

A Pi extension that adds a `/foreach` command: apply one instruction — or an installed skill — to each item of a list, one isolated subagent per item.

## What it does

```text
/foreach <instruction | /skill-name> <list-file>
```

The list file path is always the last whitespace-separated token; everything before it is the instruction, so a freeform instruction may contain spaces without needing to be quoted.

- **Freeform instruction.** `/foreach Summarize this changelog entry in one sentence ./entries.txt` — each item is appended beneath the instruction as what to apply it to.
- **Skill reference.** `/foreach /review ./prs.txt` — a leading `/` names an installed workflow skill (`~/.pi/agent/skills/<name>`), loaded with `--skill`; each item is handed to it as-is, since the skill already carries its own instructions.

The list file is plain text, one item per line. Blank lines and `#`-comment lines are skipped, so a list can be annotated:

```text
# PRs to review this week
owner/repo#101
owner/repo#104
# still waiting on CI
owner/repo#109
```

Each item runs in its own fresh, ephemeral `pi -p` subagent — no memory of any other item, no shared session. **This is a map over the list, not a pipeline**: unlike `realize`'s phases, items do not hand off to one another, and one item's outcome never affects another's. Every item runs regardless of prior failures. Progress is shown in the status line as each item runs; when the run finishes, a pass/fail tally is reported. Each item's output, plus a `summary.md`, are written under `.pi/foreach/<run-id>/`.

## Configuration

None. Once installed, invoke it as `/foreach <instruction | /skill-name> <list-file>` in Pi.

## Design notes

- **Pure, tested core.** Argument splitting (`args.ts`), list parsing (`list.ts`), instruction classification and per-item task building (`instruction.ts`), the `pi` argv translation (`runner-pi.ts`'s `buildPiArgs`), the loop itself (`loop.ts`), and the summary format (`summary.ts`) are all pure and unit-tested. `index.ts` is thin glue to the `ExtensionAPI`, the filesystem, and the process spawner.
- **No restricted tool set per item.** Unlike a `realize` phase, an item is a general-purpose instruction, not a specialized lifecycle role, so no tool allowlist is imposed — each subagent keeps `pi`'s default tools.
- **Continue on failure.** A failed item (non-zero exit, timeout, or spawn fault) does not stop the loop; it is recorded and the next item still runs. There is no gate or rework loop — that is `realize`'s job, for a different kind of workflow.

## Relationship to `realize`

Both spawn isolated `pi -p` subagents and write artifacts to `.pi/<name>/<run-id>/`, but they solve different problems: `realize` drives a fixed sequence of *dependent* lifecycle phases toward one verified change; `foreach` applies one *independent* instruction across many items, sequentially, with no phase depending on another's output.

## Files

- `index.ts` — registers the `/foreach` command: parses args, reads and parses the list, runs the loop, reports the outcome.
- `args.ts` — pure: splits the raw argument string into an instruction and a list file path.
- `list.ts` — pure: parses list file contents into items.
- `instruction.ts` — pure: classifies the instruction (freeform vs. `/skill-name`) and builds each item's task text.
- `runner.ts` — the `ItemRunner` port: how a single item is run, in semantic terms.
- `runner-pi.ts` — `PiCliRunner`, the port's `pi -p` implementation. The only module that spawns a process.
- `workspace.ts` — the `Workspace` port and its filesystem implementation: artifact storage and run-id generation.
- `loop.ts` — the deterministic orchestrator: iterates items, runs each in isolation, and tallies the outcome.
- `summary.ts` — pure: formats the final pass/fail summary.

## Installing

From this repository's root directory, run:

```sh
./run/install foreach
```

See the [installation guide](../../docs/installation.md) for more details.
