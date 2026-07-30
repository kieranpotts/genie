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
const noUI = {
  hasUI: false,
  ui: { confirm: async () => false },
  sessionManager: { getSessionId: () => 's-01' },
}

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

  it('registers all four hooks', async () => {
    const handlers = await loadExtension(file)
    assert.deepEqual(
      Object.keys(handlers).sort(),
      ['before_agent_start', 'before_provider_request', 'tool_call', 'tool_result']
    )
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

/* Model requests were the last channel the trail said nothing about. The hazard
   is the opposite of the usual one: the event hands over the entire conversation,
   so these tests are mostly about what does NOT reach the file. */
describe('permission-gate model-request logging', () => {
  let dir: string
  let file: string

  const payload = {
    model: 'computer-programmer',
    messages: [
      { role: 'system', content: 'SYSTEM-PROMPT-BODY' },
      { role: 'user', content: 'CONVERSATION-CONTENT' },
    ],
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'permgate-provider-'))
    file = join(dir, 'calls.jsonl')
  })

  it('records the shape of the request', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.before_provider_request({ type: 'before_provider_request', payload }, noUI)

      const lines = await readLines(file)
      assert.equal(lines.length, 1)
      assert.equal(lines[0].kind, 'provider_request')
      assert.equal(lines[0].model, 'computer-programmer')
      assert.equal(lines[0].messages, 2)
      assert.ok(Number(lines[0].approx_bytes) > 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never copies the conversation into the log', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.before_provider_request({ type: 'before_provider_request', payload }, noUI)

      const body = await readFile(file, 'utf8')
      assert.equal(body.includes('SYSTEM-PROMPT-BODY'), false)
      assert.equal(body.includes('CONVERSATION-CONTENT'), false)
      assert.deepEqual(
        Object.keys(JSON.parse(body.trimEnd()) as Record<string, unknown>),
        ['ts', 'kind', 'model', 'messages', 'approx_bytes']
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /* The footgun in this hook's contract: `runner.js` treats any non-undefined
     return as a REPLACEMENT payload, so a stray return value from a logging
     handler would rewrite the request the agent is about to send. */
  it('returns undefined, so it cannot replace the outbound payload', async () => {
    const handlers = await loadExtension(file)
    try {
      const returned = await handlers.before_provider_request(
        { type: 'before_provider_request', payload },
        noUI
      )
      assert.equal(returned, undefined)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /* Several model requests fall inside one turn — the agent loops until it stops
     calling tools — so the turn line is what groups them. */
  it('sits under the turn boundary that groups it', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.before_agent_start({ type: 'before_agent_start', prompt: 'p', systemPrompt: 's' }, noUI)
      await handlers.before_provider_request({ type: 'before_provider_request', payload }, noUI)
      await handlers.tool_call(
        { toolCallId: 'tc_1', toolName: 'mcp_read_file', input: { path: '/workspace/a.ts' } },
        noUI
      )
      await handlers.before_provider_request({ type: 'before_provider_request', payload }, noUI)

      const lines = await readLines(file)
      assert.deepEqual(
        lines.map(l => l.kind ?? l.phase),
        ['turn_start', 'provider_request', 'call', 'provider_request']
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/* Turn markers exist so a reviewer can attribute calls to the instruction that
   caused them without correlating timestamps against a session transcript held
   on another volume under another retention policy. */
describe('permission-gate turn markers', () => {
  let dir: string
  let file: string

  /** A `before_agent_start` event, with the fields that must never be logged. */
  const agentStart = {
    type: 'before_agent_start',
    prompt: 'PROMPT-TEXT-THE-OPERATOR-TYPED',
    systemPrompt: 'SYSTEM-PROMPT-BODY',
    systemPromptOptions: {},
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'permgate-turn-'))
    file = join(dir, 'calls.jsonl')
  })

  it('writes a boundary before the calls it groups, and numbers turns from 1', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.before_agent_start(agentStart, noUI)
      await handlers.tool_call(
        { toolCallId: 'tc_1', toolName: 'mcp_read_file', input: { path: '/workspace/a.ts' } },
        noUI
      )
      await handlers.before_agent_start(agentStart, noUI)
      await handlers.tool_call(
        { toolCallId: 'tc_2', toolName: 'mcp_read_file', input: { path: '/workspace/b.ts' } },
        noUI
      )

      const lines = await readLines(file)
      assert.deepEqual(
        lines.map(l => l.kind ?? l.phase),
        ['turn_start', 'call', 'turn_start', 'call']
      )
      assert.deepEqual(lines.filter(l => l.kind !== undefined).map(l => l.turn), [1, 2])
      assert.equal(lines[0].session, 's-01')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /* `before_agent_start` carries the prompt and the fully assembled system
     prompt. Recording either would put the conversation into the audit trail —
     the failure "paths, never content" exists to prevent. */
  it('never copies the prompt or the system prompt into the log', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.before_agent_start(agentStart, noUI)

      const body = await readFile(file, 'utf8')
      assert.equal(body.includes('PROMPT-TEXT-THE-OPERATOR-TYPED'), false)
      assert.equal(body.includes('SYSTEM-PROMPT-BODY'), false)
      assert.deepEqual(
        Object.keys(JSON.parse(body.trimEnd()) as Record<string, unknown>),
        ['ts', 'kind', 'turn', 'session']
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /* The session id is the only field either handler takes from the context
     rather than the event. A marker is worth less than a working agent, so a
     context that will not give one up costs the field, not the turn. */
  it('records the boundary without a session when the harness exposes none', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.before_agent_start(agentStart, { hasUI: false, ui: { confirm: async () => false } })
      await handlers.before_agent_start(agentStart, {
        hasUI: false,
        ui: { confirm: async () => false },
        sessionManager: { getSessionId: () => { throw new Error('no session') } },
      })

      const lines = await readLines(file)
      assert.equal(lines.length, 2)
      for (const line of lines) {
        assert.equal(line.kind, 'turn_start')
        assert.equal('session' in line, false)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
