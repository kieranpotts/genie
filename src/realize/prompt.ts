/**
 * Prompt construction for the `/realize` command.
 *
 * Builds the user message handed to the agent: a preamble naming each
 * specification source and how to obtain it, followed by the shared ownership
 * instructions saying what to do with them. Pure and side-effect free, so it is
 * unit-tested without touching the Pi API.
 */

import type { ResolvedSource } from './source.ts'

/**
 * The source-independent instructions that delegate full ownership of the
 * specification to the agent. Appended after the source preamble.
 *
 * These route the agent through the author's workflow skills, by name, in
 * lifecycle order. The methodology lives in those skills (one source of truth);
 * this prompt is the entry point that hands them the source as their starting
 * artifact. See `docs/design/realize.md` for the rationale.
 */
const OWNERSHIP_INSTRUCTIONS = [
  'You are taking full ownership of realizing this specification — turning it into working, verified reality, end to end.',
  '',
  'Work through it using your installed workflow skills, in order, invoking each for its phase:',
  '',
  '1. **specify** — Treat the supplied source material as the requirements input. Capture it as testable acceptance criteria. If it is already a rigorous specification, validate and adopt it; if it is informal, formalize it.',
  '2. **design** — Explore options for any architecturally significant decision, and record the chosen approach and its rationale.',
  '3. **elaborate** — Resolve ambiguities, gaps, and contradictions. Decide the ones where intent is clear and record your assumptions; ask only when a genuinely significant choice cannot reasonably be made on your own.',
  '4. **plan** — Break the work into small, independently shippable steps.',
  '5. **code** — Implement each step in full: code, configuration, tests, and documentation.',
  '6. **test** — Verify the result against every acceptance criterion, with evidence. Run the relevant builds, tests, and checks.',
  '7. **review** — Self-review the change for correctness, design, clarity, and completeness before finishing.',
  '',
  'Throughout, follow the conventions of the project you are working in — its branch and commit rules, its coding style, and any instructions in its `AGENTS.md` or `CONTRIBUTING`.',
  '',
  'Finish with a concise summary: what you built, the key decisions and assumptions you made, each acceptance criterion and how it was verified, and anything left outstanding.'
].join('\n')

/**
 * The `gh` command that retrieves a GitHub issue or pull request, including its
 * discussion. Shared by the single- and multi-source phrasings so the command
 * is constructed in exactly one place.
 *
 * @param resolved - A classified GitHub source.
 * @returns The `gh issue view` / `gh pr view` command line.
 */
function ghViewCommand (resolved: Extract<ResolvedSource, { kind: 'github' }>): string {
  const command = resolved.subtype === 'issue' ? 'gh issue view' : 'gh pr view'
  return `${command} ${resolved.url} --comments`
}

/**
 * Produce a full sentence telling the agent where a single specification lives
 * and how to obtain its contents, tailored to the source kind.
 *
 * Used when `/realize` is given exactly one source. For several sources, see
 * {@link sourceListItem}.
 *
 * @param resolved - The classified source.
 * @returns A single instruction sentence (or two).
 */
function sourceInstruction (resolved: ResolvedSource): string {
  switch (resolved.kind) {
    case 'file':
      return `The specification is in the file \`${resolved.path}\`. Read it in full first.`
    case 'directory':
      return `The specification is the set of artifacts in the directory \`${resolved.path}\`. List and read all relevant files in it before starting.`
    case 'github': {
      /* resolveSource only returns this kind when `gh` is available, so it is
         safe to direct the agent straight to the CLI view. */
      const noun = resolved.subtype === 'issue' ? 'issue' : 'pull request'
      return `The specification is GitHub ${noun} \`${resolved.url}\`. Retrieve it — including the discussion — with \`${ghViewCommand(resolved)}\`.`
    }
    case 'url':
      return `The specification is at \`${resolved.url}\`. Fetch and read it in full first.`
  }
}

/**
 * Produce a numbered-list clause describing one source among several, and how to
 * obtain it. The list-item register of {@link sourceInstruction}.
 *
 * @param resolved - The classified source.
 * @returns A capitalized clause ending with a period.
 */
function sourceListItem (resolved: ResolvedSource): string {
  switch (resolved.kind) {
    case 'file':
      return `The file \`${resolved.path}\` — read it in full.`
    case 'directory':
      return `The directory \`${resolved.path}\` — list and read all relevant files in it.`
    case 'github': {
      const noun = resolved.subtype === 'issue' ? 'issue' : 'pull request'
      return `GitHub ${noun} \`${resolved.url}\` — retrieve it, including the discussion, with \`${ghViewCommand(resolved)}\`.`
    }
    case 'url':
      return `The page at \`${resolved.url}\` — fetch and read it in full.`
  }
}

/**
 * Build the source preamble: a single sentence for one source, or a numbered
 * list introduced by a "spread across these sources" header for several.
 *
 * @param sources - One or more classified sources.
 * @returns The preamble that precedes the ownership instructions.
 */
function sourcePreamble (sources: ResolvedSource[]): string {
  if (sources.length === 1) {
    return sourceInstruction(sources[0])
  }

  const list = sources.map((source, index) => `${index + 1}. ${sourceListItem(source)}`).join('\n')
  return `The specification is spread across these sources. Read all of them before starting:\n\n${list}`
}

/**
 * Build the full prompt handed to the agent when `/realize` is invoked.
 *
 * Combines the source preamble (where each spec source is, how to read it) with
 * the shared ownership instructions (what to do with it).
 *
 * @param sources - One or more classified sources from `resolveSource`.
 * @returns The complete user message to send to the agent.
 */
export function buildRealizePrompt (sources: ResolvedSource[]): string {
  return `${sourcePreamble(sources)}\n\n${OWNERSHIP_INSTRUCTIONS}`
}
