import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeSession, makeMeter, appendCompaction } from './helpers.mjs'
import { collectCompactions, restoreEvents, searchEvents } from '../lib/events.js'
import { buildStatus, foldableStartIndex, isBalancedEnd, selectFoldRange } from '../lib/context.js'
import { resolveConfig } from '../lib/config.js'

test('a real Session exposes the system head plus the surface this plugin plans against', async () => {
  const session = await makeSession()
  const nodes = session.surface.nodes
  assert.equal(nodes.length, 9)
  assert.equal(session.eventAt(nodes[0])?.type, 'system/message', 'v4 format opens the surface with the system prompt')
  assert.ok(nodes[0] > 0, 'the system head is a surface append, not necessarily log seq 0')
  assert.equal(session.header.version, 4, 'the vendored runtime is the v4 session format line')
  assert.equal(foldableStartIndex(session), 1)
  const meter = makeMeter()
  const measurement = meter.measure(session)
  assert.equal(measurement.nodes.length, nodes.length)
  assert.ok(measurement.totalTokens > measurement.surfaceTokens)
})

test('isBalancedEnd refuses a boundary that splits a tool call', async () => {
  const session = await makeSession()
  const meter = makeMeter()
  const nodes = meter.measure(session).nodes
  assert.equal(isBalancedEnd({ session, nodes, index: 0 }), true, 'system head')
  assert.equal(isBalancedEnd({ session, nodes, index: 2 }), false, 'assistant with a pending tool call')
  assert.equal(isBalancedEnd({ session, nodes, index: 3 }), true, 'paired tool result')
  assert.equal(isBalancedEnd({ session, nodes, index: nodes.length - 1 }), true, 'final assistant reply')
})

test('selectFoldRange keeps the recent tail, starts after the system head, and folds the oldest balanced span', async () => {
  const session = await makeSession()
  const meter = makeMeter()
  const nodes = meter.measure(session).nodes
  const plan = selectFoldRange({ session, nodes, retainTokens: 30, minFoldTokens: 1 })
  assert.equal(plan.ok, true)
  assert.equal(plan.startSeq, nodes[1].seq, 'the system prompt node is never folded')
  assert.notEqual(plan.startSeq, nodes[0].seq)
  const endIndex = nodes.findIndex((node) => node.seq === plan.endSeq)
  assert.ok(endIndex > 1)
  assert.ok(endIndex < nodes.length - 1, 'recent tail must survive')
  assert.equal(isBalancedEnd({ session, nodes, index: endIndex }), true)
  const refused = selectFoldRange({ session, nodes, retainTokens: 30, minFoldTokens: 10 ** 9 })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /below min_tokens/)
})

test('compaction hides old rows while the log and the system head survive', async () => {
  const session = await makeSession()
  const surfaceBefore = [...session.surface.nodes]
  const result = appendCompaction(session, surfaceBefore[1], surfaceBefore[4])
  assert.ok(session.surface.nodes.length < surfaceBefore.length)
  assert.equal(session.surface.nodes[0], surfaceBefore[0], 'the system prompt node stays in place')
  assert.equal(session.eventAt(result.shadowedSeqs[0])?.type, 'user/message')

  const search = searchEvents({ session, query: 'First request' })
  assert.equal(search.hits[0]?.visibility, 'compacted')
  const restored = restoreEvents({ session, seqs: [result.shadowedSeqs[0]], maxTokens: 500 })
  assert.match(restored.restored[0].text, /First request/)

  const savings = collectCompactions(session.snapshotEvents())
  assert.equal(savings.count, 1)
  assert.ok(savings.shadowedTokens > savings.summaryTokens)
  assert.ok(savings.netSavedTokens > 0)
  assert.equal(savings.summarizerUsage.calls, 1)
  assert.ok(savings.summarizerUsage.outputTokens > 0)
})

test('the protocol protects surface node 0 when it holds the system prompt', async () => {
  const session = await makeSession()
  const nodes = [...session.surface.nodes]
  assert.throws(() => appendCompaction(session, nodes[0], nodes[2]), /system prompt|system\/message/)
})

test('buildStatus reports window, composition, largest rows, savings and recent steps', async () => {
  const session = await makeSession()
  const meter = makeMeter()
  const cfg = resolveConfig(undefined)
  const compaction = appendCompaction(session, session.surface.nodes[1], session.surface.nodes[2])
  const agent = { id: session.id, session, options: {} }
  const status = buildStatus({ agent, meter, state: { autoFolds: 2 }, cfg })
  assert.equal(status.ok, true)
  assert.equal(status.session.preset, null)
  assert.equal(status.budget.contextWindow, 200000)
  assert.ok(status.budget.usedRatio > 0)
  assert.ok(status.composition.systemTokens > 0, 'system head is priced')
  assert.ok(status.composition.toolsTokens > 0)
  assert.ok(status.largest.length > 0)
  assert.ok(status.largest[0].tokens >= status.largest[status.largest.length - 1].tokens)
  assert.equal(status.compaction.checkpoints, 1)
  assert.ok(status.compaction.netSavedTokens > 0)
  assert.equal(status.compaction.summarizerUsage.calls, 1)
  assert.equal(status.keeper.autoFolds, 2)
  assert.ok(status.usage.billedInputTokens > 0)
  assert.equal(status.usage.recentSteps.length, 2)
  assert.ok(status.usage.recentSteps[0].billedInputTokens > 0)
  assert.ok(compaction.summarySeq > 0)
})

test('a second fold can fold the previous summary (multi-generation)', async () => {
  const session = await makeSession()
  const meter = makeMeter()
  const first = appendCompaction(session, session.surface.nodes[1], session.surface.nodes[4])
  const nodesAfterFirst = meter.measure(session).nodes
  assert.equal(nodesAfterFirst.length, session.surface.nodes.length)
  assert.equal(foldableStartIndex(session), 1)
  const plan = selectFoldRange({ session, nodes: nodesAfterFirst, retainTokens: 1, minFoldTokens: 1 })
  assert.equal(plan.ok, true)
  assert.equal(plan.startSeq, nodesAfterFirst[1].seq, 'the newest summary node is the first foldable node again')
  assert.notEqual(plan.startSeq, first.shadowedSeqs[0])
})

test('an abandoned summary (no landed replacement) is not counted as savings', async () => {
  const session = await makeSession()
  const surface = [...session.surface.nodes]
  session.append('compaction/start', { compactionId: 'c-orphan', turn: null })
  session.append('compaction/summary', {
    compactionId: 'c-orphan',
    summary: [{ type: 'text', text: 'orphan summary that never landed' }],
    shadowedRange: { start: surface[1], end: surface[2] },
    shadowedSeqs: [surface[1], surface[2]],
    shadowedTokenCount: 12345,
    provider: 'test-provider',
    model: 'test-model',
  })
  session.append('compaction/end', { compactionId: 'c-orphan', turn: null })
  const stats = collectCompactions(session.snapshotEvents())
  assert.equal(stats.count, 0)
  assert.equal(stats.abandoned, 1)
  assert.equal(stats.shadowedTokens, 0)
  assert.equal(stats.netSavedTokens, 0)
})

