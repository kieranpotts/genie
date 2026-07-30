/**
 * Wiring tests for the extension entry point.
 *
 * `security-log.test.ts` asserts the record FORMAT; these assert that the
 * handlers are registered and emit the right records for a realistic
 * sequence of events.
 *
 * The `ExtensionAPI` is stubbed rather than imported: the real one belongs to a
 * running harness, and the only surface this entry point uses is `pi.on`.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>

/** The two hooks this extension registers, keyed by event name. */
interface Handlers {
  tool_call: Handler
  tool_result: Handler
}

/** Load the extension against a stub API, logging to `file`. */
async function loadExtension (file: string): Promise<Handlers> {
  const handlers: Partial<Handlers> = {}
  process.env.SECRET_SENTRY_SECURITY_LOG = file
  const module = await import('../../../src/extensions/secret-sentry/index.ts')
  const register = module.default as (pi: { on: (e: keyof Handlers, h: Handler) => void }) => void
  register({ on: (event, handler) => { handlers[event] = handler } })
  return handlers as Handlers
}

const ctx = {}

async function readLines (file: string): Promise<Array<Record<string, string>>> {
  const body = await readFile(file, 'utf8')
  return body.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, string>)
}

describe('secret-sentry wiring', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'secret-sentry-wire-'))
    file = join(dir, 'security.jsonl')
  })

  it('registers exactly the two hooks that decide and redact', async () => {
    const handlers = await loadExtension(file)
    assert.deepEqual(Object.keys(handlers).sort(), ['tool_call', 'tool_result'])
    await rm(dir, { recursive: true, force: true })
  })

  /* An allowed call is not this extension's to record any more — that is
     `audit-log`'s job. This extension writes nothing at all for it. */
  it('writes nothing for a call it does not refuse', async () => {
    const handlers = await loadExtension(file)
    try {
      const outcome = await handlers.tool_call(
        { toolCallId: 'tc_1', toolName: 'mcp_read_file', input: { path: '/workspace/a.ts' } },
        ctx
      )
      assert.equal(outcome, undefined)

      const body = await readFile(file, 'utf8').catch(() => '')
      assert.equal(body, '', 'no file should even be created')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /* There is no confirmation gate here: a mutating call proceeds exactly like
     a read, unprompted, and this extension writes nothing about either.
     Unattended operation means there is nobody to ask. */
  it('lets a mutating call proceed unprompted and unrecorded', async () => {
    const handlers = await loadExtension(file)
    try {
      const outcome = await handlers.tool_call(
        { toolCallId: 'tc_w', toolName: 'mcp_write_file', input: { path: '/workspace/x.ts', content: 'y' } },
        ctx
      )
      assert.equal(outcome, undefined, 'a call that proceeds returns no block patch')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocks and logs a sensitive-file refusal, with the full path and a reason', async () => {
    const handlers = await loadExtension(file)
    try {
      const outcome = await handlers.tool_call(
        { toolCallId: 'tc_3', toolName: 'mcp_read_file', input: { path: '/workspace/.env' } },
        ctx
      ) as { block?: boolean, reason?: string }

      assert.equal(outcome.block, true)
      assert.ok(outcome.reason?.includes('.env'))

      const lines = await readLines(file)
      assert.equal(lines.length, 1)
      assert.equal(lines[0]!.kind, 'blocked')
      assert.equal(lines[0]!.path, '/workspace/.env')
      assert.equal(typeof lines[0]!.reason, 'string')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/* Redaction is the one thing this extension does that CHANGES what the agent
   sees, so the wiring has two jobs: hand Pi a replacement it will honour, and
   record that it happened without recording what it was. */
describe('secret-sentry tool-output redaction', () => {
  let dir: string
  let file: string

  /** A syntactically valid, deliberately fake GitHub token. */
  const secret = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz'

  const resultEvent = (text: string): Record<string, unknown> => ({
    toolCallId: 'tc_1',
    toolName: 'mcp_read_file',
    input: { path: '/workspace/notes.txt' },
    content: [{ type: 'text', text }],
    isError: false,
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'secret-sentry-redact-'))
    file = join(dir, 'security.jsonl')
  })

  /* Pi replaces the tool result with what this handler returns, and that
     replacement reaches both the model's context and the session transcript. If
     the patch is not returned, the redaction is a no-op that logs as a success —
     the same silent shape as the isError bug. */
  it('returns replacement content with the secret gone', async () => {
    const handlers = await loadExtension(file)
    try {
      const patch = await handlers.tool_result(
        resultEvent(`api key: ${secret}`),
        ctx
      ) as { content: Array<{ text: string }> }

      assert.ok(patch, 'a patch must be returned, or nothing is redacted')
      assert.equal(patch.content[0]!.text, 'api key: [redacted: github-token]')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('records that redaction happened, and which rule fired', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.tool_result(resultEvent(`api key: ${secret}`), ctx)

      const lines = await readLines(file)
      assert.equal(lines[0]!.kind, 'redaction')
      assert.equal(lines[0]!.redactions, 1)
      assert.deepEqual(lines[0]!.rules, ['github-token'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /* The sharpest case of the no-content rule: this record is specifically about
     a secret, so it must describe it without carrying it. */
  it('never writes the secret to the log', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.tool_result(resultEvent(`api key: ${secret}`), ctx)

      const body = await readFile(file, 'utf8')
      assert.equal(body.includes(secret), false)
      assert.equal(body.includes('1234567890abcdef'), false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /* Returning content unconditionally would rewrite every tool result in the
     session — into the transcript as well — for no reason. And with nothing
     redacted, this extension has nothing of its own to record either. */
  it('returns no patch, and writes nothing, for clean output', async () => {
    const handlers = await loadExtension(file)
    try {
      const patch = await handlers.tool_result(resultEvent('nothing secret here'), ctx)
      assert.equal(patch, undefined)

      const body = await readFile(file, 'utf8').catch(() => '')
      assert.equal(body, '')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /* Fails open, deliberately: a redactor that throws must not break tool
     execution, and nothing is recorded for it either. */
  it('writes nothing when the content is not shaped as expected', async () => {
    const handlers = await loadExtension(file)
    try {
      const patch = await handlers.tool_result(
        { toolCallId: 'tc_9', toolName: 'mcp_read_file', input: {}, content: undefined, isError: false },
        ctx
      )

      assert.equal(patch, undefined)
      const body = await readFile(file, 'utf8').catch(() => '')
      assert.equal(body, '')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
