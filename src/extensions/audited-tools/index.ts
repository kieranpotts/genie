/**
 * Audited replacement for Pi's built-in command tool.
 *
 * Started with `--no-builtin-tools`, Pi has no file or shell access at all. File
 * access is restored by the `mcp-client` extension, which is mediated by the MCP
 * filesystem server; this extension restores `bash`, gated by a command
 * allowlist with all shell metacharacters rejected by default. Every invocation
 * is logged to an append-only audit file.
 *
 * SCOPE — read this before assuming a defence-in-depth guarantee. This extension
 * guards command execution INSIDE THE AGENT CONTAINER, which deliberately has no
 * project mount (see compose.yaml). `bash` therefore cannot reach project files
 * at all: it runs in the container's own filesystem, and the only route to the
 * project is the `mcp_*` tools. It is a guard on what the agent can execute
 * locally, not a second gate in front of the MCP boundary.
 *
 * The filesystem half of this extension was removed for exactly that reason: its
 * audited `read`/`write`/`ls` were rooted at a path that does not exist in this
 * container, so every call failed while appearing in the audit trail as allowed.
 * The one control they carried that MCP does not replicate — refusing sensitive
 * filenames — now lives in the `permission-gate` extension, which sees every
 * tool call including the `mcp_*` ones. See that extension's `sensitive-files.ts`.
 *
 * This entry point only wires things together: `register-bash.ts` holds the tool,
 * `bash-policy.ts` the pure vetting logic, and `audit-log.ts` the append-only
 * sink. The guards and the log format are pure and unit-tested; here we read the
 * environment and hand the tool its working directory, the audit log, and the
 * policy.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { AuditLog } from './audit-log.ts'
import { buildPolicy, type BashPolicy } from './bash-policy.ts'
import { registerBashTool } from './register-bash.ts'

/** Working directory vetted commands run in. Must exist in the container. */
const CWD_ENV = 'AUDITED_BASH_CWD'
/** Where the append-only audit log is written (outside the writable tree). */
const AUDIT_ENV = 'AUDITED_TOOLS_LOG'
/** Comma-separated bash allowlist; a leading `+` extends the built-in default. */
const BASH_ALLOWLIST_ENV = 'AUDITED_BASH_ALLOWLIST'

/** The agent's home. Chosen because it is the one directory guaranteed to exist
 * and be readable in the hardened image; the rootfs is read-only, so commands
 * that write need a tmpfs or volume path passed explicitly. */
const DEFAULT_CWD = '/home/pi'
const DEFAULT_LOG = '/var/log/pi/audited-tools/audit.jsonl'

export default function (pi: ExtensionAPI): void {
  const cwd = process.env[CWD_ENV] ?? DEFAULT_CWD
  const audit = new AuditLog(process.env[AUDIT_ENV] ?? DEFAULT_LOG)
  const bashPolicy: BashPolicy = buildPolicy(process.env[BASH_ALLOWLIST_ENV])

  registerBashTool(pi, cwd, audit, bashPolicy)
}
