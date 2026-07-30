/**
 * Redact secret-shaped strings from tool output before it reaches the model.
 *
 * The gap this closes: `sensitive-files.ts` refuses calls that NAME a secret
 * file — `.env`, `id_rsa`, `*.pem`. It matches on the filename, so a key pasted
 * into `notes.txt`, a token in a config sample, or a credential in a log excerpt
 * passes through untouched and enters the model's context, from where it is
 * re-sent on every subsequent request for the rest of the session.
 *
 * WHAT THIS IS NOT. It is defence in depth, not a boundary, and the ceiling is
 * worth stating before the rules below invite more confidence than they earn:
 * the agent can still be induced to read a file and act on what it says without
 * the secret appearing in a shape any rule here recognises. Nothing about this
 * module makes it safe to put secrets in a project the agent can read.
 *
 * TWO RULES ABOUT THE RULES, both of which shape every decision here:
 *
 *   1. NO ENTROPY HEURISTICS. High-entropy strings are also hashes, UUIDs,
 *      minified code, base64 test fixtures, and lockfile integrity digests. A
 *      detector built on randomness would fire on all of them, and a redaction
 *      is not a warning — it silently changes what the model reads, so a false
 *      positive corrupts the agent's input and produces a confusing failure
 *      somewhere else entirely. Every rule below anchors on a distinctive
 *      LITERAL: a delimiter, or an issuer's prefix.
 *
 *   2. ONLY THE MATCH IS REPLACED. The surrounding text survives, so a file
 *      with a key in it is still readable — and a false positive costs one span
 *      rather than the whole output.
 *
 * The replacement names the rule that fired (`[redacted: github-token]`), which
 * tells the model that something was withheld and what kind of thing it was.
 * That matters: a silently truncated value would have the agent theorising about
 * a corrupt file, whereas a named redaction is self-explanatory.
 *
 * NOTHING HERE EVER RETURNS OR RECORDS WHAT IT MATCHED. The caller gets the
 * redacted text and the names of the rules that fired — never the secret, and
 * never its length. A detector that reported its findings in full would be a
 * more convenient way to leak exactly what it was built to protect.
 *
 * Kept local to this extension rather than factored into a shared module,
 * because the verbatim-copy installer requires each extension directory to be
 * self-contained (no cross-directory imports survive installation).
 */

/**
 * One secret shape.
 *
 * `name` is a stable, code-defined identifier: it appears in the replacement
 * text and in the audit trail, so it is a vocabulary rather than a description
 * and must not be reworded casually.
 */
interface RedactionRule {
  name: string
  pattern: RegExp
}

/**
 * The rules, in application order. Each is anchored on a literal that does not
 * occur by accident — a PEM delimiter, or an issuer's key prefix — never on a
 * shape that ordinary code or data could take.
 *
 * ORDER MATTERS in exactly one place: `anthropic-api-key` runs before
 * `openai-api-key`, because an `sk-ant-…` key also satisfies the more general
 * `sk-…` shape and the more specific name is the more useful one in a review.
 * Each rule sees the output of the previous one, and a replacement contains no
 * key material, so a later rule cannot re-match a span already redacted.
 *
 * `g` on every pattern: a file with three keys in it must lose all three.
 */
const RULES: readonly RedactionRule[] = [
  /* A PEM private key block, matched delimiter to delimiter so the whole body
     goes rather than the lines that happen to look like base64. Non-greedy, so
     two keys in one file are two matches rather than one span swallowing the
     text between them. `[A-Z ]*` covers RSA, EC, OPENSSH, DSA, and the
     unqualified PKCS#8 form. */
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },

  /* AWS access key ids: a fixed 4-character issuer prefix and exactly 16
     upper-case alphanumerics. AKIA is a long-lived key, ASIA a temporary one. */
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },

  /* GitHub tokens. Two shapes: the `gh?_` family (personal, OAuth, user-to-
     server, server-to-server, refresh) with a 36-character body, and the newer
     fine-grained `github_pat_` form, which is longer and includes underscores. */
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },

  /* Slack tokens: `xox` plus a type character, then a hyphen-delimited body. */
  {
    name: 'slack-token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },

  /* Anthropic API keys. Before the general `sk-` rule; see the note above. */
  {
    name: 'anthropic-api-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },

  /* OpenAI API keys, legacy (`sk-` + body) and project-scoped (`sk-proj-`).
     This is the weakest anchor of the set — `sk-` is only three characters —
     which is why it demands at least 32 more from the key alphabet. That is
     long enough that ordinary identifiers do not reach it. */
  {
    name: 'openai-api-key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g,
  },
]

/** What a redaction pass did. Never carries what was matched. */
export interface RedactionOutcome<T> {
  /** The value with every match replaced. Identical to the input when nothing
   * matched — callers rely on that to avoid rewriting anything needlessly. */
  value: T
  /** How many matches were replaced, across all rules. */
  count: number
  /** Which rules fired, de-duplicated and in application order. Rule NAMES, so
   * a reviewer learns what kind of secret was in the output and nothing more. */
  rules: string[]
}

/** Text of one content part, with every secret shape replaced. Pure. */
export function redactText (text: string): RedactionOutcome<string> {
  let value = text
  let count = 0
  const rules: string[] = []

  for (const rule of RULES) {
    /* A fresh regex per call: `g` patterns carry `lastIndex`, and a shared
       instance would skip matches across calls. */
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    let fired = 0
    value = value.replace(pattern, () => {
      fired += 1
      return `[redacted: ${rule.name}]`
    })
    if (fired > 0) {
      count += fired
      rules.push(rule.name)
    }
  }

  return { value, count, rules }
}

/**
 * A tool-result content part, narrowed to the shape this module cares about.
 *
 * Deliberately structural rather than an import of Pi's `TextContent` /
 * `ImageContent`: the extension is installed by verbatim copy and this module is
 * pure and separately tested, so it describes what it needs rather than
 * depending on the harness's type surface. Both of Pi's shapes satisfy it.
 */
export interface ContentPart {
  type: string
  text?: string
}

/**
 * Redact every text part of a tool result. Pure.
 *
 * Generic in the part type so the caller gets back exactly what it passed in —
 * Pi's `(TextContent | ImageContent)[]` goes in and comes out, with no cast at
 * the call site to obscure whether the right thing is being replaced.
 *
 * NON-TEXT PARTS PASS THROUGH UNTOUCHED, and that is a real gap rather than an
 * oversight: a key in a screenshot or a PDF is not something a regex over a
 * string can see, and re-encoding image content to scan it is a different
 * project. Parts are returned by identity when nothing in them changed, so an
 * untouched result is untouched all the way down.
 */
export function redactContent<T extends ContentPart> (content: readonly T[]): RedactionOutcome<T[]> {
  let count = 0
  const rules: string[] = []

  const value = content.map((part) => {
    if (part.type !== 'text' || typeof part.text !== 'string') return part

    const redacted = redactText(part.text)
    if (redacted.count === 0) return part

    count += redacted.count
    for (const rule of redacted.rules) {
      if (!rules.includes(rule)) rules.push(rule)
    }
    /* The only cast in this module. Spreading a generic widens it to an object
       literal type, and this replaces one known string field with another, so
       the part keeps every property it arrived with — including the ones this
       module does not model, such as `textSignature`. */
    return { ...part, text: redacted.value } as T
  })

  return { value: count === 0 ? [...content] : value, count, rules }
}
