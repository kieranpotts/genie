/**
 * Wiring tests for the extension entry point.
 *
 * `call-log.test.ts` asserts the record FORMAT; these assert that the handlers
 * are registered and emit the right records for a realistic sequence of events.
 * That glue was previously uncovered, and it now has to coordinate two hooks
 * rather than one.
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

/** Load the extension against a stub API, logging to `file`. */
async function loadExtension (file: string): Promise<Record<string, Handler>> {
  const handlers: Record<string, Handler> = {}
  process.env.PERMISSION_GATE_CALL_LOG = file
  const module = await import('../../../src/extensions/permission-gate/index.ts')
  const register = module.default as (pi: { on: (e: string, h: Handler) => void }) => void
  register({ on: (event, handler) => { handlers[event] = handler } })
  return handlers
}

/** A context with no interactive UI, which the gate treats as default-deny. */
const noUI = { hasUI: false, ui: { confirm: async () => false } }

async function readLines (file: string): Promise<Array<Record<string, string>>> {
  const body = await readFile(file, 'utf8')
  return body.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, string>)
}

describe('permission-gate wiring', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'permgate-wire-'))
    file = join(dir, 'calls.jsonl')
  })

  it('registers both the tool_call and tool_result hooks', async () => {
    const handlers = await loadExtension(file)
    assert.deepEqual(Object.keys(handlers).sort(), ['tool_call', 'tool_result'])
    await rm(dir, { recursive: true, force: true })
  })

  /* The gap the tool_result hook exists to close: the gate admits a read, the
     MCP server refuses it. Before this, the trail asserted a read that never
     happened. */
  it('records an admitted call whose result errored as allowed-then-error', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.tool_call(
        { toolCallId: 'tc_1', toolName: 'mcp_read_file', input: { path: '/workspace/../etc/passwd' } },
        noUI
      )
      await handlers.tool_result(
        {
          toolCallId: 'tc_1',
          toolName: 'mcp_read_file',
          input: { path: '/workspace/../etc/passwd' },
          content: [{ type: 'text', text: 'irrelevant' }],
          isError: true,
        },
        noUI
      )

      const lines = await readLines(file)
      assert.equal(lines.length, 2)
      assert.equal(lines[0].phase, 'call')
      assert.equal(lines[0].outcome, 'allowed')
      assert.equal(lines[1].phase, 'result')
      assert.equal(lines[1].result, 'error')
      assert.equal(lines[0].id, lines[1].id, 'the two lines must be joinable')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('records a successful call as allowed-then-ok', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.tool_call(
        { toolCallId: 'tc_2', toolName: 'mcp_list_directory', input: { path: '/workspace' } },
        noUI
      )
      await handlers.tool_result(
        {
          toolCallId: 'tc_2',
          toolName: 'mcp_list_directory',
          input: {},
          content: [{ type: 'text', text: 'a.ts' }],
          isError: false,
        },
        noUI
      )

      const lines = await readLines(file)
      assert.equal(lines[1].result, 'ok')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /* A sensitive-file refusal never reaches the tool, so it has no result line.
     The absence is unambiguous: the call line already says blocked, and why. */
  it('writes no result line for a call the gate refused', async () => {
    const handlers = await loadExtension(file)
    try {
      const outcome = await handlers.tool_call(
        { toolCallId: 'tc_3', toolName: 'mcp_read_file', input: { path: '/workspace/.env' } },
        noUI
      ) as { block?: boolean }

      assert.equal(outcome.block, true)
      const lines = await readLines(file)
      assert.equal(lines.length, 1)
      assert.equal(lines[0].phase, 'call')
      assert.equal(lines[0].outcome, 'blocked')
      assert.equal(lines[0].confirmation, 'not-offered')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /* The result event carries the tool's ENTIRE output. Copying it into the
     trail would make the audit log a second copy of every secret the agent has
     read, which is the opposite of the point. */
  it('never copies tool output into the log', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.tool_call(
        { toolCallId: 'tc_4', toolName: 'mcp_read_file', input: { path: '/workspace/a.ts' } },
        noUI
      )
      await handlers.tool_result(
        {
          toolCallId: 'tc_4',
          toolName: 'mcp_read_file',
          input: { path: '/workspace/a.ts' },
          content: [{ type: 'text', text: 'SUPER-SECRET-FILE-BODY' }],
          isError: false,
        },
        noUI
      )

      const body = await readFile(file, 'utf8')
      assert.equal(body.includes('SUPER-SECRET-FILE-BODY'), false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
