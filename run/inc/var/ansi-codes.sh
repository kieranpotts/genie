#!/usr/bin/env bash

#
# ANSI escape codes for colored terminal output.
#
# Sourced by `run/install` and consumed by the status helpers in
# `run/inc/fn/statuses.sh` and the banners in `run/inc/fn/banners.sh`.
#
# https://en.wikipedia.org/wiki/ANSI_escape_code
#

# Reset all colors and text decorations.
export RESET='\033[0m'

# Text decorations.
export BOLD='\033[1m'

# Regular color palette.
export RED='\033[31m'
export GREEN='\033[32m'
export YELLOW='\033[33m'
export BLUE='\033[34m'
