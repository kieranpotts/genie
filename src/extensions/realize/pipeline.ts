/**
 * The deterministic orchestrator for the `/realize` pipeline.
 *
 * Drives the lifecycle phases in a fixed order, each in its own isolated context
 * via a {@link PhaseRunner}, handing off through artifacts in a {@link Workspace}.
 * The build (`specify → design → elaborate → plan → code`) runs once; then a
 * bounded `test → review → code` rework loop repeats until both gate phases pass
 * or the cycle limit is reached. Control flow lives here, in plain code — the
 * pipeline never decides routes by model judgment.
 *
 * The orchestrator depends only on the two ports, so the whole sequence,
 * including the rework loop and the gate, is unit-tested without spawning a
 * process or touching disk.
 */

import type { Phase, PhaseRunner, PhaseTask } from './runner.ts'
import type { Workspace } from './workspace.ts'
import {
  specifyPhase, designPhase, elaboratePhase, planPhase, codePhase, testPhase, reviewPhase, summaryPhase,
  parseTestVerdict, parseReviewVerdict,
  type TestVerdict, type ReviewVerdict
} from './phases.ts'

/** Default maximum number of rework cycles before the pipeline gives up. */
export const DEFAULT_MAX_CYCLES = 2

/**
 * The gate's decision after a `test`/`review` round.
 *
 * - `pass` — both signals are clear; the change may ship.
 * - `rework` — at least one signal is not clear; send it back to the coder.
 */
export type GateDecision = 'pass' | 'rework'

/**
 * Decide whether a change clears the quality gate.
 *
 * Both signals must be affirmative: verification passed *and* review did not
 * request changes. A review `comment` counts as passing (it offers feedback
 * without blocking). Anything else — a failed or blocked verification, a
 * change request, or an unparseable verdict (`null`) — means rework. Pure, so
 * the gate policy is tested directly.
 *
 * @param test - The verification verdict, or `null` if none was parseable.
 * @param review - The review verdict, or `null` if none was parseable.
 * @returns Whether the change passes or needs rework.
 */
export function gate (test: TestVerdict | null, review: ReviewVerdict | null): GateDecision {
  const verificationPassed = test === 'pass'
  const reviewCleared = review === 'approve' || review === 'comment'
  return verificationPassed && reviewCleared ? 'pass' : 'rework'
}

/**
 * Thrown when a phase fails to run (a non-zero exit or spawn fault) — distinct
 * from a phase that ran fine but reported a gate verdict. The pipeline cannot
 * continue past a phase that did not produce its artifact, so this aborts it.
 */
export class PhaseFailedError extends Error {
  readonly phase: string
  readonly output: string

  constructor (phase: string, output: string) {
    super(`The ${phase} phase failed to run.`)
    this.name = 'PhaseFailedError'
    this.phase = phase
    this.output = output
  }
}

/** The outcome of a pipeline run. */
export interface PipelineResult {
  /** Whether the change cleared the gate within the cycle limit. */
  passed: boolean
  /** How many rework cycles were performed (0 means it passed on the first round). */
  cycles: number
  /** The summary phase's report. */
  summary: string
  /** The directory the run's artifacts were written to. */
  artifactsDir: string
}

/** Settings for {@link runPipeline}. */
export interface PipelineOptions {
  /** Maximum rework cycles before giving up. Defaults to {@link DEFAULT_MAX_CYCLES}. */
  maxCycles?: number
  /** Called with each phase's name just before it runs, for progress reporting. */
  onPhaseStart?: (phaseName: string) => void
}

/**
 * Run a phase and return its output, or throw {@link PhaseFailedError} if the
 * phase itself failed to run. Used for the phases whose output the pipeline must
 * have to continue.
 */
async function requirePhase (runner: PhaseRunner, phase: Phase, task: PhaseTask): Promise<string> {
  const result = await runner.run(phase, task)
  if (!result.ok) {
    throw new PhaseFailedError(phase.name, result.output)
  }
  return result.output
}

