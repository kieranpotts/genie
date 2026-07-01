/**
 * Summary text for a finished `/foreach` run.
 *
 * Pure formatting, split out from `index.ts` so the report format is
 * unit-tested without spawning anything.
 */

import type { LoopResult } from './loop.ts'

/**
 * Build the human-readable summary written as `summary.md` and echoed to the
 * user.
 *
 * @param result - The finished loop's outcome.
 * @returns The summary text: a tally line, then one line per item.
 */
export function buildSummary (result: LoopResult): string {
  const total = result.outcomes.length
  const lines = [
    `${result.succeeded}/${total} items succeeded, ${result.failed} failed.`,
    ''
  ]
  for (const outcome of result.outcomes) {
    const mark = outcome.ok ? 'ok' : 'FAILED'
    lines.push(`- [${mark}] ${outcome.item} — ${outcome.artifactPath}`)
  }
  return lines.join('\n')
}
