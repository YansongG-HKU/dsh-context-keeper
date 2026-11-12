/**
 * Host half of the dsh-context-keeper panel.
 *
 * Registers one loopback-only, same-origin JSON route that the Client panel
 * (client.js) polls:
 *
 *   GET /context-keeper/api/state
 *     → { sessions: [...], totals: { sessions, pressureTokens, netSavedTokens, cacheHitRatio } }
 *
 * Nothing here imports a third-party package: the data is assembled from this
 * plugin's own `lib/context.js` (`makeResources`, `buildStatus`) and
 * `lib/events.js` (`collectUsage`), so the route follows the same session-log
 * reading rules as the model-facing tools.
 *
 * The route is defensive by construction: a single unreadable Agent is skipped
 * instead of failing the whole response, request handling never throws into the
 * web server, and an unavailable `webServer` service leaves the plugin inactive
 * (the package still works in agents-only profiles).
 */

import { buildStatus, makeResources } from './context.js'
import { collectUsage } from './events.js'

/** Prefix route owned by this plugin; also the base of the Client's fetch path. */
const ROUTE_PREFIX = '/context-keeper'
/** The single operation the Client panel is allowed to call. */
const STATE_PATH = `${ROUTE_PREFIX}/api/state`
/** Request header that marks a request as coming from this plugin's own page code. */
const REQUEST_HEADER = 'x-context-keeper'
/** Methods accepted by the state route (HEAD is answered like GET but without a body). */
const ALLOWED_METHODS = new Set(['GET', 'HEAD'])

/**
 * Register the panel route.
 *
 * `webServer` is an optional service at the package level: the plugin is
 * mounted in profiles without a Web server (headless runs) and must stay inert
 * there rather than fail activation.
 *
 * @param {object} ctx - the plugin's Cordis context (the caller declares `agents`).
 * @param {object|Function} [options] - optional keeper-state access.
 *   `options.stateOf(agentId)` returns the per-agent auto-compaction state kept
 *   by `index.js` (`autoFolds`, `lastSkip`, …). A `Map` of agent id → record is
 *   accepted as well. `options.cfg` is the resolved plugin config, used to cap
 *   the auto-fold pressure window. Without it, those fields default to 0 / null.
 * @returns {unknown} the Cordis fiber (or disposer) of the child installation.
 */
export function registerPanel(ctx, options) {
  const stateOf = resolveStateOf(options)
  const cfg = resolvePanelConfig(options)
  return ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    webCtx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => handleRequest(webCtx, stateOf, cfg, req, res),
        }),
      'dsh-context-keeper: panel route',
    )
  })
}

/**
 * Build the response payload without touching HTTP.
 *
 * Exported so the CLI/tests can assert the panel data shape without a server.
 *
 * @param {object} ctx - context exposing `agents` (`ctx.agents.list()`).
 * @param {(agentId: string) => object|null|undefined} [stateOf] - per-agent state access.
 * @param {object} [cfg] - resolved plugin config; carries `autoCompact.maxContextWindowCap`.
 * @returns {{sessions: object[], totals: {sessions: number, pressureTokens: number, netSavedTokens: number, cacheHitRatio: number|null}}}
 */
export function buildPanelState(ctx, stateOf, cfg) {
  const sessions = []
  const readState = typeof stateOf === 'function' ? stateOf : () => null
  for (const agent of listAgents(ctx)) {
    try {
      sessions.push(sessionRow(agent, readState, cfg ?? null))
    } catch {
      // A disposed or not-yet-ready Agent must not blank the whole panel.
    }
  }
  return { sessions, totals: totalsOf(sessions) }
}

/** Same-origin gate: loopback Host header, plugin request header, and (when sent) a matching Origin. */
function sameOrigin(webServer, req) {
  const headers = req.headers ?? {}
  const host = headers.host
  const port = webServer.port
  if (typeof host !== 'string' || port === undefined) return false
  const expected = [`127.0.0.1:${port}`, `localhost:${port}`]
  if (!expected.includes(host)) return false
  if (headers[REQUEST_HEADER] !== '1') return false
  const origin = headers.origin
  if (origin === undefined) return true
  const protocol = typeof webServer.protocol === 'string' ? webServer.protocol : 'http:'
  return origin === `${protocol}//${host}`
}

