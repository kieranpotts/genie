#!/usr/bin/env bash

#
# Where Genie's parts live on the host, and how `bin/genie` finds them.
#
# Sourced by both `bin/genie` and `run/install`, which have to agree on every
# path here or an install would put files where the CLI does not look.
#
# The layout follows the XDG base directory specification, and each override is
# honoured, so this is testable without touching a real home directory:
#
#   ${XDG_DATA_HOME:-~/.local/share}/genie    the payload (code)
#   ${XDG_CONFIG_HOME:-~/.config}/genie/env   the operator's config (cloud keys)
#   ${XDG_STATE_HOME:-~/.local/state}/genie   runtime state (proxy pid, log)
#   ~/.local/bin/genie                        the entry point on PATH
#
# The split is deliberate and is the reason `run/install` can be re-run safely:
# only the payload is replaced. Config holds cloud API keys and is never
# touched once created; state is disposable and describes what is running now.
#
# `~/.local/bin` has no XDG variable in the specification (XDG_BIN_HOME is a
# widely-implemented extension, not part of it), so it is honoured if set and
# defaulted otherwise.
#

# genie_data_dir - Where the payload is installed.
#
genie_data_dir() {
  printf '%s/genie\n' "${XDG_DATA_HOME:-${HOME}/.local/share}"
}

# genie_config_dir - Where the operator's config lives.
#
genie_config_dir() {
  printf '%s/genie\n' "${XDG_CONFIG_HOME:-${HOME}/.config}"
}

# genie_state_dir - Where runtime state lives.
#
genie_state_dir() {
  printf '%s/genie\n' "${XDG_STATE_HOME:-${HOME}/.local/state}"
}

# genie_bin_dir - Where the `genie` entry point is linked onto PATH.
#
genie_bin_dir() {
  printf '%s\n' "${XDG_BIN_HOME:-${HOME}/.local/bin}"
}

# NOTE: resolving the payload root is NOT a function here, and cannot be. It has
# to happen in `bin/genie` before anything is sourced, because what it finds is
# where this file lives. See the comment on `self` there.

# find_config_file - Locate the config file to read, in precedence order.
#
# Three sources, most specific first. The last is what lets the CLI work
# straight out of a checkout, before anything has been installed:
#
#   1. $GENIE_ENV_FILE          explicit override, for testing and for CI
#   2. <config dir>/env         the installed config
#   3. <payload>/src/infrastructure/.env   a checkout's own env file
#
# Prints the path if one is found, and nothing if none is. The caller decides
# whether absence is fatal, because `--status` can usefully answer without one.
#
# Arguments:
#   $1 - Payload root.
#
find_config_file() {
  local root="$1"
  local candidate

  if [[ -n "${GENIE_ENV_FILE:-}" ]]; then
    printf '%s\n' "${GENIE_ENV_FILE}"
    return 0
  fi

  for candidate in "$(genie_config_dir)/env" "${root}/src/infrastructure/.env"; do
    if [[ -f "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}
