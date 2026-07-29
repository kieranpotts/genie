#!/usr/bin/env bash

#
# Populate Pi's agent directory from the image's read-only template.
#
# Installed to /usr/local/bin/seed-agent-dir.
#
# WHY THIS EXISTS: Pi needs a WRITABLE agent directory. On startup it takes a
# lockfile on `trust.json` (proper-lockfile, which locks by `mkdir`), so on the
# hardened container's read-only rootfs it died before reaching a prompt:
#
#   Error: EROFS: read-only file system, mkdir '/home/pi/.pi/agent/trust.json.lock'
#
# So compose mounts a tmpfs over ~/.pi (see compose.yaml). But a tmpfs MASKS
# whatever the image put at that path — which is where the extensions and
# models.json used to live. Hence the split: the image bakes a read-only
# template at /opt/pi/agent, and this script copies it into the tmpfs.
#
# Run on every entry, and idempotent: the copy is a refresh, not a one-off
# install, so a rebuilt image always wins. Nothing here is persisted between
# container starts, which is the point — the IMAGE is the source of truth for
# what extensions the agent runs, and there is no writable volume in which a
# stale copy could survive a rebuild.
#
# This seeds configuration ONLY. It grants the agent no file access: the
# template holds extensions and models.json, and the agent's route to project
# files remains the mcp_* tools.
#

set -euo pipefail

template="/opt/pi/agent"
target="${PI_CODING_AGENT_DIR:-/home/pi/.pi/agent}"

if [[ ! -d "${template}" ]]; then
  printf 'seed-agent-dir: missing template %s; the image is built wrong.\n' "${template}" >&2
  exit 1
fi

# The tmpfs is mounted mode 1777 (a plain tmpfs is root-owned and this container
# runs as uid 1001, so it would otherwise be unwritable). Creating the agent
# directory here, as the agent's own user, is what gives it sane ownership and
# permissions inside that world-writable mount point.
mkdir -p "${target}"
chmod 0700 "${target}"

# `/.` copies the template's CONTENTS, so the target directory itself keeps the
# ownership and mode set above.
cp -R "${template}/." "${target}/"
