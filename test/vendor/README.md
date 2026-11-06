# Vendored test dependencies

This directory holds an **offline, test-only copy** of the DSH runtime packages that the plugin's test suite runs against.

## What is here

- `package.json` — the vendoring manifest. It is `private`, is never published, and records:
  - `dshRuntime`: the DSH runtime line the tree was copied from (`0.2.2-rc.1`),
  - `vendoredAt`: the date of the copy,
  - `dependencies`: **exact** versions (no semver ranges) of every vendored package.
- `node_modules/` — the vendored dependency tree: **21 packages**, copied from a real DSH 0.2.2-rc.1 installation. npm does not install it; tests import it directly by relative URL.

Packages in the tree:

| Group | Packages |
| --- | --- |
| Session runtime | `@deepseek-ai/dsh-session` **0.2.2-rc.1**, `dsh-session-format` 0.2.2-rc.1, `dsh-session-format-catalog` 0.2.2-rc.1, the format migration chain `dsh-session-format-v0-to-v1` … `v3-to-v4` (all 0.2.2-rc.1) |
| DSH services used by the runtime | `dsh-llm`, `dsh-scope`, `dsh-brand`, `dsh-timeout`, `dsh-typert-protocol`, `dsh-compaction-image-offload`, `dsh-util-crypto`, `dsh-util-values` (all 0.2.2-rc.1) |
| Framework | `@deepseek-ai/cordis` 4.1.0, `@deepseek-ai/cordis-plugin-loader` 1.1.0, `@deepseek-ai/cosmokit` 1.9.0, `@deepseek-ai/schemastery` 3.19.0 |
| Validation / schema | `@standard-schema/spec` 1.1.0, `zod` 4.4.3 |

The authoritative list, with exact versions, is in [`package.json`](package.json).

## Why it is vendored

1. **Exact runtime parity.** The regression tests replay a real compaction transaction through the *same* session-format loader and `Session.create` that the DSH desktop app ships. A different DSH version may accept a log the desktop rejects (or reject one it accepts), which is exactly the class of bug these tests exist to catch — so the tests must not float on a newer npm line.
2. **Offline and deterministic.** `npm test` needs no network, no lockfile resolution, and no install step. The tree is pinned; contributors get the same runtime as CI.
3. **Version-line isolation.** The vendored runtime is the one bundled with the shipping desktop app. Public registry lines ahead of it can carry a changed session format; using them would silently test the wrong protocol.
4. **Small footprint.** Only the transitive closed set needed by `dsh-session` is included — not the whole DSH installation.

## How the tests use it

- [`test/helpers.mjs`](../helpers.mjs) resolves `./vendor/node_modules/@deepseek-ai/` and imports `dsh-session/lib/index.js` from it. Setting the `DSH_PKG_ROOT` environment variable to another DSH package root (absolute path or `file:` URL) redirects the suite to a different runtime — useful for validating a new runtime before re-vendoring.
- `test/runtime-format.test.mjs` loads the vendored session-format validator and migration modules and asserts that logs produced by a transaction pass validation and replay through the real `Session`.
- `test/verify-live-log.mjs` replays a real session log through the same vendored runtime (usage: `node test/verify-live-log.mjs <path-to-session-log>`).

## Licensing

All 21 packages are **MIT**, and **each package keeps its own `LICENSE` file** inside its directory. The tree is redistributed under those licenses, with copyright retained by the original authors (DeepSeek and the respective package authors).

These files are unmodified test fixtures, not a fork: do not patch vendored sources. If a local patch ever becomes unavoidable, document it in this README and review the license implications first.

## Not published

`test/vendor` is test-only. Its `package.json` is `private` (name `vendor-test-deps`) and is not part of the root package's `files` list; the root `npm test` is its only consumer. Do not `npm install` inside this directory — that would defeat the exact-version pinning.

## How to update the vendor tree

1. Obtain a **real install of the target DSH runtime** — the exact version the desktop app ships. Check the app's bundled CLI dependency tree for the version.
2. Replace `node_modules/` with that install's complete dependency tree for `dsh-session` (or the relevant closed set), preserving every package's `LICENSE` file.
3. Update `test/vendor/package.json`: bump `dshRuntime`, refresh every entry in `dependencies` (exact versions only — no ranges), and set `vendoredAt` to the update date. Update this README if the package set or grouping changes.
4. Run `npm test`. Everything must pass, in particular:
   - `test/session.test.mjs`, which asserts the vendored runtime is on the v4 session-format line;
   - `test/runtime-format.test.mjs`, which runs the real v4 loader over transaction output.
5. Run the real-log replay (`node test/verify-live-log.mjs <path-to-session-log>`) and open a folded session in the desktop app: a loader regression otherwise shows up as "history failed to load" in the UI.
