/**
 * Wiring tests for the extension entry point.
 *
 * `call-log.test.ts` asserts the record FORMAT; these assert that the handlers
 * are registered and emit the right records for a realistic sequence of events.
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

/** The four hooks this extension registers, keyed by event name. */
interface Handlers {
  tool_call: Handler
  tool_result: Handler
  before_provider_request: Handler
  before_agent_start: Handler
}

/** Load the extension against a stub API, logging to `file`. */
async function loadExtension (file: string): Promise<Handlers> {
  const handlers: Partial<Handlers> = {}
  process.env.AUDIT_LOG_CALL_LOG = file
  const module = await import('../../../src/extensions/audit-log/index.ts')
  const register = module.default as (pi: { on: (e: keyof Handlers, h: Handler) => void }) => void
  register({ on: (event, handler) => { handlers[event] = handler } })
  return handlers as Handlers
}

/** A stub context. This extension never shows a UI, so only `sessionManager`
 * (read by `before_agent_start`) is ever consulted. */
const ctx = {
  sessionManager: { getSessionId: () => 's-01' },
}

async function readLines (file: string): Promise<Array<Record<string, string>>> {
  const body = await readFile(file, 'utf8')
  return body.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, string>)
}

describe('audit-log wiring', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'audit-log-wire-'))
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

  it('never returns a block patch — this extension cannot refuse a call', async () => {
    const handlers = await loadExtension(file)
    try {
      const outcome = await handlers.tool_call(
        { toolCallId: 'tc_1', toolName: 'mcp_read_file', input: { path: '/workspace/.env' } },
        ctx
      )
      assert.equal(outcome, undefined)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /* This extension has no admission decision to record, so its attempt line
     never carries `outcome` or `confirmation` — unlike the single extension
     this was split from. */
  it('logs an attempt with no outcome or confirmation field', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.tool_call(
        { toolCallId: 'tc_1', toolName: 'mcp_list_directory', input: { path: '/workspace' } },
        ctx
      )
      const [line] = await readLines(file)
      assert.ok(line)
      assert.equal(line.phase, 'call')
      assert.equal('outcome' in line, false)
      assert.equal('confirmation' in line, false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('records a call whose result errored, joined by id', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.tool_call(
        { toolCallId: 'tc_1', toolName: 'mcp_read_file', input: { path: '/workspace/../etc/passwd' } },
        ctx
      )
      await handlers.tool_result(
        {
          toolCallId: 'tc_1',
          toolName: 'mcp_read_file',
          input: { path: '/workspace/../etc/passwd' },
          content: [{ type: 'text', text: 'irrelevant' }],
          isError: true,
        },
        ctx
      )

      const lines = await readLines(file)
      assert.equal(lines.length, 2)
      assert.equal(lines[0]!.phase, 'call')
      assert.equal(lines[1]!.phase, 'result')
      assert.equal(lines[1]!.result, 'error')
      assert.equal(lines[0]!.id, lines[1]!.id, 'the two lines must be joinable')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('records a successful call as call-then-ok', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.tool_call(
        { toolCallId: 'tc_2', toolName: 'mcp_list_directory', input: { path: '/workspace' } },
        ctx
      )
      await handlers.tool_result(
        {
          toolCallId: 'tc_2',
          toolName: 'mcp_list_directory',
          input: {},
          content: [{ type: 'text', text: 'a.ts' }],
          isError: false,
        },
        ctx
      )

      const lines = await readLines(file)
      assert.equal(lines[1]!.result, 'ok')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /* The audit trail must be able to say WHICH files were read. A cap on the
     joined path list used to lose all but the first two or three, and an
     ellipsis in a log reads like formatting rather than like missing
     evidence. */
  it('logs every path of a multi-file read, however many there are', async () => {
    const handlers = await loadExtension(file)
    try {
      const paths = Array.from({ length: 50 }, (_, i) => `/workspace/src/deeply/nested/module-${i}/index.ts`)
      await handlers.tool_call(
        { toolCallId: 'tc_m', toolName: 'mcp_read_multiple_files', input: { paths } },
        ctx
      )

      const [line] = await readLines(file)
      assert.ok(line)
      for (const p of paths) assert.equal(line.detail!.includes(p), true, `detail omits ${p}`)
      assert.equal(line.detail!.includes('…'), false, 'detail must not be elided')
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
        ctx
      )
      await handlers.tool_result(
        {
          toolCallId: 'tc_4',
          toolName: 'mcp_read_file',
          input: { path: '/workspace/a.ts' },
          content: [{ type: 'text', text: 'SUPER-SECRET-FILE-BODY' }],
          isError: false,
        },
        ctx
      )

      const body = await readFile(file, 'utf8')
      assert.equal(body.includes('SUPER-SECRET-FILE-BODY'), false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never returns a content patch from tool_result — redaction is not this extension\'s job', async () => {
    const handlers = await loadExtension(file)
    try {
      const patch = await handlers.tool_result(
        {
          toolCallId: 'tc_5',
          toolName: 'mcp_read_file',
          input: { path: '/workspace/notes.txt' },
          content: [{ type: 'text', text: 'api key: ghp_1234567890abcdefghijklmnopqrstuvwxyz' }],
          isError: false,
        },
        ctx
      )
      assert.equal(patch, undefined)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/* Model requests were the last channel the trail said nothing about. The hazard
   is the opposite of the usual one: the event hands over the entire conversation,
   so these tests are mostly about what does NOT reach the file. */
describe('audit-log model-request logging', () => {
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
    dir = await mkdtemp(join(tmpdir(), 'audit-log-provider-'))
    file = join(dir, 'calls.jsonl')
  })

  it('records the shape of the request', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.before_provider_request({ type: 'before_provider_request', payload }, ctx)

      const lines = await readLines(file)
      assert.equal(lines.length, 1)
      assert.equal(lines[0]!.kind, 'provider_request')
      assert.equal(lines[0]!.model, 'computer-programmer')
      assert.equal(lines[0]!.messages, 2)
      assert.ok(Number(lines[0]!.approx_bytes) > 0)
      assert.equal(typeof lines[0]!.hash, 'string')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never copies the conversation into the log', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.before_provider_request({ type: 'before_provider_request', payload }, ctx)

      const body = await readFile(file, 'utf8')
      assert.equal(body.includes('SYSTEM-PROMPT-BODY'), false)
      assert.equal(body.includes('CONVERSATION-CONTENT'), false)
      assert.deepEqual(
        Object.keys(JSON.parse(body.trimEnd()) as Record<string, unknown>),
        ['ts', 'kind', 'model', 'messages', 'approx_bytes', 'hash']
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
        ctx
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
      await handlers.before_agent_start({ type: 'before_agent_start', prompt: 'p', systemPrompt: 's' }, ctx)
      await handlers.before_provider_request({ type: 'before_provider_request', payload }, ctx)
      await handlers.tool_call(
        { toolCallId: 'tc_1', toolName: 'mcp_read_file', input: { path: '/workspace/a.ts' } },
        ctx
      )
      await handlers.before_provider_request({ type: 'before_provider_request', payload }, ctx)

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
describe('audit-log turn markers', () => {
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
    dir = await mkdtemp(join(tmpdir(), 'audit-log-turn-'))
    file = join(dir, 'calls.jsonl')
  })

  it('writes a boundary before the calls it groups, and numbers turns from 1', async () => {
    const handlers = await loadExtension(file)
    try {
      await handlers.before_agent_start(agentStart, ctx)
      await handlers.tool_call(
        { toolCallId: 'tc_1', toolName: 'mcp_read_file', input: { path: '/workspace/a.ts' } },
        ctx
      )
      await handlers.before_agent_start(agentStart, ctx)
      await handlers.tool_call(
        { toolCallId: 'tc_2', toolName: 'mcp_read_file', input: { path: '/workspace/b.ts' } },
        ctx
      )

      const lines = await readLines(file)
      assert.deepEqual(
        lines.map(l => l.kind ?? l.phase),
        ['turn_start', 'call', 'turn_start', 'call']
      )
      assert.deepEqual(lines.filter(l => l.kind !== undefined).map(l => l.turn), [1, 2])
      assert.equal(lines[0]!.session, 's-01')
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
      await handlers.before_agent_start(agentStart, ctx)

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
      await handlers.before_agent_start(agentStart, {})
      await handlers.before_agent_start(agentStart, {
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
