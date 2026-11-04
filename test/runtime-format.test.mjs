/**
 * Regression tests for the incident that made a real session unloadable.
 *
 * DSH's v4 session loader replays every `compaction/summary`'s
 * `shadowedRange` + `shadowedSeqs` on each open. A summary that names an
 * inexact surface span, or that includes the protected `system/message` head,
 * fails the whole load (`SessionFormatError: compaction cannot shadow the
 * protected system head`) — even when the replacement message itself never
 * landed. The session then shows "历史加载失败：…" in the Web UI forever.
 *
 * These tests therefore check behaviour at the *log* level, with the exact
 * Session runtime the desktop build ships (0.2.1-rc.5, vendored): after this
 * plugin's own compaction transaction, the session must still pass the v4
 * format validation and replay.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const VENDOR = new URL('./vendor/node_modules/@deepseek-ai/', import.meta.url)
const loadVendor = (path) => import(new URL(path, VENDOR))

const { Session, KNOWN_SESSION_EVENT_TYPES } = await loadVendor('dsh-session/lib/index.js')
const { assertV4RowAdmission, assertReleasedV4Relationships } = await loadVendor(
  'dsh-session-format-v3-to-v4/lib/index.js',
)
const { currentSessionMessageProjections } = await loadVendor(
  'dsh-session-format-catalog/lib/types/message-projections.js',
)

import { makeSession, makeAgent, makeMeter, makeLlm } from './helpers.mjs'
import {
  assertCheckpointMessage,
  assertFoldSpan,
  protectedHeadOf,
  runCompaction,
} from '../lib/compaction.js'

/** The exact artifact shape the v4 persistence reader hands to the loader. */
function artifactOf(session) {
  return { header: { ...session.header }, events: [...session.snapshotEvents()] }
}

/**
 * Run the real v4 load path: row admission, released relationships, then the
 * replay-validation `Session.create` that `readSession` performs.
 */
function assertLoadable(label, session) {
  const { header, events } = artifactOf(session)
  for (const event of events) assertV4RowAdmission(event, KNOWN_SESSION_EVENT_TYPES)
  assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES)
  const replay = Session.create(header.id, events, header, 0, currentSessionMessageProjections)
  assert.equal(replay.surface.nodes[0], session.surface.nodes[0], `${label}: the surface head survives replay`)
  return replay
}

test('a keeper compaction transaction leaves a log the real v4 loader accepts', async () => {
  const session = await makeSession()
  assertLoadable('fixture before the fold', session)

  const surfaceBefore = [...session.surface.nodes]
  const head = protectedHeadOf(session)
  assert.notEqual(head, null, 'the fixture has a system head')
  assert.notEqual(head, 0, 'a real-shaped session keeps the system head off log seq 0')

  const result = await runCompaction({
    agent: makeAgent(session, { tokenMeter: makeMeter(), llm: makeLlm() }),
    startSeq: surfaceBefore[1],
    endSeq: surfaceBefore[Math.min(5, surfaceBefore.length - 2)],
    meter: makeMeter(),
    llm: makeLlm(),
  })
  assert.ok(result.shadowedSeqs.length >= 1, 'the fold replaced a surface span')

  const checkpoint = session.eventAt(result.replacementSeq)
  assert.equal(checkpoint.data.source.kind, 'compact-checkpoint', 'producer-owned checkpoint source kind')
  assert.equal(checkpoint.data.source.compactionId, result.compactionId)

  const replay = assertLoadable('fixture after the fold', session)
  assert.ok(
    replay.surface.nodes.length < surfaceBefore.length,
    'the replacement really shrank the surface',
  )
  assert.equal(replay.surface.nodes[0], head, 'the protected system head stays at node 0')
})

test('a fold span that includes the protected system head is refused before anything is written', async () => {
  const session = await makeSession()
  const eventsBefore = session.snapshotEvents().length
  const nodes = [...session.surface.nodes]
  assert.equal(protectedHeadOf(session), nodes[0], 'surface node 0 is the protected head')
  assert.throws(() => assertFoldSpan(session, nodes[0], nodes[2]), /system prompt|protected system head/)
  assert.equal(session.snapshotEvents().length, eventsBefore, 'a refused span writes no rows')
})

test('the v4 loader rejects a summary that shadows the protected system head (incident control)', async () => {
  const session = await makeSession()
  const surfaceBefore = [...session.surface.nodes]
  await runCompaction({
    agent: makeAgent(session, { tokenMeter: makeMeter(), llm: makeLlm() }),
    startSeq: surfaceBefore[1],
    endSeq: surfaceBefore[Math.min(5, surfaceBefore.length - 2)],
    meter: makeMeter(),
    llm: makeLlm(),
  })
  const { header, events } = artifactOf(session)
  const head = surfaceBefore[0]
  const second = surfaceBefore[1]
  const summaryIndex = events.findIndex((event) => event.type === 'compaction/summary')
  assert.ok(summaryIndex >= 0)

  // Recreate what the early plugin version declared: an exact surface span that
  // includes the protected head.
  const poisoned = events.map((event, index) => {
    if (index !== summaryIndex) return event
    const copy = structuredClone(event)
    copy.data.shadowedRange = { start: head, end: second }
    copy.data.shadowedSeqs = [head, second]
    return copy
  })
  assert.throws(
    () => {
      for (const event of poisoned) assertV4RowAdmission(event, KNOWN_SESSION_EVENT_TYPES)
      assertReleasedV4Relationships({ header, events: poisoned, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES)
    },
    /protected system head/,
    'the loader must reject the exact shape that once poisoned a real long session',
  )
})

test('checkpoint messages carry a producer-owned source kind, never the retired plugin wrapper', () => {
  const base = { id: 'ctx-test', role: 'user', content: [{ type: 'text', text: 'summary' }] }
  assert.doesNotThrow(() =>
    assertCheckpointMessage({ ...base, source: { kind: 'compact-checkpoint', compactionId: 'cid-1' } }),
  )
  assert.throws(() => assertCheckpointMessage({ ...base, source: { kind: 'plugin', plugin: 'dsh-context-keeper' } }), /plugin/)
  assert.throws(() => assertCheckpointMessage({ ...base, source: {} }), /source kind/)
})

