/**
 * Shared tool-result shapes for the audited tool replacements.
 *
 * Both the filesystem tools (`register-fs.ts`) and the command tool
 * (`register-bash.ts`) return results in the same `{ content, isError }` shape
 * Pi expects, so those constructors live here rather than being duplicated.
 */

/** A denied/errored tool result carrying a message back to the model. */
export function fail (message: string): unknown {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** A successful tool result. */
export function ok (text: string): unknown {
  return { content: [{ type: 'text', text }], isError: false }
}
