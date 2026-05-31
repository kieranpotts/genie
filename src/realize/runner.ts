/**
 * The phase-runner port for the `/realize` pipeline.
 *
 * `realize` drives a fixed sequence of lifecycle phases, each run in an isolated
 * context by a {@link PhaseRunner}. This module defines only the contract — the
 * value types a phase is described with, and the interface an implementation
 * satisfies. The default implementation runs each phase as a headless `pi`
 * process (see `./runner-pi.ts`); the pipeline depends only on this port, so the
 * execution mechanism can be swapped — an in-process session runner, or a fake
 * for tests — without the pipeline changing.
 *
 * Phases are described *semantically*: a phase declares the capability and the
 * model tier it needs, not concrete tool names or model identifiers. Translating
 * that intent into the underlying mechanism's vocabulary is the implementation's
 * job, so no detail of any one runner leaks across the port.
 */

/**
 * The capability a phase needs, in intent terms. A runner maps each level to the
 * concrete tool permissions of its mechanism.
 *
 * - `read-only` — inspect the workspace; make no changes (eg. `review`).
 * - `author` — additionally write artifact documents, but not run commands (eg. `specify`, `plan`).
 * - `verify` — read and run builds/tests/checks, but not modify source (eg. `test`).
 * - `full` — unrestricted: read, write, and execute (eg. `code`).
 */
export type Access = 'read-only' | 'author' | 'verify' | 'full'

/**
 * The model capability a phase asks for, in intent terms.
 *
 * - `default` — inherit whatever model the pipeline runs under.
 * - `strong` — a higher-capability model, reserved for judgment-heavy phases
 *   (eg. `design`, `review`). What it resolves to is a runner setting.
 */
export type Tier = 'default' | 'strong'

/**
 * A lifecycle phase: a named role with the access and model tier it requires.
 */
export interface Phase {
  /** Stable identifier, eg. `'review'`. Used in logs and artifact names. */
  name: string
  /** The system prompt that gives the phase its role and instructions. */
  systemPrompt: string
  /** The capability the phase needs; a runner maps it to concrete permissions. */
  access: Access
  /** The model tier the phase asks for. */
  tier: Tier
  /** Name of the workflow skill this phase should load, if any. */
  skill?: string
}

/**
 * The work handed to a phase for a single run.
 */
export interface PhaseTask {
  /** Paths to artifacts the phase should read first, in order. */
  inputs: string[]
  /** The instruction telling the phase what to do. */
  task: string
}

/**
 * The outcome of running a phase.
 */
export interface PhaseResult {
  /** Whether the phase completed successfully (eg. the process exited zero). */
  ok: boolean
  /** The captured output — the handoff text a downstream phase consumes. */
  output: string
}

/**
 * Runs a single phase in an isolated context and returns its result. The one
 * seam the pipeline depends on; implementations choose the execution mechanism.
 */
export interface PhaseRunner {
  run (phase: Phase, task: PhaseTask): Promise<PhaseResult>
}
