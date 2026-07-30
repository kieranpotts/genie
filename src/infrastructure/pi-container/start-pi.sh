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
#                      route to them, with none of that server's mediation.
#                      secret-sentry's hooks fire for any tool call, built-in
#                      included, so its sensitive-file refusal and logging
#                      would still apply — but the MCP server's containment
#                      would not: a built-in call never reaches the gateway, so
#                      the agent could read or write anywhere in THIS
#                      container's filesystem, not just /workspace.
#
#                      Do not remove this on the grounds that "there is no
#                      audited-tools extension to shadow built-ins any more".
#                      That extension's removal is exactly why this flag is now
#                      the whole of the agent's local-tool posture. See TODO.md.
#
#   --no-approve       Project trust, decided up front instead of by a prompt.
#                      Pi asks "Trust project folder?" whenever the working tree
#                      holds trust-requiring resources — `.agents/skills` in cwd
#                      or ANY ancestor, or `.pi/{settings.json,extensions,skills,
#                      prompts,themes,SYSTEM.md,APPEND_SYSTEM.md}`. That prompt
#                      blocks a non-interactive run, and because the agent
#                      directory is a tmpfs (see seed-agent-dir), the answer is
#                      not remembered — so it would block EVERY run.
#
#                      Trust is not cosmetic: it lets Pi load project settings,
#                      install missing project packages, and EXECUTE project
#                      extensions inside Pi's own process, where they could
#                      shadow or interfere with secret-sentry. Default-deny
#                      is therefore the harness's posture, and it matches what
#                      Pi does headlessly anyway (no UI ⇒ not trusted).
#
#                      Set PI_PROJECT_TRUST=approve to opt in per container.
#                      Both flags short-circuit ahead of the trust store, so
#                      either way the decision is deterministic and silent.
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

# Project trust. Deny by default; `approve` is the only value that grants it,
# so a typo fails closed rather than silently trusting the project.
trust="${PI_PROJECT_TRUST:-deny}"
case "${trust}" in
  approve) trust_flag="--approve"    ;;
  deny)    trust_flag="--no-approve" ;;
  *)
    printf 'start-pi: PI_PROJECT_TRUST must be "approve" or "deny", got "%s".\n' "${trust}" >&2
    exit 1
    ;;
esac

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: start-pi [pi-arguments...]"
  echo ""
  echo "Start the Pi coding agent with this container's security profile:"
  printf '  %-26s (override with the PI_MODEL environment variable)\n' "--model ${model}"
  printf '  %-26s (the mcp_* tools are the only file tools)\n' "--no-builtin-tools"
  printf '  %-26s (override with PI_PROJECT_TRUST=approve)\n' "${trust_flag}"
  echo ""
  echo "Extra arguments are passed through to Pi. An interactive shell aliases"
  echo "\`pi\` to this script; to start Pi WITHOUT the security profile — for"
  echo "debugging the harness itself — bypass the alias with \`\\pi\`."
  exit 0
fi

# Pi's agent directory is a tmpfs (it must be writable — see seed-agent-dir),
# so it starts every container empty and has to be populated from the image
# template before Pi looks for its extensions and models.json. Idempotent, and
# done here as well as in ~/.bashrc so that `compose exec pi start-pi` works
# without an interactive shell having run first.
seed-agent-dir

exec pi --model "${model}" --no-builtin-tools "${trust_flag}" "$@"
