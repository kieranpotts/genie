# Requirements

The only requirement, of course, is the [Pi coding agent][pi] installed and on your `PATH`:

```sh
npm install -g @earendil-works/pi-coding-agent
```

The installer warns if `pi` is not found, but still stages the extensions so they are ready once Pi is installed.

The `./run/install` script requires Bash. If you don't have this, no worries, you'll just have to copy the extensions into `~/.pi/agent/extensions/` yourself. See the [Pi docs][pi-docs].

[pi]: https://pi.dev
[pi-docs]: https://pi.dev/docs/latest/extensions#extension-locations
