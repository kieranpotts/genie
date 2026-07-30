#!/usr/bin/env bash

#
# ANSI escape codes for colored terminal output.
#
# Sourced by `bin/genie` and `run/install`, and consumed by the status helpers
# in `lib/fn/statuses.sh`.
#
# https://en.wikipedia.org/wiki/ANSI_escape_code
#
# The codes are BLANKED when they would not be interpreted, which matters here
# in a way it did not when this was only sourced by an interactive script: the
# status helpers write to stderr, and `genie`'s stderr is routinely redirected
# to a file or a pipe by a caller driving the agent programmatically. Escape
# sequences in that file are noise at best.
#
# Two conditions blank them:
#   - stderr is not a terminal (redirected or piped);
#   - NO_COLOR is set to anything, per the https://no-color.org convention.
#

if [[ -t 2 ]] && [[ -z "${NO_COLOR:-}" ]]; then

  # Reset all colors and text decorations.
  export RESET='\033[0m'

  # Text decorations.
  export BOLD='\033[1m'

  # Regular color palette.
  export RED='\033[31m'
  export GREEN='\033[32m'
  export YELLOW='\033[33m'
  export BLUE='\033[34m'

else

  export RESET=''
  export BOLD=''
  export RED=''
  export GREEN=''
  export YELLOW=''
  export BLUE=''

fi
