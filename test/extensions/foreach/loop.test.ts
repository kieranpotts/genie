import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { runLoop } from '../../../src/extensions/foreach/loop.ts'
import { FakeRunner } from './fake-runner.ts'
import { FakeWorkspace } from './fake-workspace.ts'

describe('runLoop', () => {
  it('runs every item and tallies successes', async () => {
    const runner = new FakeRunner([
      { ok: true, output: 'one' },
      { ok: true, output: 'two' }
    ])
    const workspace = new FakeWorkspace()

    const result = await runLoop({ kind: 'freeform', text: 'do it' }, ['a', 'b'], runner, workspace)

    assert.equal(result.succeeded, 2)
    assert.equal(result.failed, 0)
    assert.equal(result.outcomes.length, 2)
    assert.deepEqual(runner.calls, ['do it\n\nApply the instruction above to the following item:\n\na', 'do it\n\nApply the instruction above to the following item:\n\nb'])
  })

  it('continues past a failed item instead of stopping the run', async () => {
    const runner = new FakeRunner([
      { ok: false, output: 'boom' },
      { ok: true, output: 'fine' },
      { ok: true, output: 'also fine' }
    ])
    const workspace = new FakeWorkspace()

    const result = await runLoop({ kind: 'freeform', text: 'do it' }, ['a', 'b', 'c'], runner, workspace)

    assert.equal(runner.calls.length, 3)
    assert.equal(result.succeeded, 2)
    assert.equal(result.failed, 1)
    assert.equal(result.outcomes[0].ok, false)
    assert.equal(result.outcomes[1].ok, true)
    assert.equal(result.outcomes[2].ok, true)
  })

  it('hands a skill instruction just the item, with no item content merged in', async () => {
    const runner = new FakeRunner([{ ok: true, output: 'x' }])
    const workspace = new FakeWorkspace()

    await runLoop({ kind: 'skill', name: 'review' }, ['owner/repo#42'], runner, workspace)

    assert.deepEqual(runner.calls, ['owner/repo#42'])
  })

  it('writes one numbered artifact per item', async () => {
    const runner = new FakeRunner([
      { ok: true, output: 'first' },
      { ok: true, output: 'second' }
    ])
    const workspace = new FakeWorkspace()

    await runLoop({ kind: 'freeform', text: 'do it' }, ['a', 'b'], runner, workspace)

    assert.equal(workspace.artifacts.get('item-1.md'), 'first')
    assert.equal(workspace.artifacts.get('item-2.md'), 'second')
  })

  it('reports progress with 1-based position and the total', async () => {
    const runner = new FakeRunner([{ ok: true, output: '' }, { ok: true, output: '' }])
    const workspace = new FakeWorkspace()
    const positions: Array<[number, number]> = []

    await runLoop({ kind: 'freeform', text: 'x' }, ['a', 'b'], runner, workspace, {
      onItemStart: (position, total) => positions.push([position, total])
    })

    assert.deepEqual(positions, [[1, 2], [2, 2]])
  })
})
