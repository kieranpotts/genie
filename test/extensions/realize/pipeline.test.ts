import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { gate, runPipeline, PhaseFailedError, DEFAULT_MAX_CYCLES } from '../../../src/extensions/realize/pipeline.ts'
import type { Phase, PhaseTask, PhaseResult } from '../../../src/extensions/realize/runner.ts'
import { FakeRunner } from './fake-runner.ts'
import { FakeWorkspace } from './fake-workspace.ts'

describe('gate', () => {
  it('passes only when verification passed and review cleared', () => {
    assert.equal(gate('pass', 'approve'), 'pass')
    assert.equal(gate('pass', 'comment'), 'pass') /* comment counts as a pass */
  })

  it('reworks when review requests changes, whatever the test says', () => {
    assert.equal(gate('pass', 'request_changes'), 'rework')
  })

  it('reworks when verification did not pass, whatever the review says', () => {
    assert.equal(gate('fail', 'approve'), 'rework')
    assert.equal(gate('blocked', 'approve'), 'rework')
  })

  it('reworks when either verdict is unparseable', () => {
    assert.equal(gate(null, 'approve'), 'rework')
    assert.equal(gate('pass', null), 'rework')
  })
})

/**
 * A responder that returns canned output per phase name, defaulting to a
 * successful empty run. Gate phases (`test`/`review`) get a passing verdict
 * unless overridden, so the happy path needs no special-casing.
 */
function respondBy (byPhase: Record<string, string>): (phase: Phase, task: PhaseTask) => PhaseResult {
  const passingVerdict: Record<string, string> = { test: 'VERDICT: PASS', review: 'VERDICT: APPROVE' }
  return (phase) => ({
    ok: true,
    output: byPhase[phase.name] ?? passingVerdict[phase.name] ?? `${phase.name} output`
  })
}

/** Names of the phases the runner was asked to run, in order. */
function ranPhases (runner: FakeRunner): string[] {
  return runner.calls.map(call => call.phase.name)
}

describe('runPipeline — happy path', () => {
  it('runs the build then one passing test/review round, and writes every artifact', async () => {
    const runner = new FakeRunner(respondBy({}))
    const workspace = new FakeWorkspace()

    const result = await runPipeline('Specify from /sources', runner, workspace)

    assert.equal(result.passed, true)
    assert.equal(result.cycles, 0)
    assert.deepEqual(ranPhases(runner), ['specify', 'design', 'elaborate', 'plan', 'code', 'test', 'review', 'summary'])
    /* Artifacts handed off through the workspace. */
    for (const name of ['spec.md', 'design.md', 'elaboration.md', 'plan.md', 'change.diff', 'test-report.md', 'review-report.md', 'summary.md']) {
      assert.ok(workspace.artifacts.has(name), `wrote ${name}`)
    }
    assert.equal(result.artifactsDir, workspace.dir)
  })

  it('passes the specify task through to the first phase, with no inputs', async () => {
    const runner = new FakeRunner(respondBy({}))
    await runPipeline('THE SPECIFY TASK', runner, new FakeWorkspace())

    const specify = runner.calls[0]
    assert.equal(specify.phase.name, 'specify')
    assert.equal(specify.task.task, 'THE SPECIFY TASK')
    assert.deepEqual(specify.task.inputs, [])
  })

  it('announces each phase before running it, in lifecycle order', async () => {
    const seen: string[] = []
    const runner = new FakeRunner(respondBy({}))
    await runPipeline('go', runner, new FakeWorkspace(), { onPhaseStart: name => seen.push(name) })
    assert.deepEqual(seen, ['specify', 'design', 'elaborate', 'plan', 'code', 'test', 'review', 'summary'])
  })

  it('hands each build phase its predecessors as inputs', async () => {
    const runner = new FakeRunner(respondBy({}))
    const ws = new FakeWorkspace()
    await runPipeline('go', runner, ws)

    const byName = (name: string): PhaseTask => runner.calls.find(c => c.phase.name === name)!.task
    assert.deepEqual(byName('design').inputs, [`${ws.dir}/spec.md`])
    assert.deepEqual(byName('plan').inputs, [`${ws.dir}/spec.md`, `${ws.dir}/design.md`, `${ws.dir}/elaboration.md`])
  })
})

