/**
 * Incremental auto-compaction policy.
 *
 * This is the part that actually saves tokens without asking the model: every
 * time measured pressure crosses `minPressureRatio`, fold the oldest safe span
 * through the session's own compaction service, keeping the recent tail
 * verbatim. Native `dsh-compaction-basic` stays mounted at its 0.8 threshold as
 * the backstop, so this policy only ever folds *earlier and smaller* than the
 * harness would; each fold also turns the previous summary into the head of a
 * new summary, which is the multi-generation behavior that keeps a long
 * session faithful instead of one giant lossy checkpoint at the end.
 */

import { foldRange, selectFoldRange } from './context.js'

const round = (value) => Math.round(value * 1000) / 1000

/** Create the per-agent between-step fold attempt. */
export function createAutoCompaction({ agent, resources, cfg, state, log }) {
  return async function maybeAutoCompact(payload) {
    const policy = cfg.autoCompact
    if (!policy.enabled) return
    const signal = payload?.signal
    if (signal?.aborted) return

    const turn = payload?.turn
    if (turn !== state.lastTurn) {
      state.lastTurn = turn
      state.foldsThisTurn = 0
    }
    if (policy.maxFoldsPerTurn > 0 && state.foldsThisTurn >= policy.maxFoldsPerTurn) {
      state.lastSkip = 'turn fold budget reached'
      return
    }

    const meter = resources.meter()
    if (!meter) {
      state.lastSkip = 'token meter unavailable'
      return
    }
    if (!resources.compaction() && !resources.llm()) {
      state.lastSkip = 'no compaction engine available'
      return
    }

    const session = agent.session
    const contextWindow = session.requestContext?.()?.contextWindow
    if (typeof contextWindow !== 'number' || contextWindow <= 0) {
      state.lastSkip = 'routed model reports no context window'
      return
    }
    const measurement = meter.measure(session)
    const ratio = measurement.totalTokens / contextWindow
    state.lastPressure = {
      totalTokens: measurement.totalTokens,
      contextWindow,
      ratio: round(ratio),
    }
    if (ratio < policy.minPressureRatio) {
      state.lastSkip = 'below pressure threshold'
      return
    }
    if (
      state.lastFoldTokens !== null &&
      measurement.totalTokens - state.lastFoldTokens < policy.minGrowthTokens
    ) {
      state.lastSkip = 'waiting for growth since the last fold'
      return
    }

    const plan = selectFoldRange({
      session,
      nodes: measurement.nodes,
      retainTokens: policy.retainTokens,
      minFoldTokens: policy.minFoldTokens,
    })
    if (!plan.ok) {
      state.lastSkip = plan.error
      return
    }

    state.autoAttempts += 1
    try {
      const outcome = await foldRange({
        agent,
        resources,
        startSeq: plan.startSeq,
        endSeq: plan.endSeq,
        signal,
      })
      state.autoFolds += 1
      state.foldsThisTurn += 1
      state.lastSkip = null
      state.lastError = null
      state.lastFold = {
        startSeq: plan.startSeq,
        endSeq: plan.endSeq,
        nodes: outcome.shadowedNodes,
        shadowedTokens: outcome.shadowedTokens,
        summarySeq: outcome.summarySeq,
        freedTokens: outcome.freedTokens,
      }
      try {
        state.lastFoldTokens = meter.measure(session).totalTokens
      } catch {
        state.lastFoldTokens = null
      }
      log?.info(
        `auto-fold (${outcome.engine}): ${plan.nodes} nodes, ~${plan.shadowedTokens} tokens -> summary seq ${outcome.summarySeq} ` +
          `(pressure ${outcome.pressureBefore} -> ${outcome.pressureAfter})`,
      )
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error)
      state.lastSkip = 'fold failed'
      log?.warn(`auto-fold failed: ${state.lastError}`)
    }
  }
}
