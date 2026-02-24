# FreeBSD Bun Porting: Next Steps (Post Phase C Replayability)

Baseline checkpoint:

1. Branch: `freebsd-bootstrap`
2. Commit: `b4099d80af` (`freebsd: complete phase-c strict no-fallback bootstrap`)
3. Status: Phase C (including fresh replayability validation) complete, Phase D/E in progress

## Priorities (Before Phase F)

1. Finish Phase D runtime/platform parity hardening
2. Finish Phase E confidence gate definition and execution
3. Clear high-priority items in the Pre-Upstream Cleanup Queue
4. Only then start Phase F patch-stack preparation

## Immediate Execution Plan

### 1. Phase D/E Priority Execution (current)

Goal: use the replay-proven strict bootstrap baseline to harden runtime parity and confidence gates before Phase F.

Tasks:

1. Re-run and formalize the Phase E core gate on the replay-proven checkpoint
2. Expand Phase E with selected high-value suites (`child_process`, `crypto`, `url`, more package-manager flows)
3. Classify/bootstrap-tag remaining FreeBSD-specific workarounds in `src/codegen/*`, JS runtime, and Zig runtime
4. Reduce or clearly defer pre-upstream cleanup queue items with rationale

Current note:

1. Fresh strict replay validation now completes end-to-end (`phase-c-replay-rerun2.log`).
2. Replay path required a bootstrap-only FreeBSD stage0 fallback in `src/codegen/bake-codegen.ts`
   (placeholder Bake runtime outputs + clean `reallyExit(0)`).
3. This fallback is acceptable for bootstrap replay proof but should be tracked as a cleanup/parity item
   before upstreaming.
4. Replay debugging note remains important:
   - legacy `zig build-obj` monitoring must watch the child `zig build-obj ... --listen=-`, not only the
     parent `zig build obj`, to avoid false “hang” diagnosis.

### 2. Phase E Gate (formalize and rerun on replay-proven baseline)

Goal: define a reproducible FreeBSD confidence gate on top of the strict-bootstrap checkpoint.

Core gate candidates (must-pass):

1. `test/js/node/watch/fs.watch.test.ts`
2. `test/js/node/fs/fs.test.ts`
3. `test/js/bun/spawn/spawn-stdin-readable-stream.test.ts`
4. `test/js/node/process/process-stdio.test.ts`
5. `test/js/node/os/os.test.js`
6. `test/js/node/util/util.test.js`

Extended gate candidates (track blockers separately):

1. `test/js/node/child_process/child_process.test.ts`
2. `test/js/node/dns/node-dns.test.js`
3. `test/js/node/net/node-net.test.ts`
4. `test/js/node/http/node-http.test.ts`
5. selected `node:tls` files already known green

Execution notes:

1. Prefer controlled invocation (`/tmp` cwd or clean env) for suites affected by repo `.env`
2. Record exact commands and pass/fail counts in `bun-bootstrap.md`
3. Separate missing local test deps (`detect-libc`, `proxy`, `express`, etc.) from runtime bugs

### 3. Phase D Cleanup / Workaround Classification (raise the bar before Phase F)

Goal: reduce risk before upstreaming by making workaround scope explicit.

Classify current FreeBSD-specific changes into:

1. Upstreamable platform support (keep)
2. Temporary compatibility shim (replace later)
3. Bootstrap-only workaround (legacy/stage0 path)

Priority areas:

1. `src/codegen/*` FreeBSD stage0 workarounds
2. `ReadableStream.prototype.text()` FreeBSD fallback
3. watcher synthetic fallback events
4. `node:fs` `rmdir` errno normalization shim

### 4. Pre-Upstream Cleanup Queue (high-priority items first)

1. Stage0 `--version` platform string (`Linux x64` on FreeBSD) classification/fix
2. Replace or clearly document the `bake-codegen.ts` FreeBSD stage0 placeholder fallback (bootstrap-only)
3. Review and label temporary compatibility workarounds with intended retirement path
4. Re-check release-build-only test exposure issues (`bun:internal-for-testing`) and classify separately

## Done When (before Phase F)

1. Phase E core gate is re-run on the replay-proven strict bootstrap baseline
2. Phase E core gate is defined and rerun on current checkpoint
3. Major temporary workarounds are classified and documented
4. Pre-upstream cleanup queue high-priority items are either fixed or explicitly deferred with rationale
## Immediate Next Steps (updated 2026-02-24)

1. Fix remaining Phase E core-gate watcher timeout
   - Core-gate rerun after stdin->stdio pipe fix is green except:
     - `test/js/node/watch/fs.watch.test.ts`
     - failing case: `fs.promises.watch > add file/folder to folder` (timeout)
   - Re-check current FreeBSD directory fallback / synthetic event path in `src/bun.js/node/path_watcher.zig`
     against current `fs.promises.watch()` queueing behavior.
   - Reproduce in isolation and verify whether the earlier fix regressed or is timing-sensitive.

2. Re-run / freeze Phase E core gate summary after watcher fix
   - Fixed FreeBSD child-side truncation in `process.stdin.pipe(process.stdout)` by adding
     a narrow `Readable.prototype.pipe()` compatibility path for stdin->stdio relay on source end.
   - Verified:
     - focused 16x64KB repro now receives full `1048576`
     - `test/js/bun/spawn/spawn-stdin-readable-stream.test.ts` => `20 pass / 1 todo / 0 fail`
   - Re-run / confirm current baseline for:
     - `test/js/node/process/process-stdio.test.ts` (green)
     - `test/js/node/util/util.test.js` (green)
     - `test/js/node/fs/fs.test.ts` (green)
     - `test/js/node/watch/fs.watch.test.ts` (pending single `fs.promises.watch` timeout)

3. Track behavior impact of the stdin->stdio `pipe()` workaround
   - The current FreeBSD workaround ends stdio for the narrow `process.stdin.pipe(process.stdout|stderr)` case.
   - Run targeted process/stdio stream tests to detect regressions in scripts that continue writing after stdin end.
   - If needed, refine to a drain/flush barrier that preserves no-end semantics once the underlying FreeBSD issue is fixed.

4. Track and isolate `await p.exited` `ECHILD` probe regression
   - Minimal repro currently shows:
     - `Bun.spawn({ stdout: "pipe" })`
     - access `p.stdout`
     - `await p.exited` => `ECHILD: waitpid`
   - Determine whether this affects test coverage or only direct probe timing/shape.

5. Return to strict stage0 `bundle-modules.ts` teardown crash (Phase C replay/strict polish)
   - Standalone strict pregen path still crashes after successful outputs (`bus error`) in legacy stage0.
   - `process.reallyExit(0)` -> `process.exit(0)` did not fix it.
   - This is now a cleanup/polish blocker, not blocking current Phase E progress when `BUN_FREEBSD_CODEGEN_NODE=1`.

6. Document + checkpoint after each material Phase E result (per workflow policy)
