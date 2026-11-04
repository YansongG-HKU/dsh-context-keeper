# Benchmarks: measured token savings

All numbers below were measured on **2026-11-04** against a real DSH desktop install (DSH 0.2.1-rc.5, session format v4, 1,048,576-token context window). They come from three sources: the plugin's own live metering (`context_status` / `context_compact --dry-run`), deterministic replay of real session logs through the plugin's fold code with a fake summary model, and policy simulation over real per-step billing traces.

Session ids are truncated, and installation details are omitted on purpose. These are **local measurements on real session logs, not a public benchmark and not a production A/B test**. Read the caveats at the end before quoting any number.

## TL;DR

- **One fold** lowers single-session context pressure by **71.6% (keep 100K verbatim) to 86.5% (keep 30K verbatim)**; in real sessions, each following step then pays about **326K–512K fewer tokens**.
- **Turned into a multi-step policy** (simulated on the same real billing traces): a 240-step session saves **33.6%–44.5%** of total billed tokens, and a 668-step session saves **53.2%–72.8%**.
- **Against mature approaches:** Anthropic's -84% refers to *tokens for a whole evaluation workflow*, billion-context's -58.3% / -71.1% is *cost relative to full context*, and ACON's -26–54% is *peak token usage*. The bases all differ — the results are the same order of magnitude ("tens of percent"), but they cannot be put side by side. See [docs/competitive-landscape.md](competitive-landscape.md).
- **Honest point 1:** with the default 60% threshold, neither real long session triggered even once on a 1M window (peaks 590K / 727K < the 629K threshold). Out of the box, the savings are approximately zero; set `minPressureRatio` to 0.35–0.45, or let the model call `context_compact`.
- **Honest point 2:** DeepSeek cache hits cost 1/50 of misses, so payback is **under one step in token terms but roughly 8–25 steps in dollar terms**. Saving tokens is not the same thing as saving money, and the two must be reported separately.

## Method

1. **Real billing.** Each real session log is read by decompressing its zstd frames, and every `assistant/message.usage` record is collected. For a request,
   `billed_input = inputTokens + cacheReadTokens + cacheWriteTokens`
   (the input tokens actually billed for that request).
2. **Live metering.** The plugin's `context_status` is called in the live session; it reads the real `ctx.tokenMeter`.
3. **Fold plans and effects.** In the live session, the plugin's real tool `context_compact { dry_run: true }` produced the plan. For archived long sessions, the log was replayed through the vendored real **0.2.1-rc.5 Session** runtime, then the plugin's own `selectFoldRange` / `runCompaction` were called with a fake LLM providing the summary; transaction events were written for real, and pressure before/after was measured with the plugin's meter. All probes on real logs are read-only — no archived session was modified.
4. **Policy simulation.** The real per-step billed sequence is used as a trace. The simulation compares: no compression, DSH native compaction at 0.80, this plugin at 0.60 / 0.45 / 0.35 (keep 30K verbatim), and an irreversible clearing policy at 0.50 (keep 120K, no retrieval), over total billed tokens.

## One fold, live session (`session-dbb…`)

| Item | Measured value |
| --- | ---: |
| Context window / current pressure | 1,048,576 / **454,619 (43.4%)** |
| Surface tokens / system / tools | 357,944 / 2,400 / 18,568 |
| Steps used / cumulative billed input | 235 / 59,711,948 |
| Cache hit ratio (cacheRead / billed) | 99.53% |
| Latest step billed input | ≈ 449,876 |
| Auto-fold state | **0 folds** (`lastSkip = below pressure threshold`, 0.428 < 0.6) |

