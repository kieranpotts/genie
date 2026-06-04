/**
 * A {@link PhaseRunner} test double that records calls and returns canned
 * results, so the pipeline and phase wiring can be tested without spawning a
 * process or reaching the model API.
 *
 * Not a test file itself (no `.test.ts` suffix), so the test runner does not
 * execute it; it is imported by the suites that need it.
 */

import type { Phase, PhaseRunner, PhaseTask, PhaseResult } from '../../../src/extensions/realize/runner.ts'

/** A single recorded invocation of {@link FakeRunner.run}. */
export interface RecordedCall {
  phase: Phase
  task: PhaseTask
}

/**
 * Records every {@link run} call and delegates the result to a responder
 * function, letting a test assert on what the pipeline asked for and control
 * what it gets back.
 */
export class FakeRunner implements PhaseRunner {
  /** Calls in the order they were made. */
  readonly calls: RecordedCall[] = []

  private readonly responder: (phase: Phase, task: PhaseTask) => PhaseResult

  /**
   * @param responder - Produces the result for each call. Defaults to a
   *   successful run with empty output.
   */
  constructor (responder: (phase: Phase, task: PhaseTask) => PhaseResult = () => ({ ok: true, output: '' })) {
    this.responder = responder
  }

  async run (phase: Phase, task: PhaseTask): Promise<PhaseResult> {
    this.calls.push({ phase, task })
    return this.responder(phase, task)
  }
}
