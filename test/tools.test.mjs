import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeAgent, makeCompaction, makeLlm, makeMeter, makeSession } from './helpers.mjs'
import { createTools } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'

const signal = () => new AbortController().signal
const state = () => ({ autoAttempts: 0, autoFolds: 0, lastError: null, lastSkip: null })

async function setup(configPatch = undefined) {
  const session = await makeSession()
  const meter = makeMeter()
  const compaction = makeCompaction(session)
  const agent = makeAgent(session, { tokenMeter: meter, compaction })
  const cfg = resolveConfig(configPatch)
  const tools = createTools({ agent, cfg, state: state(), log: { info() {}, warn() {} } })
  const byName = new Map(tools.map((definition) => [definition.name, definition]))
  return { session, meter, compaction, agent, cfg, tools, byName }
}

test('createTools registers the four context tools with JSON schemas', async () => {
  const { tools, byName } = await setup()
  assert.deepEqual([...byName.keys()].sort(), ['context_compact', 'context_restore', 'context_search', 'context_status'])
  for (const definition of tools) {
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40)
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }
  const trimmed = await setup({ tools: { status: false, search: false, restore: true, compact: true } })
  assert.deepEqual([...trimmed.byName.keys()].sort(), ['context_compact', 'context_restore'])
})

test('context_status returns the live budget', async () => {
  const { byName, meter } = await setup()
  const result = await byName.get('context_status').execute({}, { signal: signal() })
  assert.equal(result.ok, true)
  assert.equal(result.budget.contextWindow, 200000)
  assert.ok(result.budget.pressureTokens >= 30000)
  assert.ok(result.largest.length > 0)
  assert.ok(meter.state.measureCount > 0)
})

test('context_search and context_restore work before and after compaction', async () => {
  const { byName, session, compaction } = await setup()
  const before = await byName.get('context_search').execute({ query: 'token-saving' }, { signal: signal() })
  assert.equal(before.ok, true)
  assert.ok(before.total >= 1)

  const firstSeq = session.surface.nodes[1]
  await compaction.compactRegion(firstSeq, session.surface.nodes[4], { id: 'x' }, signal())
  const after = await byName.get('context_search').execute({ query: 'First request' }, { signal: signal() })
  assert.equal(after.ok, true)
  assert.equal(after.hits[0].visibility, 'compacted')

  const restored = await byName
    .get('context_restore')
    .execute({ seqs: after.hits.map((hit) => hit.seq) }, { signal: signal() })
  assert.equal(restored.ok, true)
  assert.match(restored.restored[0].text, /First request/)
})

test('context_compact dry-run plans without touching history', async () => {
  const { byName, compaction, session } = await setup()
  const surfaceBefore = session.surface.nodes.length
  const plan = await byName
    .get('context_compact')
    .execute({ dry_run: true, keep_recent_tokens: 20, min_tokens: 1 }, { signal: signal() })
  assert.equal(plan.ok, true)
  assert.equal(plan.dryRun, true)
  assert.ok(plan.nodes >= 1)
  assert.ok(plan.shadowedTokens > 0)
  assert.equal(compaction.calls.length, 0)
  assert.equal(session.surface.nodes.length, surfaceBefore)
})

test('context_compact folds the planned span and reports freed tokens', async () => {
  const { byName, compaction, session } = await setup()
  const result = await byName
    .get('context_compact')
    .execute({ keep_recent_tokens: 20, min_tokens: 1 }, { signal: signal() })
  assert.equal(result.ok, true)
  assert.equal(compaction.calls.length, 1)
  assert.equal(result.engine, 'preset')
  assert.ok(result.shadowedNodes >= 1)
  assert.ok(result.pressureBefore >= result.pressureAfter)
  const types = session.snapshotEvents().map((event) => event.type)
  assert.ok(types.includes('compaction/summary'))
  assert.ok(types.includes('compaction/start'))
  assert.ok(types.includes('compaction/end'))
})

test('context_compact refuses an unbalanced explicit range', async () => {
  const { byName, session, compaction } = await setup()
  const nodes = session.surface.nodes
  const result = await byName
    .get('context_compact')
    .execute({ start: nodes[1], end: nodes[2], dry_run: true }, { signal: signal() })
  assert.equal(result.ok, false)
  assert.match(result.error, /split a tool call|balanced/)
  assert.equal(compaction.calls.length, 0)
})