**Folding once now** (`context_compact` dry run, real metering): range seq 9–1676, **489 surface nodes**, **325,988 tokens** folded, pressure **455,577 → ≈130,000 (-71.5%)**. Each following step then pays about **326K fewer tokens** (≈72% of that session's current per-step bill).

## One fold, archived 240-step session (`session-a74…`)

| Item | Measured value |
| --- | ---: |
| Events / steps with usage | 2,047 / 240 |
| Cumulative billed input | **90,156,133** |
| cacheRead / hit ratio | 89,823,744 / **99.63%** |
| Max and most recent step billed | 590,475 (= 56.4% of the window) |
| Average billed per step | 375,651 |
| Average of the last 10 / 20 / 50 steps | 587,507 / 581,941 / 560,622 |

Replaying the log through the real Session runtime and measuring the plugin's real transaction:

| Keep recent | Nodes folded | Tokens folded | Pressure before → after (plugin meter) | Single-fold drop | Fewer tokens per following step |
| --- | ---: | ---: | ---: | ---: | ---: |
| **30,000** (plugin default) | 549 | 403,901 | 466,617 → 62,817 | **-86.5%** | ≈ 404K (≈ 512K on the real meter) |
| 100,000 | 424 | 334,040 | 466,617 → 132,678 | **-71.6%** | ≈ 334K (≈ 424K on the real meter) |

> The session's real pressure read by the real meter in an isolated instance was 591,871, while the plugin's internal heuristic reported 466,617 — a ratio of ≈1.27. The "real meter" column above applies that ratio and is used only for the money conversion below.

## Multi-step policy simulation

"Native" = fold at 80% of the window, keeping ≈16% afterwards; "keeper" = fold at the given threshold and keep 30K verbatim; "irreversible" = fold at 50%, keep 120K, and the removed content cannot be retrieved.

### 240-step session, real billed total 90,156,133

| Policy | Trigger threshold | Folds | Total billed | Saving vs no compression |
| --- | ---: | ---: | ---: | ---: |
| No compression (real) | — | 0 | 90,156,133 | — |
| DSH native 0.80 | 838,861 | **0** | 90,156,133 | **0%** |
| keeper default 0.60 | 629,146 | **0** | 90,156,133 | **0%** |
| keeper 0.45 | 471,859 | 1 (step 164) | 59,857,403 | **-33.6%** |
| keeper 0.35 | 367,002 | 1 (step 102) | 50,028,640 | **-44.5%** |
| irreversible 0.50 | 524,288 | 1 (step 193) | 70,744,885 | -21.5% |

### 668-step session, real billed total 267,319,714

| Policy | Folds | Total billed | Saving vs no compression |
| --- | ---: | ---: | ---: |
| No compression (real) | 0 | 267,319,714 | — |
| DSH native 0.80 | **0** (peak 727,127 < 838,861) | 267,319,714 | **0%** |
| keeper default 0.60 | 1 (step 420) | 130,488,238 | **-51.2%** |
| keeper 0.45 | 1 (step 308) | 125,054,307 | **-53.2%** |
| keeper 0.35 | 2 (steps 221, 454) | 72,839,038 | **-72.8%** |
| irreversible 0.50 | 1 (step 354) | 139,833,229 | -47.7% |

**Key observation:** in both real sessions, DSH's native 80% compaction never fired (a 1M window needs 838,861 pressure, while the real peaks were 590K and 727K), and the plugin's default 60% threshold barely fired either. **Out-of-the-box savings are therefore ≈0**; real savings come from triggering earlier (0.35–0.45) and from the model folding on purpose.

## From tokens to money

Off-peak DeepSeek prices used for the conversion (official): cache hit **$0.003 / 1M tokens**, cache miss **$0.15 / 1M**, output **$0.6 / 1M**. A cache hit costs **1/50 of a miss**. Peak prices are 2× off-peak, but both sides scale together, so the payback step count does not change.

Taking the live session's single fold (keep 30K) as the example:

| Item | Value |
| --- | ---: |
| Fewer tokens per following step | ≈ 326,000 |
| Money saved per following step (cache-hit price) | ≈ **$0.00098** |
| One-time cost: re-caching the new prefix (≈109K misses) | ≈ $0.0160 |
| One-time cost: summary-call input (≈455K, almost all cache hits) | ≈ $0.0014 |
| One-time cost: summary output (≈1.5K tokens) | ≈ $0.0009 |
| One-time total | ≈ **$0.018** |
| **Payback** | **≈ 19 steps** |
| Net saving over 100 more steps | ≈ $0.079 (32.6M tokens) |
| Net saving over 500 more steps | ≈ $0.47 (163M tokens) |

The exact payback depends on how aggressively a fold is made; across fold sizes it lands in the **≈8–25 steps** range (folding harder pays back faster).

> Caveat: about 99.6% of billed input in these sessions is cache reads, and a cache hit costs 1/50 of a miss. Cutting 33%–72% of *billed tokens* is therefore roughly a ~30% cut of the *input dollar bill*. The token numbers look much better than the money numbers — this is the part vendor marketing never mentions.

## How this compares with mature approaches

| Approach | Published / measured number | Basis | Reversible / searchable |
| --- | --- | --- | --- |
| **dsh-context-keeper** | One fold **-71.5% (live) to -86.5%** pressure; policy simulation **-33.6% to -72.8%** of billed tokens | single-session pressure; local real-log replay and simulation | **Yes + searchable** |
| DSH native compaction-basic | 80% trigger: **0 fires → 0% saving** on both real sessions; when it does fire, a single fold is expected ≈-77% | peak-triggered, single compaction | original events remain in the log but are not model-visible |
| Anthropic context editing + memory | **-84%** tokens for a whole workflow (100-turn web search eval); **+29% / +39%** performance | whole-evaluation token consumption | No |
| Claude Code auto-compact | **no public token number**; 1M-window default trigger ≈**967K**, above the real peaks here, so it would not fire either | no public basis | No |
| Cursor / OpenAI Responses compaction | **no public numbers**; OpenAI's compaction item is opaque | no public basis | No |
| billion-context | self-run: **-58.3% / -71.1%** cost vs full context; 30× steady-state compression; 95–97% cache hit | cost relative to full context (project's own benchmark) | Yes + searchable |
| ACON (Microsoft, ICML 2026) | **peak token -26–54%**; small-model performance up to +46% | peak token usage | original text not guaranteed retrievable |

**Alignment conclusions:**

- **Do not compare the percentages directly.** -84% is whole-workflow token consumption, -58.3% / -71.1% is cost relative to full context (self-run), -26–54% is peak token usage, and this plugin's numbers are single-session pressure and replayed billed tokens.
- **What can be said:** all of them are in the "tens of percent" range, and Anthropic's result confirms that tool results are the dominant consumer — consistent with what we see in real sessions (single tool outputs around 12K tokens recurring many times).
- **Differentiation with evidence:** folds are reversible and searchable (unlike Anthropic, Claude Code, Cursor, and OpenAI compaction), and the implementation sits inside DSH's native event protocol without an extra proxy layer (one less failure surface than billion-context). **Trade-offs:** no public benchmark, and the default threshold is conservative for 1M windows. Do not claim to be "better than" these projects; the honest claim is "same order of magnitude, different basis, different trade-offs".

Sources for every competitor number, with links: [docs/competitive-landscape.md](competitive-landscape.md).

## Honest caveats

1. **The default threshold saves ≈0 on a 1M window.** Both real sessions stayed below 60% until they ended. Tune `minPressureRatio` to 0.45 or 0.35, or rely on model-initiated `context_compact`.
2. **Token savings ≠ money savings.** Because cache hits cost 1/50 of misses, a 33–72% token cut is a much smaller dollar cut. Report both bases separately.
3. **These are local results.** One live session plus two archived real sessions, replayed on one machine with a fake summary model. This is not a production A/B test, and it is not an independent public benchmark.
4. **Fold size vs. recall trade-off.** Keeping less verbatim saves more but relies more on summary quality and on `context_restore`; the summaries themselves were not evaluated for quality in this analysis.
5. **No claim of superiority.** The mechanism comparison is documented with sources; the performance comparison is not apples-to-apples by construction.

## Reproducing

The measurement pipeline is: export a session log → compute per-step `billed_input` from `assistant/message.usage` → replay the log through the plugin's fold span selection and compaction transaction → simulate trigger policies over the real billed trace. Scripts for this analysis live alongside the project (see the repository's `test/` and `scripts/` directories); `test/verify-live-log.mjs <path-to-session-log>` is the public entry point for replaying a real log through the protocol and fold transaction.
