/**
 * Source-description for the `/realize` pipeline.
 *
 * Turns the classified specification sources into the task text handed to the
 * pipeline's `specify` phase: a preamble naming each source and how to obtain it.
 * Pure and side-effect free, so it is unit-tested without touching the Pi API.
 */

import type { ResolvedSource } from './source.ts'

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
 * Produce a full sentence telling the specify phase where a single specification
 * lives and how to obtain its contents, tailored to the source kind.
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
 * @returns The preamble naming each source and how to read it.
 */
function sourcePreamble (sources: ResolvedSource[]): string {
  if (sources.length === 1) {
    return sourceInstruction(sources[0])
  }

  const list = sources.map((source, index) => `${index + 1}. ${sourceListItem(source)}`).join('\n')
  return `The specification is spread across these sources. Read all of them before starting:\n\n${list}`
}

/**
 * Build the task for the pipeline's `specify` phase: where the specification
 * source material lives and how to read it.
 *
 * The specify phase's own role (see `./phases.ts`) tells it to formalize that
 * material into a testable specification, so the task only needs to point at the
 * sources — described in the same words the command has always used.
 *
 * @param sources - One or more classified sources from `resolveSource`.
 * @returns The instruction handed to the specify phase.
 */
export function buildSpecifyTask (sources: ResolvedSource[]): string {
  return sourcePreamble(sources)
}
