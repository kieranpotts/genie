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

# Whether `docker compose up` was reached. Read by cleanup so a failure during
# the preflight checks does not announce a teardown of something never started.
boundary_started=""

# check_dependencies - Verify the host tools the runbook requires are present.
#
# Checked before anything is started, so a missing tool is reported by name
# here rather than surfacing later as a backgrounded process that "exited
# before becoming healthy" with the real cause buried in a temp log.
#
check_dependencies() {
  local missing=0

  if ! command -v docker &> /dev/null; then
    print_error "docker is not installed or not on PATH."
    print_info "Install Docker: https://docs.docker.com/engine/install/"
    missing=1
  fi

  if ! command -v curl &> /dev/null; then
    print_error "curl is not installed or not on PATH."
    missing=1
  fi

  # NOTE: the proxy server is an EXTRA. A bare `pip install litellm` provides
  # the SDK but no `litellm` command, so the install hint must keep the
  # `[proxy]` extra.
  if ! command -v litellm &> /dev/null; then
    print_error "litellm is not installed or not on PATH."
    print_info "Install the LiteLLM proxy, eg: pipx install 'litellm[proxy]'"
    print_info "(or: python3 -m pip install --user 'litellm[proxy]')"
    missing=1
  fi

  if (( missing )); then
    exit 1
  fi

  print_success "Host dependencies found (docker, curl, litellm)."
}

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
  for var in LITELLM_HOST LITELLM_PORT LITELLM_MASTER_KEY PROJECT_PATH; do
    if [[ -z "${!var:-}" ]]; then
      print_error "${var} is not set in ${env_file}."
      exit 1
    fi
  done

  # Catch the common mistake of pasting the *instruction* rather than running
  # it: `.env` files are not shell-evaluated, so a literal `$(openssl ...)`
  # is used as-is rather than expanded.
  #
  # Matching the literal characters `$(`, not expanding them.
  # shellcheck disable=SC2016
  if [[ "${LITELLM_MASTER_KEY}" == '$('* ]]; then
    print_error "LITELLM_MASTER_KEY in ${env_file} looks like an unevaluated command substitution: ${LITELLM_MASTER_KEY}"
    print_info "Generate a real value, eg: sed -i \"s|^LITELLM_MASTER_KEY=.*|LITELLM_MASTER_KEY=\$(openssl rand -hex 32)|\" ${env_file}"
    exit 1
  fi

  print_success "Host env contract validated (${env_file})."
}

