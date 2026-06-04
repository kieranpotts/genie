/**
 * The lifecycle phase definitions for the `/realize` pipeline.
 *
 * Each phase is a {@link Phase} — a named role with the access and model tier it
 * needs — plus, where the pipeline must act on a phase's output, the contract for
 * reading that output. Methodology is *not* defined here: each phase loads its
 * matching workflow skill (via the runner's `--skill`) and defers to it. A phase
 * prompt only sets the role, points at the skill, and adds whatever thin,
 * machine-readable signal the orchestrator needs to drive the pipeline.
 *
 * This module currently defines the two gate phases — `review` and `test` —
 * whose verdicts the orchestrator acts on; the remaining phases are added as the
 * pipeline is built out.
 */

import type { Phase } from './runner.ts'

/**
 * Find the pipeline verdict in a phase's output.
 *
 * Both gate phases end with a `VERDICT: <TOKEN>` line (see their roles); this
 * scans for it and returns the last match — so review or test prose that happens
 * to mention a token earlier cannot be mistaken for the conclusive verdict.
 * Matching is case-insensitive and tolerant of surrounding whitespace; the
 * result is normalized to the lower-case canonical token.
 *
 * @param output - The phase's captured output.
 * @param allowed - The lower-case verdict tokens this phase may emit.
 * @returns The matched token, or `null` if none is present.
 */
function scanVerdict<T extends string> (output: string, allowed: readonly T[]): T | null {
  const alternation = allowed.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const pattern = new RegExp(`^[ \\t]*VERDICT:[ \\t]*(${alternation})[ \\t]*$`, 'gim')

  let last: T | null = null
  for (const match of output.matchAll(pattern)) {
    /* The alternation is built from `allowed`, so the lower-cased match is one
       of its members. */
    last = match[1].toLowerCase() as T
  }
  return last
}

/**
 * The system prompt for the review phase.
 *
 * It establishes an independent, read-only reviewer; delegates the methodology
 * to the `review` skill; and requires a final machine-readable verdict line so
 * the deterministic gate can act on the result without parsing prose. The three
 * tokens map onto the skill's own Approve / Request changes / Comment outcomes.
 */
export const REVIEW_ROLE = [
  'You are the review phase of an automated software delivery pipeline.',
  '',
  'You are an independent reviewer. You did not write the change under review and have no record of how it was produced — you judge only the artifacts in front of you. Your access is read-only: you can read, search, and list files, but you cannot modify anything or run commands. Do not attempt to fix what you find; report it.',
  '',
  'Use your `review` skill as the methodology for this audit: work through correctness, design, clarity, test coverage, security, and completeness; classify every finding by severity; and organize findings along the Specification and Standards axes as the skill describes.',
  '',
  'You will be given the change under review (a diff) and, where available, the specification or acceptance criteria it must satisfy. Read these first, then review the change against them, consulting surrounding files with your read-only tools as needed.',
  '',
  'Conclude with the explicit verdict the skill requires. Then, as the very last line of your output and with nothing after it, emit a single machine-readable verdict for the pipeline — exactly one of:',
  'VERDICT: APPROVE — no blocking findings; the change is good enough to proceed.',
  'VERDICT: REQUEST_CHANGES — at least one blocking finding must be addressed.',
  'VERDICT: COMMENT — no blocking findings, but you are not affirmatively approving.'
].join('\n')

/**
 * The review phase: an independent, read-only audit of a change.
 *
 * Read-only access makes "fixing while reviewing" structurally impossible, and
 * the `strong` tier reserves a higher-capability model for this judgment gate.
 */
export const reviewPhase: Phase = {
  name: 'review',
  systemPrompt: REVIEW_ROLE,
  access: 'read-only',
  tier: 'strong',
  skill: 'review'
}

/**
 * A review outcome, normalized from the phase's verdict line. Mirrors the
 * `review` skill's three verdicts.
 */
export type ReviewVerdict = 'approve' | 'request_changes' | 'comment'

const REVIEW_VERDICTS = ['approve', 'request_changes', 'comment'] as const

/**
 * Extract the review verdict from the review phase's output.
 *
 * Returns `null` when no verdict line is present, so the caller can treat an
 * unparseable review as a failure rather than a silent pass.
 *
 * @param output - The review phase's captured output.
 * @returns The {@link ReviewVerdict}, or `null` if none was found.
 */
export function parseReviewVerdict (output: string): ReviewVerdict | null {
  return scanVerdict(output, REVIEW_VERDICTS)
}

