# Plan

## Revisit: microVM isolation

`docs/solution.md` evaluates **Gondolin** (a local Linux micro-VM extension for
Pi) as the middle of three containerization patterns Pi's own docs describe,
and rejects it in favor of plain Docker plus a host-side model proxy — see
"Containerized Pi instance" in [docs/solution.md](./docs/solution.md#containerized-pi-instance).
The rejection reasoning is narrower than a full comparison: Gondolin only
routes built-in tool *execution* into the VM, while Pi's own process, config,
and credentials stay on the host, which is why it was judged a narrower
boundary than the Docker + proxy combination actually built.

Revisit this decision against:

- <https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/>

Worth checking when revisiting: whether Docker's own microVM sandbox
architecture (as opposed to Gondolin specifically) closes the credential-
isolation gap noted in `docs/solution.md`, and how it compares to the
gVisor/VM-based isolation noted as "not required for local dev" but worth
reconsidering "if running untrusted agent extensions or in a multi-user
environment."
