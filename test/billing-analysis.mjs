// Per-step billing baseline for one decoded DSH session log.
//
// Usage:
//   node test/billing-analysis.mjs <path-to-decoded-session.jsonl>
//
// The input is a session log that has already been zstd-frame-decoded to JSONL
// (one JSON object per line, the first row being the `{"type":"session",...}`
// header). "billed input" follows the provider bill: inputTokens +
// cacheReadTokens + cacheWriteTokens per assistant step.
import fs from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node test/billing-analysis.mjs <path-to-decoded-session.jsonl>')
  process.exit(2)
}

const events = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line))
  .filter((event) => event.type !== 'session')

const steps = []
for (const event of events) {
  if (event.type !== 'assistant/message' || !event.data.usage) continue
  const usage = event.data.usage
  steps.push({
    turn: event.data.turn,
    step: event.data.step,
    seq: event.seq,
    input: usage.inputTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
    output: usage.outputTokens ?? 0,
    billed: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
  })
}

const avg = (rows, key) => Math.round(rows.reduce((sum, row) => sum + row[key], 0) / rows.length)
console.log('steps with usage:', steps.length)
for (const n of [10, 20, 30, 50]) {
  const rows = steps.slice(-n)
  const billed = avg(rows, 'billed')
  const totalBilled = rows.reduce((sum, row) => sum + row.billed, 0)
  const hit = rows.reduce((sum, row) => sum + row.cacheRead, 0) / Math.max(1, totalBilled)
  console.log(
    `last ${n}: avg billed input ${billed}, avg cacheRead ${avg(rows, 'cacheRead')}, ` +
      `avg output ${avg(rows, 'output')}, cache-hit ${(hit * 100).toFixed(2)}%`,
  )
}
console.log(
  'total billed input:',
  steps.reduce((sum, row) => sum + row.billed, 0),
  'total output:',
  steps.reduce((sum, row) => sum + row.output, 0),
)
