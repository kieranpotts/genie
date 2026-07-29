/**
 * Command allowlisting and path fencing for the audited `bash` replacement.
 *
 * The threat is command injection: a single string the agent supplies could
 * smuggle extra commands via shell *control* operators (`;`, `&&`, `|`,
 * redirection, command substitution). The defence is to never invoke a shell
 * and to reject any command containing a control operator, then run a single
 * allowlisted program with the remaining tokens as literal arguments.
 *
 * A second, unrelated rule lives here too: the PATH FENCE. The agent container
 * mounts the project read-only so a human operator can browse it from a shell,
 * but the agent itself must still reach project files only through the MCP
 * server, which mediates and logs that access. The fence enforces that split —
 * any command naming a path inside a fenced root is refused, with the model
 * pointed at the `mcp_*` tools instead. Without it the read-only mount would
 * silently hand the agent an unmediated second route to every project file.
 *
 * LIMITS OF THE FENCE — do not overstate it:
 *
 *   - It is LEXICAL. Paths are resolved with `resolve()`, which does not follow
 *     symlinks, so a symlink into a fenced root would not be caught. Nothing the
 *     agent can execute creates one today (the rootfs is read-only and `ln` is
 *     not allowlisted), but this is an assumption, not a guarantee.
 *
 *   - It is SELF-ENFORCED. Unlike the MCP server's containment, which sits in
 *     another container, this check runs in the agent's own process. It is a
 *     guard on a cooperative tool, not a boundary.
 *
 *   - It is only as strong as the allowlist. `node`, `python`, `npm`, and `make`
 *     are general-purpose interpreters: `node -e "…"` can read anything the uid
 *     can, and the fence sees only an inert script string. With those on the
 *     allowlist the fence stops accidents and casual paths, and the operator
 *     confirmation in `permission-gate` is what stops the rest. Trim the
 *     allowlist (`AUDITED_BASH_ALLOWLIST`) if you need the fence to hold on its
 *     own.
 *
 * Two classes of "special" character, treated differently:
 *
 *   - **Control operators** (`| & ; < > ` newline`) — these only have meaning to
 *     a shell. Since we never run a shell, "allowing" one could not produce the
 *     behaviour a caller wants (a tolerated `|` would become a literal argument,
 *     not a pipe). They are therefore ALWAYS rejected and not configurable.
 *
 *   - **Argument-content characters** (`$ * ? ( ) { } \`) — these routinely
 *     appear *inside* a single argument that the program itself interprets:
 *     `grep 'a.*b'`, `find -name '*.ts'`, `find … -exec cat {} \;`, regexes,
 *     literal `$` in text. Because no shell runs, they are passed through
 *     verbatim and cannot expand, glob, or substitute. They are allowed; no
 *     configuration is needed or offered.
 *
 * The upshot: there is no metacharacter whose "allow" toggle would do something
 * useful that is not already covered, so there is no metacharacter config at
 * all. The operator-tunable knobs are the program allowlist and the fence.
 *
 * All logic here is pure (no process spawning, no I/O). The `index.ts` glue
 * reads the environment, then spawns only when this approves.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Shell CONTROL operators — always rejected. Meaningful only to a shell, which
 * we never invoke, so they can only ever be an injection attempt.
 */
const CONTROL_OPERATORS = ['|', '&', ';', '<', '>', '`', '\n']

/** Default allowed programs: read-only inspection plus common dev tools. */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  // Inspection (read-only).
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'file', 'pwd', 'echo',
  'which', 'stat', 'diff', 'tree', 'sort', 'uniq', 'cut', 'basename', 'dirname',
  // Common dev tools (each carries some surface — see README).
  'git', 'node', 'npm', 'npx', 'python', 'python3', 'pip', 'make', 'cargo', 'go',
]

/**
 * Directories the agent's commands must not reach, because a mediated route to
 * them exists. `/projects/active` is where compose mounts the project read-only
 * for the operator; the agent's route to it is the `mcp_*` tools.
 */
export const DEFAULT_FENCED_ROOTS: readonly string[] = ['/projects/active']

/**
 * Where vetted commands run. The agent's home: the one directory guaranteed to
 * exist in the hardened image, and outside every fenced root.
 */
export const DEFAULT_CWD = '/home/pi'

/** The policy. Control operators are always rejected (see module doc); the
 * allowlist, the fence, and the working directory are the tunables. */
export interface BashPolicy {
  /** Programs permitted to run. */
  allowlist: readonly string[]
  /** Absolute directories no command argument may resolve into. */
  fencedRoots: readonly string[]
  /**
   * Directory commands run in, and the base relative arguments are resolved
   * against when fencing. Deliberately ONE value serving both purposes: if
   * vetting resolved against a different directory than execution used, a
   * relative path could be fenced as innocuous and then executed as a fenced
   * one.
   */
  cwd: string
}

/** The default policy. */
export function defaultPolicy (): BashPolicy {
  return { allowlist: DEFAULT_ALLOWLIST, fencedRoots: DEFAULT_FENCED_ROOTS, cwd: DEFAULT_CWD }
}

