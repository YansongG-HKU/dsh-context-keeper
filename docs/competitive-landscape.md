# Competitive landscape: context management approaches

Research date: **2026-11-04**. This document collects only public, linkable numbers about how other context-management approaches perform. The rule is simple: every number has a source link; where no public number exists, this document says **no public number** instead of guessing or converting one basis into another.

> **Access note:** at research time, `code.claude.com`, `developers.openai.com`, and `ai.google.dev` could not be fetched directly from the research environment. Statements that rely on them are marked **secondary source**, and the official URLs are still listed for verification. Everything else was read directly.

## TL;DR

- **No vendor publishes a "single-session context pressure reduction %"** — the basis this plugin reports. Public numbers fall into four different buckets:
  1. token consumption for a **whole evaluation workflow** (Anthropic: -84%),
  2. **task performance** changes (Anthropic: +29% / +39%),
  3. **peak token usage** reduction (ACON: -26–54%),
  4. **cost relative to full context** (billion-context: -58.3% / -71.1%, the project's own benchmark).
- The honest comparison is therefore **mechanism differences plus basis alignment**, never a side-by-side of percentages. This plugin's own measurements are in [docs/benchmarks.md](benchmarks.md).
- The closest competitor — the only one with a published quantitative benchmark **and** official DSH support — is **billion-context** (`bili plugin install dsh`).

## Anthropic: context editing + memory tool (released 2025-09-29)

- **Mechanism:** `context editing` automatically clears stale `tool_use` / `tool_result` blocks when the context approaches the limit (configurable trigger, keep-last-N pairs, `clear_at_least` floor, excluded tools), preserving the conversation flow. It runs server-side when the request is constructed and does not change client-side history. The `memory tool` is a client-side, file-based CRUD "memory outside the context window", persisted across sessions on a storage backend the developer controls.
- **Public numbers (official):**
  - Internal agentic-search evaluation: **memory tool + context editing +39% performance vs baseline**; **context editing alone +29%**.
  - **100-turn web-search evaluation: context editing let workflows that would otherwise fail on context exhaustion complete, and cut token consumption by 84%.**
- **Sources:** [Managing context on the Claude Developer Platform](https://claude.com/resources/articles/context-management); secondary cross-check: [Augmenter.dev](https://augmenter.dev/articles/anthropic-adds-context-editing-and-file-based-memory-to-claude-1759184891957/) and [Nadir](https://app.getnadir.com/blog/context-editing-clear-tool-uses-cache-write-cost/).
- **Basis and limitations:**
  - The 84% is token reduction **across one complete evaluation workflow**, not per-step context pressure and not a single-compaction ratio. The 29% / 39% are **performance metrics**, not token metrics. The three must not be mixed.
  - The evaluation set details are not public beyond "100 turns", so the numbers cannot be reproduced externally.
  - **Cache cost (acknowledged by the official docs):** "You'll incur cache write costs each time content is cleared." Clearing changes the prefix, so the cache is invalidated and the next request is billed at cache-write price. `clear_at_least` exists precisely to make sure enough is cleared to justify that write.
  - **Irreversible:** cleared content is gone from the request; there is no built-in "bring it back".

## Claude Code: auto-compact / `/compact` / idle compaction

- **Mechanism (secondary source, official pages listed below):** when the context approaches the limit, the history is summarized and the session continues (the engineering blog describes keeping architecture decisions, unresolved bugs, and implementation details, dropping redundant tool output, and carrying the last 5 accessed files). `/compact` compresses manually, optionally with a focus instruction. `/autocompact` configures the trigger point (100K–1M tokens); `CLAUDE_CODE_AUTO_COMPACT_WINDOW` has the highest precedence, and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can only move compaction earlier, not later.
- **Default trigger:** roughly **967K tokens** for 1M-window models; 200K-window configurations compact at the 200K boundary. Idle compaction (v2.1.299, 2026-10-14) compacts a 200K+ token session after about **54 minutes idle**, just before the 1-hour prompt-cache TTL expires, avoiding a full re-send on the next message.
- **Public numbers:** **no official token-reduction percentage.** The official docs describe behavior only.
- **Sources:** secondary [koromo's Claude Code compaction guide](https://koromo.io/blog/claude-code-context-memory/) (cites official docs/changelog); official entry points: [context window](https://code.claude.com/docs/en/context-window), [model config / default auto-compact thresholds](https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds), [prompt caching](https://code.claude.com/docs/en/prompt-caching).
- **Basis and limitations:** the widely circulated "76–83% trigger" figures are obsolete; official wording now uses token counts, so percentage thresholds should not be quoted. Compaction is **irreversible** and necessarily invalidates the cache — which is exactly why idle compaction is timed against the 1-hour TTL: it turns an unavoidable cache miss into one that was going to happen anyway. That is a genuinely smart cache-friendly design.

## Cursor: automatic summarization + `/summarize`

- **Mechanism:** Cursor automatically summarizes long conversations at the context limit; since version 1.6 (2025-09-12), `/summarize` compresses context on demand to free up window space without starting a new chat.
- **Public numbers:** **no public numbers.** The changelog describes the feature without token, cost, or success-rate data.
- **Source:** [Cursor Changelog 1.6](https://cursor.com/en-US/changelog/1-6).
- **Basis and limitations:** Cursor also markets larger effective windows as a product strategy, mixed in with compaction, so compaction savings cannot be isolated. Implementation details are not public; by the official description it is summary replacement, i.e. **irreversible**.

## OpenAI: Responses API compaction

- **Mechanism (per Microsoft Learn's official Azure OpenAI Responses API docs; the OpenAI page itself could not be fetched):** `/responses/compact` compresses the input context into a smaller input that preserves key state for subsequent turns. Server-side automatic compaction is enabled with `context_management=[{"type":"compaction","compact_threshold":200000}]`; once output tokens exceed the threshold, the API compresses automatically and returns an **encrypted compaction item** (opaque, unreadable) that later turns include. It also works with `store=false`. The Agents SDK sessions layer keeps full history by default and can limit retrieval with `SessionSettings(limit=N)` or a custom `session_input_callback`.
- **Public numbers:** **no public numbers.** The docs describe the mechanism only, with no token-reduction or quality-impact figures.
- **Sources:** [Use the Azure OpenAI Responses API](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses); [OpenAI Agents SDK — Sessions](https://openai.github.io/openai-agents-python/sessions/); official page (**secondary**, 403 at research time): [Compaction guide](https://developers.openai.com/api/docs/guides/compaction).
- **Basis and limitations:** the compaction item is opaque, so users **cannot search or restore** what was compacted away — a clear structural difference from this plugin's `context_search` / `context_restore`. Compaction is server-side and cache behavior is not public.

## Letta (MemGPT lineage): layered memory and sleep-time compute

- **Mechanism:** MemGPT treats the LLM as an operating system with **layered memory** (main context + external memory), moving data between layers via tool calls and controlling flow with interrupts, producing a "virtual context" beyond the window. Sleep-time compute lets the model think about context and pre-compute likely questions **offline**, reducing test-time compute.
- **Public numbers (papers):**
  - MemGPT paper: evaluated on document analysis (documents far larger than the window) and multi-session chat, with **no quantified token savings or compression ratio** — only task-behavior descriptions. [arXiv:2310.08560](https://arxiv.org/abs/2310.08560)
  - Sleep-time compute paper: **~5× less test-time compute** for the same accuracy (Stateful GSM-Symbolic / Stateful AIME); scaling sleep-time compute further adds **+13% (GSM-Symbolic) / +18% (AIME)** accuracy; amortized across related queries, **per-query cost drops 2.5×**. [arXiv:2504.13171](https://arxiv.org/abs/2504.13171)
- **Basis and limitations:** the 5× / 2.5× refer to **test-time compute and cost**, not context-window occupancy, and come from synthetic stateful tasks — they do not transfer directly to token savings in long coding-agent sessions. The product itself (Letta Cloud / OSS) publishes **no token-savings numbers**.

## billion-context: the closest competitor, and the only one with official DSH support

- **Mechanism:** a compression proxy placed between the agent and the model API (rewriting Anthropic/OpenAI streams), or a native DSH plugin via `bili plugin install dsh`. The model decides when and what to compress. Four tools: `compress` (fold a message span into a high-fidelity summary), `decompress` (restore), `search_context` (keyword search over summaries and visible messages), and `acp_status` (usage / compressible ranges). The design pitch: incremental, reversible, prefix-cache friendly, month-long single sessions.
- **Public numbers (official README; all self-reported / self-run):**
  - Marketing: "**5× fewer tokens**", "small context windows (100K is enough)", "month-long single sessions (billions of tokens)".
  - Paper shipped in the repository: 4.5 months, 3 hosts, **174,327 model calls, 18.76B cumulative input tokens** (≈24.7B across all hosts), **zero window violations** on a 204,800-token model, longest sessions **8,584–12,049 calls**.
  - Self-run "third-party" benchmark (LongMemEval-S / ContextBench / MemoryAgentBench, 1,500 questions, DeepSeek V4.1 Flash + Qwen3 embedding/reranker + Pi Agent, v0.1.202): ContextBench first place (Utilized F1 **0.3097**, cost **-58.3% vs full**); LongMemEval-S **79.20% vs 62.60%** (+16.6% over the best RAG baseline), independent-session cost **-71.1% vs full**; 1.48M-token MemoryAgentBench TTL **100% survival**, **30× steady-state compression** (full context failed 199/199).
  - Cache: healthy-session prefix-cache hit **95–97%**, compression overhead **≤2%**.
- **Sources:** [billion-context npm README](https://www.npmjs.com/package/billion-context) (contains all of the above plus paper/benchmark links), [GitHub repository](https://github.com/ranxianglei/billion-context) (timed out at research time; npm README is the equivalent content), [third-party-1500 benchmark README](https://github.com/ranxianglei/billion-context/blob/HEAD/benchmarks/third-party-1500/README.md).
- **Basis and limitations — important:**
  - "5× fewer tokens" is a **marketing claim** with no defined baseline or scenario; it **cannot** be converted into "80% less context".
  - -58.3% / -71.1% is **cost relative to full context**, from the project's own self-run and self-published "third-party benchmark" — not "single-session pressure reduction" and not an independent reproduction.
  - 30× is a **steady-state compression ratio** (summaries + retrieval replacing originals over a long TTL), **not** a per-request token reduction.
  - Extra always-on proxy layer, its own state store, version coupling, and its own README documents a number of runtime risks (injection failures, silent passthrough). License claims beyond the repository's own terms should be reviewed before adoption.
- **Reproducibility:** the highest of this group — code, benchmark data, and the paper are public. It has not, however, been reproduced on a DSH/DeepSeek real session outside our own replay work (different basis; see [docs/benchmarks.md](benchmarks.md)).

## ACON (Microsoft, ICML 2026): the paper whose basis is closest to "saving tokens"

- **Mechanism:** optimizes compression guidelines in natural-language space (iteratively improving them from failure analysis), compresses observations and history into concise representations, and distills the compressor into a small model — no fine-tuning of the target model.
- **Public numbers:** **peak token usage reduced 26–54%** on AppWorld / OfficeBench / Multi-objective QA, while **task success beats existing compression baselines**; small models gain **up to +46% performance** on long-horizon agents.
- **Sources:** [ACON paper arXiv:2510.00615](https://arxiv.org/abs/2510.00615), [ICML 2026 poster](https://icml.cc/virtual/2026/poster/66270), [microsoft/acon](https://github.com/microsoft/acon).
- **Basis and limitations:** **peak token usage** is the closest published basis to this plugin's pressure reduction, but the tasks, models, and benchmarks differ completely. It is a mechanism and order-of-magnitude reference only.

## Other approaches with no public numbers

- **Google Gemini context caching:** explicit/implicit caching with discounted cache-token billing plus a per-token-hour storage fee; good fit for a fixed long prefix with a variable tail. The exact multipliers and storage price were **not verified** at research time (`ai.google.dev` unreachable); only the mechanism and official entries are listed. Sources: [context caching](https://ai.google.dev/gemini-api/docs/generate-content/caching), [pricing](https://ai.google.dev/gemini-api/docs/pricing). The relevant idea — only a reused long prefix saves — is the same principle behind this plugin's summary-call replay.
- **LangChain / LangGraph summarization middleware, Cline / Roo truncation:** rolling summarization when history exceeds limits, or dropping the oldest messages by token budget. **No public numbers** (framework docs describe behavior and parameters only). Sources: [LangChain short-term memory](https://docs.langchain.com/oss/python/langchain/short-term-memory), [Cline docs](https://docs.cline.bot/).

## Side-by-side

| Approach | Mechanism | Trigger | Public quantitative result | Basis / scenario | Reversible / searchable | Cache-friendly | Open source / self-hosted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Anthropic context editing + memory tool** | Server-side clearing of stale tool results + client-side file memory | trigger (default 100K input tokens) / keep 3 / clear_at_least | **-84% token consumption** (100-turn web search); **+29%** / **+39%** performance | whole-evaluation tokens; internal agentic-search performance | cleared parts **irreversible**; memory tool stores separately | mediocre: **every clear incurs cache writes** (official) | closed API |
| **Claude Code auto-compact / idle compaction** | Summarize history at threshold, continue | 1M-window default ≈**967K**; 200K boundary; idle ~54 min (before 1h TTL) | **no public number** | — | **irreversible** | medium: compaction necessarily invalidates the prefix; idle timing is deliberate | closed CLI |
| **Cursor /summarize + auto-summarize** | Summarize at window limit; manual summarize | window limit | **no public number** | — | **irreversible** per official description | not public | closed |
| **OpenAI Responses compaction** | Server-side `/responses/compact` or `compact_threshold`; encrypted compaction item | `compact_threshold` (example 200K) | **no public number** | — | **irreversible, not searchable** (opaque item) | not public | closed API; Agents SDK open source |
| **Letta / MemGPT** | Layered memory + tool-driven paging; sleep-time compute | model-driven / interrupts | MemGPT **no token number**; sleep-time **~5× less test-time compute**, **2.5× lower per-query cost**, +13% / +18% accuracy | test-time compute/cost; synthetic stateful tasks | yes (read back from external memory) | not public | open source |
| **billion-context** | API proxy / DSH plugin; model-driven compress/decompress/search | model-driven + growth nudge + oversize preflight | **5× fewer tokens (marketing)**; self-run cost **-58.3% / -71.1% vs full**; **30× steady-state**; cache hit **95–97%**, overhead **≤2%**; 174,327 calls / 18.76B tokens / zero window violations | cost relative to full context; project's own benchmark | **yes + searchable** | good (explicit prefix-cache optimization) | open source (npm/GitHub); extra terms to review |
| **ACON (Microsoft)** | NL-space compression-guideline optimization + distilled compressor | over limit / task boundaries | **peak token -26–54%**; small models **+46%** | peak token usage | original text not guaranteed retrievable | not quantified | open source |
| **dsh-context-keeper** | Native DSH Host plugin: model-driven `context_compact` + incremental auto-fold + `context_search` / `context_restore` | 60% of the capped pressure window (`maxContextWindowCap`, default 262144) + 20K growth; keep 30K verbatim; native 80% fallback | **local**: one fold **-71.5% to -86.5%** pressure; policy simulation **-33.6% to -72.8%** billed tokens (see [benchmarks](benchmarks.md)) | single-session context pressure; local real-log replay | **yes + searchable** | good (summary replay reuses the same prefix; log never deleted) | this project |

## What cannot be compared

1. **Anthropic's -84% ≠ this plugin's -71.5%.** The former is token consumption across a 100-turn web-search workflow, including memory-tool externalization; the latter is a single session's pressure after folding 325,988 tokens. What *can* be said: the order of magnitude is the same ("tens of percent"), and Anthropic's result confirms that clearing tool results is the biggest lever — consistent with the tool results dominating real-session usage here.
2. **Anthropic's 39% / 29% are performance metrics**, not token savings. They are indirect evidence that compaction does not necessarily degrade quality; they cannot be compared with a pressure reduction.
3. **billion-context's "5× fewer tokens" is marketing** with no defined baseline and cannot be converted into "-80% context". The quotable hard numbers are its self-run cost reductions, 30× steady-state, and cache figures — always labeled "project's own benchmark, not independently reproduced".
4. **ACON's 26–54% is peak token usage**, the closest basis, but different tasks, models, and benchmarks. Same order of magnitude only; not better-or-worse.
5. **Letta's 5× / 2.5× are test-time compute/cost**, not context occupancy, and cannot be listed next to context pressure.
6. **-71.1% / -58.3% are relative to full-context cost**, not relative to a baseline token consumption. Semantically close to "the same session without folding", but the accounting basis differs.
7. **No public benchmark exists for dsh-context-keeper.** Its numbers are local replay and simulation on real logs, not a production A/B test; they should be described as "measured on real session logs", not "production measured data".

## How dsh-context-keeper differentiates, honestly

- **Versus Anthropic / Claude Code / Cursor / OpenAI:** their compaction is **not reversible and not searchable**; this plugin's folds are searchable with `context_search` and restorable with `context_restore`.
- **Versus billion-context:** both are reversible and searchable. This plugin is implemented **inside DSH's native event protocol** — no extra proxy or injection layer, no request rewriting — which removes a whole failure surface. billion-context's advantage is published, reproducible benchmarks; this project has none.
- **Trigger point:** 60% of the capped pressure window (`maxContextWindowCap`, default 262144) + 20K growth (earlier, incremental folds) versus the native 80% fallback and Claude Code's ≈967K on a 1M window. Earlier folding is the design answer to cache-friendliness and context rot, at the cost of folding content that might still have been useful verbatim.
- **The honest claim:** "same order of magnitude, different accounting basis, different trade-offs" — plus "lighter, more controllable, and verifiable" against the proxy-based option. **Not** "better than" any of them.

## Sources

**Read directly:** [Anthropic context management](https://claude.com/resources/articles/context-management), [Anthropic context engineering / context rot](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents), [Nadir (cache-write cost, 1.25× / 0.1×)](https://app.getnadir.com/blog/context-editing-clear-tool-uses-cache-write-cost/), [Augmenter.dev (39% / 29% / 84% cross-check)](https://augmenter.dev/articles/anthropic-adds-context-editing-and-file-based-memory-to-claude-1759184891957/), [billion-context npm README](https://www.npmjs.com/package/billion-context), [ACON arXiv:2510.00615](https://arxiv.org/abs/2510.00615), [MemGPT arXiv:2310.08560](https://arxiv.org/abs/2310.08560), [sleep-time compute arXiv:2504.13171](https://arxiv.org/abs/2504.13171), [Azure OpenAI Responses API](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses), [OpenAI Agents SDK sessions](https://openai.github.io/openai-agents-python/sessions/), [Cursor changelog 1.6](https://cursor.com/en-US/changelog/1-6), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing), [koromo Claude Code guide (secondary)](https://koromo.io/blog/claude-code-context-memory/).

**Official entry points not read directly (403 / timeout / unreachable at research time):** [code.claude.com context window](https://code.claude.com/docs/en/context-window), [code.claude.com auto-compact thresholds](https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds), [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction), [Anthropic context-editing docs](https://platform.claude.com/docs/en/build-with-claude/context-editing), [Gemini context caching](https://ai.google.dev/gemini-api/docs/generate-content/caching), [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [billion-context GitHub](https://github.com/ranxianglei/billion-context).
