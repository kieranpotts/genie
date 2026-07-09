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

The risk is not hypothetical. The agent executes model-directed tool calls –
file reads/writes, shell commands, etc. – and third-party extensions, any of
which can be influenced by prompt injection.

Furthermore, due to the non-determinism of large language models, new
vulnerabilities can surface at any time, without a model update. The inherent
risks in the use of models cannot be fully negated through guardrails taught
to the model through its training cycle.

To use models safely, and to create secure and reliable agents, we must
thoughtfully engineer isolated environments in which the models run.

The most important design constraint in a secure model harness is
**filesystem isolation**. We want an architecture that means that a compromised
agent or a misbehaving model cannot access files outside of the project scope,
nor host files, nor cloud credentials or other secrets, and not even host
Docker control. Every action the agent takes against the host filesystem should
be fully observable and auditable.

[pi]: https://pi.dev/
