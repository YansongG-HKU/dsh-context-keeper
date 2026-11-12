/**
 * Pure helpers over the DSH session event log.
 *
 * Nothing here imports a DSH package: the shapes are the documented durable
 * event payloads, so the same code runs inside the Harness and in plain Node
 * tests. The token estimate deliberately matches the Harness heuristic
 * (four characters per token) so numbers here line up with `ctx.tokenMeter`
 * and the compaction shadow prices.
 */

export const CHARS_PER_TOKEN = 4

/** Fixed-heuristic token estimate for one piece of text. */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Truncate to `maxChars`, marking the cut so a reader knows it is partial. */
export function truncate(text, maxChars) {
  if (typeof text !== 'string') return ''
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

/** One-line preview: collapse whitespace and bound the length. */
export function preview(text, maxChars = 120) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return truncate(flat, maxChars)
}

/** Render model content blocks to searchable/restorable plain text. */
export function renderBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
    } else if (block.type === 'reasoning') {
      if (typeof block.text === 'string' && block.text.length > 0) parts.push(`[reasoning] ${block.text}`)
    } else if (block.type === 'tool-call') {
      parts.push(`[tool-call ${block.name ?? '?'} ${truncate(String(block.arguments ?? ''), 500)}]`)
    } else if (block.type === 'tool-result') {
      const inner = renderBlocks(block.content)
      parts.push(`[tool-result${block.isError ? ' error' : ''}]${inner.length > 0 ? ` ${inner}` : ''}`)
    } else if (block.type === 'image') {
      parts.push('[image]')
    }
  }
  return parts.join('\n')
}

/** Map durable tool call ids to tool names from `tool/call` events. */
export function collectToolCallNames(events) {
  const names = new Map()
  for (const event of events) {
    if (event.type === 'tool/call') names.set(event.data.callId, event.data.name)
  }
  return names
}

/**
 * Extract the searchable text of one event, or null for non-text events.
 * @param {any} event - one durable session event.
 * @param {Map<string, string>} toolNames - callId to tool name.
 * @returns {{kind: string, tool?: string, text: string} | null}
 */
export function eventText(event, toolNames) {
  const data = event?.data
  if (!data || typeof data !== 'object') return null
  switch (event.type) {
    case 'user/message': {
      const text = renderBlocks(data.content)
      return text.length > 0 ? { kind: 'user', text } : null
    }
    case 'assistant/message': {
      const message = data.message ?? data
      const text = renderBlocks(message?.content)
      return text.length > 0 ? { kind: 'assistant', text } : null
    }
    case 'system/message':
    case 'developer/message': {
      const message = data.message ?? data
      const text = renderBlocks(message?.content)
      return text.length > 0 ? { kind: event.type === 'system/message' ? 'system' : 'developer', text } : null
    }
    case 'tool/result': {
      const message = data.message ?? data
      const callId = message?.source?.callId
      const tool = callId ? toolNames.get(callId) : undefined
      const text = renderBlocks(message?.content)
      return text.length > 0 ? { kind: 'tool', tool, text } : null
    }
    case 'compaction/summary': {
      const text = renderBlocks(data.summary)
      return text.length > 0 ? { kind: 'summary', text } : null
    }
    default:
      return null
  }
}

/** Sum provider-reported usage across the durable log. */
export function collectUsage(events) {
  const usage = {
    steps: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  }
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const reported = event.data.usage
    if (!reported) continue
    usage.steps += 1
    usage.inputTokens += Number(reported.inputTokens ?? 0)
    usage.cacheReadTokens += Number(reported.cacheReadTokens ?? 0)
    usage.cacheWriteTokens += Number(reported.cacheWriteTokens ?? 0)
    usage.outputTokens += Number(reported.outputTokens ?? 0)
    usage.reasoningTokens += Number(reported.reasoningTokens ?? 0)
  }
  const billedInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return {
    ...usage,
    billedInputTokens: billedInput,
    cacheHitRatio: billedInput > 0 ? usage.cacheReadTokens / billedInput : null,
  }
}

/**
 * Fold the durable compaction records into savings, checkpoints, and the
 * summarizer's own token cost (the auxiliary model calls each checkpoint paid).
 */
/** Whether a landed replacement covers exactly the summary's stated range. */
function landsSummary(summaryEvent, nextEvent) {
  if (summaryEvent?.type !== 'compaction/summary' || nextEvent?.type !== 'user/message') return false
  const op = nextEvent.surfaceOp
  if (!op || typeof op !== 'object' || op.op !== 'replace') return false
  const range = summaryEvent.data.shadowedRange
  if (!range) return false
  const replacementStart = Object.hasOwn(op, 'startSeq') ? op.startSeq : op.start
  const replacementEnd = Object.hasOwn(op, 'endSeq') ? op.endSeq : op.end
  return replacementStart === range.start && replacementEnd === range.end
}

