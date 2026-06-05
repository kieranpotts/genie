/**
 * Command allowlisting for the audited `bash` replacement.
 *
 * The threat is command injection: a single string the agent supplies could
 * smuggle extra commands via shell *control* operators (`;`, `&&`, `|`,
 * redirection, command substitution). The defence is to never invoke a shell
 * and to reject any command containing a control operator, then run a single
 * allowlisted program with the remaining tokens as literal arguments.
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
 * all. The only operator-tunable knob is the program allowlist.
 *
 * All logic here is pure (no process spawning, no I/O). The `index.ts` glue
 * reads the env allowlist, then spawns only when this approves.
 */

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

/** The policy. The program allowlist is the only tunable; control operators are
 * always rejected (see module doc). */
export interface BashPolicy {
  /** Programs permitted to run. */
  allowlist: readonly string[]
}

/** The default policy: the default allowlist. */
export function defaultPolicy (): BashPolicy {
  return { allowlist: DEFAULT_ALLOWLIST }
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
 * Vet a command against a policy. Allows it only if it contains no shell control
 * operator, tokenises cleanly, and its program is on the allowlist. Pure.
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

  return { allowed: true, program, args: tokens.slice(1) }
}

/**
 * Build the effective policy from the optional `AUDITED_BASH_ALLOWLIST` env
 * value: comma-separated programs, a leading `+` extending the default,
 * otherwise replacing it. Defaults to the built-in allowlist. Pure.
 */
export function buildPolicy (envAllowlist?: string): BashPolicy {
  let allowlist: readonly string[] = DEFAULT_ALLOWLIST
  if (envAllowlist && envAllowlist.trim() !== '') {
    const extend = envAllowlist.trimStart().startsWith('+')
    const names = envAllowlist.replace(/^\s*\+/, '').split(',').map((s) => s.trim()).filter(Boolean)
    allowlist = extend ? [...DEFAULT_ALLOWLIST, ...names] : names
  }
  return { allowlist }
}
