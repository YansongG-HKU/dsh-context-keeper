import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'
import { loadSessionClass } from './helpers.mjs'

function fakeHost(agents) {
  const handlers = []
  return {
    ctx: {
      agents: { list: () => agents },
      logger: { info() {}, warn() {} },
      on(event, listener) {
        handlers.push({ event, listener })
        return () => {
          const index = handlers.indexOf(handlers.find((entry) => entry.listener === listener))
          if (index >= 0) handlers.splice(index, 1)
        }
      },
    },
    handlers,
  }
}

function fakeAgent(session) {
  const registrations = []
  const listeners = []
  return {
    id: session.id,
    session,
    options: {},
    ctx: {
      get: () => undefined,
      tools: {
        register(definition) {
          registrations.push(definition)
          return () => registrations.splice(registrations.indexOf(definition), 1)
        },
      },
      systemPrompt: { section: () => () => {} },
      on(event, listener) {
        const entry = { event, listener }
        listeners.push(entry)
        return () => listeners.splice(listeners.indexOf(entry), 1)
      },
    },
    __test: { registrations, listeners },
  }
}

test('apply decorates live agents with four tools and one pre-step listener', async () => {
  const Session = await loadSessionClass()
  const session = Session.create(`wire-${Date.now()}`)
  const agent = fakeAgent(session)
  const host = fakeHost([agent])
  const dispose = apply(host.ctx, undefined)
  assert.equal(agent.__test.registrations.length, 4)
  assert.deepEqual(
    agent.__test.registrations.map((definition) => definition.name).sort(),
    ['context_compact', 'context_restore', 'context_search', 'context_status'],
  )
  assert.equal(agent.__test.listeners.filter((entry) => entry.event === 'agent/pre-step').length, 1)
  assert.equal(host.handlers.filter((entry) => entry.event === 'agent/created').length, 1)
  dispose()
  assert.equal(agent.__test.registrations.length, 0)
  assert.equal(agent.__test.listeners.length, 0)
})

test('agent/created decoration is idempotent and agent/disposed cleans up', async () => {
  const Session = await loadSessionClass()
  const session = Session.create(`wire-created-${Date.now()}`)
  const agent = fakeAgent(session)
  const host = fakeHost([])
  apply(host.ctx, undefined)
  const created = host.handlers.find((entry) => entry.event === 'agent/created')
  created.listener({ agent })
  created.listener({ agent })
  assert.equal(agent.__test.registrations.length, 4, 'decorated once')
  const disposed = host.handlers.find((entry) => entry.event === 'agent/disposed')
  disposed.listener({ agent })
  assert.equal(agent.__test.registrations.length, 0)
})

test('subagent sessions are skipped unless includeSubagents is on', async () => {
  const Session = await loadSessionClass()
  // One id for both the session and its v4 header: the loader validates they match.
  const sessionId = `wire-sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const session = Session.create(sessionId, undefined, {
    version: 4,
    id: sessionId,
    createdAt: Date.now(),
    isSeeded: false,
    origin: 'subagent',
    delegationDepth: 1,
  })
  const agent = fakeAgent(session)
  const host = fakeHost([agent])
  apply(host.ctx, undefined)
  assert.equal(agent.__test.registrations.length, 0)
  const included = fakeAgent(session)
  const host2 = fakeHost([included])
  apply(host2.ctx, { includeSubagents: true })
  assert.equal(included.__test.registrations.length, 4)
})

test('invalid config fails the plugin load loudly', () => {
  const host = fakeHost([])
  assert.throws(() => apply(host.ctx, { nope: true }), /unknown config key/)
  assert.throws(() => apply(host.ctx, { autoCompact: { minPressureRatio: 3 } }), /minPressureRatio/)
})

test('autoCompact can be disabled while tools stay available', async () => {
  const Session = await loadSessionClass()
  const session = Session.create(`wire-disabled-${Date.now()}`)
  const agent = fakeAgent(session)
  const host = fakeHost([agent])
  apply(host.ctx, { autoCompact: { enabled: false } })
  assert.equal(agent.__test.registrations.length, 4)
  assert.equal(agent.__test.listeners.length, 0)
})

