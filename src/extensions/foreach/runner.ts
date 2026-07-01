/**
 * The item-runner port for the `/foreach` loop.
 *
 * Each list item is run in its own isolated subagent. This module defines only
 * the contract; the default implementation runs each item as a headless `pi`
 * process (see `./runner-pi.ts`). The loop depends only on this port, so it is
 * unit-tested with a fake runner, with no process spawned.
 */

/** The outcome of running a single item. */
export interface ItemResult {
  /** Whether the subagent completed successfully (eg. the process exited zero). */
  ok: boolean
  /** The captured output, or the error detail if `ok` is `false`. */
  output: string
}

/**
 * Runs a single item's task in an isolated context and returns its result.
 */
export interface ItemRunner {
  run (task: string): Promise<ItemResult>
}
