/**
 * Configuration resolution for dsh-context-keeper.
 *
 * Every knob is optional. Unknown keys are rejected loudly so a typo in a
 * bundle patch cannot silently disable the plugin's savings.
 */

export const DEFAULTS = {
  // Register the model-facing tools. Turn individual tools off by setting
  // `tools.status | tools.search | tools.restore | tools.compact` to false.
  tools: {
    status: true,
    search: true,
    restore: true,
    compact: true,
  },
  // Incremental compaction policy. This is the "auto" half of the plugin: it
  // folds the oldest balanced span through the session's own compaction
  // service once measured pressure crosses `minPressureRatio`, keeping the
  // recent `retainTokens` verbatim. Disable with `{ "enabled": false }`.
  autoCompact: {
    enabled: true,
    // Fraction of the routed model's context window at which to fold.
    minPressureRatio: 0.6,
    // Verbatim recent tail to keep after a fold.
    retainTokens: 30000,
    // Never fold a span worth fewer estimated tokens than this.
    minFoldTokens: 8000,
    // Require at least this much growth (estimated request tokens) since the
    // previous fold by this plugin before folding again.
    minGrowthTokens: 20000,
    // Stop folding after this many folds inside one turn (0 = unlimited).
    maxFoldsPerTurn: 2,
  },
  // Decorate subagent sessions too (off: only top-level sessions get tools).
  includeSubagents: false,
  // Append a short system-prompt section describing the tools. Off by
  // default: tool descriptions already carry the guidance and a section costs
  // tokens on every request.
  promptSection: false,
  // Tool result bounds.
  search: {
    limit: 10,
    snippetChars: 240,
  },
  restore: {
    maxTokens: 6000,
  },
  // Extra host log lines for diagnostics.
  debug: false,
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function merge(base, patch, path, errors) {
  if (patch === undefined) return base
  if (!isPlainObject(patch)) {
    errors.push(`${path} must be an object`)
    return base
  }
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in base)) {
      errors.push(`unknown config key ${path}.${key}`)
      continue
    }
    const current = base[key]
    if (isPlainObject(current)) out[key] = merge(current, value, `${path}.${key}`, errors)
    else out[key] = value
  }
  return out
}

function checkNumber(value, path, { min = -Infinity, max = Infinity, integer = false }, errors) {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    errors.push(`${path} must be a finite number`)
    return
  }
  if (integer && !Number.isInteger(value)) errors.push(`${path} must be an integer`)
  if (value < min) errors.push(`${path} must be >= ${min}`)
  if (value > max) errors.push(`${path} must be <= ${max}`)
}

/**
 * Merge user config over defaults, validate ranges, and reject unknown keys.
 * @param {unknown} raw - the row's `config` object.
 * @returns {typeof DEFAULTS} resolved configuration.
 */
export function resolveConfig(raw) {
  const errors = []
  const cfg = merge(DEFAULTS, raw, 'config', errors)
  for (const name of ['status', 'search', 'restore', 'compact']) {
    if (typeof cfg.tools[name] !== 'boolean') errors.push(`config.tools.${name} must be a boolean`)
  }
  const auto = cfg.autoCompact
  if (typeof auto.enabled !== 'boolean') errors.push('config.autoCompact.enabled must be a boolean')
  checkNumber(auto.minPressureRatio, 'config.autoCompact.minPressureRatio', { min: 0.2, max: 0.95 }, errors)
  checkNumber(auto.retainTokens, 'config.autoCompact.retainTokens', { min: 1000, integer: true }, errors)
  checkNumber(auto.minFoldTokens, 'config.autoCompact.minFoldTokens', { min: 1000, integer: true }, errors)
  checkNumber(auto.minGrowthTokens, 'config.autoCompact.minGrowthTokens', { min: 0, integer: true }, errors)
  checkNumber(auto.maxFoldsPerTurn, 'config.autoCompact.maxFoldsPerTurn', { min: 0, integer: true }, errors)
  if (typeof cfg.includeSubagents !== 'boolean') errors.push('config.includeSubagents must be a boolean')
  if (typeof cfg.promptSection !== 'boolean') errors.push('config.promptSection must be a boolean')
  if (typeof cfg.debug !== 'boolean') errors.push('config.debug must be a boolean')
  checkNumber(cfg.search.limit, 'config.search.limit', { min: 1, max: 50, integer: true }, errors)
  checkNumber(cfg.search.snippetChars, 'config.search.snippetChars', { min: 60, max: 2000, integer: true }, errors)
  checkNumber(cfg.restore.maxTokens, 'config.restore.maxTokens', { min: 200, max: 50000, integer: true }, errors)
  if (errors.length > 0) {
    throw new Error(`dsh-context-keeper invalid config:\n- ${errors.join('\n- ')}`)
  }
  return cfg
}
