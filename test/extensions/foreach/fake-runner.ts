import type { ItemRunner, ItemResult } from '../../../src/extensions/foreach/runner.ts'

/**
 * A scripted {@link ItemRunner} for pipeline/loop tests: returns each queued
 * result in order and records every task it was given.
 */
export class FakeRunner implements ItemRunner {
  readonly calls: string[] = []
  private readonly results: ItemResult[]
  private index = 0

  constructor (results: ItemResult[]) {
    this.results = results
  }

  async run (task: string): Promise<ItemResult> {
    this.calls.push(task)
    const result = this.results[this.index] ?? { ok: true, output: '' }
    this.index++
    return result
  }
}
