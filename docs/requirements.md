# Requirements

The core requirement, of course, is the [Pi coding agent][pi] installed and on your `PATH`:

```sh
npm install -g @earendil-works/pi-coding-agent
```

The installer warns if `pi` is not found, but still stages the extensions so they are ready once Pi is installed.

The `./run/install` script requires Bash. If you don't have this, no worries, you'll just have to copy the extensions into `~/.pi/agent/extensions/` yourself. See the [Pi docs][pi-docs].

## Per-extension requirements

Some extensions expect more than Pi itself:

- [`realize`](../src/realize/README.md) delegates to a set of software-development [workflow skills][skills] — `specify`, `design`, `elaborate`, `plan`, `code`, `test`, and `review`. Install them into Pi's skills directory (`~/.pi/agent/skills/`) so the agent can invoke each phase. Without them, `realize` still runs, but the agent performs each phase unaided rather than following the skills – output will be less predictable.

[pi]: https://pi.dev
[pi-docs]: https://pi.dev/docs/latest/extensions#extension-locations
[skills]: https://github.com/kieranpotts/skills
