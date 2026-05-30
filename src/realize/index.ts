/**
 * Adds a `/realize` command that hands a specification to the agent and makes
 * it fully responsible for implementing it.
 *
 * The single argument is the spec's source: a local file, a local directory of
 * artifacts, or a URL (a GitHub issue/PR is resolved through the `gh` CLI when
 * available, otherwise fetched as a plain web page). The extension only
 * classifies the source and builds a prompt pointing the agent at it; the agent
 * reads the source and carries out the whole implementation itself.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { resolveSource, type ResolvedSource } from './source.ts'
import { buildRealizePrompt } from './prompt.ts'

export default function (pi: ExtensionAPI) {
  pi.registerCommand('realize', {
    description: 'Hand a specification (file, directory, or URL) to the agent to implement in full',
    handler: async (args, ctx) => {
      const source = args.trim()

      /* A source is required — there is nothing to realize without one. */
      if (!source) {
        ctx.ui.notify('Usage: /realize <file | directory | url>', 'error')
        return
      }

      let resolved: ResolvedSource
      try {
        resolved = await resolveSource(source)
      } catch (error) {
        /* Most likely a path that does not exist or cannot be read. */
        const message = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`Cannot read spec source: ${message}`, 'error')
        return
      }

      /* Hand the spec off. Invoked while idle, so this triggers a fresh turn. */
      pi.sendUserMessage(buildRealizePrompt(resolved))
    }
  })
}
