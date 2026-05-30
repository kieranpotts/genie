/**
 * Replaces the default "Working..." status with humorous messages to make
 * waiting for the AI more entertaining.
 *
 * Each message is composed on-the-fly by pairing a random present participle
 * with a random noun, eg. "Pickling gnomes...".
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { randomMessage } from './messages.ts'

export default function (pi: ExtensionAPI) {
  let currentMessage: string | undefined

  /**
   * When the agent starts processing, show a freshly composed message.
   */
  pi.on('agent_start', async (_event, ctx) => {
    currentMessage = randomMessage()
    ctx.ui.setWorkingMessage(currentMessage)
  })

  /**
   * When the agent finishes, restore the default working indicator.
   */
  pi.on('agent_end', async (_event, ctx) => {
    ctx.ui.setWorkingMessage() /* Clear/restore default. */
    currentMessage = undefined
  })

  /**
   * While running, occasionally swap in a new message to keep things lively.
   */
  pi.on('tool_execution_start', async (_event, ctx) => {
    /* Only reroll if a message is already showing, and only ~50% of the time. */
    if (currentMessage && Math.random() > 0.5) {
      currentMessage = randomMessage()
      ctx.ui.setWorkingMessage(currentMessage)
    }
  })
}