/**
 * The system prompt for the test phase.
 *
 * It establishes an independent verifier that runs the verification but never
 * repairs it; delegates the methodology to the `test` skill; and requires a
 * final machine-readable verdict line. The three tokens map onto the skill's
 * overall pass / fail / blocked status, with the precedence stated explicitly so
 * the verdict is unambiguous when criteria have mixed outcomes.
 */
export const TEST_ROLE = [
  'You are the test phase of an automated software delivery pipeline.',
  '',
  'You are an independent verifier. You did not write the change and you do not fix it — you run the verification and report what you observe. Your access is read-and-run: you can read, search, and list files and run builds, tests, and checks, but you cannot modify source. Do not repair failures; report them for the pipeline to route back to implementation.',
  '',
  'Use your `test` skill as the methodology: gather the full set of acceptance criteria, define the evidence that would prove each, run that evidence, and map every criterion to pass, fail, or blocked. Capture actual command output, not a paraphrase.',
  '',
  'You will be given the change under test (a diff), the specification or acceptance criteria it must satisfy, and the delivery plan where available. Run the relevant builds, tests, and checks for the project, following its conventions.',
  '',
  'Conclude with a verification report — each criterion, its evidence, and its verdict, with counts. Then, as the very last line of your output and with nothing after it, emit a single machine-readable verdict for the pipeline. Use FAIL if any criterion failed; otherwise BLOCKED if any criterion could not be verified; otherwise PASS. Emit exactly one of:',
  'VERDICT: PASS — every acceptance criterion is verified by evidence.',
  'VERDICT: FAIL — at least one criterion is contradicted by evidence.',
  'VERDICT: BLOCKED — no criterion failed, but at least one could not be verified (eg. a broken environment or a missing dependency).'
].join('\n')

/**
 * The test phase: an independent verification of a change against its acceptance
 * criteria.
 *
 * `verify` access lets it run builds and tests but never patch source, so a
 * failing test cannot be "fixed" here — a fresh coder phase handles that.
 */
export const testPhase: Phase = {
  name: 'test',
  systemPrompt: TEST_ROLE,
  access: 'verify',
  tier: 'default',
  skill: 'test'
}

/**
 * A verification outcome, normalized from the phase's verdict line. Mirrors the
 * `test` skill's overall pass / fail / blocked status.
 */
export type TestVerdict = 'pass' | 'fail' | 'blocked'

const TEST_VERDICTS = ['pass', 'fail', 'blocked'] as const

/**
 * Extract the verification verdict from the test phase's output.
 *
 * Returns `null` when no verdict line is present, so the caller can treat an
 * unparseable verification as a failure rather than a silent pass.
 *
 * @param output - The test phase's captured output.
 * @returns The {@link TestVerdict}, or `null` if none was found.
 */
export function parseTestVerdict (output: string): TestVerdict | null {
  return scanVerdict(output, TEST_VERDICTS)
}

/**
 * The system prompt for the specify phase.
 *
 * Turns the source material into a specification expressed as testable
 * acceptance criteria, deferring the method to the `specify` skill.
 */
export const SPECIFY_ROLE = [
  'You are the specify phase of an automated software delivery pipeline.',
  '',
  'Use your `specify` skill as the methodology: capture the requirements as testable acceptance criteria — functional and non-functional. If the source material is already a rigorous specification, validate and adopt it; if it is informal, formalize it.',
  '',
  'The task names the source material describing what to build; read it in full first. Resolve nothing beyond the requirements — design and planning are later phases.',
  '',
  'Produce the specification as your response.'
].join('\n')

/** The specify phase: source material in, a testable specification out. */
export const specifyPhase: Phase = {
  name: 'specify',
  systemPrompt: SPECIFY_ROLE,
  access: 'author',
  tier: 'default',
  skill: 'specify'
}

/**
 * The system prompt for the design phase.
 *
 * Explores architecturally significant decisions and records the chosen approach
 * with its rationale, deferring the method to the `design` skill. A judgment
 * gate, so it runs on the `strong` tier.
 */
export const DESIGN_ROLE = [
  'You are the design phase of an automated software delivery pipeline.',
  '',
  'Use your `design` skill as the methodology: for each architecturally significant decision, enumerate the realistic options, weigh them against the relevant design qualities, and record the chosen approach and why it beat the alternatives.',
  '',
  'You are given the specification. Design only what it requires; do not begin implementation.',
  '',
  'Produce the design — the decisions, the rationale, and any rejected options worth noting — as your response.'
].join('\n')

