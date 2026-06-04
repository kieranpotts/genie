/**
 * A {@link Workspace} test double that records artifacts in memory and returns a
 * canned diff, so the pipeline can be tested without touching disk or git.
 *
 * Not a test file itself (no `.test.ts` suffix), so the runner does not execute
 * it; it is imported by the suites that need it.
 */

import type { Workspace } from '../../src/extensions/realize/workspace.ts'

/**
 * Records every artifact written and hands out a deterministic path per name.
 * `captureDiff` returns successive entries from a supplied script (or a constant).
 */
export class FakeWorkspace implements Workspace {
  readonly dir = '/fake/run'
  /** Artifacts written so far, by name, in their final written content. */
  readonly artifacts = new Map<string, string>()
  /** Names in the order they were written (artifacts may be overwritten). */
  readonly writes: string[] = []

  private readonly diffs: string[]
  private diffIndex = 0

  /**
   * @param diffs - Diff text returned by successive `captureDiff` calls. A
   *   string is used for every call; an array is consumed in order, repeating
   *   the last entry once exhausted. Defaults to a non-empty placeholder.
   */
  constructor (diffs: string | string[] = 'diff --git a b') {
    this.diffs = Array.isArray(diffs) ? diffs : [diffs]
  }

  async writeArtifact (name: string, content: string): Promise<string> {
    this.artifacts.set(name, content)
    this.writes.push(name)
    return `${this.dir}/${name}`
  }

  async captureDiff (): Promise<string> {
    const diff = this.diffs[Math.min(this.diffIndex, this.diffs.length - 1)]
    this.diffIndex++
    return diff
  }
}
