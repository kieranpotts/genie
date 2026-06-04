/**
 * Adds a `/realize` command that hands one or more specifications to a
 * multi-phase delivery pipeline and implements them in full.
 *
 * Each space-separated argument is a spec source: a local file or directory, a
 * `file://` or http(s) URL, or a GitHub issue/PR (the `owner/repo#42` shorthand
 * and full URLs both work; resolved through the `gh` CLI when available). The
 * command classifies the sources, then runs the realize pipeline — each
 * lifecycle phase (specify → design → elaborate → plan → code → test → review)
 * in its own isolated context, handing off through artifacts on disk. Progress
 * is shown in the status line; the outcome and artifact location are reported
 * when the run finishes.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { resolveSource, type ResolvedSource } from './source.ts'
import { buildSpecifyTask } from './prompt.ts'
import { PiCliRunner } from './runner-pi.ts'
import { createFileWorkspace } from './workspace.ts'
import { runPipeline } from './pipeline.ts'

/* Namespaces this extension's status-bar entry; the same key updates and clears it. */
const STATUS_KEY = 'realize'

export default function (pi: ExtensionAPI) {
  pi.registerCommand('realize', {
    description: 'Hand one or more specification sources (file, directory, URL, or GitHub issue/PR) to a multi-phase pipeline that implements them in full',
    handler: async (args, ctx) => {
      /* Sources are whitespace-separated, so an individual path may not contain
         spaces; pass such a path as the sole argument instead. */
      const tokens = args.trim().split(/\s+/).filter(Boolean)

      /* At least one source is required — there is nothing to realize without one. */
      if (tokens.length === 0) {
        ctx.ui.notify('Usage: /realize <source> [source …]', 'error')
        return
      }

      const resolved: ResolvedSource[] = []
      for (const token of tokens) {
        try {
          resolved.push(await resolveSource(token))
        } catch (error) {
          /* Most likely a path that does not exist or cannot be read. Name the
             offending token, since there may be several. */
          const message = error instanceof Error ? error.message : String(error)
          ctx.ui.notify(`Cannot read spec source \`${token}\`: ${message}`, 'error')
          return
        }
      }

      /* Each phase runs as a headless pi process in the current project. */
      const runner = new PiCliRunner({ cwd: ctx.cwd })
      const workspace = createFileWorkspace(ctx.cwd)

      ctx.ui.notify(`Realizing specification — artifacts in ${workspace.dir}`)
      try {
        const result = await runPipeline(buildSpecifyTask(resolved), runner, workspace, {
          onPhaseStart: phase => ctx.ui.setStatus(STATUS_KEY, `realize: ${phase}…`)
        })

        const cycles = `${result.cycles} rework ${result.cycles === 1 ? 'cycle' : 'cycles'}`
        if (result.passed) {
          ctx.ui.notify(`realize: passed the quality gate after ${cycles}. Summary and artifacts in ${result.artifactsDir}`)
        } else {
          ctx.ui.notify(`realize: did not pass the quality gate after ${cycles}. See the reports in ${result.artifactsDir}`, 'warning')
        }
      } catch (error) {
        /* A phase failed to run (eg. pi not on PATH, or a non-zero exit). The
           partial artifacts remain on disk for inspection. */
        const message = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`realize: ${message}`, 'error')
      } finally {
        /* Clear the status entry however the run ended (pass undefined to clear). */
        ctx.ui.setStatus(STATUS_KEY, undefined)
      }
    }
  })
}
