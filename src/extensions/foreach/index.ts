/**
 * Adds a `/foreach` command that applies one instruction (or skill) to each
 * item of a list, in sequence.
 *
 * `/foreach <instruction> <list-file>` — the instruction is either freeform
 * text or a `/skill-name` reference to an installed workflow skill; the list
 * file is a plain text file, one item per line (blank lines and `#` comments
 * skipped). Each item runs in its own isolated, fresh `pi -p` subagent with no
 * memory of any other item — this is a map over the list, not a pipeline: an
 * item's outcome never affects another's. Every item runs regardless of prior
 * failures, and the run finishes with a pass/fail summary. Progress is shown
 * in the status line; each item's output, and the final summary, are written
 * under `.pi/foreach/<run-id>/`.
 */

import { readFile } from 'node:fs/promises'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { parseForeachArgs } from './args.ts'
import { parseInstruction } from './instruction.ts'
import { parseList } from './list.ts'
import { PiCliRunner } from './runner-pi.ts'
import { createFileWorkspace } from './workspace.ts'
import { runLoop } from './loop.ts'
import { buildSummary } from './summary.ts'

/* Namespaces this extension's status-bar entry; the same key updates and clears it. */
const STATUS_KEY = 'foreach'

export default function (pi: ExtensionAPI) {
  pi.registerCommand('foreach', {
    description: 'Apply an instruction or /skill-name to each line of a list file, one isolated subagent per item',
    handler: async (args, ctx) => {
      const parsed = parseForeachArgs(args)
      if (parsed === null) {
        ctx.ui.notify('Usage: /foreach <instruction | /skill-name> <list-file>', 'error')
        return
      }

      let contents: string
      try {
        contents = await readFile(parsed.listPath, 'utf8')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`Cannot read list file \`${parsed.listPath}\`: ${message}`, 'error')
        return
      }

      const items = parseList(contents)
      if (items.length === 0) {
        ctx.ui.notify(`List file \`${parsed.listPath}\` has no items.`, 'error')
        return
      }

      const instruction = parseInstruction(parsed.instruction)
      const runner = new PiCliRunner(instruction, { cwd: ctx.cwd })
      const workspace = createFileWorkspace(ctx.cwd)

      ctx.ui.notify(`foreach: looping over ${items.length} items — artifacts in ${workspace.dir}`)
      try {
        const result = await runLoop(instruction, items, runner, workspace, {
          onItemStart: (position, total) => ctx.ui.setStatus(STATUS_KEY, `foreach: item ${position}/${total}…`)
        })

        const summary = buildSummary(result)
        await workspace.writeArtifact('summary.md', summary)

        if (result.failed === 0) {
          ctx.ui.notify(`foreach: ${result.succeeded}/${result.outcomes.length} items succeeded. Artifacts in ${workspace.dir}`)
        } else {
          ctx.ui.notify(`foreach: ${result.succeeded}/${result.outcomes.length} items succeeded, ${result.failed} failed. See ${workspace.dir}`, 'warning')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`foreach: ${message}`, 'error')
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined)
      }
    }
  })
}
