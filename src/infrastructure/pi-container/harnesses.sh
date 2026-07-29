#!/usr/bin/env bash

#
# Print the agent harnesses available inside the hardened container.
#
# Installed to /usr/local/bin/harnesses. Called automatically by ~/.bashrc on
# every interactive shell (so it greets you whether you `docker compose run` the
# container or `docker compose exec` into a running one), and re-runnable by
# hand at any time.
#
# Keep this list in sync with what the Dockerfile actually installs. If it
# claims a harness the image does not carry, it is worse than useless.
#

set -euo pipefail

RESET='\033[0m'
BOLD='\033[1m'
GREEN='\033[32m'
YELLOW='\033[33m'
BLUE='\033[34m'

# print_banner - Heavy-ruled banner box, matching `run/inc/fn/banners.sh`.
#
# Arguments:
#   $1 - Color escape sequence to render the box in (eg. ${BLUE}).
#   $2 - Label text.
#
print_banner() {
  local color="$1"
  local label="$2"

  local width=78
  local rule
  rule=$(printf '━%.0s' $(seq 1 "${width}"))

  local pad=$(( width - 1 - ${#label} ))
  (( pad < 0 )) && pad=0

  printf '%b┏%s┓\n' "${color}" "${rule}"
  printf '┃ %s%*s┃\n' "${label}" "${pad}" ''
  printf '┗%s┛%b\n' "${rule}" "${RESET}"
}

echo ""
print_banner "${BLUE}" "HARDENED AGENT CONTAINER"
echo ""
echo "You are at a shell inside the hardened container. No agent is running."
echo ""

printf '%b%bAvailable harnesses:%b\n' "${BOLD}" "${BLUE}" "${RESET}"
echo ""
printf '  %bstart-pi%b            Pi coding agent, launched with this project'\''s\n' "${GREEN}" "${RESET}"
echo "                      security profile (audited tools only, built-ins"
echo "                      disabled, model routed through the host proxy)."
echo "                      Starts automatically on entry; run it again to"
echo "                      return to the agent after /quit."
printf '  %bstart-pi --help%b     Show the launcher'\''s options.\n' "${GREEN}" "${RESET}"
echo ""
printf '  %bpi%b                  Raw Pi, no security profile applied. For\n' "${YELLOW}" "${RESET}"
echo "                      debugging the harness itself — prefer start-pi."
echo ""

printf '%b%bThis environment:%b\n' "${BOLD}" "${BLUE}" "${RESET}"
echo ""
printf '  Model routes        %s (via the host LiteLLM proxy)\n' "${PI_MODEL:-litellm/capable}"
printf '  Project files       only through the MCP gateway (%s)\n' "${MCP_GATEWAY_URL:-unset}"
printf '  Sessions            %s\n' "${PI_CODING_AGENT_SESSION_DIR:-unset}"
echo "  Audit trails        /var/log/pi/"
echo ""
echo "No cloud API keys, no Docker socket, and no project mount exist in this"
echo "container. The rootfs is read-only; only the mounted volumes are writable."
echo ""
printf 'Re-show this message with %bharnesses%b.\n' "${GREEN}" "${RESET}"
echo ""
