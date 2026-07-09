# Hardening

My agent harness architecture hardens the security profile through the
following configuration.

## Pi-specific hardening

- Start Pi with `--no-builtin-tools`, using audited tools via an extension
  instead.

- Permission-gate extension. Explicit confirmation for writes and execution,
  with timeout defaulting to "deny". Every decision logged to an append-only
  audit file outside the container.

- A `before_provider_request` handler logging every outbound model call.

- `sessionDir` set outside the project tree. Session JSONL contains the
  full conversation, including file content the agent read.

- `PI_OFFLINE=1` disables telemetry/version-check calls, so all model
  traffic goes through the known proxy endpoint only.

- Third-party extensions treated as untrusted. No third-party packages without
  code review, all pinned to exact versions/commit hashes.

## Agent containerization

- `workspaceMount`/volumes scoped to the project only — never `~` or a parent.

- No mount of host dotfiles (`~/.ssh`, `~/.config`, `~/.gitconfig`).

- Non-root user inside the container.

- `--cap-drop ALL`, restoring only necessary capabilities.

- `--security-opt no-new-privileges:true`.

- Resource limits: `--memory`, `--cpus`, `--pids-limit`.

- Local model servers bound to the Docker bridge gateway IP only, reachable
  via `host-gateway`, never `0.0.0.0`.
