/**
 * dsh-context-keeper — Host plugin entry.
 *
 * The plugin is a decorator, not a replacement: it waits for
 * `agent/created` (and decorates Agents that were already live when the plugin
 * loaded), then registers model-facing context tools and an incremental
 * compaction listener *inside that Agent's scope*. That is why it works with
 * any stock preset: the preset still owns compaction, prompting, and tools;
 * this plugin only adds a budget view, retrieval over the compacted history,
 * and an earlier, incremental fold policy.
 */

import { makeResources } from './lib/context.js'
import { createAutoCompaction } from './lib/auto.js'
import { createTools } from './lib/tools.js'
import { resolveConfig } from './lib/config.js'
import { registerPanel } from './lib/panel.js'

export const inject = ['agents']

const PROMPT_SECTION =
  'Context tools are available: `context_status` shows the budget, `context_search` searches the full history including ' +
  'compacted parts, `context_restore` reads exact earlier rows, and `context_compact` folds a chosen old span. ' +
  'Use them when this session grows long, and restore a detail instead of re-exploring.'

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const bindings = new Map()

  const log = {
    info: (message) => write(ctx, 'info', message),
    warn: (message) => write(ctx, 'warn', message),
  }

  const decorate = (agent) => {
    try {
      if (!agent?.session || bindings.has(agent.id)) return
      const header = agent.session.header ?? {}
      if (!cfg.includeSubagents && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)) {
        log.info(`skip subagent session ${agent.id}`)
        return
      }
      if (!agent.ctx?.tools) {
        log.warn(`agent ${agent.id} has no tool registry; not decorating`)
        return
      }

      const state = {
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
      const disposers = []
      try {
        const tools = createTools({ agent, cfg, state, log })
        for (const definition of tools) disposers.push(agent.ctx.tools.register(definition))

        if (cfg.promptSection) {
          const dispose = agent.ctx.systemPrompt?.section?.({
            name: 'dsh-context-keeper',
            order: 9000,
            interpolate: false,
            text: () => PROMPT_SECTION,
          })
          if (dispose) disposers.push(dispose)
        }

        if (cfg.autoCompact.enabled) {
          const maybeAutoCompact = createAutoCompaction({
            agent,
            resources: makeResources(agent),
            cfg,
            state,
            log,
          })
          const dispose = agent.ctx.on('agent/pre-step', async (payload, next) => {
            try {
              await maybeAutoCompact({ turn: payload?.turn, signal: payload?.signal })
            } catch (error) {
              log.warn(`auto-compact listener failed: ${errorMessage(error)}`)
            }
            return next()
          })
          if (dispose) disposers.push(dispose)
        }
      } catch (error) {
        for (const dispose of disposers.splice(0)) safeDispose(dispose)
        log.warn(`could not decorate agent ${agent.id}: ${errorMessage(error)}`)
        return
      }

      bindings.set(agent.id, {
        state,
        dispose() {
          for (const dispose of disposers.splice(0)) safeDispose(dispose)
        },
      })
      log.info(`decorated ${agent.id}: ${createToolsCount(cfg)} tools, autoCompact=${cfg.autoCompact.enabled}`)
    } catch (error) {
      log.warn(`decoration failed for ${agent?.id ?? 'unknown agent'}: ${errorMessage(error)}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => decorate(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const binding = bindings.get(agent.id)
    if (!binding) return
    binding.dispose()
    bindings.delete(agent.id)
  })

  try {
    for (const agent of ctx.agents.list()) decorate(agent)
  } catch (error) {
    log.warn(`could not enumerate live agents: ${errorMessage(error)}`)
  }

  // Web panel: one loopback same-origin JSON route the Client half polls. The
  // registration is optional (headless profiles have no webServer); any failure
  // must not affect the model-facing tools.
  let panel
  try {
    panel = registerPanel(ctx, { stateOf: (agentId) => bindings.get(agentId)?.state ?? null })
  } catch (error) {
    log.warn(`could not register the panel route: ${errorMessage(error)}`)
  }

  log.info(
    `active: ${createToolsCount(cfg)} tools, autoCompact=${cfg.autoCompact.enabled}, ` +
      `threshold=${cfg.autoCompact.minPressureRatio}, retain=${cfg.autoCompact.retainTokens}`,
  )

  return () => {
    for (const binding of bindings.values()) binding.dispose()
    bindings.clear()
    if (typeof panel === 'function') safeDispose(panel)
  }
}

function createToolsCount(cfg) {
  return ['status', 'search', 'restore', 'compact'].filter((name) => cfg.tools[name]).length
}

function write(ctx, level, message) {
  try {
    const logger = ctx.logger
    if (typeof logger?.[level] === 'function') logger[level](`[dsh-context-keeper] ${message}`)
  } catch {
    /* logging must never break a turn */
  }
}

function safeDispose(dispose) {
  try {
    if (typeof dispose === 'function') dispose()
  } catch {
    /* an already-disposed registration is fine */
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