/**
 * Run the full realize pipeline for a prepared `specify` task.
 *
 * @param specifyTask - The instruction handed to the first phase, naming where
 *   the source material lives (the caller builds this from the resolved sources).
 * @param runner - Executes each phase in isolation.
 * @param workspace - Stores artifacts and captures the change diff.
 * @param options - Optional settings (eg. the rework cycle limit).
 * @returns The run outcome.
 * @throws {PhaseFailedError} If a non-gate phase fails to run.
 */
export async function runPipeline (
  specifyTask: string,
  runner: PhaseRunner,
  workspace: Workspace,
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const maxCycles = options.maxCycles ?? DEFAULT_MAX_CYCLES

  /* Announce each phase before it runs, then require its output to continue. */
  const step = async (phase: Phase, task: PhaseTask): Promise<string> => {
    options.onPhaseStart?.(phase.name)
    return requirePhase(runner, phase, task)
  }

  /* Build phase: each step reads its predecessors' artifacts and writes its own. */
  const spec = await step(specifyPhase, { inputs: [], task: specifyTask })
  const specPath = await workspace.writeArtifact('spec.md', spec)

  const design = await step(designPhase, { inputs: [specPath], task: 'Design the solution for the attached specification.' })
  const designPath = await workspace.writeArtifact('design.md', design)

  const elaboration = await step(elaboratePhase, { inputs: [specPath, designPath], task: 'Elaborate the attached specification and design: resolve ambiguities and record assumptions.' })
  const elaborationPath = await workspace.writeArtifact('elaboration.md', elaboration)

  const plan = await step(planPhase, { inputs: [specPath, designPath, elaborationPath], task: 'Break the attached specification, design, and elaboration into an ordered plan of small, shippable steps.' })
  const planPath = await workspace.writeArtifact('plan.md', plan)

  /* Initial implementation. The coder edits the working tree; its handoff is the
     diff, captured in the loop below — not a written artifact. */
  await step(codePhase, {
    inputs: [planPath, specPath, designPath, elaborationPath],
    task: 'Implement the attached plan in full, following the project conventions.'
  })

  /* Rework loop: verify and review the change; on a clear gate, stop; otherwise
     hand the diff and findings to a fresh coder, up to the cycle limit. */
  let cycles = 0
  let passed = false
  while (true) {
    const diffPath = await workspace.writeArtifact('change.diff', await workspace.captureDiff())

    const testReport = await step(testPhase, {
      inputs: [specPath, planPath, diffPath],
      task: 'Verify the attached change against the specification; report each acceptance criterion with evidence.'
    })
    const testReportPath = await workspace.writeArtifact('test-report.md', testReport)

    const reviewReport = await step(reviewPhase, {
      inputs: [specPath, diffPath],
      task: 'Review the attached change against the specification.'
    })
    const reviewReportPath = await workspace.writeArtifact('review-report.md', reviewReport)

    if (gate(parseTestVerdict(testReport), parseReviewVerdict(reviewReport)) === 'pass') {
      passed = true
      break
    }

    /* Out of rework budget: stop unsatisfied, leaving the reports for the human. */
    if (cycles >= maxCycles) {
      break
    }
    cycles++

    /* A fresh, stateless coder seeded only with the diff and the findings (D4). */
    await step(codePhase, {
      inputs: [diffPath, testReportPath, reviewReportPath],
      task: 'Address the findings in the attached test and review reports. The diff is the change so far.'
    })
  }

  /* Summarize for the human, whether or not the gate cleared. */
  const summary = await step(summaryPhase, {
    inputs: [specPath, designPath, elaborationPath, planPath],
    task: `Summarize this completed pipeline run for a human handoff. The change ${passed ? 'cleared' : 'did not clear'} the quality gate after ${cycles} rework ${cycles === 1 ? 'cycle' : 'cycles'}.`
  })
  await workspace.writeArtifact('summary.md', summary)

  return { passed, cycles, summary, artifactsDir: workspace.dir }
}
