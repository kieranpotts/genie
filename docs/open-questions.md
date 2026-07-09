# Open questions

- **MCP server: custom vs. Docker MCP Toolkit?** Deferred to a prototype of
  each. Custom gives version-controlled, reviewable policy (better fit for the
  security objective); Toolkit is faster to stand up.

- **Include `run_command` (exec into devcontainers) from day one,** or ship
  file-only mediation first and add execution later? Affects whether any
  `docker.sock`-equivalent privilege re-enters the design.

- **MCP client extension for Pi** — build in-house, or is there existing prior
  art to adopt? Scope and timeline unknown until investigated.

- **Egress filtering** — recommended for sensitive projects; currently out of
  scope for the baseline. Decide whether to make it part of the standard
  build.

- **Interactive permission prompting** is still immature across the ecosystem
  (most setups are fully open or fully closed). The permission-gate extension
  is our stopgap; staging-filesystem (copy-on-write review) approaches are
  emerging but not yet mainstream — worth tracking.
