#!/usr/bin/env bash

#
# Resolving `genie`'s arguments, and the two ways of reaching an agent inside
# the boundary: an interactive session, or one headless prompt.
#
# NEITHER PATH PASSES A SECURITY FLAG. The launch profile — `--model`,
# `--no-builtin-tools`, and the project-trust decision — lives in `start-pi`
# inside the hardened image, precisely so no caller can weaken it by replacing a
# command. This file chooses only WHICH ROLE to route to (an environment
# variable `start-pi` already reads) and WHAT TO SAY. If you ever find yourself
# adding a `pi` flag here, it belongs in `start-pi` instead.
#
# These read the globals defined in `bin/genie`:
#   infra_dir     - src/infrastructure, for models.json.
#   pi_model      - Resolved model route, eg. litellm/technical-lead.
#   prompt        - Resolved prompt text (headless mode only).
#   output_json   - Non-empty to ask Pi for JSON rather than text.
#

# Globals above are assigned in `bin/genie` and sourced before this file.
# shellcheck disable=SC2154

# model_roles - Print the role names the proxy exposes, one per line.
#
# Read out of the image's models.json rather than hard-coded here, because that
# file is what Pi actually reads to discover the routes: a role listed here but
# absent there could not be selected, and a role added there would be rejected
# by a hard-coded list for no reason. One source of truth, and it is the one the
# agent uses.
#
model_roles() {
  grep -oP '"id"\s*:\s*"\K[^"]+' "${infra_dir}/pi-container/models.json"
}

