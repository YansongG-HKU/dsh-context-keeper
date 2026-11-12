import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  estimateTokens,
  truncate,
  preview,
  renderBlocks,
  eventText,
  collectToolCallNames,
  collectUsage,
  collectCompactions,
  searchEvents,
  restoreEvents,
} from '../lib/events.js'
import { resolveConfig } from '../lib/config.js'

const textBlock = (value) => ({ type: 'text', text: value })

function syntheticLog() {
  return [
    { seq: 0, type: 'user/message', data: { id: 'u1', role: 'user', content: [textBlock('Please build a token saving plugin')], source: { kind: 'user' } } },
    { seq: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' } },
    {
      seq: 2,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          role: 'assistant',
          content: [textBlock('Reading the file.'), { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    },
    {
      seq: 3,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 't1',
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [textBlock('export const plugin = 1')] }],
          source: { kind: 'tool', callId: 'c1' },
        },
      },
    },
    {
      seq: 4,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: { id: 'a2', role: 'assistant', content: [textBlock('Done.')], source: { kind: 'model', provider: 'p', model: 'm' } },
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0, reasoningTokens: 5 },
      },
    },
    {
      seq: 5,
      type: 'compaction/summary',
      data: {
        compactionId: 'cid',
        summary: [textBlock('[compacted-summary] built a token saving plugin')],
        shadowedRange: { start: 0, end: 3 },
        shadowedSeqs: [0, 2, 3],
        shadowedTokenCount: 4200,
        provider: 'p',
        model: 'm',
        rawOutput: [textBlock('built a token saving plugin')],
        llmStreamCall: true,
      },
    },
    {
      seq: 6,
      type: 'user/message',
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 3 },
      sourceEventSeqs: [0, 2, 3],
      data: {
        id: 'u-summary',
        role: 'user',
        content: [textBlock('[compacted-summary] built a token saving plugin')],
        // v4: a persisted replacement must carry a producer-owned source kind;
        // `{kind:'plugin', plugin}` is a retired v3 wrapper the loader refuses.
        source: { kind: 'compact-checkpoint', compactionId: 'cid' },
      },
    },
  ]
}

const stubSession = (events, nodes) => ({
  snapshotEvents: () => events,
  surface: { nodes },
})

test('estimateTokens uses the harness four-characters-per-token heuristic', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('中文'), 1)
})

test('truncate and preview bound text without throwing', () => {
  assert.equal(truncate('abcdef', 10), 'abcdef')
  assert.ok(truncate('abcdef', 4).endsWith('…'))
  assert.equal(preview('a\n\n b\tc', 20), 'a b c')
})

