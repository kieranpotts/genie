# The problem

[Pi][pi] is a minimal coding agent harness. Really, it's more of a baseline
framework on which you program your own custom harness, rather than a finished
product.

Out-of-the-box, Pi runs with full system permissions with zero security
controls. This is a deliberate design choice, not a bug. But running such
an agent directly on your host machine carries non-trivial risks, since doing
so exposes:

- Your host dotfiles – `~/.ssh/*`, `~/.config/*`, `~/.gitconfig` – and the
  security credentials they contain.
- Cloud API keys held in the host environment.
- Everything on disk, not only your programming projects.
- The host network and process space.

The risk is not hypothetical. An AI agent executes model-directed tool calls –
file reads/writes, shell commands, etc. – any of which can be influenced by
malicious prompt injection. And the agent harness and its third-party extensions
can itself be compromised via conventional security vulnerabilities.

Furthermore, due to the non-determinism of large language models, new
vulnerabilities can surface at any time, without a software update. Models are
inherently untrustworthy, no matter how many guardrails they have been taught
in their training cycles.

Therefore, to create secure and reliable agents, we must thoughtfully engineer
isolated environments in which the underlying models run.

The most important design constraint is **filesystem isolation**. We want an
architecture will keep a misbehaving model or a compromised model isolated
from files outside of the project scope, and isolated from the cloud credentials
and other secrets required by the agent.

In addition, every action the agent takes against the host filesystem should
be fully observable and leave a detailed audit trail.

[pi]: https://pi.dev/