/** Route one request; every failure path answers JSON and never escapes. */
function handleRequest(webCtx, stateOf, cfg, req, res) {
  try {
    if (!sameOrigin(webCtx.webServer, req)) {
      sendJson(res, 403, { error: 'Same-origin context-keeper request required' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    if (url.pathname !== STATE_PATH) {
      sendJson(res, 404, { error: 'Unknown context-keeper route' })
      return
    }
    if (!ALLOWED_METHODS.has(method)) {
      sendJson(res, 405, { error: `Method ${method} is not allowed` })
      return
    }
    const payload = buildPanelState(webCtx, stateOf, cfg)
    if (method === 'HEAD') {
      sendJson(res, 200, payload, { body: false })
      return
    }
    sendJson(res, 200, payload)
  } catch (error) {
    try {
      sendJson(res, 500, { error: errorMessage(error) })
    } catch {
      // The response may already be gone; nothing else can be reported here.
    }
  }
}

/** One response row for one live Agent; every field is always present. */
function sessionRow(agent, stateOf, cfg) {
  const resources = makeResources(agent)
  let meter = null
  try {
    meter = resources.meter()
  } catch {
    meter = null
  }
  let state = null
  try {
    state = stateOf(agent.id) ?? null
  } catch {
    state = null
  }
  const status = buildStatus({ agent, meter, state, cfg: cfg ?? null })
  const budget = status?.budget ?? {}
  const composition = status?.composition ?? {}
  const compaction = status?.compaction ?? {}
  const keeper = status?.keeper ?? {}
  const sessionInfo = status?.session ?? {}
  const header = agent?.session?.header ?? {}
  const usage = status?.usage ?? fallbackUsage(agent)

  const pressureTokens = numberOrNull(budget.pressureTokens)
  const contextWindow = numberOrNull(budget.contextWindow)
  const ratio =
    numberOrNull(budget.usedRatio) ??
    (pressureTokens !== null && contextWindow !== null && contextWindow > 0 ? pressureTokens / contextWindow : null)
  // The auto-fold policy may price pressure against a capped window; expose it
  // so the client can distinguish real window occupancy from the fold trigger.
  const policy = keeper.policy ?? {}
  const autoFoldWindow = numberOrNull(policy.effectiveContextWindow) ?? contextWindow

  return {
    id: String(agent.id),
    preset: typeof sessionInfo.preset === 'string' ? sessionInfo.preset : null,
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    pressureTokens,
    contextWindow,
    autoFoldWindow,
    ratio,
    surfaceTokens: numberOrNull(budget.surfaceTokens) ?? numberOrNull(composition.messageTokens),
    systemTokens: numberOrNull(composition.systemTokens) ?? 0,
    toolsTokens: numberOrNull(composition.toolsTokens) ?? 0,
    netSavedTokens: numberOrNull(compaction.netSavedTokens) ?? 0,
    checkpoints: numberOrNull(compaction.checkpoints) ?? 0,
    autoFolds: numberOrNull(keeper.autoFolds) ?? 0,
    lastSkip: typeof keeper.lastSkip === 'string' && keeper.lastSkip.length > 0 ? keeper.lastSkip : null,
    steps: Math.max(numberOrNull(sessionInfo.steps) ?? 0, numberOrNull(usage.steps) ?? 0),
    cacheHitRatio: numberOrNull(usage.cacheHitRatio),
  }
}

/** Read provider usage only when the status view did not carry it. */
function fallbackUsage(agent) {
  try {
    return collectUsage(agent.session.snapshotEvents())
  } catch {
    return {}
  }
}

function totalsOf(rows) {
  return {
    sessions: rows.length,
    pressureTokens: sumOf(rows, 'pressureTokens'),
    netSavedTokens: sumOf(rows, 'netSavedTokens'),
    cacheHitRatio: averageOf(rows, 'cacheHitRatio'),
  }
}

function sumOf(rows, key) {
  let total = 0
  for (const row of rows) if (numberOrNull(row[key]) !== null) total += row[key]
  return total
}

function averageOf(rows, key) {
  let total = 0
  let count = 0
  for (const row of rows) {
    if (numberOrNull(row[key]) === null) continue
    total += row[key]
    count += 1
  }
  return count > 0 ? total / count : null
}

function listAgents(ctx) {
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents
    const list = agents?.list?.()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function resolveStateOf(options) {
  if (typeof options === 'function') return options
  if (options === null || typeof options !== 'object') return () => null
  if (typeof options.stateOf === 'function') return options.stateOf
  if (typeof options.get === 'function') {
    return (agentId) => {
      const value = options.get(agentId)
      return value && typeof value === 'object' ? (value.state ?? null) : null
    }
  }
  return () => null
}

/** The resolved plugin config carried alongside the state accessor, if any. */
function resolvePanelConfig(options) {
  if (options === null || typeof options !== 'object') return null
  return options.cfg ?? null
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Minimal JSON responder; owns the response like the Web server contract requires. */
function sendJson(res, status, value, options) {
  if (res.headersSent || res.writableEnded) return
  const body = JSON.stringify(value === undefined ? {} : value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  if (options && options.body === false) {
    res.end()
    return
  }
  res.end(body)
}

