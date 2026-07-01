import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildSummary } from '../../../src/extensions/foreach/summary.ts'
import type { LoopResult } from '../../../src/extensions/foreach/loop.ts'

describe('buildSummary', () => {
  it('reports the tally and one line per item', () => {
    const result: LoopResult = {
      succeeded: 1,
      failed: 1,
      outcomes: [
        { item: 'a', ok: true, artifactPath: '/run/item-1.md' },
        { item: 'b', ok: false, artifactPath: '/run/item-2.md' }
      ]
    }

    const summary = buildSummary(result)

    assert.match(summary, /^1\/2 items succeeded, 1 failed\.$/m)
    assert.match(summary, /\[ok\] a — \/run\/item-1\.md/)
    assert.match(summary, /\[FAILED\] b — \/run\/item-2\.md/)
  })
})
