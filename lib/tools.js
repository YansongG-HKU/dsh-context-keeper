/**
 * Model-facing tool definitions.
 *
 * Tools are plain `ToolDefinition` objects (no package imports): the Harness
 * registry accepts a raw JSON-Schema `parameters` object plus a canonical
 * `output` projector, exactly like a shipped tool.
 */

import { buildStatus, compactRequest, makeResources } from './context.js'
import { restoreEvents, searchEvents } from './events.js'

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const STATUS_DESCRIPTION =
  'Report this session context budget: measured tokens versus the model window, composition (system/tools/messages), ' +
  'the largest history rows with their seq numbers, compaction checkpoints and tokens already saved, and cache/usage totals. ' +
  'Read-only. Call it when the session is long, before a large exploration, or when deciding whether to fold history.'

const SEARCH_DESCRIPTION =
  'Search the full session history by keyword or regular expression, including parts already folded into compaction summaries ' +
  'and no longer visible in context. Use it to recover an exact file path, command, error string, decision, or earlier detail. ' +
  'Returns seq numbers and snippets; pass seqs to context_restore to read the exact text. Prefer targeted queries over broad ones.'

const RESTORE_DESCRIPTION =
  'Read exact text of earlier history rows by seq (from context_search or context_status), including rows hidden by compaction. ' +
  'Restores at most about max_tokens tokens. Use it when the summary lost a detail you actually need, not to re-read everything.'

const COMPACT_DESCRIPTION =
  'Fold an older span of this conversation into one durable summary using the session compaction engine, freeing context. ' +
  'Omit start/end to fold the oldest span while keeping recent tokens; pass dry_run=true to see the plan first. ' +
  'Never splits an assistant tool-call/result pair. Prefer small, task-complete older spans over recent turns.'

const withoutEmpty = (value) => {
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out
}

const integer = (description) => ({ type: 'integer', description })

/** Build this agent's tool definitions. */
export function createTools({ agent, cfg, state, log }) {
  const resources = makeResources(agent)
  const definitions = []
  const wrapped = (execute) => async (args, exec) => {
    try {
      return await execute(args ?? {}, exec)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log?.warn(`tool failed: ${message}`)
      return { ok: false, error: message }
    }
  }

  if (cfg.tools.status) {
    definitions.push({
      name: 'context_status',
      description: STATUS_DESCRIPTION,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OUTPUT,
      execute: wrapped(async () => buildStatus({ agent, meter: resources.meter(), state, cfg })),
    })
  }

  if (cfg.tools.search) {
    definitions.push({
      name: 'context_search',
      description: SEARCH_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword, or a regular expression when regex=true.' },
          regex: { type: 'boolean', description: 'Treat query as a regular expression (case-insensitive).' },
          limit: integer('Maximum hits to return (1-50; default 10).'),
          include_compacted: {
            type: 'boolean',
            description: 'Include history hidden by compaction (default true). Set false to search only visible context.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: OUTPUT,
      execute: wrapped(async (args) => {
        const session = resources.session()
        const result = searchEvents({
          session,
          query: args.query,
          regex: args.regex === true,
          limit: clampInt(args.limit, 1, 50, cfg.search.limit),
          snippetChars: cfg.search.snippetChars,
          includeCompacted: args.include_compacted !== false,
        })
        return {
          ok: true,
          ...result,
          hint:
            result.total === 0
              ? 'No match. Try a shorter keyword, a file basename, or a distinctive error fragment.'
              : 'Use context_restore with the seqs you need for exact text.',
        }
      }),
    })
  }

  if (cfg.tools.restore) {
    definitions.push({
      name: 'context_restore',
      description: RESTORE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          seqs: {
            type: 'array',
            items: { type: 'integer' },
            description: 'History row seq numbers to restore (1-20 rows).',
          },
          max_tokens: integer(`Output budget in tokens (default ${cfg.restore.maxTokens}).`),
        },
        required: ['seqs'],
        additionalProperties: false,
      },
      output: OUTPUT,
      execute: wrapped(async (args) => {
        const seqs = Array.isArray(args.seqs) ? args.seqs.slice(0, 20).map(Number) : []
        if (seqs.length === 0) return { ok: false, error: 'seqs must contain at least one integer seq' }
        const budget = clampInt(args.max_tokens, 200, 50000, cfg.restore.maxTokens)
        const result = restoreEvents({ session: resources.session(), seqs, maxTokens: budget })
        return { ok: true, ...result }
      }),
    })
  }

  if (cfg.tools.compact) {
    definitions.push({
      name: 'context_compact',
      description: COMPACT_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          start: integer('First surface seq of the span (optional; omit with end to plan automatically).'),
          end: integer('Last surface seq of the span (optional; must be a balanced boundary).'),
          keep_recent_tokens: integer('When planning automatically, keep at least this many recent tokens verbatim.'),
          min_tokens: integer('Refuse to fold a span smaller than this many estimated tokens.'),
          dry_run: { type: 'boolean', description: 'Return the plan without changing history.' },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      execute: wrapped(async (args, exec) =>
        compactRequest({ agent, resources, args: withoutEmpty(args), cfg, signal: exec?.signal }),
      ),
    })
  }

  return definitions
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}
