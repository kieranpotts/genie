/**
 * The extractor that stands between the outbound conversation and the audit
 * trail.
 *
 * `before_provider_request` hands over the whole payload — system prompt, every
 * message, every file the agent has read — so these tests are as much about what
 * the result does NOT contain as about what it does.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { describeProviderRequest } from '../../../src/extensions/secret-sentry/provider-request.ts'

/** An OpenAI-completions body, which is the shape this stack's LiteLLM route
 * sends. The message bodies are the thing that must not survive extraction. */
const openAiPayload = {
  model: 'computer-programmer',
  stream: true,
  messages: [
    { role: 'system', content: 'SYSTEM-PROMPT-BODY' },
    { role: 'user', content: 'READ THE FILE' },
    { role: 'assistant', content: 'SECRET-FILE-CONTENTS-FROM-A-TOOL-RESULT' },
  ],
  tools: [{ type: 'function', function: { name: 'mcp_read_file' } }],
}

describe('describeProviderRequest', () => {
  it('takes the model, the message count, and the size', () => {
    const shape = describeProviderRequest(openAiPayload)
    assert.equal(shape.model, 'computer-programmer')
    assert.equal(shape.messages, 3)
    assert.equal(shape.approx_bytes, Buffer.byteLength(JSON.stringify(openAiPayload), 'utf8'))
  })

  /* The point of the module. A reviewer must be able to see that a request went
     out and how big it was, without the trail becoming a second copy of the
     conversation. */
  it('carries no message content, no prompt, and no tool definitions', () => {
    const serialised = JSON.stringify(describeProviderRequest(openAiPayload))
    assert.equal(serialised.includes('SYSTEM-PROMPT-BODY'), false)
    assert.equal(serialised.includes('READ THE FILE'), false)
    assert.equal(serialised.includes('SECRET-FILE-CONTENTS-FROM-A-TOOL-RESULT'), false)
    assert.equal(serialised.includes('mcp_read_file'), false)
  })

  /* The key set is closed, so a payload carrying extra fields cannot widen the
     record. This is the guard against a future edit that spreads the payload. */
  it('yields only the three known keys, whatever else the payload holds', () => {
    const shape = describeProviderRequest({
      ...openAiPayload,
      temperature: 0.2,
      metadata: { user: 'pi', notes: 'SHOULD-NOT-APPEAR' },
    })
    assert.deepEqual(Object.keys(shape).sort(), ['approx_bytes', 'messages', 'model'])
  })

  it('counts Google\'s `contents` as messages too', () => {
    const shape = describeProviderRequest({ model: 'gemini', contents: [{}, {}] })
    assert.equal(shape.messages, 2)
  })

  /* An absent field must mean "the payload did not carry this", never "the value
     was zero" — a logged 0 would be a claim about the request. */
  it('omits fields the payload does not carry rather than inventing values', () => {
    const shape = describeProviderRequest({ stream: true })
    assert.equal('model' in shape, false)
    assert.equal('messages' in shape, false)
    assert.equal(shape.approx_bytes, Buffer.byteLength('{"stream":true}', 'utf8'))
  })

  it('reports an empty message list as 0, which is a fact rather than an absence', () => {
    assert.equal(describeProviderRequest({ messages: [] }).messages, 0)
  })

  it('ignores a model field that is not a non-empty string', () => {
    assert.equal('model' in describeProviderRequest({ model: '' }), false)
    assert.equal('model' in describeProviderRequest({ model: 42 }), false)
  })

  /* Total by design: describing a request must never be able to fail one. */
  it('yields an empty shape for a payload it cannot read', () => {
    assert.deepEqual(describeProviderRequest(undefined), {})
    assert.deepEqual(describeProviderRequest(null), {})
    assert.deepEqual(describeProviderRequest('a string'), {})
  })

  it('omits the size, rather than throwing, when the payload cannot be serialised', () => {
    const circular: Record<string, unknown> = { model: 'm', messages: [{}] }
    circular.self = circular
    const shape = describeProviderRequest(circular)
    assert.equal(shape.model, 'm')
    assert.equal(shape.messages, 1)
    assert.equal('approx_bytes' in shape, false)
  })
})
