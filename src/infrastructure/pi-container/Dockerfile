# =============================================================================
# Hardened Pi agent image.
#
# Builds a container that runs the Pi coding agent with the smallest viable
# surface. The image itself bakes in NONE of the dangerous things:
#   - no cloud API keys (held by the host proxy; see src/infra/proxy/)
#   - no Docker socket
#   - no project source (compose mounts it read-only at runtime, for the
#     operator to browse; the agent has no local tool that can read it)
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
# Security extensions. The in-Pi half of the architecture (the `mcp-client` and
# `permission-gate` extensions) is installed here so the hardened controls ship
# WITH the image rather than being added ad hoc.
#
# Note what is NOT here: nothing restores local file or shell access. Pi runs
# with `--no-builtin-tools`, and `mcp-client` gives back only the `mcp_*` tools,
# which resolve inside the MCP server's container. An `audited-tools` extension
# used to provide a guarded `bash`; it was removed because a guard running in
# the agent's own process is cooperative, not a boundary. See TODO.md.
#
# Rather than copy `src/extensions/` wholesale, the build copies only the named
# security extensions. Each name is appended below as its step lands; until
# then the agent's extension directory is created empty.
#
# Build context is the repo root:
#   docker build -f src/infra/pi-container/Dockerfile -t pi-agent:hardened .
# ---------------------------------------------------------------------------
#
# NOTE THE DESTINATION: these are baked into /opt/pi/agent, NOT into
# ~/.pi/agent where Pi actually looks. Pi needs its agent directory to be
# WRITABLE — it takes a lockfile on `trust.json` at startup (mkdir, via
# proper-lockfile) and dies with EROFS on the read-only rootfs otherwise. That
# directory is therefore a tmpfs at runtime (see compose.yaml), and a tmpfs
# MASKS whatever the image had at the same path. So the image keeps a read-only
# TEMPLATE here, and `seed-agent-dir` copies it into the tmpfs on entry.
#
# The indirection buys something beyond just working: the image stays the single
# source of truth for extensions. A writable named volume would have been the
# obvious alternative, but Docker seeds a named volume only when it is EMPTY, so
# every later `docker build` would leave the old extensions in place and the
# staleness would be silent — the same trap documented for pi-logs below.
# Copying from the image on every entry cannot go stale.
#
RUN mkdir -p /opt/pi/agent/extensions
COPY src/extensions/mcp-client/             /opt/pi/agent/extensions/mcp-client/
COPY src/extensions/permission-gate/        /opt/pi/agent/extensions/permission-gate/

# ---------------------------------------------------------------------------
# Model routing. Pi has no built-in knowledge of the host LiteLLM proxy; it
# discovers the role routes ONLY through this models.json, which
# declares the proxy as an OpenAI-compatible provider. Without it Pi falls back
# to its default provider (google) with no key and reports "No models
# available". The proxy token is interpolated at runtime from
# $LITELLM_MASTER_KEY (compose env) — NO cloud key is baked into the image.
#
# CAVEAT: Pi does NOT interpolate env vars in `baseUrl`, so the proxy host:port
# is a literal in models.json and MUST match the host proxy's LITELLM_PORT
# (default 4000). Change one, change the other.
# ---------------------------------------------------------------------------
COPY src/infrastructure/pi-container/models.json /opt/pi/agent/models.json

# The agent directory Pi reads. Stated explicitly rather than left to Pi's
# `homedir()` default, because `seed-agent-dir` and the compose tmpfs target
# have to agree with it, and an implicit path is not something they can agree
# with. Pi resolves this via ENV_AGENT_DIR (`<APP>_CODING_AGENT_DIR`), the same
# mechanism as the session dir below.
ENV PI_CODING_AGENT_DIR=/home/pi/.pi/agent

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

