#!/usr/bin/env bash

#
# Launch Pi with this project's security profile applied.
#
# Installed to /usr/local/bin/start-pi. This is the supported way to start the
# agent inside the hardened container, and it exists so the security-critical
# flags cannot be lost the way they were when compose overrode the image's
# entrypoint args.
#
# Two flags are non-negotiable for the security profile:
#
#   --model            Pi has no default route to the host proxy. Without an
#                      explicit model it falls back to its built-in provider
#                      (google), finds no key, and reports "No models
#                      available". The route names come from models.json.
#
#   --no-builtin-tools THIS IS THE CONTROL, not a tidying-up flag. Pi's built-in
#                      read, grep, find, edit, and write operate directly on
#                      THIS container's filesystem — which mounts the project
#                      read-only at /workspace for the operator. Without
#                      this flag the agent can read every project file locally,
#                      bypassing the MCP server that is supposed to be its only
#                      route to them, with none of that server's mediation or
#                      logging. permission-gate would not catch it either: it
#                      gates writes and execution, and lets reads pass silently.
#
#                      Do not remove this on the grounds that "there is no
#                      audited-tools extension to shadow built-ins any more".
#                      That extension's removal is exactly why this flag is now
#                      the whole of the agent's local-tool posture. See TODO.md.
#
# Any additional arguments are passed through to Pi.
#

set -euo pipefail

# Model route. Each proxy route is a ROLE (computer-programmer, technical-lead,
# technical-writer, security-analyst) backed by a capability-tuned Ollama model
# — see proxy/litellm.config.yaml. `computer-programmer` is the default because
# this is a coding agent; switch roles at runtime with Pi's /model command, or
# per-container by overriding PI_MODEL, without rebuilding the image.
model="${PI_MODEL:-litellm/computer-programmer}"

# Pi's agent directory is a tmpfs (it must be writable — see seed-agent-dir),
# so it starts every container empty and has to be populated from the image
# template before Pi looks for its extensions and models.json. Idempotent, and
# done here as well as in ~/.bashrc so that `compose exec pi start-pi` works
# without an interactive shell having run first.
seed-agent-dir

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: start-pi [pi-arguments...]"
  echo ""
  echo "Start the Pi coding agent with this container's security profile:"
  printf '  %-26s (override with the PI_MODEL environment variable)\n' "--model ${model}"
  printf '  %-26s (the mcp_* tools are the only file tools)\n' "--no-builtin-tools"
  echo ""
  echo "Extra arguments are passed through to Pi. To start Pi without the"
  echo "security profile — for debugging the harness itself — run \`pi\` directly."
  exit 0
fi

exec pi --model "${model}" --no-builtin-tools "$@"
