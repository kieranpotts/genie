#!/usr/bin/env bash

#
# Helpers for bringing up the security hardening infrastructure: the host
# LiteLLM proxy, the hardened agent image, and the docker compose boundary.
#
# Automates steps 2-4 of the operator runbook in
# `src/infrastructure/README.md`. Step 1 (populating `.env`) is deliberately
# left manual — it requires the operator's own cloud API keys and generated
# secrets — but is validated here before anything is started.
#
# These read the globals defined in `run/startup`:
#   infra_dir     - src/infrastructure, where .env/compose.yaml/proxy live.
#   env_file      - Absolute path to src/infrastructure/.env.
#   proxy_log     - Where the backgrounded LiteLLM proxy's output is captured.
#

# Globals above are assigned in `run/startup` and sourced before this file.
# shellcheck disable=SC2154

# PID of the backgrounded LiteLLM proxy, set by start_proxy. Read by cleanup.
proxy_pid=""

# check_env - Verify `.env` exists and required values have been filled in.
#
# Fails fast with a pointer to the manual step 1 in the runbook, rather than
# letting the proxy or compose fail later with a less obvious error.
#
check_env() {
  if [[ ! -f "${env_file}" ]]; then
    print_error "Missing ${env_file}."
    print_info "Run step 1 of the runbook first: cp ${infra_dir}/.env.example ${env_file}, then fill it in."
    exit 1
  fi

  set -a
  # shellcheck source=/dev/null
  . "${env_file}"
  set +a

  local var
  for var in LITELLM_HOST LITELLM_PORT LITELLM_MASTER_KEY MCP_GATEWAY_AUTH_TOKEN PROJECT_PATH; do
    if [[ -z "${!var:-}" ]]; then
      print_error "${var} is not set in ${env_file}."
      exit 1
    fi
  done

  # Catch the common mistake of pasting the *instruction* rather than running
  # it: `.env` files are not shell-evaluated, so a literal `$(openssl ...)`
  # is used as-is rather than expanded.
  for var in LITELLM_MASTER_KEY MCP_GATEWAY_AUTH_TOKEN; do
    # Matching the literal characters `$(`, not expanding them.
    # shellcheck disable=SC2016
    if [[ "${!var}" == '$('* ]]; then
      print_error "${var} in ${env_file} looks like an unevaluated command substitution: ${!var}"
      print_info "Generate a real value, eg: sed -i \"s|^${var}=.*|${var}=\$(openssl rand -hex 32)|\" ${env_file}"
      exit 1
    fi
  done

  print_success "Host env contract validated (${env_file})."
}

# start_proxy - Start the LiteLLM proxy on the host, in the background.
#
# Sets the module-level `proxy_pid`, used by cleanup to stop it on exit.
#
start_proxy() {
  if curl -sf "http://${LITELLM_HOST}:${LITELLM_PORT}/health/liveliness" &> /dev/null; then
    print_info "LiteLLM proxy already running on ${LITELLM_HOST}:${LITELLM_PORT}. Reusing it."
    return 0
  fi

  print_info "Starting LiteLLM proxy on ${LITELLM_HOST}:${LITELLM_PORT} (log: ${proxy_log})."
  litellm --config "${infra_dir}/proxy/litellm.config.yaml" \
          --host "${LITELLM_HOST}" --port "${LITELLM_PORT}" \
          > "${proxy_log}" 2>&1 &
  proxy_pid=$!

  local waited=0
  local timeout=30
  while ! curl -sf "http://${LITELLM_HOST}:${LITELLM_PORT}/health/liveliness" &> /dev/null; do
    if ! kill -0 "${proxy_pid}" 2>/dev/null; then
      print_error "LiteLLM proxy exited before becoming healthy. See ${proxy_log}."
      exit 1
    fi
    if (( waited >= timeout )); then
      print_error "LiteLLM proxy did not become healthy within ${timeout}s. See ${proxy_log}."
      exit 1
    fi
    sleep 1
    (( waited += 1 ))
  done

  print_success "LiteLLM proxy is up (pid ${proxy_pid})."
}

# build_image - Build the hardened agent image.
#
build_image() {
  print_info "Building the hardened agent image (pi-agent:hardened)."
  docker build -f "${infra_dir}/pi-container/Dockerfile" -t pi-agent:hardened "${repo_root}"
  print_success "Image built: pi-agent:hardened."
}

# bring_up_boundary - Bring up the docker compose boundary.
#
# Runs in the foreground so the operator sees container output; Ctrl-C
# triggers cleanup (see `run/startup`), which tears compose back down and
# stops the proxy this script started.
#
bring_up_boundary() {
  print_info "Bringing up the compose boundary (agent-net, mcp-gateway, pi)."
  docker compose -f "${infra_dir}/compose.yaml" --env-file "${env_file}" up
}

# cleanup - Stop what this script started. Registered as an EXIT trap.
#
cleanup() {
  print_info "Tearing down the compose boundary."
  docker compose -f "${infra_dir}/compose.yaml" --env-file "${env_file}" down 2>/dev/null || true

  if [[ -n "${proxy_pid}" ]] && kill -0 "${proxy_pid}" 2>/dev/null; then
    print_info "Stopping the LiteLLM proxy (pid ${proxy_pid})."
    kill "${proxy_pid}" 2>/dev/null || true
    wait "${proxy_pid}" 2>/dev/null || true
  fi
}