# ---------------------------------------------------------------------------
# Audit trails. The agent runs as uid 1001 and the rootfs is read-only, so the
# ONLY way it can write its audit logs is a volume it owns.
#
# Ownership is established HERE, not at runtime, and the mechanism is subtle
# enough to be worth stating: when Docker mounts an EMPTY named volume over a
# path that exists in the image, it seeds the volume with that path's contents
# AND its ownership. Creating these directories as `pi` at build time is
# therefore what makes the mounted volume writable by the agent.
#
# The corollary is that this only takes effect for a volume created after this
# layer is built. A pi-logs volume that already exists keeps its old ownership
# (root:root, unwritable by the agent) — remove it to re-seed:
#   docker compose -f src/infrastructure/compose.yaml down
#   docker volume rm pi-secure-agent_pi-logs
#
# `permission-gate` creates its own log file and parent directory on first
# write, but it cannot create them under a root-owned mount point, and it
# swallows write failures by design so the audit trail would go silently
# missing.
# ---------------------------------------------------------------------------
RUN mkdir -p /var/log/pi/permission-gate \
 && chown -R pi:pi /var/log/pi
VOLUME ["/var/log/pi"]

# ---------------------------------------------------------------------------
# Harness launcher and greeting.
#
# An interactive session lands in the hardened Pi harness, but the agent is
# started BY THE SHELL (~/.bashrc calls `start-pi`), not by an ENTRYPOINT. That
# indirection is the point: Pi as the container's main process would make
# `/quit` exit PID 1 and stop the container, whereas a shell parent survives it
# and catches you. Quitting the agent leaves you inside the boundary, with the
# harness list printed, able to start it again.
#
# `start-pi` carries the security-critical launch flags (--model,
# --no-builtin-tools) so they live WITH the image rather than in a compose
# `command:` that any caller can silently replace.
# ---------------------------------------------------------------------------
COPY src/infrastructure/pi-container/harnesses.sh      /usr/local/bin/harnesses
COPY src/infrastructure/pi-container/start-pi.sh       /usr/local/bin/start-pi
COPY src/infrastructure/pi-container/seed-agent-dir.sh /usr/local/bin/seed-agent-dir
RUN chmod 0555 /usr/local/bin/harnesses /usr/local/bin/start-pi /usr/local/bin/seed-agent-dir
COPY --chown=pi:pi src/infrastructure/pi-container/bashrc /home/pi/.bashrc

# Drop to the unprivileged user for everything that follows.
USER pi
WORKDIR /home/pi

# A shell, which then starts the agent (see .bashrc). This also covers
# `docker compose exec pi bash`, which never runs an entrypoint.
#
# NOTE: compose overrides this to idle, because `up -d` has no operator
# attached and must not launch an unwatched agent — see compose.yaml.
#
# No ENTRYPOINT: a compose `command:` should REPLACE the default shell, not be
# appended as arguments to it.
CMD ["bash"]

# ===========================================================================
# RUNTIME hardening — applied by compose (step 4), NOT settable in a Dockerfile:
#
#   user: "1001:1001"                 # belt-and-braces over USER above
#   cap_drop: [ALL]                   # restore none unless proven necessary
#   security_opt: [no-new-privileges:true]
#   read_only: true                   # rootfs read-only; writable tmpfs below
#   tmpfs: [/tmp]
#   tmpfs mount at /home/pi/.pi       # Pi's agent dir MUST be writable (it locks
#                                     # trust.json on startup). Needs mode 1777:
#                                     # a default tmpfs is root-owned and this
#                                     # container is uid 1001. Populated from the
#                                     # image template by `seed-agent-dir`.
#   mem_limit / cpus / pids_limit     # resource limits
#   networks: [agent-net]             # no host networking
#   environment:
#     OPENAI_API_KEY / ANTHROPIC_API_KEY: (MUST be absent — keys stay on host)
#     AGENT_MODEL_ENDPOINT: http://host-gateway:4000
#     LITELLM_MASTER_KEY:   (proxy token only — not a cloud key)
#   NO bind of /var/run/docker.sock
#   NO bind of host dotfiles
#   project bound READ-ONLY at /workspace, for the operator to browse;
#     the agent has no local tool that can read it, so it reaches project files
#     ONLY via the MCP server over agent-net
# ===========================================================================
