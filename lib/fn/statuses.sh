#!/usr/bin/env bash

#
# Utility functions to print status updates during infrastructure startup.
#
# EVERYTHING HERE WRITES TO STDERR, and that is load-bearing rather than
# stylistic. `genie` without `--tui` is a programmatic interface: its STDOUT is
# the agent's response and nothing else, so that
#
#   genie --prompt "..." > answer.txt
#
# captures the answer rather than the answer interleaved with a bring-up
# narration. Progress is diagnostics, so it belongs on stderr by the same
# argument that puts errors there.
#
# In an ordinary terminal both streams land on the same screen, so this is
# invisible in interactive use.
#

# print_info - Print a general information message.
#
# Arguments:
#   $1 - Message to print.
#
print_info() {
  printf '%b%b[INFO]%b %s\n' "${BOLD}" "${BLUE}" "${RESET}" "$1" >&2
}

# print_success - Print notification of a successful operation.
#
# Arguments:
#   $1 - Message to print.
#
print_success() {
  printf '%b%b✓%b %s\n' "${BOLD}" "${GREEN}" "${RESET}" "$1" >&2
}

# print_warning - Print a warning message.
#
# Arguments:
#   $1 - Message to print.
#
print_warning() {
  printf '%b%b[WARNING]%b %s\n' "${BOLD}" "${YELLOW}" "${RESET}" "$1" >&2
}

# print_error - Notify the user of an error.
#
# Usage of this function should be followed by an exit command, with a non-zero
# exit code to indicate failure.
#
# Arguments:
#   $1 - Message to print.
#
print_error() {
  printf '%b%b[ERROR]%b %s\n' "${BOLD}" "${RED}" "${RESET}" "$1" >&2
}

# print_detail - Print an unprefixed, indented continuation line.
#
# For output that belongs to the message above it rather than standing on its
# own: a tail of a log, a list of valid values, a table of status fields.
#
# Arguments:
#   $1 - Message to print.
#
print_detail() {
  printf '    %s\n' "$1" >&2
}

# print_blank - Print an empty line, to stderr like everything else here.
#
# Exists so that spacing does not have to be written as a bare `echo ""`, which
# would go to STDOUT and so would corrupt a captured response.
#
print_blank() {
  printf '\n' >&2
}
