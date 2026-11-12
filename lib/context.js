/**
 * Context reading and fold planning.
 *
 * `selectFoldRange` mirrors the Harness' own retention rule: keep a verbatim
 * recent tail priced by `ctx.tokenMeter`, fold the oldest head, and never cut
 * an assistant tool-call/result pair. The actual summarization and durable
 * transaction stay in the session's own compaction service — this module only
 * decides *when* and *what*, and reports what it saved.
 */

import {
  collectCompactions,
  collectStepUsage,
  collectUsage,
  estimateTokens,
  eventText,
  preview,
  renderBlocks,
  truncate,
  collectToolCallNames,
} from './events.js'
import { runCompaction, systemHeadOf } from './compaction.js'

const MAX_LARGEST_NODES = 8

/**
 * The denominator the auto-fold policy prices pressure against.
 *
 * A routed model may declare a window far larger than any session can reach
 * (self-deployed providers commonly declare 1,048,576), which would put
 * `minPressureRatio` out of reach forever. `maxContextWindowCap > 0` bounds the
 * denominator; `0` keeps the declared window (the pre-0.1.3 behaviour).
 * @returns {number|null} the effective window, or null when the route reports none.
 */
export function effectiveContextWindow(declaredWindow, cap) {
  if (typeof declaredWindow !== 'number' || !Number.isFinite(declaredWindow) || declaredWindow <= 0) return null
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) return declaredWindow
  return Math.min(declaredWindow, cap)
}

/** The first foldable surface position: 1 when node 0 holds the system prompt. */
export function foldableStartIndex(session) {
  return systemHeadOf(session) === null ? 0 : 1
}

/** Heuristic token size of the leading system/developer prompt nodes. */
function promptNodeTokens(session, bySeq) {
  let tokens = 0
  for (const seq of session.surface.nodes) {
    const event = bySeq.get(seq)
    if (!event) break
    if (event.type !== 'system/message' && event.type !== 'developer/message') break
    const message = event.data.message ?? event.data
    tokens += estimateTokens(renderBlocks(message?.content))
  }
  return tokens
}

function safeMeasure(meter, session) {
  try {
    return meter.measure(session)
  } catch {
    return null
  }
}

/** Lazy access to the services this plugin consumes. */
export function makeResources(agent) {
  return {
    meter: () => {
      try {
        return agent.ctx.get('tokenMeter') ?? null
      } catch {
        return null
      }
    },
    compaction: () => {
      try {
        return agent.ctx.get('compaction') ?? null
      } catch {
        return null
      }
    },
    llm: () => {
      try {
        return agent.ctx.get('llm') ?? null
      } catch {
        return null
      }
    },
    session: () => agent.session,
  }
}

/** Summarize the current budget, composition, largest rows, and recorded savings. */
export function buildStatus({ agent, meter, state, cfg }) {
  const session = agent.session
  const events = session.snapshotEvents()
  const header = session.requestHeader?.()
  const route = session.requestContext?.()
  const measurement = meter ? safeMeasure(meter, session) : null
  const contextWindow = typeof route?.contextWindow === 'number' ? route.contextWindow : null
  const effectiveWindow = effectiveContextWindow(contextWindow, cfg?.autoCompact?.maxContextWindowCap)
  const pressureTokens = measurement ? measurement.totalTokens : null
  const surfaceTokens = measurement ? measurement.surfaceTokens : null
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const systemTokens = estimateTokens(header?.system) + promptNodeTokens(session, bySeq)
  const toolsTokens = estimateTokens(header?.tools ? JSON.stringify(header.tools) : '')
  const usage = collectUsage(events)
  const compaction = collectCompactions(events)
  const recentSteps = collectStepUsage(events, 8)

  const largest = []
  if (measurement) {
    const toolNames = collectToolCallNames(events)
    const topNodes = [...measurement.nodes].sort((a, b) => b.tokens - a.tokens).slice(0, MAX_LARGEST_NODES)
    for (const node of topNodes) {
      const event = bySeq.get(node.seq)
      const extracted = event ? eventText(event, toolNames) : null
      largest.push({
        seq: node.seq,
        tokens: node.tokens,
        kind: extracted?.kind ?? event?.type ?? 'unknown',
        ...(extracted?.tool ? { tool: extracted.tool } : {}),
        preview: extracted ? preview(extracted.text, 100) : '',
      })
    }
  }

  const turns = events.filter((event) => event.type === 'turn/start').length
  const steps = events.filter((event) => event.type === 'step/start').length

  return {
    ok: true,
    session: {
      id: session.id,
      preset: session.header?.agentPreset ?? null,
      turns,
      steps,
      events: events.length,
      surfaceNodes: session.surface.nodes.length,
    },
    budget: {
      model: header?.config?.model ?? null,
      provider: header?.config?.provider ?? null,
      contextWindow,
      pressureTokens,
      surfaceTokens,
      usedRatio: contextWindow && pressureTokens !== null ? round(pressureTokens / contextWindow) : null,
      remainingTokens: contextWindow !== null && pressureTokens !== null ? contextWindow - pressureTokens : null,
    },
    composition: {
      systemTokens,
      toolsTokens,
      messageTokens: surfaceTokens,
      note: 'system/tools are fixed-heuristic estimates; messageTokens is the metered surface total',
    },
    largest,
    compaction: {
      checkpoints: compaction.count,
      shadowedTokens: compaction.shadowedTokens,
      summaryTokens: compaction.summaryTokens,
      netSavedTokens: compaction.netSavedTokens,
      summarizerUsage: compaction.summarizerUsage,
      abandoned: compaction.abandoned,
      lastCheckpointSeq: compaction.lastSeq,
      recent: compaction.checkpoints.slice(-3),
    },
    usage: { ...usage, recentSteps },
    keeper: {
      autoAttempts: state?.autoAttempts ?? 0,
      autoFolds: state?.autoFolds ?? 0,
      lastAutoError: state?.lastError ?? null,
      lastSkip: state?.lastSkip ?? null,
      lastPressure: state?.lastPressure ?? null,
      policy: {
        enabled: cfg?.autoCompact?.enabled ?? false,
        minPressureRatio: cfg?.autoCompact?.minPressureRatio ?? null,
        // Window the auto-fold policy measures against (declared, capped by
        // `maxContextWindowCap`); null when the route reports no window. Reading
        // the config plus `session.requestContext()` is enough, so this doubles
        // as a hot-reload check after deployment.
        maxContextWindowCap: cfg?.autoCompact?.maxContextWindowCap ?? null,
        effectiveContextWindow: effectiveWindow,
        retainTokens: cfg?.autoCompact?.retainTokens ?? null,
        minFoldTokens: cfg?.autoCompact?.minFoldTokens ?? null,
        minGrowthTokens: cfg?.autoCompact?.minGrowthTokens ?? null,
      },
    },
  }
}

