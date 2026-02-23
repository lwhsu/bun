# FreeBSD Bun Porting: Next Steps (Post Phase C-strict)

Baseline checkpoint:

1. Branch: `freebsd-bootstrap`
2. Commit: `b4099d80af` (`freebsd: complete phase-c strict no-fallback bootstrap`)
3. Status: Phase C (including C-strict) complete, Phase D/E in progress

## Priorities (Before Phase F)

1. Finish Phase D runtime/platform parity hardening
2. Finish Phase E confidence gate definition and execution
3. Clear high-priority items in the Pre-Upstream Cleanup Queue
4. Only then start Phase F patch-stack preparation

## Immediate Execution Plan

### 1. Phase C Replayability Integrity (must keep)

Goal: ensure strict bootstrap is reproducible from a fresh legacy worktree, not only from accumulated local legacy edits.

Tasks:

1. Export any remaining legacy-worktree fixes into `scripts/patches/`
2. Wire each patch into `scripts/bootstrap-freebsd.sh` (`patch_legacy_worktree_for_freebsd()`)
3. Rebuild stage0 from a fresh legacy worktree
4. Re-run strict no-fallback bootstrap:
   - `BUN_FREEBSD_BINDGENV2_NODE=0`
   - `BUN_FREEBSD_CODEGEN_NODE=0`
   - `BUN_FREEBSD_NPM_INSTALL=0`

Current note:

1. The legacy `src/install/extract_tarball.zig` cache-move fallback fix has been exported and wired.
2. Replay validation exposed malformed patch headers in some legacy debug patches; fixed and replay now reaches stage0 build.
3. Replay validation exposed stale `~/.cache/zig` dependency during legacy `identifier-cache`; bootstrap now forces legacy Zig caches under `${BUN_FREEBSD_BOOTSTRAP_DIR}/legacy-zig-cache`.
4. Next action: rerun fresh replay validation and confirm full strict bootstrap completes end-to-end.

### 2. Phase E Gate (formalize and rerun)

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

### 3. Phase D Cleanup / Workaround Classification

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
2. Review and label temporary compatibility workarounds with intended retirement path
3. Re-check release-build-only test exposure issues (`bun:internal-for-testing`) and classify separately

## Done When (before Phase F)

1. Strict bootstrap replayability is validated from patchset + fresh legacy worktree
2. Phase E core gate is defined and rerun on current checkpoint
3. Major temporary workarounds are classified and documented
4. Pre-upstream cleanup queue high-priority items are either fixed or explicitly deferred with rationale