describe('runPipeline — rework loop', () => {
  it('reworks once when the first review requests changes, then passes', async () => {
    /* First review requests changes; second approves. */
    const reviews = ['VERDICT: REQUEST_CHANGES', 'VERDICT: APPROVE']
    let reviewCount = 0
    const runner = new FakeRunner(phase => {
      if (phase.name === 'review') return { ok: true, output: reviews[reviewCount++] }
      if (phase.name === 'test') return { ok: true, output: 'VERDICT: PASS' }
      return { ok: true, output: `${phase.name} output` }
    })

    const result = await runPipeline('go', runner, new FakeWorkspace())

    assert.equal(result.passed, true)
    assert.equal(result.cycles, 1)
    /* code runs twice: initial build + one rework. */
    assert.equal(ranPhases(runner).filter(n => n === 'code').length, 2)
    assert.equal(ranPhases(runner).filter(n => n === 'review').length, 2)
  })

  it('seeds the rework coder with the diff and both reports, not the plan', async () => {
    const reviews = ['VERDICT: REQUEST_CHANGES', 'VERDICT: APPROVE']
    let reviewCount = 0
    const runner = new FakeRunner(phase => {
      if (phase.name === 'review') return { ok: true, output: reviews[reviewCount++] }
      if (phase.name === 'test') return { ok: true, output: 'VERDICT: PASS' }
      return { ok: true, output: `${phase.name} output` }
    })
    const ws = new FakeWorkspace()

    await runPipeline('go', runner, ws)

    /* The second code call is the rework. */
    const codeCalls = runner.calls.filter(c => c.phase.name === 'code')
    assert.equal(codeCalls.length, 2)
    assert.deepEqual(codeCalls[1].task.inputs, [
      `${ws.dir}/change.diff`,
      `${ws.dir}/test-report.md`,
      `${ws.dir}/review-report.md`
    ])
  })

  it('stops unsatisfied after exhausting the cycle limit', async () => {
    /* Review always requests changes, so the gate never clears. */
    const runner = new FakeRunner(phase => {
      if (phase.name === 'review') return { ok: true, output: 'VERDICT: REQUEST_CHANGES' }
      if (phase.name === 'test') return { ok: true, output: 'VERDICT: PASS' }
      return { ok: true, output: `${phase.name} output` }
    })

    const result = await runPipeline('go', runner, new FakeWorkspace(), { maxCycles: 2 })

    assert.equal(result.passed, false)
    assert.equal(result.cycles, 2)
    /* test/review run maxCycles + 1 times (once per round, including the last). */
    assert.equal(ranPhases(runner).filter(n => n === 'review').length, 3)
    /* code runs the initial build + maxCycles reworks. */
    assert.equal(ranPhases(runner).filter(n => n === 'code').length, 3)
    /* It still summarizes the (unsatisfied) outcome. */
    assert.equal(ranPhases(runner).at(-1), 'summary')
  })

  it('defaults to two rework cycles', async () => {
    const runner = new FakeRunner(phase => {
      if (phase.name === 'review') return { ok: true, output: 'VERDICT: REQUEST_CHANGES' }
      if (phase.name === 'test') return { ok: true, output: 'VERDICT: PASS' }
      return { ok: true, output: `${phase.name} output` }
    })
    const result = await runPipeline('go', runner, new FakeWorkspace())
    assert.equal(result.cycles, DEFAULT_MAX_CYCLES)
  })

  it('treats a review comment as a pass', async () => {
    const runner = new FakeRunner(phase => {
      if (phase.name === 'review') return { ok: true, output: 'VERDICT: COMMENT' }
      if (phase.name === 'test') return { ok: true, output: 'VERDICT: PASS' }
      return { ok: true, output: `${phase.name} output` }
    })
    const result = await runPipeline('go', runner, new FakeWorkspace())
    assert.equal(result.passed, true)
    assert.equal(result.cycles, 0)
  })

  it('reworks when verification fails even if review approves', async () => {
    const tests = ['VERDICT: FAIL', 'VERDICT: PASS']
    let testCount = 0
    const runner = new FakeRunner(phase => {
      if (phase.name === 'test') return { ok: true, output: tests[testCount++] }
      if (phase.name === 'review') return { ok: true, output: 'VERDICT: APPROVE' }
      return { ok: true, output: `${phase.name} output` }
    })
    const result = await runPipeline('go', runner, new FakeWorkspace())
    assert.equal(result.passed, true)
    assert.equal(result.cycles, 1)
  })
})

describe('runPipeline — failures', () => {
  it('aborts with PhaseFailedError when a build phase fails to run', async () => {
    const runner = new FakeRunner(phase => ({
      ok: phase.name !== 'design',
      output: phase.name === 'design' ? 'boom' : `${phase.name} output`
    }))

    await assert.rejects(
      runPipeline('go', runner, new FakeWorkspace()),
      (error: unknown) => error instanceof PhaseFailedError && error.phase === 'design'
    )
  })

  it('aborts when a gate phase process itself fails (distinct from a fail verdict)', async () => {
    const runner = new FakeRunner(phase => ({
      ok: phase.name !== 'test',
      output: phase.name === 'test' ? 'crashed' : `${phase.name} output`
    }))

    await assert.rejects(
      runPipeline('go', runner, new FakeWorkspace()),
      (error: unknown) => error instanceof PhaseFailedError && error.phase === 'test'
    )
  })
})
