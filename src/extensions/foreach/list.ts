/**
 * List parsing for the `/foreach` command.
 *
 * The list is a plain text file, one item per line. Blank lines and `#`
 * comment lines are skipped, so a list can be annotated. Parsing is pure — the
 * command handler is responsible for reading the file's contents first.
 */

/**
 * Parse list file contents into an ordered array of items.
 *
 * @param contents - The raw text of the list file.
 * @returns The non-blank, non-comment lines, trimmed, in file order.
 */
export function parseList (contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
}
