import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  reviewPhase, parseReviewVerdict, REVIEW_ROLE,
  testPhase, parseTestVerdict, TEST_ROLE,
  specifyPhase, designPhase, elaboratePhase, planPhase, codePhase, summaryPhase,
  phases
} from '../../src/realize/phases.ts'
import { FakeRunner } from './fake-runner.ts'

describe('reviewPhase', () => {
  it('is a read-only, strong-tier phase backed by the review skill', () => {
    assert.equal(reviewPhase.name, 'review')
    assert.equal(reviewPhase.access, 'read-only')
    assert.equal(reviewPhase.tier, 'strong')
    assert.equal(reviewPhase.skill, 'review')
  })

  it('delegates methodology to the skill and demands a machine-readable verdict', () => {
    assert.match(REVIEW_ROLE, /`review` skill/)
    assert.match(REVIEW_ROLE, /read-only/)
    assert.match(REVIEW_ROLE, /VERDICT: APPROVE/)
    assert.match(REVIEW_ROLE, /VERDICT: REQUEST_CHANGES/)
    assert.match(REVIEW_ROLE, /VERDICT: COMMENT/)
  })
})

describe('parseReviewVerdict', () => {
  it('reads each verdict token, normalized to lower case', () => {
    assert.equal(parseReviewVerdict('VERDICT: APPROVE'), 'approve')
    assert.equal(parseReviewVerdict('VERDICT: REQUEST_CHANGES'), 'request_changes')
    assert.equal(parseReviewVerdict('VERDICT: COMMENT'), 'comment')
  })

  it('finds the verdict on the last line of a full review', () => {
    const output = [
      '## Specification',
      '- [Blocking] AC-2 not handled.',
      '',
      'Request changes.',
      'VERDICT: REQUEST_CHANGES'
    ].join('\n')
    assert.equal(parseReviewVerdict(output), 'request_changes')
  })

  it('takes the last verdict when prose mentions a token earlier', () => {
    const output = [
      'I considered whether to VERDICT: APPROVE but found an issue.',
      'VERDICT: REQUEST_CHANGES'
    ].join('\n')
    assert.equal(parseReviewVerdict(output), 'request_changes')
  })

  it('tolerates surrounding whitespace and lower-case tokens', () => {
    assert.equal(parseReviewVerdict('   verdict:   approve   '), 'approve')
  })

  it('returns null when no verdict line is present', () => {
    assert.equal(parseReviewVerdict('Looks good to me, ship it.'), null)
    assert.equal(parseReviewVerdict(''), null)
  })

  it('ignores a token that is not one of the review verdicts', () => {
    assert.equal(parseReviewVerdict('VERDICT: MAYBE'), null)
    /* A test verdict is not a review verdict. */
    assert.equal(parseReviewVerdict('VERDICT: PASS'), null)
  })
})

describe('testPhase', () => {
  it('is a verify-access, default-tier phase backed by the test skill', () => {
    assert.equal(testPhase.name, 'test')
    assert.equal(testPhase.access, 'verify')
    assert.equal(testPhase.tier, 'default')
    assert.equal(testPhase.skill, 'test')
  })

  it('delegates methodology to the skill, forbids fixing, and demands a verdict', () => {
    assert.match(TEST_ROLE, /`test` skill/)
    assert.match(TEST_ROLE, /cannot modify source/)
    assert.match(TEST_ROLE, /VERDICT: PASS/)
    assert.match(TEST_ROLE, /VERDICT: FAIL/)
    assert.match(TEST_ROLE, /VERDICT: BLOCKED/)
  })
})

describe('parseTestVerdict', () => {
  it('reads each verdict token, normalized to lower case', () => {
    assert.equal(parseTestVerdict('VERDICT: PASS'), 'pass')
    assert.equal(parseTestVerdict('VERDICT: FAIL'), 'fail')
    assert.equal(parseTestVerdict('VERDICT: BLOCKED'), 'blocked')
  })

  it('finds the verdict on the last line of a full report', () => {
    const output = 'AC-1 PASS\nAC-2 FAIL\n\nVERDICT: FAIL'
    assert.equal(parseTestVerdict(output), 'fail')
  })

  it('returns null when absent or not a test verdict', () => {
    assert.equal(parseTestVerdict('all good'), null)
    assert.equal(parseTestVerdict('VERDICT: APPROVE'), null)
  })
})

describe('build phases', () => {
  it('the author phases write artifacts and run on the right tier', () => {
    for (const phase of [specifyPhase, elaboratePhase, planPhase]) {
      assert.equal(phase.access, 'author')
      assert.equal(phase.tier, 'default')
    }
    /* Design is the author-side judgment gate, so it gets the strong tier. */
    assert.equal(designPhase.access, 'author')
    assert.equal(designPhase.tier, 'strong')
  })

  it('each build phase loads its matching skill', () => {
    assert.equal(specifyPhase.skill, 'specify')
    assert.equal(designPhase.skill, 'design')
    assert.equal(elaboratePhase.skill, 'elaborate')
    assert.equal(planPhase.skill, 'plan')
    assert.equal(codePhase.skill, 'code')
  })

  it('code is the only full-access phase', () => {
    assert.equal(codePhase.access, 'full')
  })

  it('summary is read-only and uses no skill', () => {
    assert.equal(summaryPhase.access, 'read-only')
    assert.equal(summaryPhase.skill, undefined)
  })
})

describe('phases registry', () => {
  it('holds all eight phases keyed by name', () => {
    assert.deepEqual(
      Object.keys(phases).sort(),
      ['code', 'design', 'elaborate', 'plan', 'review', 'specify', 'summary', 'test']
    )
    for (const [key, phase] of Object.entries(phases)) {
      assert.equal(phase.name, key, `${key} entry names itself`)
    }
  })
})

describe('review phase through the runner port', () => {
  it('runs the review phase with the given inputs and task, and yields a parseable verdict', async () => {
    const runner = new FakeRunner(() => ({
      ok: true,
      output: 'Approve.\nVERDICT: APPROVE'
    }))

    const task = { inputs: ['/run/spec.md', '/run/change.diff'], task: 'Review the change.' }
    const result = await runner.run(reviewPhase, task)

    /* The port carried exactly the phase and task we asked for. */
    assert.equal(runner.calls.length, 1)
    assert.equal(runner.calls[0].phase, reviewPhase)
    assert.deepEqual(runner.calls[0].task.inputs, ['/run/spec.md', '/run/change.diff'])

    /* And its output is the handoff the gate will act on. */
    assert.equal(result.ok, true)
    assert.equal(parseReviewVerdict(result.output), 'approve')
  })

  it('surfaces an unparseable review as a null verdict the gate can reject', async () => {
    const runner = new FakeRunner(() => ({ ok: true, output: 'I forgot the verdict line.' }))
    const result = await runner.run(reviewPhase, { inputs: [], task: 'Review.' })
    assert.equal(parseReviewVerdict(result.output), null)
  })
})
