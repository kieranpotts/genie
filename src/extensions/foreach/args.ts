/**
 * Argument parsing for the `/foreach` command.
 *
 * The command takes two things — a freeform instruction (or a `/skill-name`
 * reference) and a path to a list file — but only one argument string, since
 * Pi commands are not given pre-split argv. The list file path is always the
 * last whitespace-separated token; everything before it is the instruction.
 * This mirrors the common CLI convention of "last argument is the target" and
 * avoids requiring a delimiter that a freeform instruction might otherwise need
 * to contain.
 */

/** A parsed `/foreach` invocation. */
export interface ForeachArgs {
  /** The freeform instruction text, or a `/skill-name` reference, verbatim. */
  instruction: string
  /** The path to the list file, as typed (not yet resolved or read). */
  listPath: string
}

/**
 * Split a `/foreach` argument string into an instruction and a list file path.
 *
 * @param args - The raw argument string passed to the command.
 * @returns The parsed instruction and list path, or `null` if there are fewer
 *   than two whitespace-separated tokens (nothing to loop over).
 */
export function parseForeachArgs (args: string): ForeachArgs | null {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 2) {
    return null
  }
  const listPath = tokens[tokens.length - 1]
  const instruction = tokens.slice(0, -1).join(' ')
  return { instruction, listPath }
}
