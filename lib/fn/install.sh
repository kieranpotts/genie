#!/usr/bin/env bash

#
# Helpers for installing the Genie payload centrally and putting `genie` on PATH.
#
# These read the globals defined in `run/install`:
#   repo_root    - The working tree being installed from.
#   data_dir     - Where the payload is installed to.
#   config_dir   - Where the operator's config lives.
#   config_file  - The config file itself (cloud keys).
#   bin_dir      - Where the `genie` entry point is linked.
#   bin_link     - The entry point itself.
#   link_mode    - Non-empty to symlink the payload rather than copy it.
#

# Globals above are assigned in `run/install` and sourced before this file.
# shellcheck disable=SC2154

# What the payload consists of. AN EXPLICIT ALLOWLIST, never a tree copy.
#
# This mirrors the discipline the Dockerfile already applies by naming each
# extension in its own COPY line: nothing reaches the installed payload just by
# existing in the repository. `test/`, `docs/`, `node_modules/`, and the tooling
# config are all excluded by construction rather than by a list of exceptions
# that a new directory could slip past.
#
# `src/extensions/` is here because it is needed at BUILD time — the Dockerfile
# COPYs the three security extensions out of it, and the build context is the
# payload root. It is not installed for the host to run.
#
payload_paths=(
  "bin"
  "lib"
  "src/extensions"
  "src/infrastructure"
  "LICENSE.txt"
)

# check_prerequisites - Verify the payload is complete and the tools are present.
#
# Checks the source, not the destination: an install from an incomplete tree
# would produce a `genie` that fails later, somewhere less obvious.
#
check_prerequisites() {
  local missing=0 path

  for path in "${payload_paths[@]}"; do
    if [[ ! -e "${repo_root}/${path}" ]]; then
      print_error "Missing from this working tree: ${path}"
      missing=1
    fi
  done

  if (( missing )); then
    print_info "This does not look like a complete Genie checkout."
    exit 1
  fi

  # Not fatal. Genie is useful to install before Docker or LiteLLM are set up,
  # and `genie` itself checks for them before it needs them — with better
  # messages, because by then it knows what it was about to do.
  local tool
  for tool in docker litellm; do
    if ! command -v "${tool}" &> /dev/null; then
      print_warning "${tool} is not on PATH. Genie needs it to run, but not to install."
    fi
  done
}

# install_payload - Put the payload where `genie` will look for it.
#
# Replaces any previous payload rather than merging over it, so a file deleted
# from the repository does not survive in the install. That is the same reason
# the extension installer in the `pi` repository removes its target first.
#
install_payload() {
  # A previous install may be either a directory (copy mode) or a symlink
  # (--link mode), and `rm -rf` on a symlink removes the link rather than
  # following it into the working tree. Tested separately so a symlink is never
  # recursed into.
  if [[ -L "${data_dir}" ]]; then
    rm -f "${data_dir}"
  elif [[ -d "${data_dir}" ]]; then
    rm -rf "${data_dir}"
  fi

  mkdir -p "$(dirname "${data_dir}")"

  if [[ -n "${link_mode}" ]]; then
    ln -s "${repo_root}" "${data_dir}"
    print_success "Linked ${data_dir} -> ${repo_root}"
    print_info "Edits to this working tree take effect on the next \`genie\` run."
    return 0
  fi

  mkdir -p "${data_dir}"

  local path
  for path in "${payload_paths[@]}"; do
    mkdir -p "${data_dir}/$(dirname "${path}")"
    cp -R "${repo_root}/${path}" "${data_dir}/${path}"
  done

  prune_secrets

  print_success "Installed the payload to ${data_dir}"
}

# prune_secrets - Remove any local env file the payload copy picked up.
#
# `src/infrastructure/` is copied as a directory, so a working tree that has a
# real `.env` in it — which is where this project's config USED to live, so many
# will — would have its cloud API keys duplicated into the payload. That copy
# would sit outside the 0700 config directory, would be missed by every later
# `chmod`, and `find_config_file` would even fall back to reading it. A second
# copy of a credential nobody knows about is worse than the first.
#
# This is the same rule `.gitignore` and `.dockerignore` already apply to keep
# local env files out of commits and out of build contexts — `.env` and `.env.*`
# go, `.env.example` stays, because it is the documented contract and holds no
# secrets. The installer is the third place that rule has to hold.
#
# Only reached in copy mode. Under `--link` nothing is copied, so there is no
# duplicate to make.
#
prune_secrets() {
  local found
  found=$(find "${data_dir}" -type f \
            \( -name '.env' -o -name '.env.*' \) \
            ! -name '.env.example' -print -delete 2>/dev/null || true)

  if [[ -n "${found}" ]]; then
    print_warning "Removed local env files from the payload copy; they hold secrets and belong only in ${config_file}:"
    local file
    while IFS= read -r file; do
      print_detail "${file#"${data_dir}"/}"
    done <<< "${found}"
  fi
}

