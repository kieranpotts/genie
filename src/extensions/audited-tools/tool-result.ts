/**
 * Tool-result shapes for the audited tool replacement.
 *
 * The command tool (`register-bash.ts`) returns results in the `{ content,
 * isError }` shape Pi expects. These constructors keep that shape in one place,
 * so a second audited tool would not have to restate it.
 */

/** A denied/errored tool result carrying a message back to the model. */
export function fail (message: string): unknown {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** A successful tool result. */
export function ok (text: string): unknown {
  return { content: [{ type: 'text', text }], isError: false }
}
