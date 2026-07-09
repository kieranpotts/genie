/**
 * Filesystem half of the audited tools: audited `read`, `write`, and `ls`.
 *
 * These replace Pi's built-in file tools (removed by `--no-builtin-tools`). Each
 * authorises its `path` argument through `path-guard` before any I/O — confining
 * access to an allowlisted root and refusing sensitive filenames — and records
 * the decision to the shared audit log. The threat this half addresses is
 * filesystem escape (directory traversal, secret exfiltration), distinct from
 * the command-injection threat handled in `register-bash.ts`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { authorize } from './path-guard.ts'
import { AuditLog, makeEntry } from './audit-log.ts'
import { fail, ok } from './tool-result.ts'

/** Register the audited `read`, `write`, and `ls` tools against `pi`. */
export function registerFsTools (pi: ExtensionAPI, root: string, audit: AuditLog): void {
  registerRead(pi, root, audit)
  registerWrite(pi, root, audit)
  registerLs(pi, root, audit)
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
