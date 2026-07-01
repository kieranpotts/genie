# Requirements

The core requirement, of course, is the [Pi coding agent][pi] installed and on your `PATH`:

```sh
npm install -g @earendil-works/pi-coding-agent
```

The installer warns if `pi` is not found, but still stages the extensions so they are ready once Pi is installed.

The `./run/install` script requires Bash. If you don't have this, no worries, you'll just have to copy the extensions into `~/.pi/agent/extensions/` yourself. See the [Pi docs][pi-docs].

## Per-extension requirements

None of the current extensions require more than Pi itself. [`foreach`](../src/extensions/foreach/README.md) can optionally invoke an installed [workflow skill][skills] (`~/.pi/agent/skills/`) when its instruction argument is a `/skill-name` reference, but this is optional — a freeform instruction requires nothing further.

[pi]: https://pi.dev
[pi-docs]: https://pi.dev/docs/latest/extensions#extension-locations
[skills]: https://github.com/kieranpotts/skills