/** Outcome of vetting a command. */
export type BashDecision =
  | { allowed: true, program: string, args: string[] }
  | { allowed: false, reason: string }

/**
 * Split a command string into whitespace-separated tokens, honouring single and
 * double quotes so quoted arguments stay intact. Does NOT interpret any shell
 * feature — quotes only group, they do not enable substitution. Pure.
 *
 * Returns null if quoting is unbalanced (which we treat as unsafe).
 */
export function tokenize (command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (/\s/.test(ch)) {
      if (started) { tokens.push(current); current = ''; started = false }
      continue
    }
    current += ch
    started = true
  }
  if (quote) return null // unbalanced quote
  if (started) tokens.push(current)
  return tokens
}

/**
 * Which shell control operators appear in the command. Checks the RAW string
 * (before tokenising), because a control operator is an injection risk wherever
 * it sits. Pure. Argument-content characters (`$ * ? ( ) { } \`) are NOT checked
 * here — they pass through as inert literals (no shell runs to interpret them).
 */
export function offendingOperators (command: string): string[] {
  return CONTROL_OPERATORS.filter((op) => command.includes(op))
}

/**
 * Whether `target` — already resolved to an absolute path — lies within `root`.
 *
 * Compares via `relative()` and rejects a result that escapes (`..`) or is
 * absolute (which `relative` returns when the paths share no base). An empty
 * result means target IS root, which counts as within. This is what defeats the
 * prefix-collision case: `/projects/active-evil` shares `/projects/active` as a
 * string prefix but is not inside it. Pure.
 */
export function isWithin (root: string, target: string): boolean {
  const rel = relative(resolve(root), target)
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * The first token that resolves inside a fenced root, or undefined if none.
 *
 * EVERY token is checked, the program included, and each is resolved against
 * `policy.cwd` when relative — so `../../projects/active/.env` is caught as
 * surely as the absolute form. Tokens that are not paths at all (flags,
 * regexes, `-name`) resolve to harmless paths under the cwd and never match,
 * which is why this can check indiscriminately without false positives. Pure.
 */
export function fencedToken (tokens: readonly string[], policy: BashPolicy): string | undefined {
  for (const token of tokens) {
    const target = isAbsolute(token) ? resolve(token) : resolve(policy.cwd, token)
    if (policy.fencedRoots.some((root) => isWithin(root, target))) return token
  }
  return undefined
}

/**
 * Vet a command against a policy. Allows it only if it contains no shell control
 * operator, tokenises cleanly, its program is on the allowlist, and no argument
 * reaches into a fenced root. Pure.
 */
export function vetCommand (command: string, policy: BashPolicy): BashDecision {
  const trimmed = command.trim()
  if (trimmed === '') return { allowed: false, reason: 'empty command' }

  const offenders = offendingOperators(trimmed)
  if (offenders.length > 0) {
    const shown = offenders.map((o) => (o === '\n' ? '\\n' : o)).join(' ')
    return { allowed: false, reason: `command contains disallowed shell operators: ${shown}` }
  }

  const tokens = tokenize(trimmed)
  if (tokens === null) return { allowed: false, reason: 'unbalanced quotes in command' }
  if (tokens.length === 0) return { allowed: false, reason: 'no program in command' }

  const program = tokens[0]
  if (!policy.allowlist.includes(program)) {
    return { allowed: false, reason: `program not on allowlist: ${program}` }
  }

  const fenced = fencedToken(tokens, policy)
  if (fenced !== undefined) {
    return {
      allowed: false,
      reason: `command reaches into a mediated path: ${fenced} — use the mcp_* tools for project files`,
    }
  }

  return { allowed: true, program, args: tokens.slice(1) }
}

/**
 * Build the effective policy from the environment. Each comma-separated value,
 * when non-empty, FULLY REPLACES its built-in default rather than extending it,
 * so an operator can always see the whole effective policy in one place. An
 * unset or blank value leaves the default. Pure.
 *
 * Note the asymmetry between the two lists: emptying the allowlist would be a
 * tightening (no program runs), but emptying the fence would be a LOOSENING (no
 * path is mediated), so a blank fence value keeps the default rather than
 * clearing it. Pass `AUDITED_BASH_FENCE=none` to genuinely disable fencing —
 * explicit, greppable, and impossible to do by accident with an empty string.
 */
export function buildPolicy (envAllowlist?: string, envFence?: string, cwd?: string): BashPolicy {
  let allowlist: readonly string[] = DEFAULT_ALLOWLIST
  if (envAllowlist && envAllowlist.trim() !== '') {
    allowlist = envAllowlist.split(',').map((s) => s.trim()).filter(Boolean)
  }

  let fencedRoots: readonly string[] = DEFAULT_FENCED_ROOTS
  if (envFence && envFence.trim() !== '') {
    fencedRoots = envFence.trim() === 'none'
      ? []
      : envFence.split(',').map((s) => s.trim()).filter(Boolean)
  }

  return { allowlist, fencedRoots, cwd: cwd && cwd.trim() !== '' ? cwd : DEFAULT_CWD }
}