# check_ollama - Verify OLLAMA_HOST points at a daemon that has models.
#
# The proxy resolves `os.environ/OLLAMA_HOST` as the `api_base` for the Ollama
# routes, and it runs ON THE HOST -- so this should be loopback, not the bridge
# gateway. Nothing in a container talks to Ollama directly.
#
# The failure this catches: a SECOND `ollama serve` bound to the bridge gateway
# runs under a different home directory, so it has an empty model store and a
# freshly generated ~/.ollama/id_ed25519 that is not associated with any
# ollama.com account. Every `:cloud` model then fails with
# `{"error":"Unauthorized"}`, which reaches the operator as an opaque LiteLLM
# 500 mid-conversation rather than as a startup error. An empty model list is
# the cheap, reliable tell.
#
# Warns rather than exits: a purely cloud-routed config needs no local models.
#
check_ollama() {
  if [[ -z "${OLLAMA_HOST:-}" ]]; then
    print_warning "OLLAMA_HOST is not set in ${env_file}; the Ollama routes will not resolve."
    return 0
  fi

  # Tolerate a bare host:port -- `api_base` needs a scheme, but the variable is
  # also documented as an Ollama bind address, which has none.
  local base="${OLLAMA_HOST}"
  [[ "${base}" == http://* || "${base}" == https://* ]] || base="http://${base}"

  local tags
  if ! tags=$(curl -sf -m 5 "${base}/api/tags" 2>/dev/null); then
    print_warning "No Ollama daemon answered at ${base}. The Ollama routes will fail."
    print_info "The proxy runs on the host, so this is usually http://127.0.0.1:11434."
    return 0
  fi

  # Matching the empty-list shape, whitespace-insensitively.
  if [[ "${tags//[[:space:]]/}" == '{"models":[]}' ]]; then
    print_warning "The Ollama daemon at ${base} has NO models."
    print_info "This is the wrong daemon -- a second 'ollama serve' has its own empty"
    print_info "model store and an unregistered identity, so :cloud models return"
    print_info "Unauthorized. Point OLLAMA_HOST at the daemon holding your models"
    print_info "(usually http://127.0.0.1:11434) rather than at the bridge gateway."
    return 0
  fi

  print_success "Ollama reachable at ${base}."
}

# stop_stale_proxy - Stop any LiteLLM proxy already on the configured port.
#
# The proxy reads litellm.config.yaml ONCE and resolves every `os.environ/NAME`
# ONCE, both at startup. A proxy left over from an earlier run therefore keeps
# serving the OLD routes with the OLD environment, however much has changed on
# disk since. Reusing it -- which this function used to do -- silently discards
# every edit to `.env` and to the proxy config, and the failure surfaces much
# later as a confusing model error rather than as a config problem.
#
# So a running proxy is always REPLACED, never reused.
#
stop_stale_proxy() {
  if ! curl -sf "http://${LITELLM_HOST}:${LITELLM_PORT}/health/liveliness" &> /dev/null; then
    return 0
  fi

  print_info "A LiteLLM proxy is already running on ${LITELLM_HOST}:${LITELLM_PORT}."
  print_info "Restarting it so it picks up the current config and environment."

  # `ss` reports the PID only for processes owned by this user, which the proxy
  # is when started by this script. pgrep is the fallback for a proxy started
  # by hand (eg. the runbook's step 2).
  local pid
  pid=$(ss -lntpH "sport = :${LITELLM_PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
  if [[ -z "${pid}" ]]; then
    pid=$(pgrep -f "litellm .*--port ${LITELLM_PORT}" | head -1)
  fi

  if [[ -z "${pid}" ]]; then
    print_error "Could not identify the process listening on ${LITELLM_HOST}:${LITELLM_PORT}."
    print_info "It may belong to another user. Stop it, then re-run this script."
    exit 1
  fi

  kill "${pid}" 2>/dev/null || true

  # Wait for the port to actually free; binding while the old process still
  # holds it would fail in a much less obvious way.
  local waited=0
  local timeout=15
  while curl -sf "http://${LITELLM_HOST}:${LITELLM_PORT}/health/liveliness" &> /dev/null; do
    if (( waited >= timeout )); then
      print_warning "Proxy ${pid} did not stop within ${timeout}s; sending SIGKILL."
      kill -9 "${pid}" 2>/dev/null || true
      sleep 2
      break
    fi
    sleep 1
    (( waited += 1 ))
  done

  if curl -sf "http://${LITELLM_HOST}:${LITELLM_PORT}/health/liveliness" &> /dev/null; then
    print_error "Could not free ${LITELLM_HOST}:${LITELLM_PORT} (process ${pid} still listening)."
    exit 1
  fi

  print_success "Previous proxy (pid ${pid}) stopped."
}

# start_proxy - Start the LiteLLM proxy on the host, in the background.
#
# Always starts a FRESH process, so the run reflects the current
# litellm.config.yaml and `.env`. See stop_stale_proxy.
#
# Sets the module-level `proxy_pid`, used by cleanup to stop it on exit.
#
start_proxy() {
  stop_stale_proxy

  print_info "Starting LiteLLM proxy on ${LITELLM_HOST}:${LITELLM_PORT} (log: ${proxy_log})."
  litellm --config "${infra_dir}/proxy/litellm.config.yaml" \
          --host "${LITELLM_HOST}" --port "${LITELLM_PORT}" \
          > "${proxy_log}" 2>&1 &
  proxy_pid=$!

  local waited=0
  local timeout=30
  while ! curl -sf "http://${LITELLM_HOST}:${LITELLM_PORT}/health/liveliness" &> /dev/null; do
    if ! kill -0 "${proxy_pid}" 2>/dev/null; then
      print_error "LiteLLM proxy exited before becoming healthy."
      print_proxy_log
      exit 1
    fi
    if (( waited >= timeout )); then
      print_error "LiteLLM proxy did not become healthy within ${timeout}s."
      print_proxy_log
      exit 1
    fi
    sleep 1
    (( waited += 1 ))
  done

  print_success "LiteLLM proxy is up (pid ${proxy_pid})."
}

# print_proxy_log - Show the tail of the proxy log inline, on failure.
#
# The proxy runs backgrounded with its output redirected, so its own error --
# which is usually the whole story -- is invisible unless it is surfaced here.
# The full log path is still printed for the cases where the tail is not enough.
#
print_proxy_log() {
  if [[ -s "${proxy_log}" ]]; then
    print_info "Last lines of ${proxy_log}:"
    echo ""
    local line
    while IFS= read -r line; do
      printf '    %s\n' "${line}"
    done < <(tail -n 20 "${proxy_log}")
    echo ""
  else
    print_info "The proxy log (${proxy_log}) is empty."
  fi
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
# DETACHED, deliberately. An attached `up` multiplexes every container's output
# into one log stream and gives the operator no terminal on any of them -- so
# the shell inside the pi container would be running but unreachable. The
# container is entered separately, by `enter_container` below.
#
bring_up_boundary() {
  print_info "Bringing up the compose boundary (agent-net, mcp-gateway, pi)."
  boundary_started="yes"
  docker compose -f "${infra_dir}/compose.yaml" --env-file "${env_file}" up -d

  # `up -d` returns once the containers are created and started, which is not
  # the same as the gateway having finished listing its tools. Give the pi
  # container a moment to still be running -- if it exited immediately, the
  # shell below would fail with a much less obvious error.
  local waited=0
  local timeout=15
  while ! compose_service_running "pi"; do
    if (( waited >= timeout )); then
      print_error "The pi container is not running ${timeout}s after starting."
      print_info "Inspect it with: docker compose -f ${infra_dir}/compose.yaml logs pi"
      exit 1
    fi
    sleep 1
    (( waited += 1 ))
  done

  print_success "Boundary is up (mcp-gateway, pi)."
}

# compose_service_running - True if the named compose service has a running
# container.
#
# Arguments:
#   $1 - Compose service name.
#
compose_service_running() {
  local service="$1"
  local running

  running=$(docker compose -f "${infra_dir}/compose.yaml" --env-file "${env_file}" \
              ps --status running --services 2>/dev/null || true)

  grep -qx "${service}" <<< "${running}"
}

# enter_container - Enter the hardened container, where the harness auto-starts.
#
# This is the foreground step: it holds the script open for as long as the
# operator is working, and exiting falls through to cleanup, which tears the
# boundary down and stops the proxy this script started.
#
# The container's ~/.bashrc starts the hardened Pi harness on entry. `/quit`
# returns to the container's shell rather than ending the session, so leaving
# for good is a two-step exit: quit the agent, then exit the shell.
#
enter_container() {
  print_info "Entering the hardened container. /quit leaves the agent; exit the shell to tear everything down."
  echo ""

  # `exec` (not `attach`): attaching would share PID 1's terminal with the
  # detached shell rather than giving this operator their own.
  #
  # Failure here must not skip cleanup, and the operator's own exit code from
  # the shell is not the script's -- so swallow it and let the EXIT trap run.
  docker compose -f "${infra_dir}/compose.yaml" --env-file "${env_file}" \
    exec pi bash || true
}

# cleanup - Stop what this script started. Registered as an EXIT trap.
#
cleanup() {
  # Only tear down what was actually brought up. A failure during the preflight
  # checks used to announce a teardown of a boundary that was never started,
  # which reads as though the failure happened later than it did.
  if [[ -n "${boundary_started}" ]]; then
    print_info "Tearing down the compose boundary."
    docker compose -f "${infra_dir}/compose.yaml" --env-file "${env_file}" down 2>/dev/null || true
  fi

  if [[ -n "${proxy_pid}" ]] && kill -0 "${proxy_pid}" 2>/dev/null; then
    print_info "Stopping the LiteLLM proxy (pid ${proxy_pid})."
    kill "${proxy_pid}" 2>/dev/null || true
    wait "${proxy_pid}" 2>/dev/null || true
  fi
}
