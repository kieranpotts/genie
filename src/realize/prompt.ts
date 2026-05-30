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
 */
const OWNERSHIP_INSTRUCTIONS = [
  'You are taking full ownership of realizing this specification — turning it into a working reality, end to end.',
  '',
  'Work through it as follows:',
  '',
  '1. Understand the specification completely before changing anything. Follow any references it makes to other documents, code, issues, or resources.',
  '2. Identify ambiguities, gaps, and contradictions. Resolve the ones where intent is clear, recording the assumptions you make. Ask only when a genuinely significant choice is unclear and you cannot reasonably decide it yourself.',
  '3. Plan the work, then implement it in full — code, configuration, tests, and documentation, as the specification requires.',
  '4. Verify your work against the specification. Run the relevant builds, tests, and checks, and confirm the result satisfies what was asked.',
  '5. Finish with a concise summary of what you did, the decisions and assumptions you made, and anything left outstanding.'
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