# resolve_model - Normalise and validate a requested role.
#
# Accepts either the bare role (`technical-lead`) or the fully qualified route
# (`litellm/technical-lead`), because both are names the operator sees — the
# bare form in the proxy config and in models.json, the qualified form in Pi's
# own `/model` command and in `PI_MODEL`. Prints the qualified form.
#
# FAILS CLOSED ON AN UNKNOWN ROLE, listing the valid ones. The alternative is
# passing it through for Pi to reject much later, after a bring-up, with a
# message about a provider rather than about a typo — and `PI_PROJECT_TRUST`
# already establishes that a typo in this harness should not be quietly
# tolerated.
#
# Arguments:
#   $1 - Requested role, bare or qualified.
#
resolve_model() {
  local requested="$1"
  local role="${requested#litellm/}"

  if [[ "${requested}" == */* && "${requested}" != litellm/* ]]; then
    print_error "Unsupported model provider: ${requested%%/*}"
    print_info "Genie routes every model through the host LiteLLM proxy, so the"
    print_info "provider is always \`litellm\`. Name a role instead:"
    _print_roles
    exit 1
  fi

  if ! model_roles | grep -qx "${role}"; then
    print_error "Unknown role: ${role}"
    print_info "The proxy exposes one route per role:"
    _print_roles
    exit 1
  fi

  printf 'litellm/%s\n' "${role}"
}

# _print_roles - List the valid roles as indented detail lines.
#
_print_roles() {
  local role
  while IFS= read -r role; do
    print_detail "${role}"
  done < <(model_roles)
}

# resolve_project - Resolve, validate, and print the project directory.
#
# Resolves symlinks as well as making the path absolute, because the result
# becomes a Docker bind `device` and the daemon resolves it on the host, not
# through this shell's view of it.
#
# TWO PATHS ARE REFUSED OUTRIGHT — `/` and the home directory. This volume
# becomes the entire world the agent can reach, and the whole architecture rests
# on that world being one project: an agent scoped to `$HOME` has the operator's
# SSH keys, browser profiles, and every other repository inside its boundary,
# with the MCP server's allowed-directory check satisfied by all of it. Both are
# far more likely to be a forgotten `cd` than an intention, and the cost of
# being wrong is the loss of the property this project exists to provide.
#
# Arguments:
#   $1 - Requested directory, or empty for the working directory.
#
resolve_project() {
  local requested="${1:-${PWD}}"
  local resolved

  if ! resolved=$(readlink -f "${requested}" 2>/dev/null) || [[ -z "${resolved}" ]]; then
    print_error "Cannot resolve project directory: ${requested}"
    exit 1
  fi

  if [[ ! -d "${resolved}" ]]; then
    print_error "Project directory does not exist: ${resolved}"
    exit 1
  fi

  if [[ "${resolved}" == "/" ]]; then
    print_error "Refusing to scope the agent to the filesystem root."
    print_info "The project directory becomes the only thing the agent can reach."
    print_info "Name a single project with --project, or run genie from inside one."
    exit 1
  fi

  if [[ "${resolved}" == "$(readlink -f "${HOME}")" ]]; then
    print_error "Refusing to scope the agent to your home directory: ${resolved}"
    print_info "That would put your keys, credentials, and every other repository"
    print_info "inside the agent's boundary. Name a single project instead."
    exit 1
  fi

  printf '%s\n' "${resolved}"
}

# resolve_prompt - Resolve the prompt from an argument or from stdin.
#
# Three accepted forms, because a CLI that can only take a quoted string is
# awkward to drive from another program:
#
#   literal text   used as-is
#   a file path    READ ON THE HOST, and its CONTENTS used
#   `-`            read from stdin
#
# A path is read here rather than handed to Pi as `@file`, which would be the
# obvious thing and would silently fail: Pi runs inside the container, whose
# only view of the host is the project at /workspace, so `@/home/you/prompt.md`
# resolves to nothing there. Reading it on the host makes any readable file
# usable as a prompt regardless of where it lives, and adds no mount.
#
# Arguments:
#   $1 - Requested prompt: text, a path, `-`, or empty to read stdin.
#
resolve_prompt() {
  local requested="${1:-}"
  local text

  if [[ "${requested}" == "-" || -z "${requested}" ]]; then
    if [[ -t 0 ]]; then
      print_error "No prompt given."
      print_info "Pass one with --prompt, pipe one in, or use --tui for a session."
      exit 1
    fi
    text=$(cat)
  elif [[ -f "${requested}" ]]; then
    if [[ ! -r "${requested}" ]]; then
      print_error "Prompt file is not readable: ${requested}"
      exit 1
    fi
    text=$(< "${requested}")
  else
    text="${requested}"
  fi

  # Whitespace-only counts as empty: it would reach the model as a turn with
  # nothing in it, and the answer to that is not worth a session.
  if [[ -z "${text//[[:space:]]/}" ]]; then
    print_error "The prompt is empty."
    exit 1
  fi

  printf '%s' "${text}"
}

# require_terminal - Refuse a TUI session when there is no terminal to draw on.
#
# CHECKED BEFORE ANYTHING IS STARTED, which is the whole point of it being a
# separate function. Left inside `enter_tui` it ran after the bring-up, so
# `genie --tui < /dev/null` built the image, re-pointed the project volume, and
# started the containers and the proxy before announcing that it could not open a
# session — doing all of the work and none of the job.
#
require_terminal() {
  if [[ ! -t 0 ]]; then
    print_error "--tui needs a terminal; stdin is not one."
    print_info "For a scripted run, use --prompt instead."
    exit 1
  fi
}

# enter_tui - Enter the hardened container, where the harness auto-starts.
#
# The container's ~/.bashrc starts the hardened Pi harness on entry. `/quit`
# returns to the container's shell rather than ending the session, so leaving
# the agent is not the same as leaving the boundary — and, now that the stack is
# persistent, leaving the boundary is not the same as tearing it down either.
# Hence the parting hint: nothing else would tell the operator that something is
# still running.
#
enter_tui() {
  print_info "Entering the hardened container. /quit leaves the agent; exit the shell to leave the container."
  print_blank

  # `exec` (not `attach`): attaching would share PID 1's terminal with the
  # detached `sleep` rather than giving this operator their own.
  #
  # The operator's own exit code from the shell is not this command's, so it is
  # swallowed: quitting an agent is not a failure.
  compose exec -e PI_MODEL="${pi_model}" pi bash || true

  print_blank
  print_info "Left the container. The boundary is still up — \`genie --down\` stops it."
}

# run_headless - Send one prompt to an agent and let its response reach stdout.
#
# THE CONTRACT THIS UPHOLDS: stdout carries the model's answer and nothing else,
# stderr carries everything else, and the exit code is Pi's. That is what makes
# `genie` usable from another program, and it is why every status helper in this
# project writes to stderr.
#
# Flags worth their explanation:
#   -T           No pseudo-tty. With one, compose puts the terminal in raw mode
#                and Pi renders for a terminal, so captured output arrives full
#                of control sequences and \r line endings. This is a one-way
#                stream, not a session.
#   < /dev/null  Any stdin this command had has ALREADY been consumed by
#                resolve_prompt. Leaving it connected would hand a half-read
#                pipe to the container for no reason.
#   -p           Pi's non-interactive mode: process the prompt, print, exit.
#
run_headless() {
  local pi_args=(-p)
  if [[ -n "${output_json}" ]]; then
    pi_args+=(--mode json)
  fi
  pi_args+=("${prompt}")

  compose exec -T -e PI_MODEL="${pi_model}" pi start-pi "${pi_args[@]}" < /dev/null
}
