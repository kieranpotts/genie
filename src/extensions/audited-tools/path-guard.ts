/**
 * Path allowlisting for the audited tool replacements.
 *
 * This is the defence-in-depth layer: even if the MCP boundary is bypassed,
 * every file operation passes through here first. The rules implement the
 * design doc's requirements exactly:
 *
 *   - canonicalise the requested path (`resolve`) before any check;
 *   - confirm it stays within an allowlisted root via a `relative()` comparison
 *     that rejects any result starting with `..` — this defeats both directory
 *     traversal (`../../etc/passwd`) and prefix-collision (`/root-evil` vs.
 *     `/root`);
 *   - allowlist, never blocklist.
 *
 * All functions are pure (they do no I/O; they reason about path strings), so
 * the full matrix of traversal and collision cases is unit-testable.
 */

import { isAbsolute, relative, resolve, basename } from 'node:path'

/** Outcome of a path check: either an allowed canonical path or a denial. */
export type PathDecision =
  | { allowed: true, path: string }
  | { allowed: false, reason: string }

/**
 * Resolve `requested` (relative to `root` if not absolute) and confirm it lies
 * within `root`. Returns the canonical absolute path when allowed. Pure.
 *
 * `root` is assumed already canonical (an absolute, resolved allowlist root).
 */
export function checkPath (root: string, requested: string): PathDecision {
  const canonicalRoot = resolve(root)
  const target = isAbsolute(requested) ? resolve(requested) : resolve(canonicalRoot, requested)

  const rel = relative(canonicalRoot, target)

  // Inside the root iff the relative path neither escapes (`..`) nor is absolute
  // (which `relative` returns when the two paths share no base, e.g. different
  // drives). An empty `rel` means the path IS the root, which is allowed.
  if (rel === '') return { allowed: true, path: target }
  if (rel === '..' || rel.startsWith(`..${sep()}`) || isAbsolute(rel)) {
    return { allowed: false, reason: `path escapes the allowed root: ${requested}` }
  }
  return { allowed: true, path: target }
}

/** Platform path separator, isolated so tests can reason about it. */
function sep (): string {
  return process.platform === 'win32' ? '\\' : '/'
}

/**
 * Filenames the agent must never read or write regardless of path: secrets,
 * key material, credential stores. Matched on the basename, case-insensitively,
 * including common compound forms (`.env.local`, `id_rsa.pub`). Allowlisting
 * governs *where*; this governs *what*, as a second, independent gate.
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

/** Whether the basename of `requested` matches a sensitive-file pattern. Pure. */
export function isSensitiveFile (requested: string): boolean {
  const name = basename(requested)
  return SENSITIVE_PATTERNS.some((re) => re.test(name))
}

/**
 * Combined gate: a path is permitted only if it is within `root` AND not a
 * sensitive filename. Returns the canonical path or the first failing reason.
 * Pure.
 */
export function authorize (root: string, requested: string): PathDecision {
  if (isSensitiveFile(requested)) {
    return { allowed: false, reason: `sensitive file refused: ${basename(requested)}` }
  }
  return checkPath(root, requested)
}