export function collectCompactions(events) {
  const checkpoints = []
  const summarizerUsage = { calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  let shadowedTokens = 0
  let summaryTokens = 0
  let abandoned = 0
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'compaction/prune') {
      const shadowed = Number(event.data.shadowedTokenCount ?? 0)
      shadowedTokens += shadowed
      checkpoints.push({
        seq: event.seq,
        kind: 'prune',
        nodes: (event.data.shadowedSeqs ?? []).length,
        shadowedTokens: shadowed,
        summaryTokens: 0,
      })
      continue
    }
    if (event.type !== 'compaction/summary') continue
    // A summary that never landed a replacement (a failed transaction) saved
    // nothing; counting it would overstate the plugin's savings.
    if (!landsSummary(event, events[index + 1])) {
      abandoned += 1
      continue
    }
    const shadowed = Number(event.data.shadowedTokenCount ?? 0)
    const summary = estimateTokens(renderBlocks(event.data.summary))
    shadowedTokens += shadowed
    summaryTokens += summary
    const usage = event.data.usage
    if (usage && typeof usage === 'object') {
      summarizerUsage.calls += 1
      summarizerUsage.inputTokens += Number(usage.inputTokens ?? 0)
      summarizerUsage.cacheReadTokens += Number(usage.cacheReadTokens ?? 0)
      summarizerUsage.cacheWriteTokens += Number(usage.cacheWriteTokens ?? 0)
      summarizerUsage.outputTokens += Number(usage.outputTokens ?? 0)
      summarizerUsage.reasoningTokens += Number(usage.reasoningTokens ?? 0)
    }
    checkpoints.push({
      seq: event.seq,
      kind: 'summary',
      nodes: (event.data.shadowedSeqs ?? []).length,
      shadowedTokens: shadowed,
      summaryTokens: summary,
      range: event.data.shadowedRange ?? null,
    })
  }
  return {
    count: checkpoints.length,
    shadowedTokens,
    summaryTokens,
    netSavedTokens: Math.max(0, shadowedTokens - summaryTokens),
    summarizerUsage,
    abandoned,
    lastSeq: checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].seq : null,
    checkpoints,
  }
}

/**
 * Per-step provider usage for the most recent steps, oldest first. This is the
 * number a person sees on their bill: billed input = uncached + cache read +
 * cache write, plus output.
 */
export function collectStepUsage(events, limit = 8) {
  const steps = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (!usage) continue
    steps.push({
      turn: Number(event.data.turn ?? 0),
      step: Number(event.data.step ?? 0),
      seq: event.seq,
      inputTokens: Number(usage.inputTokens ?? 0),
      cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
      billedInputTokens:
        Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0) + Number(usage.cacheWriteTokens ?? 0),
    })
  }
  return steps.slice(-limit)
}

/**
 * Search the whole durable log, including rows the surface no longer shows.
 * @returns {{hits: object[], total: number, truncated: boolean}}
 */
export function searchEvents({ session, query, regex = false, limit = 10, snippetChars = 240, includeCompacted = true }) {
  const events = session.snapshotEvents()
  const toolNames = collectToolCallNames(events)
  const visible = new Set(session.surface.nodes)
  const needle = String(query)
  const matcher = regex ? new RegExp(needle, 'i') : null
  const lowercaseNeedle = regex ? null : needle.toLowerCase()
  const hits = []
  let total = 0
  for (const event of events) {
    if (!includeCompacted && (!visible.has(event.seq) || event.type === 'compaction/summary')) continue
    const extracted = eventText(event, toolNames)
    if (!extracted) continue
    const matchAt = matcher ? (matcher.exec(extracted.text)?.index ?? -1) : extracted.text.toLowerCase().indexOf(lowercaseNeedle)
    if (matchAt < 0) continue
    const visibility = extracted.kind === 'summary' ? 'summary' : visible.has(event.seq) ? 'visible' : 'compacted'
    total += 1
    if (hits.length >= limit) continue
    hits.push({
      seq: event.seq,
      kind: extracted.kind,
      ...(extracted.tool ? { tool: extracted.tool } : {}),
      visibility,
      tokens: estimateTokens(extracted.text),
      snippet: matchSnippet(extracted.text, matchAt, snippetChars),
    })
  }
  return { hits, total, truncated: total > hits.length }
}

function matchSnippet(text, index, snippetChars) {
  const half = Math.floor(snippetChars / 2)
  const start = Math.max(0, index - half)
  const end = Math.min(text.length, start + snippetChars)
  const body = text.slice(start, end).replace(/\s+/g, ' ')
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/**
 * Rebuild exact text for the requested durable rows, bounded by a token budget.
 * @returns {{restored: object[], omitted: number, totalTokens: number}}
 */
export function restoreEvents({ session, seqs, maxTokens = 6000 }) {
  const events = session.snapshotEvents()
  const toolNames = collectToolCallNames(events)
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const budgetChars = Math.max(400, Math.floor(maxTokens * CHARS_PER_TOKEN))
  let used = 0
  let omitted = 0
  const restored = []
  for (const seq of seqs) {
    const event = bySeq.get(seq)
    if (!event) {
      restored.push({ seq, error: 'not found in this session log' })
      continue
    }
    const extracted = eventText(event, toolNames)
    if (!extracted) {
      restored.push({ seq, error: `event type ${event.type} has no restorable text` })
      continue
    }
    const remaining = budgetChars - used
    if (remaining <= 80) {
      omitted += 1
      continue
    }
    const text = truncate(extracted.text, remaining)
    used += text.length
    restored.push({
      seq,
      kind: extracted.kind,
      ...(extracted.tool ? { tool: extracted.tool } : {}),
      text,
      truncated: text.length < extracted.text.length,
    })
  }
  return { restored, omitted, totalTokens: estimateTokens('x'.repeat(used)) }
}