# install_entry_point - Link `genie` onto PATH.
#
# A symlink rather than a copy, so `run/install --link` gives a genie that
# follows the working tree, and so a re-install in copy mode does not leave a
# stale second copy of the script behind.
#
install_entry_point() {
  mkdir -p "${bin_dir}"

  # Replace unconditionally: a link left pointing at an older payload location
  # is the failure this is most likely to cause.
  ln -sfn "${data_dir}/bin/genie" "${bin_link}"
  chmod +x "${repo_root}/bin/genie"

  print_success "Linked ${bin_link} -> ${data_dir}/bin/genie"
}

# install_config - Seed the config file, without ever overwriting one.
#
# THE CONFIG HOLDS CLOUD API KEYS, so this is the one part of the install that
# must be conservative: mode 0600 in a 0700 directory, and never replaced. A
# re-install that clobbered it would destroy the operator's keys, and an install
# that left it world-readable would leak them.
#
# An existing `src/infrastructure/.env` in the checkout is copied across on a
# first install, because that is where the config used to live and having to
# re-enter every key to adopt the installer would be a poor trade.
#
install_config() {
  mkdir -p "${config_dir}"
  chmod 0700 "${config_dir}"

  if [[ -f "${config_file}" ]]; then
    print_success "Kept the existing config at ${config_file}"
    return 0
  fi

  local checkout_env="${repo_root}/src/infrastructure/.env"
  if [[ -f "${checkout_env}" ]]; then
    cp "${checkout_env}" "${config_file}"
    chmod 0600 "${config_file}"
    print_success "Adopted your checkout's .env as ${config_file}"
    print_info "The checkout's copy is left alone; the installed genie reads this one."
    return 0
  fi

  cp "${repo_root}/src/infrastructure/.env.example" "${config_file}"
  chmod 0600 "${config_file}"
  print_warning "Created ${config_file} from the example. IT IS NOT USABLE YET."
  print_info "Fill in your cloud API keys and generate a master key:"
  print_detail "\$EDITOR ${config_file}"
  print_detail "sed -i \"s|^LITELLM_MASTER_KEY=.*|LITELLM_MASTER_KEY=\$(openssl rand -hex 32)|\" ${config_file}"
}

# check_path - Report whether the entry point is actually reachable.
#
# Installing a binary somewhere not on PATH is a silent failure: everything
# reports success and the command does not exist. Checked against the PATH of
# this shell, which is the operator's.
#
check_path() {
  case ":${PATH}:" in
    *":${bin_dir}:"*)
      print_success "${bin_dir} is on your PATH."
      ;;
    *)
      print_warning "${bin_dir} is NOT on your PATH, so \`genie\` will not be found."
      print_info "Add it to your shell profile, eg:"
      print_detail "echo 'export PATH=\"${bin_dir}:\$PATH\"' >> ~/.bashrc"
      ;;
  esac
}

# uninstall - Remove the entry point and the payload, keeping config and state.
#
# Config is kept because it holds keys the operator generated and cloud
# credentials they pasted; deleting those on an uninstall would be a hostile
# reading of the request. Both remaining paths are printed so removing them is
# one copy-paste away.
#
# The docker volumes are also kept, and for a stronger reason: `pi-logs` is the
# audit trail. Uninstalling a CLI is not consent to destroy an accountability
# record.
#
uninstall() {
  if [[ -L "${bin_link}" || -f "${bin_link}" ]]; then
    rm -f "${bin_link}"
    print_success "Removed ${bin_link}"
  fi

  if [[ -L "${data_dir}" ]]; then
    rm -f "${data_dir}"
    print_success "Removed the payload link ${data_dir}"
  elif [[ -d "${data_dir}" ]]; then
    rm -rf "${data_dir}"
    print_success "Removed the payload ${data_dir}"
  fi

  print_blank
  print_info "Kept, deliberately:"
  print_detail "${config_file}  (your cloud API keys)"
  print_detail "$(genie_state_dir)  (proxy state)"
  print_detail "docker volumes pi-logs and pi-sessions  (the audit trail)"
  print_blank
  print_info "If the boundary is still up, stop it before removing the payload:"
  print_detail "docker compose -p ${compose_project} down"
}