/**
 * Decide whether node `index` is a safe fold end: after processing the head
 * through `index`, no assistant tool call is left unanswered.
 */
export function isBalancedEnd({ session, nodes, index }) {
  const surface = session.surface.nodes
  const limit = Math.min(index, surface.length - 1)
  return limit >= 0 && latestBalancedEnd(session, nodes, limit) === limit
}

function latestBalancedEnd(session, nodes, limit) {
  const surface = session.surface.nodes
  let latest = -1
  const pending = new Set()
  for (let position = 0; position <= limit; position += 1) {
    const seq = surface[position]
    const event = session.eventAt(seq)
    if (!event) break
    if (event.type === 'assistant/message') {
      const message = event.data.message ?? event.data
      for (const block of message?.content ?? []) {
        if (block?.type === 'tool-call' && block.id !== undefined) pending.add(block.id)
      }
    } else if (event.type === 'tool/result') {
      const message = event.data.message ?? event.data
      const callId = message?.source?.callId
      if (callId !== undefined) pending.delete(callId)
    }
    if (pending.size === 0 && typeof nodes[position]?.seq === 'number' && nodes[position].seq === seq) {
      latest = position
    }
  }
  return latest
}

/**
 * Plan an incremental fold: keep the priced recent tail, fold from the oldest
 * foldable surface node up to the newest balanced boundary before the retained
 * tail. In the current session format surface node 0 holds the system prompt and
 * is never inside a fold.
 * @returns {{ok: true, startSeq: number, endSeq: number, nodes: number, shadowedTokens: number, heuristicTokens: number} | {ok: false, error: string}}
 */
export function selectFoldRange({ session, nodes, retainTokens, minFoldTokens }) {
  if (!Array.isArray(nodes) || nodes.length < 3) {
    return { ok: false, error: 'not enough surface history to fold' }
  }
  const surface = session.surface.nodes
  if (nodes.length !== surface.length) {
    return { ok: false, error: 'metered surface does not match the current session surface; retry next step' }
  }
  const firstIndex = foldableStartIndex(session)
  if (nodes.length <= firstIndex + 1) return { ok: false, error: 'not enough surface history to fold' }
  let accumulated = 0
  let keepFrom = nodes.length
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += nodes[index].tokens ?? 0
    keepFrom = index
    if (accumulated >= retainTokens) break
  }
  const endIndex = latestBalancedEnd(session, nodes, keepFrom - 1)
  if (endIndex < firstIndex) {
    return { ok: false, error: 'no balanced older span can be folded without splitting a tool call' }
  }
  let shadowedTokens = 0
  let heuristicTokens = 0
  for (let index = firstIndex; index <= endIndex; index += 1) {
    shadowedTokens += nodes[index].tokens ?? 0
    heuristicTokens += nodes[index].heuristicTokens ?? 0
  }
  if (shadowedTokens < minFoldTokens) {
    return {
      ok: false,
      error: `oldest balanced span is only ~${shadowedTokens} tokens, below min_tokens ${minFoldTokens}`,
      shadowedTokens,
    }
  }
  return {
    ok: true,
    startSeq: nodes[firstIndex].seq,
    endSeq: nodes[endIndex].seq,
    nodes: endIndex - firstIndex + 1,
    shadowedTokens,
    heuristicTokens,
  }
}