test('the plugin runs its own compaction transaction when no preset service is reachable', async () => {
  const session = await makeSession()
  const meter = makeMeter()
  const llm = makeLlm()
  const agent = makeAgent(session, { tokenMeter: meter, llm })
  const cfg = resolveConfig(undefined)
  const tools = createTools({ agent, cfg, state: state(), log: { info() {}, warn() {} } })
  const compact = tools.find((definition) => definition.name === 'context_compact')
  const result = await compact.execute({ keep_recent_tokens: 20, min_tokens: 1 }, { signal: signal() })
  assert.equal(result.ok, true)
  assert.equal(result.engine, 'keeper')
  assert.equal(llm.calls.length, 1)
  const call = llm.calls[0]
  assert.equal(call.purpose, 'compaction')
  assert.equal(call.provider, 'test-provider')
  assert.equal(call.model, 'test-model')
  assert.equal(call.maxTokens, 8192)
  assert.ok(Array.isArray(call.tools) && call.tools.length === 1)
  assert.equal(call.system, undefined, 'v4 format carries the system prompt as a leading message')
  assert.equal(call.messages[0].role, 'system')
  assert.match(JSON.stringify(call.messages[0].content), /test agent/)
  assert.ok(call.messages.length >= 2)
  assert.match(call.messages[call.messages.length - 1].content[0].text, /compaction engine/)
  const types = session.snapshotEvents().map((event) => event.type)
  for (const expected of ['compaction/start', 'compaction/summary', 'compaction/end']) {
    assert.ok(types.includes(expected), expected)
  }
  const replacement = session
    .snapshotEvents()
    .find((event) => event.type === 'user/message' && event.surfaceOp?.op === 'replace')
  assert.ok(replacement)
  assert.match(replacement.data.content[0].text, /<compacted-summary>/)
  assert.match(replacement.data.content.at(-1).text, /<\/compacted-summary>/)
  assert.ok(result.shadowedNodes >= 1)
})

test('the own-engine transaction refuses a summary that is not smaller', async () => {
  const session = await makeSession()
  const surfaceBefore = [...session.surface.nodes]
  const meter = makeMeter()
  const llm = makeLlm({ summary: 'x'.repeat(200000) })
  const agent = makeAgent(session, { tokenMeter: meter, llm })
  const cfg = resolveConfig(undefined)
  const tools = createTools({ agent, cfg, state: state(), log: { info() {}, warn() {} } })
  const compact = tools.find((definition) => definition.name === 'context_compact')
  const result = await compact.execute({ keep_recent_tokens: 20, min_tokens: 1 }, { signal: signal() })
  assert.equal(result.ok, false)
  assert.match(result.error, /not smaller/)
  assert.deepEqual(session.surface.nodes, surfaceBefore, 'a rejected summary changes no visible history')
  const end = session.snapshotEvents().filter((event) => event.type === 'compaction/end')
  assert.equal(end.length, 1)
  assert.ok(typeof end[0].data.error === 'string' && end[0].data.error.length > 0)
})

test('without any compaction engine the tool fails with a clear reason', async () => {
  const session = await makeSession()
  const agent = makeAgent(session, { tokenMeter: makeMeter() })
  const cfg = resolveConfig(undefined)
  const tools = createTools({ agent, cfg, state: state(), log: { info() {}, warn() {} } })
  const compact = tools.find((definition) => definition.name === 'context_compact')
  const result = await compact.execute({ dry_run: true }, { signal: signal() })
  assert.equal(result.ok, false)
  assert.match(result.error, /no compaction engine/)
})

test('tool errors become structured failures, not thrown exceptions', async () => {
  const { byName } = await setup()
  const result = await byName.get('context_search').execute({ query: '([', regex: true }, { signal: signal() })
  assert.equal(result.ok, false)
  assert.ok(typeof result.error === 'string' && result.error.length > 0)
})





test('context_search runs regular expressions with the same results as keyword search', async () => {
  const { byName } = await setup()
  const search = byName.get('context_search').execute
  const keyword = await search({ query: 'token-saving' })
  const regex = await search({ query: 'token[-]saving', regex: true })
  assert.ok(keyword.total > 0)
  assert.deepEqual(regex, keyword)
})

test('context_search bounds a runaway regex, stays responsive, and supports cancellation', async () => {
  const session = {
    surface: { nodes: [1] },
    snapshotEvents: () => [{
      seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'a'.repeat(32) + '!' }] },
    }],
  }
  const tools = createTools({ agent: { session }, cfg: resolveConfig(), state: state() })
  const search = tools.find(({ name }) => name === 'context_search').execute
  const query = { query: '^(a+)+$', regex: true }
  const runaway = search(query)
  const first = await Promise.race([
    runaway.then(() => 'search finished'),
    new Promise((resolve) => setImmediate(() => resolve('host responsive'))),
  ])
  assert.equal(first, 'host responsive')
  assert.match((await runaway).error, /timed out/)

  const controller = new AbortController()
  const cancelled = search(query, { signal: controller.signal })
  setImmediate(() => controller.abort())
  assert.match((await cancelled).error, /abort/i)
  assert.equal((await search({ query: 'a+!', regex: true })).total, 1)
})
