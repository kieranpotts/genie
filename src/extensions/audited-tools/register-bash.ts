/**
 * Command half of the audited tools: the audited `bash` replacement.
 *
 * This replaces Pi's built-in `bash` (removed by `--no-builtin-tools`). Every
 * command is vetted through `bash-policy` before anything runs — no shell is
 * ever invoked, shell control operators are rejected, and only allowlisted
 * programs execute — and the decision is recorded to the shared audit log. The
 * threat this half addresses is command injection, distinct from the filesystem
 * escape handled in `register-fs.ts`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { execFile } from 'node:child_process'
import { AuditLog, makeEntry } from './audit-log.ts'
import { vetCommand, type BashPolicy } from './bash-policy.ts'
import { fail, ok } from './tool-result.ts'

/** A bash command may run for at most this long before being killed. */
const BASH_TIMEOUT_MS = 30_000
/** Cap captured output so a runaway command cannot flood the model context. */
const BASH_MAX_BUFFER = 1024 * 1024

/** Register the audited `bash` tool against `pi`. */
export function registerBashTool (pi: ExtensionAPI, root: string, audit: AuditLog, policy: BashPolicy): void {
  pi.registerTool({
    name: 'bash',
    label: 'bash',
    description:
      'Run a single allowlisted program with literal arguments, in the project workspace. ' +
      'No shell is invoked: pipes, redirection, substitution, globs, and chaining are rejected. ' +
      'Only allowlisted programs run; everything else is denied.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } as never,
    execute: (async (_id: string, params: { command: string }) => {
      const decision = vetCommand(params.command, policy)
      if (!decision.allowed) {
        await audit.record(makeEntry('bash', 'denied', { command: params.command, reason: decision.reason }))
        return fail(`Denied: ${decision.reason}`)
      }
      await audit.record(makeEntry('bash', 'allowed', { command: params.command }))
      try {
        const output = await runProgram(decision.program, decision.args, root)
        return ok(output)
      } catch (err) {
        await audit.record(makeEntry('bash', 'error', { command: params.command, reason: String(err) }))
        return fail(`Command failed: ${String(err)}`)
      }
    }) as never,
  })
}

/**
 * Spawn a vetted program with `execFile` — NOT a shell — so the already-checked
 * argument vector cannot be reinterpreted. Runs in the workspace root, with a
 * timeout and a bounded output buffer. Resolves to combined stdout+stderr.
 */
function runProgram (program: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { cwd, timeout: BASH_TIMEOUT_MS, maxBuffer: BASH_MAX_BUFFER, shell: false },
      (err, stdout, stderr) => {
        const combined = `${stdout ?? ''}${stderr ?? ''}`
        if (err) {
          // Surface the program's own output alongside the failure.
          reject(new Error(combined.trim() === '' ? err.message : combined))
          return
        }
        resolve(combined)
      }
    )
  })
}
