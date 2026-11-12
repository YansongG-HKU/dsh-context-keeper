import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { makeAgent, makeMeter, makeSession } from './helpers.mjs'
import { buildPanelState, registerPanel } from '../lib/panel.js'
import { resolveConfig } from '../lib/config.js'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))

/** Minimal React stand-in: the factory only defines components and registers slots. */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (callback) => callback,
  useMemo: (factory) => factory(),
  useReducer: (reducer, initial) => [initial, () => {}],
  Fragment: 'Fragment',
}

function loadClientModule() {
  const code = fs.readFileSync(CLIENT_PATH, 'utf8')
  let definition
  const windowStub = { __ModuleLoader__: { load: (value) => { definition = value } } }
  new Function('window', code)(windowStub)
  assert.ok(definition, 'client.js registers one module with the loader')
  assert.equal(definition.id, 'dsh-context-keeper')
  const factory = definition.factory((id) => {
    if (id === 'react') return ReactStub
    throw new Error(`unexpected client dependency: ${id}`)
  })
  return factory
}

test('client.js registers a sidebar entry and a main panel through the slot API', () => {
  const factory = loadClientModule()
  const registered = []
  const ctx = {
    effect(callback) {
      return callback()
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject(name, register) {
        assert.ok(['sidebar.panellist', 'main'].includes(name), `unexpected slot ${name}`)
        register()
      },
      register(options, component) {
        registered.push({ options, component })
      },
    },
  }
  assert.deepEqual(factory.inject, ['slots', 'locale'])
  factory.apply(ctx)
  const sidebar = registered.find((entry) => entry.options.name === 'sidebar.panellist')
  const panel = registered.find((entry) => entry.options.name === 'main')
  assert.ok(sidebar, 'sidebar.panellist registered')
  assert.equal(sidebar.options.id, 'dsh-context-keeper')
  assert.equal(sidebar.options.order, 20)
  assert.equal(typeof sidebar.options.label, 'function')
  assert.equal(typeof sidebar.component, 'function', 'icon component')
  assert.ok(panel, 'main panel registered')
  assert.equal(panel.options.key, 'dsh-context-keeper')
  assert.equal(typeof panel.component, 'function', 'panel component')
})

test('buildPanelState summarizes live agents for the panel', async () => {
  const session = await makeSession()
  const agent = makeAgent(session, { tokenMeter: makeMeter() })
  const state = { autoFolds: 2, lastSkip: 'below pressure threshold' }
  const payload = buildPanelState({ agents: { list: () => [agent] } }, () => state)
  assert.equal(payload.totals.sessions, 1)
  assert.equal(payload.sessions.length, 1)
  const row = payload.sessions[0]
  assert.equal(row.id, session.id)
  assert.equal(row.preset, null)
  assert.equal(typeof row.pressureTokens, 'number')
  assert.equal(row.contextWindow, 200000)
  assert.equal(row.autoFoldWindow, 200000, 'without a cap the policy window equals the declared window')
  assert.ok(row.ratio > 0)
  assert.ok(row.surfaceTokens > 0)
  assert.ok(row.systemTokens > 0, 'system head is priced')
  assert.ok(row.toolsTokens > 0)
  assert.equal(row.autoFolds, 2)
  assert.equal(row.lastSkip, 'below pressure threshold')
  assert.ok(row.steps > 0)
  assert.ok(typeof row.cacheHitRatio === 'number')
  assert.ok(payload.totals.pressureTokens > 0)
  const capped = buildPanelState(
    { agents: { list: () => [agent] } },
    () => state,
    resolveConfig({ autoCompact: { maxContextWindowCap: 100000 } }),
  )
  assert.equal(capped.sessions[0].contextWindow, 200000, 'the declared window is still reported')
  assert.equal(capped.sessions[0].autoFoldWindow, 100000, 'the capped window drives the auto-fold policy')
})

test('registerPanel serves a same-origin JSON state route and rejects foreign callers', async () => {
  const session = await makeSession()
  const agent = makeAgent(session, { tokenMeter: makeMeter() })
  let route
  const webServer = {
    port: 1234,
    protocol: 'http:',
    register(candidate) {
      route = candidate
      return () => {}
    },
  }
  const webCtx = {
    webServer,
    effect: (callback) => callback(),
    get: (name) => (name === 'agents' ? { list: () => [agent] } : undefined),
  }
  const ctx = {
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['webServer'])
      return callback(webCtx)
    },
  }
  registerPanel(ctx, { stateOf: () => ({ autoFolds: 1, lastSkip: null }) })
  assert.ok(route, 'route registered')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/context-keeper')

  const call = (headers, url = '/context-keeper/api/state', method = 'GET') => {
    const response = {
      status: 0,
      headers: null,
      body: '',
      headersSent: false,
      writableEnded: false,
      writeHead(status, responseHeaders) {
        this.status = status
        this.headers = responseHeaders
        this.headersSent = true
      },
      end(body) {
        this.body = body ?? ''
        this.writableEnded = true
      },
    }
    route.handler({ url, method, headers }, response)
    return response
  }

  const ok = call({ host: '127.0.0.1:1234', 'x-context-keeper': '1' })
  assert.equal(ok.status, 200)
  const payload = JSON.parse(ok.body)
  assert.ok(Array.isArray(payload.sessions))
  assert.equal(payload.totals.sessions, 1)

  const foreign = call({ host: '127.0.0.1:1234' })
  assert.equal(foreign.status, 403)
  const wrongRoot = call({ host: '127.0.0.1:1234', 'x-context-keeper': '1' }, '/context-keeper/other')
  assert.equal(wrongRoot.status, 404)
  const wrongMethod = call({ host: '127.0.0.1:1234', 'x-context-keeper': '1' }, '/context-keeper/api/state', 'POST')
  assert.equal(wrongMethod.status, 405)
})
