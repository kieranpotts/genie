/**
 * The audited `bash` replacement.
 *
 * This replaces Pi's built-in `bash` (removed by `--no-builtin-tools`). Every
 * command is vetted through `bash-policy` before anything runs — no shell is
 * ever invoked, shell control operators are rejected, and only allowlisted
 * programs execute — and the decision is recorded to the audit log. The threat
 * addressed here is command injection.
 *
 * Commands run in the agent container, which has no project mount, so this tool
 * cannot reach project files — see the scope note in `index.ts`.
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

/** Register the audited `bash` tool against `pi`. `cwd` is the directory vetted
 * commands run in; it must exist. */
export function registerBashTool (pi: ExtensionAPI, cwd: string, audit: AuditLog, policy: BashPolicy): void {
  pi.registerTool({
    name: 'bash',
    label: 'bash',
    description:
      'Run a single allowlisted program with literal arguments, inside the agent container. ' +
      'No shell is invoked: pipes, redirection, substitution, globs, and chaining are rejected. ' +
      'Only allowlisted programs run; everything else is denied. ' +
      'This cannot reach project files — use the mcp_* tools for those.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } as never,
    execute: (async (_id: string, params: { command: string }) => {
      const decision = vetCommand(params.command, policy)
      if (!decision.allowed) {
        await audit.record(makeEntry('bash', 'denied', { command: params.command, reason: decision.reason }))
        return fail(`Denied: ${decision.reason}`)
      }
      await audit.record(makeEntry('bash', 'allowed', { command: params.command }))
      try {
        const output = await runProgram(decision.program, decision.args, cwd)
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
 * argument vector cannot be reinterpreted. Runs in `cwd`, with a timeout and a
 * bounded output buffer. Resolves to combined stdout+stderr.
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
