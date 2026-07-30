#!/usr/bin/env bash

#
# Tail the audit trail written by the hardened container's `audit-log` and
# `secret-sentry` extensions, on the `pi-logs` volume.
#
# See "Inspect the audit trail" in src/infrastructure/README.md for how to read
# what comes out — in particular that a call writes TWO lines joined by `id`, so
# every naive count is otherwise doubled.
#
# These read the globals defined in `bin/genie`:
#   infra_dir - src/infrastructure, for the compose file.
#

# Globals above are assigned in `bin/genie` and sourced before this file.
# shellcheck disable=SC2154

# Log paths inside the container, on the pi-logs volume. Each extension writes
# to its own subdirectory of that one volume; keep these in step with
# SECRET_SENTRY_SECURITY_LOG and AUDIT_LOG_CALL_LOG in compose.yaml.
audit_log_path="/var/log/pi/audit-log/calls.jsonl"
security_log_path="/var/log/pi/secret-sentry/security.jsonl"

# tail_logs - Follow one or both audit trails until interrupted.
#
# Arguments:
#   $1 - Which trail: `audit`, `security`, or `all` (the default).
#
tail_logs() {
  local which="${1:-all}"
  local targets=()

  case "${which}" in
    all)
      targets=("${audit_log_path}" "${security_log_path}")
      ;;
    audit)
      targets=("${audit_log_path}")
      ;;
    security)
      targets=("${security_log_path}")
      ;;
    *)
      print_error "Unknown log: ${which}"
      print_info "Valid values are: all, audit, security."
      exit 1
      ;;
  esac

  if ! boundary_running; then
    print_error "The pi container is not running, and the logs live inside it."
    print_info "Bring the boundary up first: genie --up"
    exit 1
  fi

  print_info "Tailing ${targets[*]} (Ctrl-C to stop)."
  print_blank

  # -F (--follow=name --retry): keeps following if the file is rotated, and
  # waits rather than erroring if a log has no lines yet -- each extension only
  # creates its file on its first write, so a clean session may not have one.
  #
  # -T: no pseudo-tty. This is a one-way stream to this terminal, not an
  # interactive session.
  #
  # NOT `exec`. `compose` is a shell FUNCTION (it carries the -f/--env-file pair
  # and exports PROJECT_PATH), and `exec` replaces the shell with a program —
  # it cannot run a function, so `exec compose ...` fails with
  # "exec: compose: not found". Called normally, tail still runs in the
  # foreground of this process group, so Ctrl-C reaches it.
  compose exec -T pi tail -n 20 -F "${targets[@]}"
}
