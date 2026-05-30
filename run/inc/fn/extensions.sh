#!/usr/bin/env bash

#
# Helpers for discovering, backing up, and installing Pi extensions.
#
# These read the globals defined in `run/install`:
#   available_extensions  - Names of installable extensions.
#   src_dir               - Where extension sources live in this repo.
#   pi_extensions_dir     - Where extensions are installed to.
#

# Globals above are assigned in `run/install` and sourced before this file.
# shellcheck disable=SC2154

# check_prerequisites - Verify Pi is available and ensure the target dir exists.
#
# Warns (but does not fail) when the `pi` binary is not on PATH. Extensions
# may be staged before Pi itself is installed. Creates the extensions
# directory if it does not already exist.
#
check_prerequisites() {
  if ! command -v pi &> /dev/null; then
    print_warning "Pi coding agent not found in PATH."
    print_info "Install Pi first: npm install -g @earendil-works/pi-coding-agent"
    print_info "Continuing anyway... your extensions will be ready when you install Pi."
  else
    print_success "Pi coding agent found: $(pi --version)."
  fi

  if [[ ! -d "${pi_extensions_dir}" ]]; then
    print_info "Creating extensions directory..."
    mkdir -p "${pi_extensions_dir}"
    print_success "Created ${pi_extensions_dir}."
  else
    print_success "Extensions directory exists."
  fi
}

# is_available_extension - Test whether a name is in `available_extensions`.
#
# Arguments:
#   $1 - Extension name to test.
#
# Returns:
#   0 if the name is available, 1 otherwise.
#
is_available_extension() {
  local name="$1"
  local ext

  for ext in "${available_extensions[@]}"; do
    [[ "${ext}" == "${name}" ]] && return 0
  done
  return 1
}

# list_available_extensions - Print the available extensions and descriptions.
#
list_available_extensions() {
  printf '%b%bAvailable extensions:%b\n' "${BOLD}" "${BLUE}" "${RESET}"

  local ext desc
  for ext in "${available_extensions[@]}"; do
    case "${ext}" in
      pickling-gnomes)
        desc="Replaces the \"Working...\" status with randomly composed nonsense"
        ;;
      *)
        desc=""
        ;;
    esac
    printf '  %b%s%b - %s\n' "${GREEN}" "${ext}" "${RESET}" "${desc}"
  done
}

# backup_existing_extension - Back up an installed extension before overwriting.
#
# Arguments:
#   $1 - Extension name.
#
backup_existing_extension() {
  local ext_name="$1"
  local target_dir="${pi_extensions_dir}/${ext_name}"

  if [[ -d "${target_dir}" ]]; then
    local backup_dir
    backup_dir="${target_dir}.backup.$(date +%Y%m%d_%H%M%S)"
    print_warning "Existing extension found, backing up to $(basename "${backup_dir}")."
    cp -R "${target_dir}" "${backup_dir}"
    print_success "Backup created."
  fi
}

# install_extension - Install a single extension from source.
#
# Copies the extension's source directory into the Pi extensions directory,
# preserving the `<name>/index.ts` layout so directory-form (multi-file)
# extensions are auto-discovered by Pi.
#
# Arguments:
#   $1 - Extension name. Source must exist at
#        `${src_dir}/<name>/index.ts`.
#
# Returns:
#   0 on success, 1 if the source is missing or the copy fails.
#
install_extension() {
  local ext_name="$1"
  local source_dir="${src_dir}/${ext_name}"
  local source_file="${source_dir}/index.ts"
  local target_dir="${pi_extensions_dir}/${ext_name}"

  if [[ ! -f "${source_file}" ]]; then
    print_error "Extension entry point not found: ${source_file}"
    return 1
  fi

  backup_existing_extension "${ext_name}"

  print_info "Installing ${ext_name}..."
  # Replace any previous install so files removed from source do not linger.
  rm -rf "${target_dir}"
  if cp -R "${source_dir}" "${target_dir}"; then
    print_success "Installed ${ext_name} to ${target_dir}/."
    return 0
  else
    print_error "Failed to install ${ext_name}."
    return 1
  fi
}

# install_all_extensions - Install every entry in `available_extensions`.
#
install_all_extensions() {
  print_info "Installing all extensions..."

  local success_count=0
  local fail_count=0
  local ext

  for ext in "${available_extensions[@]}"; do
    if install_extension "${ext}"; then
      success_count=$((success_count + 1))
    else
      fail_count=$((fail_count + 1))
    fi
  done

  print_summary "${success_count}" "${fail_count}"
}

# install_named_extensions - Install a specific set of named extensions.
#
# Unknown names are reported and counted as failures, but do not abort the run.
#
# Arguments:
#   $@ - Extension names to install.
#
install_named_extensions() {
  local success_count=0
  local fail_count=0
  local ext_name

  for ext_name in "$@"; do
    if ! is_available_extension "${ext_name}"; then
      print_error "Unknown extension: ${ext_name}"
      list_available_extensions
      fail_count=$((fail_count + 1))
      continue
    fi

    if install_extension "${ext_name}"; then
      success_count=$((success_count + 1))
    else
      fail_count=$((fail_count + 1))
    fi
  done

  print_summary "${success_count}" "${fail_count}"
}