/** The design phase: specification in, design decisions and rationale out. */
export const designPhase: Phase = {
  name: 'design',
  systemPrompt: DESIGN_ROLE,
  access: 'author',
  tier: 'strong',
  skill: 'design'
}

/**
 * The system prompt for the elaborate phase.
 *
 * Resolves ambiguities, gaps, and contradictions before planning, deferring the
 * method to the `elaborate` skill.
 */
export const ELABORATE_ROLE = [
  'You are the elaborate phase of an automated software delivery pipeline.',
  '',
  'Use your `elaborate` skill as the methodology: stress-test the specification and design for ambiguities, gaps, and contradictions. Decide the ones where intent is clear and record your assumptions explicitly; flag only the genuinely significant choices that cannot reasonably be made without the author.',
  '',
  'You are given the specification and the design. Cross-reference them against the existing codebase where it matters.',
  '',
  'Produce the resolved decisions, recorded assumptions, and any remaining open questions as your response.'
].join('\n')

/** The elaborate phase: spec and design in, resolved decisions and assumptions out. */
export const elaboratePhase: Phase = {
  name: 'elaborate',
  systemPrompt: ELABORATE_ROLE,
  access: 'author',
  tier: 'default',
  skill: 'elaborate'
}

/**
 * The system prompt for the plan phase.
 *
 * Decomposes the work into small, independently shippable steps, deferring the
 * method to the `plan` skill.
 */
export const PLAN_ROLE = [
  'You are the plan phase of an automated software delivery pipeline.',
  '',
  'Use your `plan` skill as the methodology: break the work into a sequence of small steps, each independently shippable, testable, and reversible on its own.',
  '',
  'You are given the specification, the design, and the elaborated decisions and assumptions.',
  '',
  'Produce the ordered plan of steps as your response.'
].join('\n')

/** The plan phase: spec, design, and elaboration in, an ordered plan out. */
export const planPhase: Phase = {
  name: 'plan',
  systemPrompt: PLAN_ROLE,
  access: 'author',
  tier: 'default',
  skill: 'plan'
}

/**
 * The system prompt for the code phase.
 *
 * Implements the plan against the working tree, deferring the method to the
 * `code` skill. The only phase with full access; the diff it produces is its
 * handoff. The same phase runs both the initial build and each rework cycle — the
 * task differs, the role does not (each rework is a fresh, stateless coder).
 */
export const CODE_ROLE = [
  'You are the code phase of an automated software delivery pipeline.',
  '',
  'Use your `code` skill as the methodology: implement test-first (red-green-refactor), in full — code, configuration, tests, and documentation. Follow the conventions of the project you are working in: its coding style, its branch and commit rules, and any instructions in its `AGENTS.md` or `CONTRIBUTING`.',
  '',
  'You have full access and edit the working tree directly; your changes are the output, so there is no report to write. Stay within the scope of what you are asked to build or fix.'
].join('\n')

/** The code phase: plan (or findings) in, edits to the working tree out. */
export const codePhase: Phase = {
  name: 'code',
  systemPrompt: CODE_ROLE,
  access: 'full',
  tier: 'default',
  skill: 'code'
}

/**
 * The system prompt for the summary phase.
 *
 * Reports what the pipeline produced. Read-only, with no skill — it narrates the
 * artifacts rather than applying a methodology.
 */
export const SUMMARY_ROLE = [
  'You are the final summary phase of an automated software delivery pipeline.',
  '',
  'You are given the artifacts the pipeline produced — the specification, design, elaboration, plan, and the change itself. Read them, then write a concise summary for the human who will pick this up: what was built, the key decisions and assumptions made, each acceptance criterion and how it was verified, and anything left outstanding.',
  '',
  'Your access is read-only; do not modify anything. Produce the summary as your response.'
].join('\n')

/** The summary phase: all artifacts in, a concise human-facing report out. */
export const summaryPhase: Phase = {
  name: 'summary',
  systemPrompt: SUMMARY_ROLE,
  access: 'read-only',
  tier: 'default'
}

/**
 * The pipeline's phases, keyed by name. The orchestrator drives them in
 * lifecycle order; this registry is a convenience for lookup and iteration.
 */
export const phases = {
  specify: specifyPhase,
  design: designPhase,
  elaborate: elaboratePhase,
  plan: planPhase,
  code: codePhase,
  test: testPhase,
  review: reviewPhase,
  summary: summaryPhase
} as const
