#!/usr/bin/env bash

#
# Banner, summary, and usage output for the installer.
#
# These read the globals defined in `run/install`:
#   available_extensions   - Names of installable extensions.
#   extensions_source_dir  - Where extension sources live in this repo.
#   pi_extensions_dir      - Where extensions are installed to.
#   repo_root              - Absolute path to the repository root.
#

# Globals above are assigned in `run/install` and sourced before this file.
# shellcheck disable=SC2154

# print_banner - Print a heavy-ruled banner box around a single-line label.
#
# Models the STARTING / FINISHED banners in the bootstrap project's
# `run/inc/fn/steps.sh`. The inner width (78) matches those banners.
#
# Arguments:
#   $1 - Color escape sequence to render the box in (eg. ${BLUE}).
#   $2 - Label text (rendered as-is, typically uppercase).
#
print_banner() {
  local color="$1"
  local label="$2"

  # Inner width between the box corners, matching the bootstrap banners.
  local width=78
  local rule
  rule=$(printf '━%.0s' $(seq 1 "${width}"))

  # Pad the label line out to the inner width: 1 leading space + label + pad.
  local pad=$(( width - 1 - ${#label} ))
  (( pad < 0 )) && pad=0

  printf '%b┏%s┓\n' "${color}" "${rule}"
  printf '┃ %s%*s┃\n' "${label}" "${pad}" ''
  printf '┗%s┛%b\n' "${rule}" "${RESET}"
}

# print_header - Print the installer's title banner.
#
print_header() {
  echo ""
  print_banner "${BLUE}" "PI EXTENSIONS INSTALLER"
  echo ""
}

# print_summary - Print a summary of how many extensions installed or failed.
#
# Arguments:
#   $1 - Count of successfully installed extensions.
#   $2 - Count of failed extensions.
#
print_summary() {
  local success_count="$1"
  local fail_count="$2"

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  print_success "Installed: ${success_count} extension(s)."
  if [[ "${fail_count}" -gt 0 ]]; then
    print_error "Failed: ${fail_count} extension(s)."
  fi
  echo "═══════════════════════════════════════════════════════════════"
}

# show_usage - Print usage information and the list of available extensions.
#
show_usage() {
  echo "Usage: ./run/install [extension-name...]"
  echo ""
  echo "Install Pi extensions to ~/.pi/agent/extensions/."
  echo ""
  echo "Options:"
  echo "  (no args)           Install all extensions."
  echo "  extension-name      Install specific extension(s)."
  echo "  -h, --help          Show this help message."
  echo "  -l, --list          List available extensions."
  echo ""
  echo "Examples:"
  echo "  ./run/install                                # Install all."
  echo "  ./run/install my-first-extension             # Install one."
  echo "  ./run/install my-first-extension my-second   # Install multiple."
  echo ""
  list_available_extensions
}

# post_install_instructions - Print next steps and documentation pointers.
#
post_install_instructions() {
  echo ""
  print_banner "${GREEN}" "INSTALLATION COMPLETE"
  echo ""
  printf '%b%bNext steps:%b\n\n' "${BOLD}" "${BLUE}" "${RESET}"

  echo "1. Start or restart Pi:"
  printf '   %b%s%b\n\n' "${GREEN}" "pi" "${RESET}"

  echo "2. In Pi, reload extensions:"
  printf '   %b%s%b\n\n' "${GREEN}" "/reload" "${RESET}"

  echo "3. Try an extension:"
  if [[ -f "${pi_extensions_dir}/my-first-extension.ts" ]]; then
    printf '   %b%s%b   (My first extension — see its README)\n' "${GREEN}" "/my-first-extension" "${RESET}"
  fi
  echo ""

  printf '%b%bDocumentation:%b\n' "${BOLD}" "${BLUE}" "${RESET}"
  printf '   %b%s%b\n\n' "${GREEN}" "${repo_root}/README.md" "${RESET}"

  printf '%b%bExtension docs:%b\n' "${BOLD}" "${BLUE}" "${RESET}"
  local ext
  for ext in "${available_extensions[@]}"; do
    if [[ -f "${pi_extensions_dir}/${ext}.ts" ]]; then
      printf '   %b%s%b\n' "${GREEN}" "${extensions_source_dir}/${ext}/README.md" "${RESET}"
    fi
  done
  echo ""
}
