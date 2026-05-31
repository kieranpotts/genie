/**
 * Adds a `/realize` command that hands one or more specifications to the agent
 * and makes it fully responsible for implementing them.
 *
 * Each space-separated argument is a spec source: a local file or directory, a
 * `file://` or http(s) URL, or a GitHub issue/PR (the `owner/repo#42` shorthand
 * and full URLs both work; resolved through the `gh` CLI when available,
 * otherwise fetched as a plain web page). The extension only classifies the
 * sources and builds a prompt pointing the agent at them; the agent reads the
 * sources and carries out the whole implementation itself.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { resolveSource, type ResolvedSource } from './source.ts'
import { buildRealizePrompt } from './prompt.ts'

export default function (pi: ExtensionAPI) {
  pi.registerCommand('realize', {
    description: 'Hand one or more specification sources (file, directory, URL, or GitHub issue/PR) to the agent to implement in full',
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

      /* Hand the spec off. Invoked while idle, so this triggers a fresh turn. */
      pi.sendUserMessage(buildRealizePrompt(resolved))
    }
  })
}
