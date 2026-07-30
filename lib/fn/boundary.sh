#!/usr/bin/env bash

#
# Bring up, reuse, inspect, and tear down the security hardening boundary: the
# host LiteLLM proxy, the hardened agent image, and the docker compose stack.
#
# Automates steps 2-5 of the operator runbook in
# `src/infrastructure/README.md`. Step 1 (populating the config file) is
# deliberately left manual — it requires the operator's own cloud API keys and
# generated secrets — but is validated here before anything is started.
#
# THE STACK IS PERSISTENT, which is the difference between this and the
# bring-up-then-always-tear-down script it replaces. `genie` is a programmatic
# interface: a caller sending three prompts in a row must not pay three image
# builds, three compose bring-ups, and three proxy starts. So every step below
# is idempotent and reuses what is already healthy, and teardown is an explicit
# `genie --down` rather than an exit trap.
#
# The cost of that is real and is not hidden: a proxy holding every cloud API
# key stays running between invocations. It is unchanged in WHERE it listens —
# `agent-net`'s gateway address, never 0.0.0.0 — so the exposure is
# longer-lived, not wider, and `genie --status` reports it so a stack left up is
# a visible thing rather than a forgotten one.
#
# These read the globals defined in `bin/genie`:
#   payload_root    - Root holding lib/ and src/; also the docker build context.
#   infra_dir       - src/infrastructure, where compose.yaml and proxy/ live.
#   env_file        - Absolute path to the config file (cloud keys).
#   state_dir       - Where the proxy pid, log, and fingerprint are recorded.
#   compose_project - Compose project name; namespaces this stack's volumes.
#   project_path    - Absolute host path of the project to expose to the agent.
#   force_rebuild   - Non-empty to rebuild and recreate even when already up.
#

# Globals above are assigned in `bin/genie` and sourced before this file.
# shellcheck disable=SC2154

#
# State file paths, all under ${state_dir}. These are what make the proxy
# reusable ACROSS invocations: a variable holding a pid dies with the process
# that set it, so the pid has to be written down.
#

# proxy_pid_file - Pid of the proxy THIS tool started. Its presence is how a
# proxy we own is told apart from one started by hand or by another user, which
# is a distinction reuse depends on (see ensure_proxy).
proxy_pid_file() { printf '%s/proxy.pid\n' "${state_dir}"; }

# proxy_log_file - Where the detached proxy's output is captured. A fixed path
# rather than a mktemp, so `genie --status` can point at the log of the proxy
# that is running right now.
proxy_log_file() { printf '%s/proxy.log\n' "${state_dir}"; }

# proxy_fingerprint_file - Hash of the config the running proxy was started
# with. See proxy_fingerprint.
proxy_fingerprint_file() { printf '%s/proxy.fingerprint\n' "${state_dir}"; }

# compose - Run docker compose against this stack's file and config.
#
# Every compose invocation in this file goes through here so the `-f` and
# `--env-file` pair cannot drift between them, and so PROJECT_PATH is exported
# in exactly one place.
#
# PROJECT_PATH is exported rather than written into the config file because it
# is a per-invocation argument (`genie --project`), not an operator secret.
# Compose resolves interpolation from the shell environment IN PREFERENCE TO
# `--env-file`, so this overrides any stale PROJECT_PATH still sitting in the
# config — verified against the installed compose, not assumed.
#
# Arguments:
#   $@ - Arguments to docker compose.
#
compose() {
  PROJECT_PATH="${project_path}" \
    docker compose -f "${infra_dir}/compose.yaml" --env-file "${env_file}" "$@"
}

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
}

# read_config - Export the config file's values, if the file exists.
#
# SEPARATE FROM VALIDATION, and the split earns its keep on exactly one path:
# `genie --status` must work against a config that is missing OR incomplete,
# because a fresh install creates one from the example and reporting what is set
# up is the first thing anyone does next. Validating there would refuse to answer
# the question at the moment it is most worth asking.
#
# Returns non-zero when there is no file, so a caller can tell "nothing
# configured" from "configured".
#
read_config() {
  [[ -f "${env_file}" ]] || return 1

  set -a
  # shellcheck source=/dev/null
  . "${env_file}"
  set +a
}

