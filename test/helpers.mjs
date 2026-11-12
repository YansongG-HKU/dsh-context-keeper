/**
 * Test helpers: a real DSH `Session` (the runtime line the desktop app ships:
 * DSH 0.2.1-rc.5 + session format v4 — `system/message` at surface node 0,
 * `startSeq`/`endSeq` replacements, producer-owned message sources) plus fake
 * services with the exact shapes this plugin consumes. Tests never touch the
 * user's profile or running Harness.
 */
import { pathToFileURL } from 'node:url'
import { estimateTokens, eventText, collectToolCallNames } from '../lib/events.js'

const VENDOR = new URL('./vendor/node_modules/@deepseek-ai/', import.meta.url)
export const DSH_PKG_ROOT = process.env.DSH_PKG_ROOT ?? VENDOR.href.replace(/\/$/, '')

let SessionClass
export async function loadSessionClass() {
  if (SessionClass) return SessionClass
  const base = DSH_PKG_ROOT.replace(/\/$/, '')
  const href = base.startsWith('file:')
    ? `${base}/dsh-session/lib/index.js`
    : pathToFileURL(`${base}/dsh-session/lib/index.js`).href
  const mod = await import(href)
  SessionClass = mod.Session
  return SessionClass
}

let nextMessage = 0
const messageId = () => `msg-${(nextMessage += 1)}`

