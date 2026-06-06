# Pi [![CI check pipeline status](https://github.com/kieranpotts/pi/actions/workflows/check.yaml/badge.svg)](https://github.com/kieranpotts/pi/actions/workflows/check.yaml)

**🚧 Under construction.** **My AI agent harness infrastructure, built around the Pi coding agent.**

Pi is a minimal coding agent — really a baseline framework on which you build your own agent harness rather than a finished product. Out-of-the-box it runs with full system permissions and zero security controls. This repository is my answer to that: a personal agent harness built as a set of TypeScript extensions for Pi plus the surrounding infrastructure – a hardened container, a path-and-operation-gated MCP server, audit logging, and a host-side model proxy.

The goal is safe and predictable agentic workflows. It is safe because the agent never touches the host filesystem directly, access is mediated and logged through scoped allowlists, and credentials stay out of the agent's reach. This security profile is suitable for the regulated industries I work in, and portable across the development environments I move between as a software contractor.

It is predictable because reliable agentic workflows — ones that produce artifacts of consistently high quality — are not coaxed out of a model through carefully worded prompts, which remains fragile and non-deterministic. They are engineered into the harness itself, by encoding structured lifecycle tasks as explicit phases, each phase constraining what the agent can do and see at every step.

The key design goal is to make outcomes primarily a property of the deterministic engineering around the agent, rather than of any single prompt or the capabilities of any particular language model.

> [!WARNING]
> These artifacts are built for my personal use and they are volatile — they may change, break, or be removed at any time. They carry no support or stability guarantees. You are, however, welcome to fork this repository and use it as a basis for engineering your own agent harness.

## 📓 Documentation

- [**Requirements**](./docs/requirements.md)
- [**Installation**](./docs/installation.md)
- [**Contributing**](./CONTRIBUTING.md)
- [**Acknowledgements**](./docs/acknowledgements.md)

-----

Copyright © 2020-present Kieran Potts, [MIT license](./LICENSE.txt)
