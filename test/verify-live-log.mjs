/**
 * Protocol-parity check on a REAL desktop session log.
 *
 * Rehydrates a stored v4 session (which contains `system/message`,
 * `developer/message` and plugin events) with the vendored DSH 0.2.1-rc.5
 * Session runtime (the exact line the desktop app ships), then runs the
 * plugin's fold planner + its own compaction transaction against it with a
 * fake summarizer. This is the offline proof that the transaction works on the
 * same events the live desktop wrote.
 *
 * Usage: node test/vendor/../verify-live-log.mjs <session.jsonl>
 */
import fs from 'node:fs'
import { makeMeter, makeAgent, makeLlm } from './helpers.mjs'
import { foldableStartIndex, selectFoldRange } from '../lib/context.js'
import { collectCompactions } from '../lib/events.js'
import { runCompaction } from '../lib/compaction.js'

const file = process.argv[2]
if (!file) {
  console.error('usage: node test/verify-live-log.mjs <session.jsonl>')
  process.exit(2)
}

const { Session } = await import(
  new URL('./vendor/node_modules/@deepseek-ai/dsh-session/lib/index.js', import.meta.url).href
)

const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim())
const header = lines.map((line) => JSON.parse(line)).find((event) => event.type === 'session')
const events = lines.map((line) => JSON.parse(line)).filter((event) => event.type !== 'session')
console.log('log:', file)
console.log('session:', header?.id, 'preset:', header?.agentPreset, 'events:', events.length)

let session
try {
  session = Session.create(header?.id ?? 'replay', events)
} catch (error) {
  console.log('REHYDRATE FAILED:', error.message)
  process.exit(1)
}
const surface = [...session.surface.nodes]
const head = session.eventAt(surface[0])
const route = session.requestContext?.()
console.log('rehydrated surface nodes:', surface.length, '| node 0:', head?.type)
console.log('contextWindow:', route?.contextWindow, '| header keys:', Object.keys(session.requestHeader() ?? {}))
console.log('foldable start index:', foldableStartIndex(session))

// A stored session log ends with `turn/end`, so the replayed session is
// between turns. In the live app a model-driven compaction always runs inside
// an open turn, and the durable transaction requires that ownership — open a
// synthetic live turn (same shape the agent loop writes) before driving the
// tool path. No matching `turn/end` is appended: the helper exits here.
const lastTurn = session
  .snapshotEvents()
  .filter((event) => event.type === 'turn/start')
  .reduce((max, event) => Math.max(max, Number(event.data.turn ?? 0)), 0)
const liveTurn = lastTurn + 1
session.append('turn/start', { turn: liveTurn })
console.log('synthetic live turn opened:', liveTurn, '(log closed after turn', lastTurn + ')')

const meter = makeMeter()
const measurement = meter.measure(session)
console.log('metered surface tokens:', measurement.surfaceTokens, '| pressure:', measurement.totalTokens)

const plan = selectFoldRange({ session, nodes: measurement.nodes, retainTokens: 100000, minFoldTokens: 20000 })
console.log('fold plan:', JSON.stringify(plan))
if (!plan.ok) process.exit(1)

const llm = makeLlm({ summary: '## Primary Request and Intent\n- parity check on the real log\n' })
const agent = makeAgent(session, { tokenMeter: meter, llm })
const result = await runCompaction({
  agent,
  startSeq: plan.startSeq,
  endSeq: plan.endSeq,
  signal: new AbortController().signal,
  meter,
  llm,
})
console.log('transaction OK:', {
  engine: 'keeper',
  shadowedNodes: result.shadowedSeqs.length,
  shadowedTokens: result.shadowedTokenCount,
  summarySeq: result.summarySeq,
  replacementSeq: result.replacementSeq,
  framedTokens: result.framedTokens,
})
const after = [...session.surface.nodes]
const replacement = session.eventAt(result.replacementSeq)
console.log('surface after:', after.length, '| node 0 still system:', session.eventAt(after[0])?.type)
console.log('replacement surfaceOp keys:', Object.keys(replacement.surfaceOp), JSON.stringify(replacement.surfaceOp))
const afterMeasure = meter.measure(session)
console.log('pressure before/after:', measurement.totalTokens, '->', afterMeasure.totalTokens)
console.log('system head preserved:', session.eventAt(after[0])?.seq === surface[0])
console.log('summary call: purpose=%s messages=%d firstRole=%s systemField=%s', llm.calls[0].purpose, llm.calls[0].messages.length, llm.calls[0].messages[0]?.role, String(llm.calls[0].system))
const stats = collectCompactions(session.snapshotEvents())
console.log('compaction stats after replay: landed=%d abandoned=%d netSaved=%d summarizerCalls=%d', stats.count, stats.abandoned, stats.netSavedTokens, stats.summarizerUsage.calls)


