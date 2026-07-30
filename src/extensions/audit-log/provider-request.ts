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

  const bytes = serialisedBytes(payload)
  if (bytes !== undefined) {
    shape.approx_bytes = bytes
  }

  return shape
}

/**
 * Byte length of the serialised payload, or `undefined` if it cannot be
 * serialised (a circular reference, a `BigInt`, a throwing getter).
 *
 * The string exists only long enough to be measured. It is never returned, never
 * logged, and nothing else in this module sees it.
 */
function serialisedBytes (payload: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8')
  } catch {
    return undefined
  }
}
