# pickling-penguins

A Pi extension that replaces the default "Working..." status with a stream of randomly-composed nonsense, like "Pickling penguins...", so waiting for the agent is a little more entertaining!

## What it does

While the agent is working, the status line shows a message built on-the-fly by pairing a random present participle with a random noun, generating nonsense like "Flambéing the singularity..." or "Schlepping doppelgängers...".

With over 100 participles and over 100 nouns, that is over 10,000 possible combinations, so you will rarely see the same one twice.

The message is chosen when the agent starts and may be swapped out once or twice while it runs. When the agent finishes, the default status is restored.

## Configuration

None. There are no settings, no commands, and nothing to invoke. Once installed, the extension just does its thing. Give Pi a prompt and watch the status line.

## Installing

From this repository's root directory, run:

```sh
./run/install pickling-penguins
```

See the [installation guide](../../docs/installation.md) for more details.
