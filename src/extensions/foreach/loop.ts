/**
 * The deterministic orchestrator for the `/foreach` loop.
 *
 * Applies one instruction (or skill) to each item of a list, sequentially, each
 * in its own isolated subagent via an {@link ItemRunner}. Unlike `realize`'s
 * pipeline, there is no handoff between steps and no gate: every item runs
 * regardless of how the previous one went, and the loop reports a final
 * pass/fail tally rather than blocking on the first failure. This is a map, not
 * a pipeline — items are independent by design (see the README).
 */

import type { ItemRunner } from './runner.ts'
import type { ParsedInstruction } from './instruction.ts'
import { buildItemTask } from './instruction.ts'
import type { Workspace } from './workspace.ts'
import { itemFileStem } from './workspace.ts'

/** The per-item outcome recorded in a {@link LoopResult}. */
export interface ItemOutcome {
  /** The list item this outcome is for. */
  item: string
  /** Whether the item's subagent completed successfully. */
  ok: boolean
  /** The artifact path its output (or failure detail) was written to. */
  artifactPath: string
}

/** The outcome of a full `/foreach` run. */
export interface LoopResult {
  /** One outcome per list item, in list order. */
  outcomes: ItemOutcome[]
  /** Count of items whose subagent completed successfully. */
  succeeded: number
  /** Count of items whose subagent failed. */
  failed: number
}

/** Settings for {@link runLoop}. */
export interface LoopOptions {
  /** Called with an item's 1-based position and total just before it runs. */
  onItemStart?: (position: number, total: number) => void
}

/**
 * Run the `/foreach` loop: apply `instruction` to each of `items`, in order,
 * each via a fresh call to `runner.run`. Every item runs regardless of prior
 * failures; the run's own progress is never interrupted by an individual
 * item's outcome.
 *
 * @param instruction - The classified instruction shared by every item.
 * @param items - The list items to loop over, in order.
 * @param runner - Executes each item's task in isolation.
 * @param workspace - Stores each item's output artifact.
 * @param options - Optional settings (eg. progress reporting).
 * @returns The run outcome: per-item results and the pass/fail tally.
 */
export async function runLoop (
  instruction: ParsedInstruction,
  items: string[],
  runner: ItemRunner,
  workspace: Workspace,
  options: LoopOptions = {}
): Promise<LoopResult> {
  const outcomes: ItemOutcome[] = []
  let succeeded = 0
  let failed = 0

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    options.onItemStart?.(i + 1, items.length)

    const task = buildItemTask(instruction, item)
    const result = await runner.run(task)

    const stem = itemFileStem(i, items.length)
    const artifactPath = await workspace.writeArtifact(`item-${stem}.md`, result.output)

    outcomes.push({ item, ok: result.ok, artifactPath })
    if (result.ok) {
      succeeded++
    } else {
      failed++
    }
  }

  return { outcomes, succeeded, failed }
}
