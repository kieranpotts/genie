/**
 * Sensitive-filename refusal.
 *
 * Secrets and key material are refused by NAME, wherever they live, and the
 * refusal is absolute — it is not a prompt the user can approve, because the
 * whole point is that a misbehaving model must not be able to talk a distracted
 * operator into leaking a private key.
 *
 * This lives here because the permission gate's `tool_call` hook is the one
 * place that sees EVERY tool call, including the `mcp_*` tools that are the sole
 * route to project files. The MCP filesystem server enforces its
 * allowed-directory boundary but has no notion of sensitive filenames, so
 * without this the agent could read a project's committed `.env` or `*.pem`
 * unchallenged.
 *
 * (Historically the rule lived in an `audited-tools` extension's path guard,
 * where it covered only that extension's own file tools. That extension has
 * since been removed entirely — see `TODO.md`.)
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
 * Every path-shaped value in a tool input, flattened: the string values of the
 * path-bearing keys, and the string members of their array forms. Pure.
 *
 * This used to also tokenise a `command` string, so that `cat id_rsa` was caught
 * for the `audited-tools` extension's `bash`. No tool takes a `command` argument
 * any more — the agent has no execution surface — so that branch was removed
 * rather than left dormant. It was never sound for the case that mattered:
 * whitespace-splitting `node -e "…readFileSync('.env')…"` yields a token whose
 * basename is `.env','utf8')`, which matches nothing. If execution ever returns
 * (see the deferred exec-server option in `TODO.md`), do not restore this as it
 * was — the argument vector should be checked, not a re-split string.
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
