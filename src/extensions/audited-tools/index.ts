/**
 * Audited replacements for Pi's built-in file and command tools.
 *
 * Started with `--no-builtin-tools`, Pi has no file or shell access at all; this
 * extension provides `read`, `write`, `ls`, and `bash` back — the file tools
 * gated by a path allowlist and sensitive-filename refusal, and `bash` gated by
 * a command allowlist with all shell metacharacters rejected by default. Every
 * invocation is logged to an append-only audit file. This is the defence-in-
 * depth layer described in the architecture doc: even if the MCP boundary is
 * bypassed, no file or command operation occurs without passing a guard and
 * being recorded.
 *
 * This entry point only wires things together. The two halves live apart:
 * `register-fs.ts` (filesystem tools, guarded by `path-guard.ts`) and
 * `register-bash.ts` (the command tool, guarded by `bash-policy.ts`). Both share
 * the audit sink (`audit-log.ts`) so the log stays a single chronological trail,
 * and the result shapes (`tool-result.ts`). The guards and the log format are
 * pure and unit-tested; here we read the environment and hand the halves the
 * filesystem root, the audit log, and the bash policy.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { AuditLog } from './audit-log.ts'
import { buildPolicy, type BashPolicy } from './bash-policy.ts'
import { registerFsTools } from './register-fs.ts'
import { registerBashTool } from './register-bash.ts'

/** Allowlist root the tools are confined to. Set by compose for the container. */
const ROOT_ENV = 'AUDITED_TOOLS_ROOT'
/** Where the append-only audit log is written (outside the writable tree). */
const AUDIT_ENV = 'AUDITED_TOOLS_LOG'
/** Comma-separated bash allowlist; a leading `+` extends the built-in default. */
const BASH_ALLOWLIST_ENV = 'AUDITED_BASH_ALLOWLIST'

const DEFAULT_ROOT = '/projects/active'
const DEFAULT_LOG = '/var/log/pi/audited-tools/audit.jsonl'

export default function (pi: ExtensionAPI): void {
  const root = process.env[ROOT_ENV] ?? DEFAULT_ROOT
  const audit = new AuditLog(process.env[AUDIT_ENV] ?? DEFAULT_LOG)
  const bashPolicy: BashPolicy = buildPolicy(process.env[BASH_ALLOWLIST_ENV])

  registerFsTools(pi, root, audit)
  registerBashTool(pi, root, audit, bashPolicy)
}