# load_config - Read the config file and verify the required values are set.
#
# Fails fast with a pointer to the manual step 1 in the runbook, rather than
# letting the proxy or compose fail later with a less obvious error. Called by
# everything that is about to actually start or stop something.
#
# PROJECT_PATH IS NOT REQUIRED HERE, which is a change from when this file was
# reached only by `run/startup`. It is now a CLI argument defaulting to the
# working directory, so a config file that never mentions it is correct and
# complete; `bin/genie` uses any value it does find only as a fallback default.
#
load_config() {
  if ! read_config; then
    print_error "Missing config file: ${env_file}"
    print_info "Create it from the example and fill it in:"
    print_detail "cp ${payload_root}/src/infrastructure/.env.example ${env_file}"
    print_info "It holds your cloud API keys, so keep it mode 0600."
    exit 1
  fi

  local var
  for var in LITELLM_HOST LITELLM_PORT LITELLM_MASTER_KEY; do
    if [[ -z "${!var:-}" ]]; then
      print_error "${var} is not set in ${env_file}."
      exit 1
    fi
  done

  # Catch the common mistake of pasting the *instruction* rather than running
  # it: config files are not shell-evaluated, so a literal `$(openssl ...)`
  # is used as-is rather than expanded.
  #
  # Matching the literal characters `$(`, not expanding them.
  # shellcheck disable=SC2016
  if [[ "${LITELLM_MASTER_KEY}" == '$('* ]]; then
    print_error "LITELLM_MASTER_KEY in ${env_file} looks like an unevaluated command substitution: ${LITELLM_MASTER_KEY}"
    print_info "Generate a real value, eg: sed -i \"s|^LITELLM_MASTER_KEY=.*|LITELLM_MASTER_KEY=\$(openssl rand -hex 32)|\" ${env_file}"
    exit 1
  fi
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
# Called only when a proxy is about to be STARTED. On the reuse path there is no
# new proxy to misconfigure, and this costs a network round trip on a code path
# that has to stay fast.
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
}

# print_tail - Show the last lines of a file, indented, on stderr.
#
# Output redirected to a log is invisible unless it is surfaced on failure, and
# that output is usually the whole story. The full path is still printed for the
# cases where the tail is not enough.
#
# Arguments:
#   $1 - Path to the file.
#   $2 - How many lines to show.
#
print_tail() {
  local file="$1"
  local lines="$2"

  if [[ ! -s "${file}" ]]; then
    print_info "${file} is empty."
    return 0
  fi

  print_info "Last ${lines} lines of ${file}:"
  print_blank
  local line
  while IFS= read -r line; do
    print_detail "${line}"
  done < <(tail -n "${lines}" "${file}")
  print_blank
}

# build_image - Build the hardened agent image.
#
# Called whenever the boundary is about to be brought up, so an edit to an
# extension or to the Dockerfile is picked up without anyone having to remember
# to ask for it. Docker's layer cache makes the no-change case cheap, and
# compose recreates the pi container by itself when the image id has moved.
#
# The build context is the payload root, which is what requires the payload to
# carry `src/extensions/` as well as `src/infrastructure/` — the Dockerfile's
# COPY lines reach into both.
#
build_image() {
  print_info "Building the hardened agent image (pi-agent:hardened)."

  # Quiet on success, full output on failure. A build log is the right thing to
  # see when a build breaks and pure noise in front of every prompt otherwise —
  # and this runs on every bring-up, so the default has to be quiet.
  local log="${state_dir}/build.log"
  if ! docker build -f "${infra_dir}/pi-container/Dockerfile" \
                    -t pi-agent:hardened "${payload_root}" \
                    > "${log}" 2>&1; then
    print_error "Building pi-agent:hardened failed."
    print_tail "${log}" 30
    exit 1
  fi
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

  running=$(compose ps --status running --services 2>/dev/null || true)

  grep -qx "${service}" <<< "${running}"
}

# boundary_running - True if the agent container is up.
#
# `pi` is the service to test rather than `mcp-gateway`, because it is the one
# every command here has to exec into.
#
boundary_running() {
  compose_service_running "pi"
}

# project_volume - Print the name of this stack's `project` volume, if it exists.
#
# Looked up by its compose LABELS rather than by assuming Docker's
# `<project>_<key>` naming, so the only coupling is the project name itself.
#
project_volume() {
  docker volume ls --quiet \
    --filter "label=com.docker.compose.project=${compose_project}" \
    --filter "label=com.docker.compose.volume=project" 2>/dev/null | head -1
}

