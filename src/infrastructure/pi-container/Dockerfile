# =============================================================================
# Hardened Pi agent image.
#
# Builds a container that runs the Pi coding agent with the smallest viable
# surface. The image itself bakes in NONE of the dangerous things:
#   - no cloud API keys (held by the host proxy; see src/infra/proxy/)
#   - no Docker socket
#   - no project source (mounted at runtime by the MCP server, never here)
#   - runs as a non-root user
#
# Capability dropping, no-new-privileges, read-only rootfs, and resource limits
# are RUNTIME concerns and are applied by the compose file in step 4 — a
# Dockerfile cannot set them itself. They are listed at the foot of this file so
# the compose wiring stays in sync.
#
# See docs/local-agent-architecture.md (hardening checklist) and
# docs/local-agent-implementation-plan.md (step 3).
# =============================================================================

# Pin to a Node version Pi supports (22.18+; dev uses 24). Digest-pinned for
# reproducibility; the tag is kept in the comment for legibility. Re-pin with:
#   docker pull node:24-bookworm-slim && docker inspect --format '{{index .RepoDigests 0}}' node:24-bookworm-slim
FROM node:24-bookworm-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf

# ---------------------------------------------------------------------------
# Non-root user. Pi runs as `pi`, never root. Home is /home/pi, which also
# holds config and the session directory (mounted as a named volume at runtime).
# ---------------------------------------------------------------------------
RUN groupadd --system --gid 1001 pi \
 && useradd  --system --uid 1001 --gid pi --create-home --home-dir /home/pi pi

# ---------------------------------------------------------------------------
# Install the Pi coding agent globally. This is the only network-fetched
# software in the image; everything else is local.
# ---------------------------------------------------------------------------
RUN npm install -g @earendil-works/pi-coding-agent \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# Security extensions. The in-Pi half of the architecture (the `mcp-client`,
# `audited-tools`, and `permission-gate` extensions) is installed here so the
# hardened controls ship WITH the image rather than being added ad hoc.
#
# Rather than copy `src/extensions/` wholesale, the build copies only the named
# security extensions. Each name is appended below as its step lands; until
# then the agent's extension directory is created empty.
#
# Build context is the repo root:
#   docker build -f src/infra/pi-container/Dockerfile -t pi-agent:hardened .
# ---------------------------------------------------------------------------
RUN mkdir -p /home/pi/.pi/agent/extensions && chown -R pi:pi /home/pi/.pi
COPY --chown=pi:pi src/extensions/mcp-client/             /home/pi/.pi/agent/extensions/mcp-client/
COPY --chown=pi:pi src/extensions/audited-tools/          /home/pi/.pi/agent/extensions/audited-tools/
COPY --chown=pi:pi src/extensions/permission-gate/        /home/pi/.pi/agent/extensions/permission-gate/

# ---------------------------------------------------------------------------
# Model routing. Pi has no built-in knowledge of the host LiteLLM proxy; it
# discovers the `capable`/`fast` routes ONLY through this models.json, which
# declares the proxy as an OpenAI-compatible provider. Without it Pi falls back
# to its default provider (google) with no key and reports "No models
# available". The proxy token is interpolated at runtime from
# $LITELLM_MASTER_KEY (compose env) — NO cloud key is baked into the image.
#
# CAVEAT: Pi does NOT interpolate env vars in `baseUrl`, so the proxy host:port
# is a literal in models.json and MUST match the host proxy's LITELLM_PORT
# (default 4000). Change one, change the other.
# ---------------------------------------------------------------------------
COPY --chown=pi:pi src/infrastructure/pi-container/models.json /home/pi/.pi/agent/models.json

# ---------------------------------------------------------------------------
# Network posture: no telemetry, no version check, no startup network calls.
# All model traffic goes through the host proxy endpoint and nothing else.
# ---------------------------------------------------------------------------
ENV PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    NODE_ENV=production

# ---------------------------------------------------------------------------
# Session storage on a controlled path under the user's home, intended to be a
# named volume at runtime so transcripts persist OUTSIDE any project tree.
# Session JSONL is sensitive (holds file content the agent read).
# ---------------------------------------------------------------------------
ENV PI_CODING_AGENT_SESSION_DIR=/home/pi/sessions
RUN mkdir -p /home/pi/sessions && chown -R pi:pi /home/pi/sessions
VOLUME ["/home/pi/sessions"]

# Drop to the unprivileged user for everything that follows.
USER pi
WORKDIR /home/pi

# Pi is the entrypoint; model + MCP endpoints are supplied at runtime (compose).
ENTRYPOINT ["pi"]

# ===========================================================================
# RUNTIME hardening — applied by compose (step 4), NOT settable in a Dockerfile:
#
#   user: "1001:1001"                 # belt-and-braces over USER above
#   cap_drop: [ALL]                   # restore none unless proven necessary
#   security_opt: [no-new-privileges:true]
#   read_only: true                   # rootfs read-only; writable tmpfs for /tmp
#   tmpfs: [/tmp]
#   mem_limit / cpus / pids_limit     # resource limits
#   networks: [agent-net]             # no host networking
#   environment:
#     OPENAI_API_KEY / ANTHROPIC_API_KEY: (MUST be absent — keys stay on host)
#     AGENT_MODEL_ENDPOINT: http://host-gateway:4000
#     LITELLM_MASTER_KEY:   (proxy token only — not a cloud key)
#   NO bind of /var/run/docker.sock
#   NO bind of any project path or host dotfiles
#   project files reached ONLY via the MCP server over agent-net
# ===========================================================================