export function userMessage(text) {
  return { id: messageId(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

export function systemMessage(text) {
  // v4: a system/message must carry the producer-owned system-prompt source.
  return { id: messageId(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } }
}

export function assistantMessage(blocks, meta = {}) {
  return {
    id: messageId(),
    role: 'assistant',
    content: blocks,
    source: { kind: 'model', provider: 'test-provider', model: 'test-model', ...meta },
  }
}

/**
 * Current-format (v4) tool result: the message itself has the `tool` role and
 * carries `toolCallId`; its content is plain blocks — the retired
 * `{ type: 'tool-result', ... }` wrapper block is a v3 shape the v4 loader
 * refuses. `source.callId` must equal `toolCallId`.
 */
export function toolResultMessage(callId, text, isError = false) {
  return {
    id: messageId(),
    role: 'tool',
    toolCallId: callId,
    content: [{ type: 'text', text }],
    source: { kind: 'tool', callId },
    ...(isError ? { isError: true } : {}),
  }
}

export const text = (value) => ({ type: 'text', text: value })
export const toolCall = (id, name, args = {}) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })

const longText = (label, size) => `${label}: ${'detail '.repeat(Math.ceil(size / 7))}`

/**
 * Build a realistic two-turn session in the current format (v4): a system head
 * as **surface node 0** (it is *not* log seq 0 — `request/context`,
 * `request/header`, `turn/start` and `step/start` are log-only rows appended
 * before it, exactly as in a real session), two asks, one tool call each, and
 * two assistant replies. `request/header` carries tools only; the system prompt
 * is a surface `system/message` event.
 */
export async function makeSession({ contextWindow = 200000, headerConfig = {} } = {}) {
  const Session = await loadSessionClass()
  const session = Session.create(`test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const header = {
    header: {
      config: { provider: 'test-provider', model: 'test-model', ...headerConfig },
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    },
    reason: 'initial',
  }
  session.append('turn/start', { turn: 1 })
  session.append('request/context', { provider: 'test-provider', model: 'test-model', contextWindow })
  session.append('request/header', header)
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: systemMessage('You are a test agent.') }, { surfaceOp: 'append' })
  session.append('user/message', userMessage('First request: build a token-saving plugin and explain the design.'), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: assistantMessage([
        text('I will inspect the workspace.'),
        toolCall('call-1', 'read', { path: '/repo/src/index.ts' }),
      ]),
      stream: [],
    },
    { surfaceOp: 'append' },
  )
  session.append('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"/repo/src/index.ts"}' })
  session.append(
    'tool/result',
    { turn: 1, step: 1, message: toolResultMessage('call-1', longText('export const plugin = { name: "context-keeper" }', 6000)) },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 2,
      message: assistantMessage([text(longText('The plugin entry point registers tools and listens for agent/created.', 1200))]),
      stream: [],
      usage: { inputTokens: 1200, outputTokens: 90, cacheReadTokens: 40000, cacheWriteTokens: 0, reasoningTokens: 20 },
    },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('request/context', { provider: 'test-provider', model: 'test-model', contextWindow })
  session.append('request/header', header)
  session.append('step/start', { turn: 2, step: 1 })
  session.append('user/message', userMessage('Second request: measure where the tokens go and add restore.'), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    {
      turn: 2,
      step: 1,
      message: assistantMessage([
        text('Running a measurement.'),
        toolCall('call-2', 'pwsh', { command: 'node analyze.mjs' }),
      ]),
      stream: [],
    },
    { surfaceOp: 'append' },
  )
  session.append('tool/call', { turn: 2, step: 1, callId: 'call-2', name: 'pwsh', arguments: '{"command":"node analyze.mjs"}' })
  session.append(
    'tool/result',
    {
      turn: 2,
      step: 1,
      message: toolResultMessage('call-2', longText('tool results dominate the context: 62% of measured surface tokens', 8000)),
    },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: 2, step: 1 })
  session.append('step/start', { turn: 2, step: 2 })
  session.append(
    'assistant/message',
    {
      turn: 2,
      step: 2,
      message: assistantMessage([text(longText('Compaction savings should be reported per checkpoint.', 1000))]),
      stream: [],
      usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 48000 },
    },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: 2, step: 2 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  // Leave a turn open: a model-driven compaction tool always runs inside a turn,
  // and the durable transaction requires that.
  session.append('turn/start', { turn: 3 })
  return session
}

/**
 * Meter stand-in: the same measurement vocabulary as `ctx.tokenMeter`, priced
 * with the Harness heuristic, plus a fixed envelope overhead that simulates
 * tool schemas. The system head is priced as part of the surface, as in the real
 * meter.
 */
export function makeMeter({ systemOverheadTokens = 30000 } = {}) {
  const state = { systemOverheadTokens, measureCount: 0 }
  return {
    state,
    measure(session) {
      state.measureCount += 1
      const events = session.snapshotEvents()
      const names = collectToolCallNames(events)
      const nodes = session.surface.nodes.map((seq) => {
        const event = session.eventAt(seq)
        const extracted = eventText(event, names)
        const tokens = estimateTokens(extracted?.text ?? '')
        return { seq, tokens, heuristicTokens: tokens }
      })
      const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
      return {
        logRevision: events.length,
        baseline: { kind: 'estimated', tokens: 0 },
        surfaceDeltaTokens: 0,
        totalTokens: state.systemOverheadTokens + surfaceTokens,
        surfaceTokens,
        nodes,
      }
    },
    estimateMessage(message) {
      return estimateTokens(JSON.stringify(message))
    },
  }
}

/** The open turn number of a durable log, or null between turns (v4 compaction owner). */
function openTurnOf(session) {
  let openTurn = null
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') openTurn = event.data.turn
    else if (event.type === 'turn/end') openTurn = null
  }
  return openTurn
}

/**
 * Append the durable transaction a real compaction backend writes in v4:
 * compaction/start (owned by the open turn) → compaction/summary (with the
 * summarizer call record) → the `user/message` surface REPLACE carrying a
 * producer-owned `compact-checkpoint` source → compaction/end.
 */
export function appendCompaction(session, startSeq, endSeq, summaryText = '[compacted-summary] earlier work: built a token-saving plugin.') {
  const surface = session.surface.nodes
  const startIndex = surface.indexOf(startSeq)
  const endIndex = surface.indexOf(endSeq)
  const shadowedSeqs = surface.slice(startIndex, endIndex + 1)
  let shadowedTokens = 0
  for (const seq of shadowedSeqs) shadowedTokens += estimateTokens(String(session.eventAt(seq)?.data ? JSON.stringify(session.eventAt(seq).data) : ''))
  const compactionId = `cid-${summarySeqOf(session)}`
  const turn = openTurnOf(session)
  session.append('compaction/start', { compactionId, turn })
  const summary = session.append('compaction/summary', {
    compactionId,
    summary: [text(summaryText)],
    shadowedRange: { start: startSeq, end: endSeq },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount: shadowedTokens,
    provider: 'test-provider',
    model: 'test-model',
    rawOutput: [text(summaryText)],
    llmStreamCall: true,
    usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 9000 },
  })
  const replacement = session.append(
    'user/message',
    {
      id: messageId(),
      role: 'user',
      content: [text(`[compacted-summary] ${summaryText}`)],
      // v4 requires a producer-owned source kind; the shipped backend writes a
      // compact-checkpoint source correlated with the transaction.
      source: { kind: 'compact-checkpoint', compactionId },
    },
    { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: [summary.seq, ...shadowedSeqs] },
  )
  session.append('compaction/end', { compactionId, turn })
  return { summarySeq: summary.seq, replacementSeq: replacement.seq, shadowedSeqs, shadowedTokens }
}

function summarySeqOf(session) {
  return session.snapshotEvents().filter((event) => event.type === 'compaction/summary').length
}

/** Compaction service stand-in that really mutates the test session surface. */
export function makeCompaction(session) {
  const calls = []
  return {
    calls,
    async compactRegion(startSeq, endSeq, _agent, signal) {
      if (signal?.aborted) throw new Error('aborted')
      calls.push({ startSeq, endSeq })
      const result = appendCompaction(session, startSeq, endSeq)
      return {
        compactionId: 'test-compaction',
        startSeq: result.summarySeq - 1,
        summarySeq: result.summarySeq,
        endSeq: result.replacementSeq,
        shadowedRange: { start: startSeq, end: endSeq },
        shadowedSeqs: result.shadowedSeqs,
        shadowedTokenCount: result.shadowedTokens,
      }
    },
  }
}

/**
 * LLM service stand-in: streams one text block for the summarization call.
 * `summary` controls the checkpoint body; `finish` injects a failure.
 * `textBeforeFinish` makes a `max-tokens` finish emit the text block first,
 * mimicking a response cut off after partial output.
 */
export function makeLlm({ summary = '## Primary Request and Intent\n- build a token-saving plugin\n\n## Next Step\n- fold old history', finish, textBeforeFinish = false } = {}) {
  const calls = []
  return {
    calls,
    async *stream(options) {
      calls.push(options)
      if (finish === 'max-tokens') {
        if (textBeforeFinish) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } }
          yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 8192, cacheReadTokens: 9000 } }
        }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } }
      yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 9000 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/** An Agent-shaped object with scoped services the plugin asks for. */
export function makeAgent(session, services = {}) {
  const registrations = []
  const listeners = []
  const sections = []
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    status: 'idle',
    ctx: {
      get(name) {
        return services[name]
      },
      tools: {
        register(definition) {
          registrations.push(definition)
          return () => {
            const index = registrations.indexOf(definition)
            if (index >= 0) registrations.splice(index, 1)
          }
        },
      },
      systemPrompt: {
        section(section) {
          sections.push(section)
          return () => sections.splice(sections.indexOf(section), 1)
        },
      },
      on(event, listener) {
        const entry = { event, listener }
        listeners.push(entry)
        return () => {
          const index = listeners.indexOf(entry)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    },
    __test: { registrations, listeners, sections },
  }
  return agent
}

/** Drive the registered `agent/pre-step` waterfall listeners once. */
export async function runPreStep(agent, payload = {}) {
  const entry = agent.__test.listeners.find((item) => item.event === 'agent/pre-step')
  if (!entry) throw new Error('no agent/pre-step listener registered')
  const result = await entry.listener({ agent, turn: 1, step: 1, messages: [], signal: new AbortController().signal, ...payload }, async () => ({ kind: 'enter', messages: [] }))
  return result
}

export function fakeContext(agent, events = null) {
  const created = []
  const ctx = {
    agents: { list: () => [agent] },
    logger: { info() {}, warn() {} },
    on(event, listener) {
      created.push({ event, listener })
      return () => {}
    },
  }
  return { ctx, created }
}



