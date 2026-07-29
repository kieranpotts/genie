/**
 * Sensitive-filename refusal.
 *
 * Secrets and key material are refused by NAME, wherever they live, and the
 * refusal is absolute — it is not a prompt the user can approve, because the
 * whole point is that a misbehaving model must not be able to talk a distracted
 * operator into leaking a private key.
 *
 * This rule used to live in the `audited-tools` extension's path guard, where it
 * covered only that extension's own file tools. Those were removed (they were
 * rooted at a path the agent container does not have), so the rule was lifted
 * here: the permission gate's `tool_call` hook is the one place that sees EVERY
 * tool call, including the `mcp_*` tools that are now the sole route to project
 * files. The MCP filesystem server enforces its allowed-directory boundary but
 * has no notion of sensitive filenames, so without this the agent could read a
 * project's committed `.env` or `*.pem` unchallenged.
 *
 * The logic is pure and unit-tested; `index.ts` is the glue that blocks and logs.
 *
 * Note the deliberate division of labour: CONTAINMENT (staying inside the
 * project) is the MCP server's job and is enforced there, on the far side of the
 * boundary. This module does not duplicate it — it only answers "is this name
 * one we never touch?".
 */

import { basename } from 'node:path'

/**
 * Filenames never read or written regardless of path: secrets, key material,
 * credential stores. Matched on the basename, case-insensitively, including
 * common compound forms (`.env.local`, `id_rsa.pub`).
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pgpass$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^.*\.pem$/i,
  /^.*\.key$/i,
  /^.*\.p12$/i,
  /^.*\.pfx$/i,
  /^credentials$/i,
  /^\.git-credentials$/i,
]

/**
 * Tool-input keys whose values are paths. An explicit list rather than a walk of
 * every string in the input, because some arguments are patterns rather than
 * paths — `search_files` takes `pattern: "*.key"`, which must not be mistaken
 * for a request to open a key file. Covers the MCP filesystem server's argument
 * shapes (`path`, `paths`, `source`, `destination`) and any tool following the
 * same conventions.
 */
const PATH_KEYS = ['path', 'paths', 'source', 'destination', 'file', 'files', 'filepath', 'target']

/** Whether the basename of `candidate` matches a sensitive-file pattern. Pure. */
export function isSensitiveFile (candidate: string): boolean {
  const name = basename(candidate)
  return SENSITIVE_PATTERNS.some((re) => re.test(name))
}

/**
 * Every path-shaped value in a tool input, flattened. String values of the
 * path-bearing keys, plus each whitespace-separated token of a `command`, since
 * a vetted `bash` call can still name a file as an argument (`cat id_rsa`).
 * Quotes are stripped so a quoted argument is checked on its content. Pure.
 */
export function pathArguments (input: Record<string, unknown>): string[] {
  const found: string[] = []

  for (const key of PATH_KEYS) {
    const value = input[key]
    if (typeof value === 'string') found.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') found.push(item)
    }
  }

  if (typeof input.command === 'string') {
    for (const token of input.command.split(/\s+/)) {
      const unquoted = token.replace(/^['"]|['"]$/g, '')
      if (unquoted !== '') found.push(unquoted)
    }
  }

  return found
}

/**
 * The first sensitive path in a tool input, or undefined if none. Returning the
 * offending value (not just a boolean) lets the caller name it in the denial
 * reason and the audit trail. Pure.
 */
export function findSensitiveArgument (input: Record<string, unknown>): string | undefined {
  return pathArguments(input).find(isSensitiveFile)
}