# current_project - Print the host directory the `project` volume points at.
#
# This is the AUTHORITATIVE answer to "which project is the stack scoped to".
# It is read from Docker rather than from a state file we wrote, because the
# volume is what the agent actually reaches through, and a state file could
# disagree with it after any manual `docker` command.
#
# Prints nothing when there is no volume yet.
#
current_project() {
  local volume
  volume=$(project_volume)
  [[ -n "${volume}" ]] || return 0

  # `<no value>` when a volume has no Options, which is why the result is
  # filtered rather than trusted.
  local device
  device=$(docker volume inspect --format '{{ index .Options "device" }}' \
             "${volume}" 2>/dev/null || true)
  [[ "${device}" == "<no value>" ]] && return 0

  printf '%s\n' "${device}"
}

# ensure_project_volume - Point the `project` volume at ${project_path}.
#
# ONLY ACTS WHEN THE TARGET HAS CHANGED, which is the change from recreating it
# unconditionally on every run. Unconditional recreation was right for a script
# that tore the whole stack down at exit anyway; here it would destroy a
# healthy, reusable boundary before every prompt and make persistence
# pointless.
#
# WHY RECREATING IS SAFE WHEN IT IS NEEDED: the volume is a bind POINTER, not
# storage. compose.yaml declares it `type: none, o: bind, device:
# ${PROJECT_PATH}`, so Docker records a host path and mounts it; the bytes live
# on the host and are never copied in. Destroying and recreating the volume
# therefore loses nothing, which is also why compose's "data will be lost"
# prompt is a false alarm for THIS volume specifically.
#
# WHY IT IS NEEDED AT ALL: change the project and the existing volume keeps its
# old `device`. Compose notices the mismatch and stops to ask an interactive
# `Recreate (data will be lost)? (y/N)` — which HANGS a non-interactive run,
# because at that point nothing is feeding its stdin. Doing it here makes
# `--project` the single source of truth for which project the stack is scoped
# to.
#
# ONLY the `project` volume is touched. `pi-logs` (audit trails) and
# `pi-sessions` (transcripts) hold real data with no host-side copy, so the
# teardown here is a bare `down` and MUST NEVER become `down -v`: `-v` takes
# all three, and the audit trail is the one thing this architecture exists to
# produce.
#
ensure_project_volume() {
  local volume old_device
  old_device=$(current_project)

  if [[ "${old_device}" == "${project_path}" ]]; then
    return 0
  fi

  volume=$(project_volume)

  if [[ -z "${volume}" ]]; then
    print_info "No project volume yet; compose will create it from ${project_path}."
    return 0
  fi

  print_info "Re-pointing the project volume: ${old_device:-unset} -> ${project_path}"

  # A volume still attached to a container cannot be removed, so the boundary
  # has to come down first. This is the one path on which switching projects
  # costs a full restart, and it is unavoidable: a bind mount is established
  # when the container is created.
  compose down --remove-orphans &> /dev/null || true

  if ! docker volume rm "${volume}" &> /dev/null; then
    print_error "Could not remove the ${volume} volume; a container still holds it."
    # The likely culprit is NOT a compose service. The mcp-gateway spawns the
    # filesystem-server container itself, through the Docker socket, so that
    # container carries no compose labels and the `down` above does not touch
    # it. A gateway that was killed rather than stopped leaves it behind,
    # holding this volume.
    print_info "The mcp-gateway spawns its filesystem server outside compose, so"
    print_info "a leftover from a killed gateway is not removed by \`compose down\`."
    print_info "Find and remove it, then try again:"
    print_detail "docker ps -a --filter volume=${volume}"
    print_detail "docker rm -f \$(docker ps -aq --filter volume=${volume})"
    exit 1
  fi
}

