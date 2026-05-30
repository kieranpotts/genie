#!/usr/bin/env bash

#
# Utility functions to print status updates during installation.
#

# print_info - Print a general information message.
#
# Arguments:
#   $1 - Message to print.
#
print_info() {
  printf '%b%b[INFO]%b %s\n' "${BOLD}" "${BLUE}" "${RESET}" "$1"
}

# print_success - Print notification of a successful operation.
#
# Arguments:
#   $1 - Message to print.
#
print_success() {
  printf '%b%b✓%b %s\n' "${BOLD}" "${GREEN}" "${RESET}" "$1"
}

# print_warning - Print a warning message.
#
# Arguments:
#   $1 - Message to print.
#
print_warning() {
  printf '%b%b[WARNING]%b %s\n' "${BOLD}" "${YELLOW}" "${RESET}" "$1"
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
  printf '%b%b[ERROR]%b %s\n' "${BOLD}" "${RED}" "${RESET}" "$1"
}
