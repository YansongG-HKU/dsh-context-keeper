/**
 * A native compaction transaction.
 *
 * Prefer the session's own `ctx.compaction` service when it is reachable. In a
 * stock Web/Desktop profile it is not: each agent preset mounts
 * `dsh-compaction-basic` inside an isolated service realm, so an Agent-scoped
 * decorator resolves no `compaction` service. This module therefore implements
 * the exact same durable protocol the shipped backend writes:
 *
 *   compaction/start  (log-only lock, enclosed in the open turn)
 *   compaction/summary (log-only shadow price + summary provenance)
 *   user/message      (the single surface REPLACE carrying the checkpoint)
 *   compaction/end    (log-only release, with `error` when the attempt failed)
 *
 * The summarization call replays the session's own system prompt, tool schemas
 * and the selected region messages, then appends the compaction instruction as
 * the final user message — a genuine prefix of the last routed request, so the
 * provider's KV cache is reused. The summary is validated to be smaller than
 * the shadowed content before anything visible changes. A response cut off at
 * the token cap is salvaged when it produced text: the partial checkpoint is
 * still validated against the shadowed span and its summary row is marked
 * `truncated: true`; only an empty answer fails the transaction.
 */

import { estimateTokens, renderBlocks } from './events.js'

const SUMMARY_MAX_TOKENS = 8192
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'
/**
 * Message source kind DSH accepts for a compaction checkpoint (v4 session format).
 * `kind: 'plugin'` is a retired wrapper: a persisted message carrying it fails
 * the format loader (`format v4 message requires a producer-owned source kind`),
 * which would make the whole session unloadable.
 */
const CHECKPOINT_SOURCE_KIND = 'compact-checkpoint'

/** The checkpoint preamble is the shipped backend's wording: models already treat it as established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. ' +
  'Treat the captured context as established background and build on it without restating it. Continue the task ' +
  'directly from the messages that follow, without acknowledging this checkpoint.'

const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Detect an unmatched `compaction/start` (the durable compaction lock). */
export function hasActiveCompaction(session) {
  const events = session.snapshotEvents()
  let lastStart
  let lastEnd
  for (const event of events) {
    if (event.type === 'compaction/start') lastStart = event.seq
    else if (event.type === 'compaction/end') lastEnd = event.seq
  }
  return lastStart !== undefined && (lastEnd === undefined || lastEnd < lastStart)
}

/** The open turn number, or null between turns. */
export function openTurnOf(session) {
  const events = session.snapshotEvents()
  let openTurn = null
  for (const event of events) {
    if (event.type === 'turn/start') openTurn = event.data.turn
    else if (event.type === 'turn/end') openTurn = null
  }
  return openTurn
}