# ensure_boundary - Bring the docker compose boundary up, if it is not already.
#
# DETACHED, deliberately. An attached `up` multiplexes every container's output
# into one log stream and gives the operator no terminal on any of them -- so
# the shell inside the pi container would be running but unreachable. The
# container is entered separately, by enter_tui or run_headless.
#
# `--rebuild` (${force_rebuild}) forces this to run even when the boundary is
# already up. That is what makes an extension edit reachable without a
# `--down`/`--up` cycle: the image is rebuilt, and `compose up -d` recreates any
# container whose image id has moved, so the new extensions are in the agent.
#
ensure_boundary() {
  if boundary_running && [[ -z "${force_rebuild}" ]]; then
    return 0
  fi

  build_image

  print_info "Bringing up the compose boundary (agent-net, mcp-gateway, pi)."
  if ! compose up -d; then
    print_error "Could not bring up the compose boundary."
    exit 1
  fi

  # `up -d` returns once the containers are created and started, which is not
  # the same as the gateway having finished listing its tools. Confirm the pi
  # container is still running -- if it exited immediately, the exec that
  # follows would fail with a much less obvious error.
  local waited=0
  local timeout=15
  while ! boundary_running; do
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

# proxy_healthy - True if something answers the proxy's liveness endpoint.
#
# Safe to call before the config has been loaded, which `print_status` does:
# without an address there is nothing to ask, and "not healthy" is the honest
# answer rather than an unbound-variable crash.
#
# THE TIMEOUTS ARE NOT OPTIONAL. LITELLM_HOST is `agent-net`'s gateway, an
# address that DOES NOT EXIST on the host until compose creates the network — so
# the ordinary case of "nothing is up yet" is not a refused connection but an
# unroutable one, and curl's default is to keep trying for about two minutes.
# Without a bound here, `genie --status` on a stopped stack took that long, and
# every invocation's reuse check would pay it. Measured, not theorised.
#
# 2s to connect is generous for a host-local interface, and 5s total covers a
# proxy that is up but busy.
#
proxy_healthy() {
  [[ -n "${LITELLM_HOST:-}" && -n "${LITELLM_PORT:-}" ]] || return 1

  curl -sf --connect-timeout 2 -m 5 \
    "http://${LITELLM_HOST}:${LITELLM_PORT}/health/liveliness" &> /dev/null
}

# listening_pid - Print the pid listening on the proxy's port, if discoverable.
#
# `ss` reports the pid only for processes owned by this user, which the proxy is
# when started by this tool. pgrep is the fallback for a proxy started by hand
# (eg. the runbook's step 5).
#
listening_pid() {
  local pid
  pid=$(ss -lntpH "sport = :${LITELLM_PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
  if [[ -z "${pid}" ]]; then
    pid=$(pgrep -f "litellm .*--port ${LITELLM_PORT}" | head -1)
  fi
  printf '%s\n' "${pid}"
}

# proxy_fingerprint - Hash the config the proxy resolves at startup.
#
# THIS IS WHAT MAKES REUSE SAFE. The proxy reads litellm.config.yaml ONCE and
# resolves every `os.environ/NAME` ONCE, both at startup. A proxy left over from
# an earlier run therefore keeps serving the OLD routes with the OLD
# environment, however much has changed on disk since — so reusing one blindly
# silently discards every edit to the config file and to the proxy config, and
# the failure surfaces much later as a confusing model error rather than as a
# config problem.
#
# Hashing both inputs turns "has anything the proxy baked in changed?" into a
# comparison. Unchanged means reuse is indistinguishable from a restart;
# changed means replace. The invariant is the same one the old
# always-replace behaviour enforced — it is now measured instead of assumed.
#
proxy_fingerprint() {
  cat "${infra_dir}/proxy/litellm.config.yaml" "${env_file}" 2>/dev/null \
    | sha256sum | cut -d' ' -f1
}

# proxy_is_ours - True if the pid we recorded is still alive.
#
# Distinguishes a proxy this tool started from one started by hand or by another
# user. Only our own is a candidate for reuse: for anything else we know neither
# what config it holds nor whether we may signal it.
#
proxy_is_ours() {
  local pid_file
  pid_file=$(proxy_pid_file)
  [[ -f "${pid_file}" ]] || return 1

  local pid
  pid=$(< "${pid_file}")
  [[ -n "${pid}" ]] || return 1

  kill -0 "${pid}" 2>/dev/null
}

# stop_stale_proxy - Stop whatever proxy is on the configured port.
#
# Used when a running proxy cannot be reused: it is not ours, or its config has
# moved under it. Binding while the old process still holds the port would fail
# in a much less obvious way, so this waits for the port to actually free.
#
stop_stale_proxy() {
  local pid
  pid=$(listening_pid)

  if [[ -z "${pid}" ]]; then
    print_error "Could not identify the process listening on ${LITELLM_HOST}:${LITELLM_PORT}."
    print_info "It may belong to another user. Stop it, then try again."
    exit 1
  fi

  kill "${pid}" 2>/dev/null || true

  local waited=0
  local timeout=15
  while proxy_healthy; do
    if (( waited >= timeout )); then
      print_warning "Proxy ${pid} did not stop within ${timeout}s; sending SIGKILL."
      kill -9 "${pid}" 2>/dev/null || true
      sleep 2
      break
    fi
    sleep 1
    (( waited += 1 ))
  done

  if proxy_healthy; then
    print_error "Could not free ${LITELLM_HOST}:${LITELLM_PORT} (process ${pid} still listening)."
    exit 1
  fi

  print_success "Previous proxy (pid ${pid}) stopped."
}

# start_proxy - Start the LiteLLM proxy on the host, detached.
#
# DETACHED FROM THIS PROCESS, which is what lets the stack outlive the command
# that created it:
#
#   setsid       puts the proxy in its own session, so a Ctrl-C at the terminal
#                running `genie` signals only `genie`. Without it the proxy
#                shares this process group and dies with any interrupted prompt
#                — which would silently undo the persistence this file exists
#                to provide.
#   < /dev/null  it must never contend for the caller's stdin, which in headless
#                use may be a pipe carrying a prompt.
#
# The pid is resolved from the LISTENING SOCKET rather than from `$!`, which is
# the pid of whatever `setsid` decided to become and is not reliably the proxy.
# The socket is authoritative about what is actually serving the port, and it is
# the same lookup stop_stale_proxy uses.
#
# The address is agent-net's gateway rather than docker0's because the network
# is `internal: true`: the container has no route off its own subnet, so
# docker0's 172.17.0.1 is unreachable from it. Binding wider (0.0.0.0) would
# work but would expose a key-holding proxy on every host interface.
#
# Arguments:
#   $1 - Config fingerprint to record for the started proxy.
#
start_proxy() {
  local fingerprint="$1"
  local log
  log=$(proxy_log_file)

  print_info "Starting LiteLLM proxy on ${LITELLM_HOST}:${LITELLM_PORT} (log: ${log})."

  setsid litellm --config "${infra_dir}/proxy/litellm.config.yaml" \
                 --host "${LITELLM_HOST}" --port "${LITELLM_PORT}" \
                 > "${log}" 2>&1 < /dev/null &
  local spawned=$!

  # 60s, not the 30s this waited when it ran in the foreground of an
  # interactive script. A cold LiteLLM start imports a lot of Python, and a
  # timeout that fires early leaves a proxy coming up behind a command that has
  # already reported failure — the worst of both.
  local waited=0
  local timeout=60
  while ! proxy_healthy; do
    # A dead child is only conclusive while it IS still our child; once setsid
    # has re-parented the proxy, `kill -0` on the spawned pid says nothing
    # about the proxy. So this is treated as a hint that warrants one more
    # health check, and the timeout below is the real backstop.
    if ! kill -0 "${spawned}" 2>/dev/null; then
      sleep 1
      if ! proxy_healthy; then
        print_error "LiteLLM proxy exited before becoming healthy."
        print_tail "${log}" 20
        exit 1
      fi
    fi
    if (( waited >= timeout )); then
      print_error "LiteLLM proxy did not become healthy within ${timeout}s."
      print_tail "${log}" 20
      exit 1
    fi
    sleep 1
    (( waited += 1 ))
  done

  local pid
  pid=$(listening_pid)
  printf '%s\n' "${pid}" > "$(proxy_pid_file)"
  printf '%s\n' "${fingerprint}" > "$(proxy_fingerprint_file)"

  print_success "LiteLLM proxy is up (pid ${pid:-unknown})."
}

# ensure_proxy - Make a proxy serving the CURRENT config available.
#
# MUST RUN AFTER ensure_boundary. `LITELLM_HOST` is the gateway address of
# `agent-net` (see the pinned subnet in compose.yaml), and compose only creates
# that host interface when it creates the network. Called earlier, `litellm
# --host` fails with "Cannot assign requested address" and the proxy never
# starts.
#
# It reads as backwards -- the model proxy starting after the thing that calls
# it -- so: nothing between the two needs a model. The pi container's PID 1 is
# `sleep infinity`, so no agent exists until enter_tui or run_headless, which
# run last.
#
# REUSE REQUIRES ALL THREE of: the endpoint answers, the pid is one we recorded
# and is still alive, and the config fingerprint is unchanged. Any one failing
# means replace. See proxy_fingerprint for why the third is not optional.
#
ensure_proxy() {
  local want
  want=$(proxy_fingerprint)

  if proxy_healthy; then
    if ! proxy_is_ours; then
      print_info "A LiteLLM proxy is running on ${LITELLM_HOST}:${LITELLM_PORT} that this tool did not start."
      print_info "Replacing it: its config and environment are unknown."
      stop_stale_proxy
    elif [[ "$(cat "$(proxy_fingerprint_file)" 2>/dev/null)" != "${want}" ]]; then
      print_info "The proxy config has changed since the running proxy started."
      print_info "Replacing it so the new routes and environment take effect."
      stop_stale_proxy
    else
      # The reuse path, and the reason repeat invocations are fast.
      return 0
    fi
  fi

  check_ollama
  start_proxy "${want}"
}

# stop_proxy - Stop the proxy this tool started and clear its state.
#
# Silent when there is nothing running, so `genie --down` is safe to repeat.
#
stop_proxy() {
  if proxy_is_ours; then
    local pid
    pid=$(< "$(proxy_pid_file)")
    print_info "Stopping the LiteLLM proxy (pid ${pid})."
    kill "${pid}" 2>/dev/null || true

    local waited=0
    while (( waited < 10 )) && kill -0 "${pid}" 2>/dev/null; do
      sleep 1
      (( waited += 1 ))
    done
    if kill -0 "${pid}" 2>/dev/null; then
      kill -9 "${pid}" 2>/dev/null || true
    fi
  elif proxy_healthy; then
    # Deliberately left alone. We did not start it, so we do not know what else
    # depends on it, and killing another user's process is not ours to do.
    print_warning "A LiteLLM proxy on ${LITELLM_HOST}:${LITELLM_PORT} was not started by genie; leaving it running."
  fi

  rm -f "$(proxy_pid_file)" "$(proxy_fingerprint_file)"
}

# ensure_up - Bring the whole boundary to a usable state, reusing what is there.
#
# ORDER IS LOAD-BEARING: the boundary must come up BEFORE the proxy starts.
# LITELLM_HOST is agent-net's gateway address, and that address does not exist
# on the host until compose creates the network -- binding to it first fails
# with "Cannot assign requested address". See ensure_proxy.
#
ensure_up() {
  check_dependencies
  load_config
  ensure_project_volume
  ensure_boundary
  ensure_proxy
}

# teardown - Stop everything this tool started.
#
# Teardown is the reverse of startup, which matters: the proxy is bound to
# agent-net's gateway address, so tearing the network down first would pull the
# interface out from under a still-running process. Stop the proxy first.
#
# `compose down`, NEVER `down -v`. `-v` would take `pi-logs` and `pi-sessions`
# along with the project pointer, and the audit trail is the one thing this
# architecture exists to produce.
#
teardown() {
  stop_proxy

  if [[ -n "$(compose ps --all --services 2>/dev/null)" ]]; then
    print_info "Tearing down the compose boundary."
    compose down 2>/dev/null || true
  fi

  print_success "Boundary is down. Audit logs and sessions are preserved on their volumes."
}

# print_status - Report what is running, for `genie --status`.
#
# Reads Docker and the live socket rather than any state file we wrote, so the
# report cannot disagree with reality after a manual `docker` command.
#
print_status() {
  local project boundary proxy address

  if boundary_running; then
    boundary="up"
  else
    boundary="down"
  fi

  # Reachable without a config file, so every field has to tolerate its absence:
  # `genie --status` on a fresh install is exactly when someone is trying to find
  # out what is set up, and that is the moment it must not crash.
  if [[ -z "${LITELLM_HOST:-}" || -z "${LITELLM_PORT:-}" ]]; then
    proxy="unknown"
    address="(no address configured)"
  else
    address="on ${LITELLM_HOST}:${LITELLM_PORT}"
    if proxy_healthy; then
      if proxy_is_ours; then
        proxy="up (pid $(< "$(proxy_pid_file)"))"
      else
        proxy="up (not started by genie)"
      fi
    else
      proxy="down"
    fi
  fi

  project=$(current_project)

  printf '%b%bGenie status%b\n' "${BOLD}" "${BLUE}" "${RESET}" >&2
  print_blank
  print_detail "$(printf '%-11s %s' 'boundary' "${boundary}")"
  print_detail "$(printf '%-11s %s' 'proxy' "${proxy} ${address}")"
  print_detail "$(printf '%-11s %s' 'project' "${project:-none}")"
  print_detail "$(printf '%-11s %s' 'payload' "${payload_root}")"
  print_detail "$(printf '%-11s %s' 'config' "${env_file}")"
  print_detail "$(printf '%-11s %s' 'proxy log' "$(proxy_log_file)")"
  print_blank

  if [[ "${boundary}" == "down" ]]; then
    print_info "Nothing is running. \`genie --up\` starts it, or just send a prompt."
  fi
}