test('renderBlocks flattens nested tool results and tool calls', () => {
  const rendered = renderBlocks([
    textBlock('hello'),
    { type: 'reasoning', text: 'why' },
    { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' },
    { type: 'tool-result', toolCallId: 'c1', content: [textBlock('body')] },
    { type: 'image', attachment: {} },
  ])
  assert.match(rendered, /hello/)
  assert.match(rendered, /\[reasoning\] why/)
  assert.match(rendered, /\[tool-call read/)
  assert.match(rendered, /\[tool-result\] body/)
  assert.match(rendered, /\[image\]/)
})

test('eventText extracts each durable text event and skips log-only rows', () => {
  const events = syntheticLog()
  const names = collectToolCallNames(events)
  assert.equal(eventText(events[0], names)?.kind, 'user')
  assert.equal(eventText(events[2], names)?.kind, 'assistant')
  const tool = eventText(events[3], names)
  assert.equal(tool?.kind, 'tool')
  assert.equal(tool?.tool, 'read')
  assert.match(tool?.text ?? '', /export const plugin/)
  assert.equal(eventText(events[5], names)?.kind, 'summary')
  assert.equal(eventText({ seq: 9, type: 'turn/start', data: { turn: 1 } }, names), null)
})

test('collectUsage sums provider usage and computes the cache share', () => {
  const usage = collectUsage(syntheticLog())
  assert.equal(usage.steps, 1)
  assert.equal(usage.inputTokens, 100)
  assert.equal(usage.outputTokens, 20)
  assert.equal(usage.cacheReadTokens, 900)
  assert.equal(usage.billedInputTokens, 1000)
  assert.equal(usage.cacheHitRatio, 0.9)
})

test('collectCompactions reports shadowed, summary, and net saved tokens', () => {
  const stats = collectCompactions(syntheticLog())
  assert.equal(stats.count, 1)
  assert.equal(stats.shadowedTokens, 4200)
  assert.ok(stats.summaryTokens > 0)
  assert.equal(stats.netSavedTokens, 4200 - stats.summaryTokens)
  assert.equal(stats.checkpoints[0].nodes, 3)
})

test('searchEvents finds visible, compacted and summary rows', () => {
  const events = syntheticLog()
  // Only row 4 stays on the surface after the synthetic compaction.
  const session = stubSession(events, [4])
  const visible = searchEvents({ session, query: 'Done' })
  assert.equal(visible.hits[0]?.visibility, 'visible')
  const compacted = searchEvents({ session, query: 'token saving' })
  assert.ok(compacted.hits.some((hit) => hit.visibility === 'compacted' || hit.visibility === 'summary'))
  const summary = searchEvents({ session, query: 'compacted-summary' })
  assert.equal(summary.hits[0]?.kind, 'summary')
  const excluded = searchEvents({ session, query: 'token saving', includeCompacted: false })
  assert.equal(excluded.total, 0)
  const regex = searchEvents({ session, query: 'token\\s+saving', regex: true })
  assert.ok(regex.total >= 1)
  const limited = searchEvents({ session, query: 'e', limit: 1 })
  assert.equal(limited.hits.length, 1)
  assert.equal(limited.truncated, true)
})

test('restoreEvents rebuilds exact text, honours the budget, and reports misses', () => {
  const session = stubSession(syntheticLog(), [4])
  const restored = restoreEvents({ session, seqs: [2, 3, 4, 99], maxTokens: 100 })
  assert.equal(restored.restored.length, 4)
  assert.match(restored.restored[0].text, /Reading the file/)
  assert.match(restored.restored[1].text, /export const plugin/)
  assert.equal(restored.restored[3].error, 'not found in this session log')
  assert.ok(restored.restored.every((row) => !row.truncated || row.text.endsWith('…')))
  const tiny = restoreEvents({ session, seqs: [0, 2], maxTokens: 200 })
  assert.ok(tiny.omitted >= 0)
})

test('resolveConfig applies defaults, merges overrides, and rejects bad input', () => {
  const defaults = resolveConfig(undefined)
  assert.equal(defaults.autoCompact.enabled, true)
  assert.equal(defaults.autoCompact.minPressureRatio, 0.6)
  assert.equal(defaults.autoCompact.maxContextWindowCap, 262144)
  const merged = resolveConfig({ autoCompact: { enabled: false, retainTokens: 12000, maxContextWindowCap: 0 }, debug: true })
  assert.equal(merged.autoCompact.enabled, false)
  assert.equal(merged.autoCompact.retainTokens, 12000)
  assert.equal(merged.autoCompact.minPressureRatio, 0.6)
  assert.equal(merged.autoCompact.maxContextWindowCap, 0, '0 disables the cap')
  assert.equal(merged.debug, true)
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key/)
  assert.throws(() => resolveConfig({ autoCompact: { minPressureRatio: 1.5 } }), /minPressureRatio/)
  assert.throws(() => resolveConfig({ autoCompact: { maxContextWindowCap: -1 } }), /maxContextWindowCap/)
  assert.throws(() => resolveConfig({ autoCompact: { maxContextWindowCap: 1024.5 } }), /maxContextWindowCap/)
  assert.throws(() => resolveConfig({ tools: { status: 'yes' } }), /tools.status/)
})

test('visible-only search reads only eligible message content', () => {
  let reads = 0
  const content = [{ type: 'text', text: 'MATCH' }]
  const events = Array.from({ length: 2000 }, (_, seq) => ({
    seq, type: 'tool/result', data: { get content() { reads += 1; return content } },
  }))
  events.push({ seq: 2000, type: 'compaction/summary', data: { summary: content } })
  const session = {
    snapshotEvents: () => events,
    surface: { nodes: events.slice(-21).map(({ seq }) => seq) },
  }
  const options = { session, query: 'match', includeCompacted: false, limit: 2 }
  const result = searchEvents(options)
  assert.equal(reads, 20)
  assert.equal(result.total, 20)
  assert.deepEqual(result.hits.map(({ seq }) => seq), [1980, 1981])
  assert.equal(result.truncated, true)
  assert.deepEqual(searchEvents({ ...options, regex: true }), result)
  assert.equal(searchEvents({ ...options, includeCompacted: true }).total, 2001)
})
