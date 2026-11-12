# Changelog

All notable changes to `dsh-context-keeper` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.1.3] — 2026-11-12

- Skip non-visible history before text extraction in visible-only searches. With 2,000 history events and 20 eligible messages, extraction drops from 2,000 to 20. See [#5](https://github.com/YansongG-HKU/dsh-context-keeper/issues/5).

- Add `autoCompact.maxContextWindowCap` (default `262144`, `0` = no cap) to the pressure denominator. A self-deployed model that declares a 1M window no longer pushes `minPressureRatio` out of reach: at the default cap the 60% threshold is ≈157K tokens instead of ≈629K, so auto-folding actually triggers. `context_status` now reports `keeper.policy.maxContextWindowCap` and `keeper.policy.effectiveContextWindow` (config + the session's routed window), so a deployment can verify the new code is live without extra I/O.

- Salvage a summarization response cut off at the token cap: when partial text was produced it is used as the checkpoint (still validated to be smaller than the shadowed span) and the `compaction/summary` row is marked `truncated: true`. Only a response with no text fails the transaction.

- Forward the routed request's `reasoningEffort` (`request/header.config.reasoningEffort`) to the summarization call, so a reasoning model folds under the session's thinking configuration instead of the provider default that can spend the whole summary budget on hidden reasoning. `temperature` is not forced.

## [0.1.2] — 2026-11-10

- Plan a balanced context fold with one forward scan. Refuse automatic fold plans when even the first foldable boundary has an unanswered tool call. See [#1](https://github.com/YansongG-HKU/dsh-context-keeper/issues/1).

- Build previews only for the eight highest-token status rows, preserving meter order for tied rows. See [#2](https://github.com/YansongG-HKU/dsh-context-keeper/issues/2).

## [0.1.1] — 2026-11-06

### Changed

- **DSH 0.2.2-rc.1 compatibility.** Re-vendored the offline test dependency tree (`test/vendor/`) from the shipping 0.2.2-rc.1 desktop runtime (session format stays v4; 48/48 tests pass against it).
- Declared `engines.dsh: ">=0.2.2-rc.1"` in `package.json`; README prerequisites now name 0.2.2-rc.1.

### Verified

- Host tool registration, scoped prompt section, `agent/pre-step` auto-compaction and the sidebar panel contract are unchanged between 0.2.1-rc.5 and 0.2.2-rc.1.
