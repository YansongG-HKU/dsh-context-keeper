# Changelog

All notable changes to `dsh-context-keeper` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.1.1] — 2026-11-06

### Changed

- **DSH 0.2.2-rc.1 compatibility.** Re-vendored the offline test dependency tree (`test/vendor/`) from the shipping 0.2.2-rc.1 desktop runtime (session format stays v4; 48/48 tests pass against it).
- Declared `engines.dsh: ">=0.2.2-rc.1"` in `package.json`; README prerequisites now name 0.2.2-rc.1.

### Verified

- Host tool registration, scoped prompt section, `agent/pre-step` auto-compaction and the sidebar panel contract are unchanged between 0.2.1-rc.5 and 0.2.2-rc.1.
