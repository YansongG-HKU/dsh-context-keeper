import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeAgent, makeCompaction, makeLlm, makeMeter, makeSession, runPreStep } from './helpers.mjs'
import { createAutoCompaction } from '../lib/auto.js'
import { makeResources } from '../lib/context.js'
import { resolveConfig } from '../lib/config.js'

function autoState() {
  return {
    autoAttempts: 0,
    autoFolds: 0,
    lastError: null,
    lastSkip: null,
    lastPressure: null,
    lastFold: null,
    lastFoldTokens: null,
    foldsThisTurn: 0,
    lastTurn: null,
  }
}

async function setup({ systemOverheadTokens, patch } = {}) {
  const session = await makeSession()
  const meter = makeMeter({ systemOverheadTokens })
  const compaction = makeCompaction(session)
  const agent = makeAgent(session, { tokenMeter: meter, compaction })
  const cfg = resolveConfig(patch)
  const state = autoState()
  const maybeAutoCompact = createAutoCompaction({
    agent,
    resources: makeResources(agent),
    cfg,
    state,
    log: { info() {}, warn() {} },
  })
  return { session, meter, compaction, agent, cfg, state, maybeAutoCompact }
}

test('below the pressure threshold the policy folds nothing', async () => {
  const { compaction, state, maybeAutoCompact } = await setup({ systemOverheadTokens: 10000 })
  await maybeAutoCompact({ turn: 1, signal: new AbortController().signal })
  assert.equal(compaction.calls.length, 0)
  assert.equal(state.autoAttempts, 0)
  assert.equal(state.lastSkip, 'below pressure threshold')
  assert.ok(state.lastPressure.ratio < 0.6)
})

test('above the threshold the policy folds once and records the freed tokens', async () => {
  const { compaction, state, maybeAutoCompact, session } = await setup({ systemOverheadTokens: 150000, patch: { autoCompact: { retainTokens: 1000, minFoldTokens: 1000 } } })
  const nodesBefore = session.surface.nodes.length
  await maybeAutoCompact({ turn: 1, signal: new AbortController().signal })
  assert.equal(compaction.calls.length, 1)
  assert.equal(state.autoFolds, 1)
  assert.equal(state.autoAttempts, 1)
  assert.ok(state.lastFold.shadowedTokens > 0)
  assert.ok(session.surface.nodes.length < nodesBefore)
  const call = compaction.calls[0]
  assert.ok(call.startSeq < call.endSeq)
})

test('growth gate stops a second fold in the same pressure band', async () => {
  const { compaction, state, maybeAutoCompact } = await setup({ systemOverheadTokens: 150000, patch: { autoCompact: { retainTokens: 1000, minFoldTokens: 1000 } } })
  await maybeAutoCompact({ turn: 1, signal: new AbortController().signal })
  await maybeAutoCompact({ turn: 2, signal: new AbortController().signal })
  assert.equal(compaction.calls.length, 1, 'second attempt must wait for minGrowthTokens')
  assert.equal(state.lastSkip, 'waiting for growth since the last fold')
})

test('maxFoldsPerTurn caps folds inside one turn', async () => {
  const { compaction, state, maybeAutoCompact } = await setup({
    systemOverheadTokens: 150000,
    patch: { autoCompact: { retainTokens: 1000, minFoldTokens: 1000, minGrowthTokens: 0, maxFoldsPerTurn: 1 } },
  })
  await maybeAutoCompact({ turn: 1, signal: new AbortController().signal })
  const foldsAfterFirst = compaction.calls.length
  await maybeAutoCompact({ turn: 1, signal: new AbortController().signal })
  assert.equal(compaction.calls.length, foldsAfterFirst)
  assert.equal(state.lastSkip, 'turn fold budget reached')
  await maybeAutoCompact({ turn: 2, signal: new AbortController().signal })
  assert.equal(state.lastTurn, 2)
  assert.equal(state.foldsThisTurn, 0, 'a new turn resets the per-turn budget')
  assert.notEqual(state.lastSkip, 'turn fold budget reached')
})

test('the pre-step waterfall listener runs the policy and calls next()', async () => {
  const { compaction, agent, maybeAutoCompact, state, cfg } = await setup({ systemOverheadTokens: 150000, patch: { autoCompact: { retainTokens: 1000, minFoldTokens: 1000 } } })
  void maybeAutoCompact
  // Re-create the wiring the plugin entry performs.
  const listener = async (payload, next) => {
    await createAutoCompaction({ agent, resources: makeResources(agent), cfg, state, log: { info() {}, warn() {} } })(payload)
    return next()
  }
  agent.__test.listeners.push({ event: 'agent/pre-step', listener })
  const decision = await runPreStep(agent, { signal: new AbortController().signal })
  assert.equal(decision.kind, 'enter')
  assert.equal(compaction.calls.length, 1)
})

test('aborted steps never fold', async () => {
  const { compaction, maybeAutoCompact } = await setup({ systemOverheadTokens: 150000, patch: { autoCompact: { retainTokens: 1000, minFoldTokens: 1000 } } })
  const controller = new AbortController()
  controller.abort()
  await maybeAutoCompact({ turn: 1, signal: controller.signal })
  assert.equal(compaction.calls.length, 0)
})

test('disabled policy is a no-op', async () => {
  const { compaction, state, maybeAutoCompact } = await setup({
    systemOverheadTokens: 150000,
    patch: { autoCompact: { enabled: false } },
  })
  await maybeAutoCompact({ turn: 1, signal: new AbortController().signal })
  assert.equal(compaction.calls.length, 0)
  assert.equal(state.autoAttempts, 0)
})

test('without any compaction engine the policy degrades to a skip', async () => {
  const session = await makeSession()
  const meter = makeMeter({ systemOverheadTokens: 150000 })
  const agent = makeAgent(session, { tokenMeter: meter })
  const state = autoState()
  const maybeAutoCompact = createAutoCompaction({
    agent,
    resources: makeResources(agent),
    cfg: resolveConfig({ autoCompact: { retainTokens: 1000, minFoldTokens: 1000 } }),
    state,
    log: { info() {}, warn() {} },
  })
  await maybeAutoCompact({ turn: 1, signal: new AbortController().signal })
  assert.equal(state.autoAttempts, 0)
  assert.equal(state.lastSkip, 'no compaction engine available')
})

test('the fallback engine folds automatically when the preset service is unreachable', async () => {
  const session = await makeSession()
  const meter = makeMeter({ systemOverheadTokens: 150000 })
  const llm = makeLlm()
  const agent = makeAgent(session, { tokenMeter: meter, llm })
  const state = autoState()
  const maybeAutoCompact = createAutoCompaction({
    agent,
    resources: makeResources(agent),
    cfg: resolveConfig({ autoCompact: { retainTokens: 1000, minFoldTokens: 1000 } }),
    state,
    log: { info() {}, warn() {} },
  })
  const nodesBefore = session.surface.nodes.length
  await maybeAutoCompact({ turn: 1, signal: new AbortController().signal })
  assert.equal(state.autoFolds, 1)
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].purpose, 'compaction')
  assert.ok(state.lastFold.shadowedTokens > 0)
  assert.ok(session.surface.nodes.length < nodesBefore)
  assert.ok(session.snapshotEvents().some((event) => event.type === 'compaction/summary'))
})






