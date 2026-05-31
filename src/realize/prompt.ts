/**
 * Prompt construction for the `/realize` command.
 *
 * Builds the user message handed to the agent: a source-specific line saying
 * where the specification is and how to obtain it, followed by the shared
 * ownership instructions saying what to do with it. Pure and side-effect free,
 * so it is unit-tested without touching the Pi API.
 */

import type { ResolvedSource } from './source.ts'

/**
 * The source-independent instructions that delegate full ownership of the
 * specification to the agent. Appended after a source-specific opening line.
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
  '1. **specify** — Treat the source as the requirements input. Capture it as testable acceptance criteria. If the source is already a rigorous specification, validate and adopt it; if it is informal, formalize it.',
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
 * Produce the opening line that tells the agent where the specification lives
 * and how to obtain its contents, tailored to the source kind.
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
      const command = resolved.subtype === 'issue' ? 'gh issue view' : 'gh pr view'
      return `The specification is GitHub ${noun} \`${resolved.url}\`. Retrieve it — including the discussion — with \`${command} ${resolved.url} --comments\`.`
    }
    case 'url':
      return `The specification is at \`${resolved.url}\`. Fetch and read it in full first.`
  }
}

/**
 * Build the full prompt handed to the agent when `/realize` is invoked.
 *
 * Combines the source-specific instruction (where the spec is, how to read it)
 * with the shared ownership instructions (what to do with it).
 *
 * @param resolved - The classified source from `resolveSource`.
 * @returns The complete user message to send to the agent.
 */
export function buildRealizePrompt (resolved: ResolvedSource): string {
  return `${sourceInstruction(resolved)}\n\n${OWNERSHIP_INSTRUCTIONS}`
}
