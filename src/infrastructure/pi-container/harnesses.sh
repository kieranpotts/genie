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
echo "                      security profile (built-in tools disabled, files"
echo "                      via MCP only, model routed through the host proxy)."
echo "                      Starts automatically on entry; run it again to"
echo "                      return to the agent after /quit."
printf '  %bstart-pi --help%b     Show the launcher'\''s options.\n' "${GREEN}" "${RESET}"
echo ""
printf '  %bpi%b                  Alias for start-pi, so the name you already know\n' "${GREEN}" "${RESET}"
echo "                      gets the security profile too."
echo ""
printf '  %b\\pi%b                 Raw Pi, no security profile applied — built-in\n' "${YELLOW}" "${RESET}"
echo "                      read/grep/find/edit intact, operating on THIS"
echo "                      container's filesystem. The backslash bypasses the"
echo "                      alias. For debugging the harness itself only."
echo ""

printf '%b%bThis environment:%b\n' "${BOLD}" "${BLUE}" "${RESET}"
echo ""
printf '  Role                %s (via the host LiteLLM proxy)\n' "${PI_MODEL:-litellm/computer-programmer}"
printf '  Project files       agent: through the MCP gateway only (%s)\n' "${MCP_GATEWAY_URL:-unset}"
printf '                      you:   %s, mounted read-only\n' "${PI_PROJECT_DIR:-/workspace}"
printf '  Sessions            %s\n' "${PI_CODING_AGENT_SESSION_DIR:-unset}"
echo "  Audit trails        /var/log/pi/"
echo ""
echo "No cloud API keys and no Docker socket exist in this container."
echo ""
printf 'The project IS mounted here, read-only at %s, but it is mounted\n' "${PI_PROJECT_DIR:-/workspace}"
echo "FOR YOU, not for the agent: the agent has no local tool that can read it,"
echo "because it runs with built-in tools disabled. Its mcp_* tools resolve inside"
echo "the MCP server's container, not this one, so every access it makes is"
echo "mediated and logged. Read-only here means the MCP server holds the only"
echo "writable handle to the project."
echo ""
echo "The rootfs is read-only; only the mounted volumes are writable."
echo ""
printf 'Re-show this message with %bharnesses%b.\n' "${GREEN}" "${RESET}"
echo ""