/** One framed replacement message from a summary. */
function checkpointMessage(summary, compactionId) {
  return {
    id: `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content: [
      { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
      ...summary,
      { type: 'text', text: SUMMARY_CLOSE_TAG },
    ],
    // Producer-owned source kind, correlated with the compaction transaction.
    source: { kind: CHECKPOINT_SOURCE_KIND, compactionId },
  }
}

/** The `system/message` at surface node 0 of the current session format. */
export function systemHeadOf(session) {
  const nodes = session.surface.nodes
  if (nodes.length === 0) return null
  const head = session.eventAt(nodes[0])
  return head?.type === 'system/message' ? head : null
}

/**
 * Seq of the surface node the v4 loader protects as the system head, or null.
 *
 * The format keeps the first surface event when it is a `system/message`; that
 * node may never appear inside a recovery/compaction span.
 */
export function protectedHeadOf(session) {
  const head = systemHeadOf(session)
  return head === null ? null : head.seq
}

/**
 * Validate that `[startSeq, endSeq]` is a legal fold target on the current
 * surface, before anything durable is written.
 *
 * A `compaction/summary` declares `shadowedRange` + `shadowedSeqs`, and DSH's v4
 * loader replays those against the surface on every load. A span that is stale,
 * inexact, or that includes the protected system head poisons the session log:
 * every later load fails with a `SessionFormatError` even when the replacement
 * itself never landed. Everything this function rejects must therefore be
 * rejected before the summary row is appended.
 *
 * @returns {{surface: number[], startIndex: number, endIndex: number, shadowedSeqs: number[]}}
 */
export function assertFoldSpan(session, startSeq, endSeq) {
  const surface = [...session.surface.nodes]
  const startIndex = surface.indexOf(startSeq)
  const endIndex = surface.indexOf(endSeq)
  if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
    throw new Error('compaction range is not on the current surface')
  }
  const protectedHead = protectedHeadOf(session)
  if (protectedHead !== null) {
    if (startIndex === 0) {
      throw new Error('cannot fold the system prompt node; start the span after the session system prompt')
    }
    if (surface.slice(startIndex, endIndex + 1).includes(protectedHead)) {
      throw new Error('compaction span must not shadow the protected system head')
    }
  }
  return { surface, startIndex, endIndex, shadowedSeqs: surface.slice(startIndex, endIndex + 1) }
}

/** Reject a checkpoint message the v4 loader would refuse to read back. */
export function assertCheckpointMessage(message) {
  if (typeof message?.id !== 'string' || message.id.length === 0) throw new Error('checkpoint message needs an id')
  if (message.role !== 'user') throw new Error('checkpoint message must have the user role')
  if (!Array.isArray(message.content) || message.content.length === 0) throw new Error('checkpoint message needs content')
  if (!message.content.every((block) => block?.type === 'text' && typeof block.text === 'string')) {
    throw new Error('checkpoint message content must be text blocks')
  }
  const source = message.source
  if (source === null || typeof source !== 'object' || typeof source.kind !== 'string' || source.kind.length === 0) {
    throw new Error('checkpoint message needs a producer-owned source kind')
  }
  if (source.kind === 'plugin') {
    throw new Error('checkpoint message source kind "plugin" is retired in the current session format')
  }
}

/**
 * Replacement marker for this session's surface protocol.
 *
 * The current DSH session format (v4; `system/message` at surface node 0, the
 * desktop app's 0.2.1-rc.5 line) uses `{ op: 'replace', startSeq, endSeq }` and
 * requires exactly those three keys. An older published line used
 * `{ op: 'replace', start, end }`. Evidence from the log wins; a session with no
 * replacement yet that carries a `system/message` defaults to the current shape.
 */
export function replacementSurfaceOp(session, startSeq, endSeq) {
  const events = session.snapshotEvents()
  let modern = false
  let legacy = false
  for (const event of events) {
    const op = event.surfaceOp
    if (!op || typeof op !== 'object') continue
    if (Object.hasOwn(op, 'startSeq')) modern = true
    else if (Object.hasOwn(op, 'start')) legacy = true
  }
  if (!modern && events.some((event) => event.type === 'system/message')) modern = true
  const useSeqFields = modern || !legacy
  return useSeqFields ? { op: 'replace', startSeq, endSeq } : { op: 'replace', start: startSeq, end: endSeq }
}

/** Replay the selected region exactly as the conversation model saw it. */
function buildReplay(session, shadowedSeqs) {
  const header = session.requestHeader()
  const head = systemHeadOf(session)
  const systemMessage = head === null ? null : session.deriveEventMessage(head)
  const regionMessages = shadowedSeqs
    .map((seq) => session.deriveEventMessage(session.eventAt(seq)))
    .filter((message) => message !== null)
  return { header, messages: systemMessage === null ? regionMessages : [systemMessage, ...regionMessages], hasSystemMessage: systemMessage !== null }
}

/** Assemble one streaming model call into text blocks plus usage facts. */
async function runSummaryCall({ llm, session, agent, replay, signal }) {
  const route = replay.header?.config
  const provider = route?.provider ?? agent.options?.provider
  const model = route?.model ?? agent.options?.model
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
    throw new Error('no routed provider/model available for summarization')
  }
  // Carry the route's thinking configuration into the summary call: a
  // reasoning model should fold under the same effort the session is routed
  // with, otherwise a provider default (often "high") can spend the whole
  // summary budget on hidden reasoning and truncate the answer. Only forward it
  // when the route actually declares one; never invent a value (`temperature`
  // is left alone for the same reason).
  const reasoningEffort = route?.reasoningEffort
  const routedEffort = typeof reasoningEffort === 'string' && reasoningEffort.length > 0 ? reasoningEffort : null
  // The directive is the final user message, exactly as the shipped backend
  // sends it: a bare `{role, content}` with no persisted-message source tag.
  const instruction = {
    role: 'user',
    content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
  }
  // Routed tool history travels with the call so the summarization request is a
  // genuine prefix of the last routed request (KV-cache reuse, same as shipped).
  let toolHistory
  try {
    if (typeof session.toolHistory === 'function') toolHistory = session.toolHistory()
  } catch {
    toolHistory = undefined
  }
  const options = {
    provider,
    model,
    messages: [...replay.messages, instruction],
    ...(toolHistory === undefined ? {} : { toolHistory }),
    // The current format carries the system prompt as a leading
    // `system/message` in `messages`; only the legacy protocol still uses the
    // out-of-band `system` slot.
    ...(replay.hasSystemMessage || replay.header?.system === undefined ? {} : { system: replay.header.system }),
    ...(replay.header?.tools === undefined ? {} : { tools: [...replay.header.tools] }),
    maxTokens: SUMMARY_MAX_TOKENS,
    ...(routedEffort === null ? {} : { reasoningEffort: routedEffort }),
    sessionId: session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  }
  const blocks = []
  let usage
  let finish
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') blocks.push(chunk.block)
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    throw new Error(`summarization failed: ${finish.failure?.message ?? finish.kind}`)
  }
  const summary = blocks
    .map((block) => ({ type: 'text', text: String(block.text ?? '') }))
    .filter((block) => block.text.trim().length > 0)
  // A response cut off at the token cap is still usable when it produced text:
  // a partial checkpoint beats no checkpoint. The caller validates that the
  // framed result is smaller than the shadowed span before committing it, and
  // marks the summary row `truncated: true`. Only an empty answer is fatal.
  const truncated = finish?.kind === 'max-tokens'
  if (summary.length === 0) {
    if (truncated) throw new Error('summarization truncated at the token cap')
    throw new Error('summarization produced no text summary content')
  }
  return { summary, usage, provider, model, ...(truncated ? { truncated: true } : {}) }
}

/** Price the framed checkpoint with the same estimator the harness uses when possible. */
function priceCheckpoint(meter, message, summary) {
  if (meter && typeof meter.estimateMessage === 'function') {
    try {
      return meter.estimateMessage(message)
    } catch {
      /* fall through to the fixed heuristic */
    }
  }
  return estimateTokens(renderBlocks(message.content)) + 8
}

/**
 * Run one compaction transaction over an inclusive surface span.
 * @returns {{ok: true, compactionId: string, startSeq: number, summarySeq: number, endSeq: number, shadowedSeqs: number[], shadowedTokenCount: number, summary: object[], usage: object|undefined}}
 */
export async function runCompaction({ agent, startSeq, endSeq, signal, meter, llm }) {
  const session = agent.session
  // Validate the span against the current surface *before* any durable row is
  // written. A summary whose shadowed span is illegal poisons the log even when
  // the replacement never lands (the loader replays every summary range).
  const span = assertFoldSpan(session, startSeq, endSeq)
  const surface = span.surface
  const startIndex = span.startIndex
  const endIndex = span.endIndex
  const shadowedSeqs = span.shadowedSeqs
  const turn = openTurnOf(session)
  if (turn === null) throw new Error('compaction needs an open turn')
  if (hasActiveCompaction(session)) throw new Error('another compaction is already in progress')

  const measurement = meter?.measure(session)
  const selected = measurement?.nodes?.slice(startIndex, endIndex + 1) ?? []
  const shadowedRouteTokens = selected.reduce((sum, node) => sum + (node.tokens ?? 0), 0)
  const shadowedHeuristicTokens = selected.reduce((sum, node) => sum + (node.heuristicTokens ?? 0), 0)

  const replay = buildReplay(session, shadowedSeqs)
  const compactionId = `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const startEvent = session.append('compaction/start', { compactionId, turn })
  let summarized
  try {
    summarized = await runSummaryCall({ llm, session, agent, replay, signal })
  } catch (error) {
    closeWithError(session, compactionId, turn, error)
    throw error
  }

  // The summarizer may have written its own rows; the model-visible history
  // must not have moved under the selected span.
  const after = [...session.surface.nodes]
  if (after.length !== surface.length || after.some((seq, index) => seq !== surface[index])) {
    closeWithError(session, compactionId, turn, new Error('session surface changed during summarization'))
    throw new Error('session surface changed during summarization')
  }
  // Re-assert the exact span and the protected-head rule on the live surface
  // right before the summary row is committed.
  const rechecked = assertFoldSpan(session, startSeq, endSeq)
  if (
    rechecked.shadowedSeqs.length !== shadowedSeqs.length ||
    rechecked.shadowedSeqs.some((seq, index) => seq !== shadowedSeqs[index])
  ) {
    closeWithError(session, compactionId, turn, new Error('compaction span changed during summarization'))
    throw new Error('compaction span changed during summarization')
  }

  const checkpoint = checkpointMessage(summarized.summary, compactionId)
  assertCheckpointMessage(checkpoint)
  const framedTokens = priceCheckpoint(meter, checkpoint, summarized.summary)
  const shadowedPrice = shadowedRouteTokens > 0 ? shadowedRouteTokens : shadowedHeuristicTokens
  if (framedTokens >= shadowedPrice) {
    closeWithError(session, compactionId, turn, new Error('summary is not smaller than the shadowed content'))
    throw new Error(`summary is not smaller than the shadowed content (${framedTokens} >= ${shadowedPrice})`)
  }

  let summaryEvent
  let replacement
  try {
    summaryEvent = session.append('compaction/summary', {
      compactionId,
      summary: summarized.summary,
      shadowedRange: { start: startSeq, end: endSeq },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount: shadowedHeuristicTokens,
      provider: summarized.provider,
      model: summarized.model,
      maxTokens: SUMMARY_MAX_TOKENS,
      ...(summarized.truncated === true ? { truncated: true } : {}),
      ...(summarized.usage === undefined ? {} : { usage: summarized.usage }),
    })
    replacement = session.append('user/message', checkpoint, {
      surfaceOp: replacementSurfaceOp(session, startSeq, endSeq),
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    })
  } catch (error) {
    closeWithError(session, compactionId, turn, error)
    throw error
  }
  const endEvent = session.append('compaction/end', { compactionId, turn })
  return {
    ok: true,
    compactionId,
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    replacementSeq: replacement.seq,
    endSeq: endEvent.seq,
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount: shadowedHeuristicTokens,
    shadowedRouteTokens,
    framedTokens,
    summary: summarized.summary,
    usage: summarized.usage,
    ...(summarized.truncated === true ? { truncated: true } : {}),
  }
}

function closeWithError(session, compactionId, turn, error) {
  try {
    session.append('compaction/end', {
      compactionId,
      turn,
      error: error instanceof Error ? error.message : String(error),
    })
  } catch {
    /* a failed close deliberately leaves the lock detectable */
  }
}
