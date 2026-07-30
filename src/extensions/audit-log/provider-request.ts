/**
 * Reduce an outbound model request to its SHAPE, discarding its content.
 *
 * `before_provider_request` hands over `payload: unknown`, and that payload is
 * the entire conversation: the system prompt, every message, and the contents of
 * every file the agent has read this session. Logging it would put a complete
 * copy of everything the agent has touched into the audit trail — worse than the
 * gap it closes, and the exact opposite of the "paths, never content" rule the
 * rest of the trail is built on.
 *
 * So this extracts NAMED SCALARS and never spreads. That is a deliberate
 * discipline rather than a style preference: `payload: unknown` makes
 * serialising the lot the easiest thing to write by accident, and the record
 * would look plausible while carrying the whole context. The extension's test
 * suite asserts the resulting key set is closed for the same reason.
 *
 * `hash` is the one field here that lets a reviewer tie a logged request back
 * to a specific payload without the payload itself ever touching the trail:
 * a SHA-256 digest of the serialised body, taken over the same bytes
 * `approx_bytes` measures. It is a fingerprint, not a decode path — nothing in
 * this file, or anywhere the log is read, can turn a hash back into the
 * conversation it was taken from. Two requests with the same hash carried the
 * same bytes; that is the entire claim it makes.
 *
 * The payload's shape is the PROVIDER's, not Pi's — it is whatever the API
 * client is about to send, so the OpenAI-completions body for this stack's
 * LiteLLM route (`{ model, messages, tools, stream, … }`), and something else
 * for a different provider. Nothing here assumes a shape: each field is read if
 * it is there and OMITTED if it is not, because a `0` or an `""` would be a
 * claim about the request rather than an absence of one.
 *
 * Kept local to this extension rather than factored into a shared module,
 * because the verbatim-copy installer requires each extension directory to be
 * self-contained (no cross-directory imports survive installation).
 */

import { createHash } from 'node:crypto'

/** The shape of one outbound model request. Every field is optional: an absent
 * field means the payload did not carry it, never that its value was zero. */
export interface ProviderRequestShape {
  /** The model id as it appears in the outbound body — what was actually asked
   * for, not what Pi has selected in its own state. */
  model?: string
  /** How many messages the request carries. */
  messages?: number
  /** Size of the serialised body in bytes. "approx" because it measures the
   * JSON this handler can see, not the bytes on the wire: headers, compression,
   * and any provider-side re-encoding are all outside it. It exists to make
   * context growth visible WITHOUT recording the context. */
  approx_bytes?: number
  /** SHA-256 digest, hex-encoded, of the same serialised body `approx_bytes`
   * measures. A fingerprint for tying a logged request to a specific payload
   * after the fact — never a means of recovering the payload from the log. */
  hash?: string
}

/**
 * Extract the shape of a model request. Pure, total, and never throws: a
 * payload it cannot read yields an empty shape rather than an error, because a
 * failure to describe a request must not fail the request.
 */
export function describeProviderRequest (payload: unknown): ProviderRequestShape {
  if (payload === null || typeof payload !== 'object') return {}
  const body = payload as Record<string, unknown>

  const shape: ProviderRequestShape = {}

  if (typeof body.model === 'string' && body.model.length > 0) {
    shape.model = body.model
  }

  /* `messages` for the OpenAI and Anthropic shapes, `contents` for Google's.
     Counted rather than read — the count is the shape, the array is the
     conversation. */
  const messages = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.contents) ? body.contents : undefined
  if (messages !== undefined) {
    shape.messages = messages.length
  }

  const serialised = serialise(payload)
  if (serialised !== undefined) {
    shape.approx_bytes = Buffer.byteLength(serialised, 'utf8')
    shape.hash = createHash('sha256').update(serialised, 'utf8').digest('hex')
  }

  return shape
}

/**
 * The payload serialised to JSON, or `undefined` if it cannot be (a circular
 * reference, a `BigInt`, a throwing getter).
 *
 * The string exists only long enough for `approx_bytes` and `hash` to be
 * derived from it. It is never returned, never logged, and nothing else in
 * this module sees it.
 */
function serialise (payload: unknown): string | undefined {
  try {
    return JSON.stringify(payload) ?? undefined
  } catch {
    return undefined
  }
}