/**
 * Fold one span and report the measured effect.
 *
 * The session's own compaction service is used when this plugin can reach it
 * (a preset that mounts it unisolated); otherwise the plugin runs the identical
 * durable transaction itself, so the capability works in the stock Web/Desktop
 * preset realm too. Throws on summarizer/transaction errors.
 */
export async function foldRange({ agent, resources, startSeq, endSeq, signal }) {
  const meter = resources.meter()
  const before = meter ? safeMeasure(meter, agent.session) : null
  const service = resources.compaction()
  let result
  let engine
  if (service && typeof service.compactRegion === 'function') {
    engine = 'preset'
    result = await service.compactRegion(startSeq, endSeq, agent, signal)
  } else {
    const llm = resources.llm()
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('no compaction engine: neither a preset compaction service nor the llm service is reachable')
    }
    engine = 'keeper'
    result = await runCompaction({ agent, startSeq, endSeq, signal, meter, llm })
  }
  const after = meter ? safeMeasure(meter, agent.session) : null
  return {
    ok: true,
    engine,
    shadowedNodes: Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs.length : null,
    shadowedTokens: result?.shadowedTokenCount ?? null,
    summarySeq: result?.summarySeq ?? null,
    compactionStartSeq: result?.startSeq ?? null,
    compactionEndSeq: result?.endSeq ?? null,
    pressureBefore: before?.totalTokens ?? null,
    pressureAfter: after?.totalTokens ?? null,
    freedTokens:
      before && after
        ? Math.max(0, before.totalTokens - after.totalTokens)
        : result?.shadowedTokenCount ?? null,
  }
}

/** Compact one requested inclusive range, or a planned oldest range. */
export async function compactRequest({ agent, resources, args, cfg, signal }) {
  const meter = resources.meter()
  if (!meter) return { ok: false, error: 'token meter service is unavailable in this session' }
  if (!resources.compaction() && !resources.llm()) {
    return { ok: false, error: 'no compaction engine is reachable from this session (no compaction service and no llm service)' }
  }
  const session = agent.session
  const measurement = safeMeasure(meter, session)
  if (!measurement) return { ok: false, error: 'could not measure the session context' }

  let startSeq
  let endSeq
  let shadowedTokens
  let nodeCount
  if (args.start !== undefined || args.end !== undefined) {
    if (args.start === undefined || args.end === undefined) {
      return { ok: false, error: 'provide both start and end seqs, or neither' }
    }
    const nodes = measurement.nodes
    const startIndex = nodes.findIndex((node) => node.seq === args.start)
    const endIndex = nodes.findIndex((node) => node.seq === args.end)
    if (startIndex < 0 || endIndex < 0) {
      return { ok: false, error: 'start/end must both be surface seqs currently visible in the context' }
    }
    if (startIndex > endIndex) return { ok: false, error: 'start seq is after end seq on the surface' }
    if (startIndex === 0 && foldableStartIndex(session) === 1) {
      return { ok: false, error: 'the system prompt node cannot be folded; start after it' }
    }
    if (!isBalancedEnd({ session, nodes, index: endIndex })) {
      return { ok: false, error: 'the requested end seq would split a tool call/result pair or leave an open step' }
    }
    startSeq = args.start
    endSeq = args.end
    nodeCount = endIndex - startIndex + 1
    shadowedTokens = nodes.slice(startIndex, endIndex + 1).reduce((sum, node) => sum + (node.tokens ?? 0), 0)
  } else {
    const plan = selectFoldRange({
      session,
      nodes: measurement.nodes,
      retainTokens: args.keep_recent_tokens ?? cfg.autoCompact.retainTokens,
      minFoldTokens: args.min_tokens ?? cfg.autoCompact.minFoldTokens,
    })
    if (!plan.ok) return { ok: false, error: plan.error }
    startSeq = plan.startSeq
    endSeq = plan.endSeq
    nodeCount = plan.nodes
    shadowedTokens = plan.shadowedTokens
  }

  const plan = {
    ok: true,
    dryRun: args.dry_run === true,
    range: { start: startSeq, end: endSeq },
    nodes: nodeCount,
    shadowedTokens,
    pressureBefore: measurement.totalTokens,
    contextWindow: session.requestContext?.()?.contextWindow ?? null,
  }
  if (plan.dryRun) return plan
  const outcome = await foldRange({ agent, resources, startSeq, endSeq, signal })
  return { ...plan, ...outcome, dryRun: false }
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

export { renderBlocks, truncate }

