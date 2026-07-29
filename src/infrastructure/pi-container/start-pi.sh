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
#   --no-builtin-tools Without it, the audited-tools extension only shadows
#                      read/write/ls/bash BY NAME; Pi's built-in edit, grep,
#                      and find stay live and unguarded. See
#                      src/extensions/audited-tools/README.md.
#
# Any additional arguments are passed through to Pi.
#

set -euo pipefail

# Model route. Overridable from compose via PI_MODEL so the route can be
# switched without rebuilding the image; `capable` falls back to `fast` at the
# proxy when the cloud model is unreachable (see proxy/litellm.config.yaml).
model="${PI_MODEL:-litellm/capable}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: start-pi [pi-arguments...]"
  echo ""
  echo "Start the Pi coding agent with this container's security profile:"
  printf '  %-26s (override with the PI_MODEL environment variable)\n' "--model ${model}"
  printf '  %-26s (audited replacements are the only file tools)\n' "--no-builtin-tools"
  echo ""
  echo "Extra arguments are passed through to Pi. To start Pi without the"
  echo "security profile — for debugging the harness itself — run \`pi\` directly."
  exit 0
fi

exec pi --model "${model}" --no-builtin-tools "$@"
