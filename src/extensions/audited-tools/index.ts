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
 * The guards (`path-guard.ts`, `bash-policy.ts`) and the log format
 * (`audit-log.ts`) are pure and unit-tested; this entry point wires them to the
 * filesystem, the process spawner, and the `ExtensionAPI`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { authorize } from './path-guard.ts'
import { AuditLog, makeEntry } from './audit-log.ts'
import { buildPolicy, vetCommand, type BashPolicy } from './bash-policy.ts'

/** Allowlist root the tools are confined to. Set by compose for the container. */
const ROOT_ENV = 'AUDITED_TOOLS_ROOT'
/** Where the append-only audit log is written (outside the writable tree). */
const AUDIT_ENV = 'AUDITED_TOOLS_LOG'
/** Comma-separated bash allowlist; a leading `+` extends the built-in default. */
const BASH_ALLOWLIST_ENV = 'AUDITED_BASH_ALLOWLIST'

const DEFAULT_ROOT = '/projects/active'
const DEFAULT_LOG = '/home/pi/sessions/audit.jsonl'
/** A bash command may run for at most this long before being killed. */
const BASH_TIMEOUT_MS = 30_000
/** Cap captured output so a runaway command cannot flood the model context. */
const BASH_MAX_BUFFER = 1024 * 1024

export default function (pi: ExtensionAPI): void {
  const root = process.env[ROOT_ENV] ?? DEFAULT_ROOT
  const audit = new AuditLog(process.env[AUDIT_ENV] ?? DEFAULT_LOG)
  const bashPolicy: BashPolicy = buildPolicy(process.env[BASH_ALLOWLIST_ENV])

  registerRead(pi, root, audit)
  registerWrite(pi, root, audit)
  registerLs(pi, root, audit)
  registerBash(pi, root, audit, bashPolicy)
}

/** Authorize a path, logging the decision. Returns the canonical path or null. */
async function guard (audit: AuditLog, tool: string, root: string, requested: string): Promise<string | null> {
  const decision = authorize(root, requested)
  if (!decision.allowed) {
    await audit.record(makeEntry(tool, 'denied', { path: requested, reason: decision.reason }))
    return null
  }
  await audit.record(makeEntry(tool, 'allowed', { path: decision.path }))
  return decision.path
}

/** A denied/errored tool result carrying a message back to the model. */
function fail (message: string): unknown {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** A successful tool result. */
function ok (text: string): unknown {
  return { content: [{ type: 'text', text }], isError: false }
}

function registerRead (pi: ExtensionAPI, root: string, audit: AuditLog): void {
  pi.registerTool({
    name: 'read',
    label: 'read',
    description: 'Read a UTF-8 text file. Access is confined to the project workspace; sensitive files are refused.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } as never,
    execute: (async (_id: string, params: { path: string }) => {
      const safe = await guard(audit, 'read', root, params.path)
      if (safe === null) return fail(`Denied: ${params.path} is outside the allowed workspace or is a protected file.`)
      try {
        return ok(await readFile(safe, 'utf8'))
      } catch (err) {
        await audit.record(makeEntry('read', 'error', { path: safe, reason: String(err) }))
        return fail(`Read failed: ${String(err)}`)
      }
    }) as never,
  })
}

function registerWrite (pi: ExtensionAPI, root: string, audit: AuditLog): void {
  pi.registerTool({
    name: 'write',
    label: 'write',
    description: 'Write a UTF-8 text file, creating parent directories as needed. Access is confined to the project workspace; sensitive files are refused.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    } as never,
    execute: (async (_id: string, params: { path: string, content: string }) => {
      const safe = await guard(audit, 'write', root, params.path)
      if (safe === null) return fail(`Denied: ${params.path} is outside the allowed workspace or is a protected file.`)
      try {
        await mkdir(dirname(safe), { recursive: true })
        await writeFile(safe, params.content, 'utf8')
        return ok(`Wrote ${params.content.length} bytes to ${safe}.`)
      } catch (err) {
        await audit.record(makeEntry('write', 'error', { path: safe, reason: String(err) }))
        return fail(`Write failed: ${String(err)}`)
      }
    }) as never,
  })
}

function registerLs (pi: ExtensionAPI, root: string, audit: AuditLog): void {
  pi.registerTool({
    name: 'ls',
    label: 'ls',
    description: 'List the entries of a directory. Access is confined to the project workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } as never,
    execute: (async (_id: string, params: { path: string }) => {
      const safe = await guard(audit, 'ls', root, params.path)
      if (safe === null) return fail(`Denied: ${params.path} is outside the allowed workspace.`)
      try {
        const entries = await readdir(safe, { withFileTypes: true })
        const lines = entries.map((e) => (e.isDirectory() ? `${join(e.name)}/` : e.name))
        return ok(lines.join('\n'))
      } catch (err) {
        await audit.record(makeEntry('ls', 'error', { path: safe, reason: String(err) }))
        return fail(`List failed: ${String(err)}`)
      }
    }) as never,
  })
}

function registerBash (pi: ExtensionAPI, root: string, audit: AuditLog, policy: BashPolicy): void {
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
