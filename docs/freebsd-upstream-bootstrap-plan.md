# FreeBSD Bootstrap and Upstream Readiness Plan

Last updated: 2026-02-22
Repository: `/home/lwhsu/killme/bun`
Branch at planning time: `freebsd-bootstrap` (`2e7d7b21a7`)

## 1. Current Status (Re-checked)

### Verified now

- `git status --porcelain` in main worktree is clean.
- Canonical full bootstrap script rerun succeeded in active dirs:
  - `BUN_FREEBSD_BOOTSTRAP_DIR=/home/lwhsu/killme/bun/build/freebsd-bootstrap`
  - `BUN_FREEBSD_BUILD_DIR=/home/lwhsu/killme/bun/build/release`
- Stage0 binary exists and runs:
  - `build/freebsd-bootstrap/stage0/bun --version` -> `0.0.0`
  - `build/freebsd-bootstrap/stage0/bun -e 'console.log(1+1)'` -> `2`
- Active stage0 runtime gate now also passes for node fs import:
  - `build/freebsd-bootstrap/stage0/bun -e 'import fs from "node:fs"; console.log(typeof fs.readFile)'` -> `function`
- Active final binary refreshed and validated:
  - `build/release/bun --version` -> `1.3.10`
  - `build/release/bun -e 'console.log(1+1)'` -> `2`
  - `build/release/bun -e 'import fs from "node:fs"; console.log(typeof fs.readFile)'` -> `function`

### State that still needs cleanup/normalization

- Workspace-local cleanup is complete:
  - duplicate legacy worktrees under `build/` were removed
  - non-canonical build outputs were archived under `build/archive-freebsd-experiments/20260222-phaseB`
  - active `build/` entries are now only:
    - `build/freebsd-bootstrap`
    - `build/release`
    - `build/archive-freebsd-experiments`
- Remaining non-canonical detached worktrees outside workspace:
  - `/home/lwhsu/tmp/bun-stage0-compat`
  - `/home/lwhsu/tmp/bun-stage0-june2024/legacy-worktree`
- `vendor/WebKit` is intentionally not clean (local FreeBSD patching work + stash).

## 2. Target Definition

We consider FreeBSD support complete for upstream submission when all of these are true:

1. Cold-start bootstrap on FreeBSD works from source without an existing FreeBSD `bun` binary.
2. Bootstrap output produces a deterministic stage0 location and can build current-tree Bun.
3. Core runtime smokes and focused regression suites pass on FreeBSD.
4. Patch stack is split into reviewable units with minimal risk and clear rationale.
5. Workspace is tidy: no ambiguous parallel worktrees or undocumented local-only artifacts.

## 2.1 Node Fallback Exit Point

Question: when can we set these to fully self-hosted defaults?

- `BUN_FREEBSD_BINDGENV2_NODE=0`
- `BUN_FREEBSD_CODEGEN_NODE=0`
- `BUN_FREEBSD_NPM_INSTALL=0`

Answer:

1. Target phase: **Phase C (Bootstrap Pipeline Hardening)**.
2. Practical gate: mark this change only when Phase C rerun matrix passes with these settings forced to `0` in configure.
3. Confidence gate: keep it only after Phase E targeted tests pass on the same build.
4. Upstreaming gate: land this default switch in Phase F as a separate reviewable patch.

Why Phase C:

1. These flags directly control configure/codegen runner behavior (`cmake/Globals.cmake`, `cmake/targets/BuildBun.cmake`, `cmake/tools/SetupEsbuild.cmake`).
2. The phase objective is deterministic bootstrap without FreeBSD-only fallback behavior.
3. Until Phase C exits cleanly, leaving fallback-enabled defaults reduces bootstrap breakage risk.

Current status at 2026-02-22:

1. `BUN_FREEBSD_BINDGENV2_NODE=0` is now working again in split mode when:
   - `BUN_FREEBSD_CODEGEN_NODE=1`
   - `BUN_FREEBSD_NPM_INSTALL=1`
2. Verified by building target `bun-bindgen-v2` in a fresh build directory.
3. Full no-fallback (`BUN_FREEBSD_BINDGENV2_NODE=0`, `BUN_FREEBSD_CODEGEN_NODE=0`, `BUN_FREEBSD_NPM_INSTALL=0`) is still blocked by stage0 runtime issues:
   - legacy stage0 `bun build` crashes (`SIGSEGV`) in bundler parser worker (`src.bundler.bundle_v2.ParseTask.callback`)
   - stage0 subprocess APIs on FreeBSD are unstable (`Bun.spawn*`, `node:child_process.spawnSync`) and cannot be used as a reliable script-level workaround
   - `bindgen.ts` functional mismatch under stage0
4. Latest crash narrowing for install path:
   - stage0 `bun install` core backtrace points at `src.sys.File.toSource` during lockfile workspace parsing (`Package.processWorkspaceName*`).
5. 2026-02-22 update:
   - Legacy stage0 with `build-obj-safe` plus FreeBSD `read`-based file-read path no longer crashes on `bun install --frozen-lockfile`.
   - This narrows remaining no-fallback work to stage0 codegen/runtime behavior rather than install lockfile parsing.

## 2.3 Pre-Upstream Cleanup Queue (Non-Critical but Important)

Use this section for tasks that are not blocking bootstrap/runtime correctness, but should be tracked and preferably resolved before upstream submission.

Current items:

1. Legacy stage0 version/platform reporting shows `Linux x64` on FreeBSD.
   - Example output: `Bun v0.0.0 (<legacy-hash>) Linux x64`
   - Impact: confusing logs/repro reports; not currently a bootstrap blocker.
   - Desired outcome: stage0 reports FreeBSD correctly (or clearly identifies the legacy bootstrap target semantics).
2. Review temporary FreeBSD compatibility workarounds and mark upstream intent explicitly.
   - Example categories:
     - acceptable bootstrap-only workaround (legacy patch set)
     - temporary current-tree compatibility shim to replace later
3. Re-check release-build-only test exposure issues (e.g. `bun:internal-for-testing`) and classify separately from FreeBSD runtime parity.

## 2.2 Current Stage0 Build Design (How It Works Today)

This section documents the current cold-start dependency chain implemented by `scripts/bootstrap-freebsd.sh`.

### Inputs

1. Source tree:
   - main branch/worktree (current tree)
   - legacy commit worktree for stage0 (`8d7d58606b`)
2. WebKit source repository clone:
   - default expected at `vendor/WebKit`
3. Two WebKit package outputs produced by `scripts/prepare-webkit-freebsd.sh`:
   - legacy stage0 WebKit package
   - current-tree WebKit package
4. Toolchains:
   - legacy zig: **0.13.x** required for legacy stage0 build
   - current zig: configured via `BUN_FREEBSD_CURRENT_ZIG` (can be oven-zig path)
5. Runtimes/tools:
   - git, cmake, ninja, gmake, node, npm, perl, python3, clang, clang++, zig

### What stage0 is built from

1. Script creates/uses detached legacy worktree at `${BUN_FREEBSD_BOOTSTRAP_DIR}/legacy-worktree`.
2. Script applies FreeBSD compatibility patches from `scripts/patches/freebsd-stage0-*.patch`.
   - includes a legacy-only `StreamInternals.ts` compatibility hunk removing class-field declarations in `Denqueue`.
   - rationale: avoid legacy codegen emitting `__publicField` references that can fail at stage0 runtime.
3. Script runs Node-based legacy codegen helper:
   - `scripts/bootstrap-freebsd-generate-legacy-codegen.mjs`
4. Script builds stage0 in legacy tree via `gmake` targets:
   - `vendor`
   - `identifier-cache`
   - `sqlite`
   - `release-bindings`
   - `build-obj`
   - `bun-link-lld-release`
5. Script installs produced stage0 binary to deterministic path:
   - `${BUN_FREEBSD_BOOTSTRAP_DIR}/stage0/bun`

### Stage0 runtime acceptance gate (current behavior)

`scripts/bootstrap-freebsd.sh` now validates stage0 runtime before accepting/reusing it.

Validation commands:

1. `${stage0} --version`
2. `${stage0} -e 'console.log(1+1)'`
3. `${stage0} -e 'import fs from "node:fs"; console.log(typeof fs.readFile)'`

Behavior:

1. If an existing stage0 binary fails any check, bootstrap forcibly rebuilds stage0.
2. During forced rebuild, bootstrap removes stale legacy generated code outputs before regenerating codegen artifacts.
3. If post-build stage0 still fails runtime validation, bootstrap exits non-zero.
4. Known fixed regression signature (now covered by patch + runtime gate):
   - `ReferenceError: Can't find variable: __publicField`
   - stack path: `new Denqueue` -> `node:stream` -> `node:fs`

### How stage0 is used afterwards

1. Current-tree CMake configure receives:
   - `-DBUN_EXECUTABLE=${BUN_FREEBSD_BOOTSTRAP_DIR}/stage0/bun`
2. Current-tree configure/build currently forces FreeBSD Node fallbacks in bootstrap script:
   - `BUN_FREEBSD_BINDGENV2_NODE=1`
   - `BUN_FREEBSD_GENERATE_CLASSES_NODE=1`
   - `BUN_FREEBSD_CODEGEN_NODE=1`
   - `BUN_FREEBSD_NPM_INSTALL=1`
3. Final binary is then built in `${BUN_FREEBSD_BUILD_DIR}`.

## 3. Full Roadmap

Documentation rule for every phase update:

1. Add `Status` with date.
2. Add `How to reproduce`.
3. Add `How to verify`.
4. Add `How to review`.
5. Link evidence in `bun-bootstrap.md` when the phase changes.

### Phase A: Freeze a Canonical Baseline

Goal: lock one known-good path before further changes.

Status: **Completed** (2026-02-21 baseline freeze validated).

How it was done:

1. Chose one canonical successful pair:
   - Stage0: `build/20260221-2027-freebsd-bootstrap-cleanroom-step1/stage0/bun`
   - Final: `build/20260221-2027-current-from-cleanroom-step1/bun`
2. Re-ran runtime smoke commands on both binaries.
3. Captured host/toolchain manifest (`uname`, zig, clang, cmake, ninja, node).

How to reproduce:

```bash
cd /home/lwhsu/killme/bun

build/20260221-2027-freebsd-bootstrap-cleanroom-step1/stage0/bun --version
build/20260221-2027-freebsd-bootstrap-cleanroom-step1/stage0/bun -e 'console.log(1+1)'

build/20260221-2027-current-from-cleanroom-step1/bun --version
build/20260221-2027-current-from-cleanroom-step1/bun -e 'console.log(1+1)'

uname -srmo
/usr/local/bin/zig version
clang --version | sed -n '1p'
cmake --version | sed -n '1p'
ninja --version
node --version
```

How to verify:

1. Stage0 returns `0.0.0` and prints `2` for `1+1`.
2. Final bun returns `1.3.10` and prints `2` for `1+1`.
3. Toolchain commands return concrete versions without errors.

How to review:

1. Confirm this file and `bun-bootstrap.md` agree on canonical dirs.
2. Confirm binaries currently exist at the exact paths above.
3. Confirm no hidden reliance on `/tmp`.

Exit criteria:

1. Any collaborator can repeat baseline checks from the commands above.

### Phase B: Sort and Tidy Workspace/Worktrees

Goal: remove ambiguity and make the repository auditable for upstream.

Status: **Completed (workspace scope)** on 2026-02-22.

How to do it:

1. Keep only one active legacy worktree:
   - `build/freebsd-bootstrap/legacy-worktree`
2. Keep one optional backup legacy worktree in `~/tmp`.
3. Move non-canonical experiment outputs under:
   - `build/archive-freebsd-experiments/<timestamp>-<name>`
4. Keep `vendor/WebKit` pinned at one commit and document local deltas.
5. Preserve only reproducibility-critical artifacts in active paths.

How to reproduce:

```bash
cd /home/lwhsu/killme/bun
git worktree list --porcelain
ls -1 build
git -C vendor/WebKit rev-parse --short=12 HEAD
git -C vendor/WebKit status --short
git -C vendor/WebKit stash list | sed -n '1,20p'
```

How to verify:

1. `git worktree list` shows one canonical legacy worktree plus optional backup only.
2. `build/` clearly separates active dirs from archived dirs.
3. WebKit state (commit + local changes/stash) is documented in a reproducible way.

How to review:

1. Inspect directory layout and compare to this plan.
2. Confirm no active build flow still points to archived directories.
3. Confirm cleanup does not delete canonical stage0/final artifacts.

Exit criteria:

1. Worktree list is small and purposeful.
2. Directory layout is explicit and documented.

Completion evidence (2026-02-22):

1. Removed in-workspace duplicate detached worktrees:
   - `build/20260221-1844-freebsd-bootstrap-cleanroom-step1/legacy-worktree`
   - `build/20260221-2027-freebsd-bootstrap-cleanroom-step1/legacy-worktree`
   - `build/freebsd-bootstrap-cleanroom-step1/legacy-worktree`
2. Archived 44 non-canonical build outputs to:
   - `build/archive-freebsd-experiments/20260222-phaseB`
3. Active `build/` top-level entries reduced to:
   - `archive-freebsd-experiments`, `freebsd-bootstrap`, `release`

### Phase C: Bootstrap Pipeline Hardening

Goal: make cold-start script robust and deterministic on FreeBSD.

Status: **In progress** (major watcher milestone completed).

Phase C split:

1. **C-basic: completed** (deterministic bootstrap + idempotent rerun + compiler-switch rebuild succeeded).
2. **C-strict: in progress** (full no-fallback mode still blocked by stage0 runtime behavior).

Current C-strict status (2026-02-22):

1. `stage0` runtime preprocessing for `src/codegen/bundle-modules.ts` no longer stalls by default on FreeBSD.
   - `src/codegen/bundle-modules.ts` was adjusted so the FreeBSD tee-write compatibility path is opt-in (`BUN_FREEBSD_FORCE_TEE_WRITE=1`) instead of forced for all stage0 runs.
2. Legacy stage0 `bun build` remains the blocker for full no-fallback mode.
   - Repro: `${BUN_FREEBSD_BOOTSTRAP_DIR}/stage0/bun build <input.ts> --target bun --outdir <dir>` crashes with `SIGSEGV`.
   - `bundle-modules.ts` in no-fallback mode depends on this stage0 bundler path, so Phase C strict cannot exit yet.
3. Legacy stage0 subprocess APIs are also unstable on FreeBSD (`Bun.spawn`, `Bun.spawnSync`, `node:child_process.spawnSync` can crash), so script-level spawn fallbacks are not a complete workaround.
4. Legacy stage0 crash debugging work is tracked as replayable patch files under `scripts/patches/` (not as ad-hoc edits in the legacy worktree).

How to do it:

1. Keep `scripts/bootstrap-freebsd.sh` as the only supported entrypoint.
2. Run it from a cleaned workspace using canonical dirs.
3. Re-run without clearing caches to prove idempotence.
4. Re-run after Zig variant switch to prove cache fingerprint invalidation.
5. Record long Zig object compile expectation in docs/logs to avoid false hang diagnosis.

How to reproduce:

```bash
cd /home/lwhsu/killme/bun

export BUN_FREEBSD_BOOTSTRAP_DIR=/home/lwhsu/killme/bun/build/freebsd-bootstrap
export BUN_FREEBSD_BUILD_DIR=/home/lwhsu/killme/bun/build/release
export BUN_FREEBSD_CMAKE_BUILD_TYPE=Release
export BUN_FREEBSD_CURRENT_ZIG=/home/lwhsu/killme/bun/build/freebsd-bootstrap/oven-zig/build-freebsd/stage3/bin/zig

./scripts/bootstrap-freebsd.sh
./scripts/bootstrap-freebsd.sh
```

How to verify:

1. Script exits successfully on consecutive runs.
2. Stage0 path is deterministic:
   - `${BUN_FREEBSD_BOOTSTRAP_DIR}/stage0/bun`
3. Final binary exists at `${BUN_FREEBSD_BUILD_DIR}/bun`.
4. Stage0 runtime gate includes `import fs from "node:fs"` and must print `function` for `typeof fs.readFile`.
5. Stage0 runtime gate passes:
   - `${BUN_FREEBSD_BOOTSTRAP_DIR}/stage0/bun -e 'import fs from "node:fs"; console.log(typeof fs.readFile)'`
6. Note for reviewers: `zig build-obj` can take around 15 minutes with high CPU before finishing.

How to review:

1. Inspect `scripts/bootstrap-freebsd.sh` and patch list in `scripts/patches/`.
2. Confirm error paths are explicit (missing zig/webkit/patch failures).
3. Confirm cache fingerprint logic is still present and exercised.
4. Confirm legacy WebKit package reproducibility:
   - same commit metadata (`BUN_WEBKIT_VERSION`) is not sufficient by itself
   - compare archive fingerprints (`libJavaScriptCore.a`, `libWTF.a`) when behavior diverges.

Legacy patch tracking policy (required for reproducibility):

1. Treat `build/freebsd-bootstrap/legacy-worktree` as disposable.
2. Any intentional legacy source modification must be exported into `scripts/patches/freebsd-stage0-*.patch` immediately.
3. `scripts/bootstrap-freebsd.sh` must apply each patch idempotently via `apply_patch_if_needed()` with a guard condition.
4. Do not track generated legacy files (`*.lut.h`, `WebCoreJSBuiltins.*`, `ZigGeneratedClasses.*`) as patch artifacts.
5. Classify each legacy patch in notes/logs:
   - bootstrap-only compatibility patch
   - runtime correctness candidate to compare against current tree

Exit criteria:

1. Two consecutive runs succeed with no manual patching between runs.
2. A no-fallback configure/build run succeeds with:
   - `-DBUN_FREEBSD_BINDGENV2_NODE=0`
   - `-DBUN_FREEBSD_CODEGEN_NODE=0`
   - `-DBUN_FREEBSD_NPM_INSTALL=0`

2026-02-22 milestone evidence:

1. Run #1 completed with rebuilt final binary in `build/release/bun`.
2. Run #2 completed immediately after and reported:
   - `obj cached`
   - `compile obj bun ReleaseFast x86_64-freebsd cached 16ms`
3. Stage0 and final runtime smoke checks passed after run #2, including:
   - `stage0 bun -e 'import fs from "node:fs"; console.log(typeof fs.readFile)'` -> `function`.

### Phase D: Runtime and Platform Parity

Goal: move from bootstrap success to maintainable FreeBSD runtime support.

Status: **In progress (major gate slices passing)**.

How to do it:

1. Audit FreeBSD-specific changes by subsystem from `git diff`.
2. Classify each patch:
   - permanent platform support
   - temporary workaround to retire
3. Replace workaround logic with native FreeBSD behavior when possible.
4. Re-check spawn/kqueue/stdio behavior under targeted load.

How to reproduce:

```bash
cd /home/lwhsu/killme/bun
BASE=$(git merge-base origin/main HEAD)
git diff --name-status "$BASE"..HEAD | sed -n '1,240p'
```

How to verify:

1. No known deterministic deadlock remains in bootstrap-critical flows.
2. FreeBSD code paths use `OS(FREEBSD)` consistently where macro-based selection is required.
3. New runtime changes do not regress previously passing spawn/stdin flows.

How to review:

1. Review file groups by subsystem (spawn/event/fd/fs/shell).
2. Require a concrete repro command per fix.
3. Require a "why FreeBSD-specific" note for each conditional path.

Exit criteria:

1. Runtime-critical FreeBSD behavior is stable without known blockers.

### Phase E: Test Matrix for "Full Support"

Goal: define and execute a FreeBSD confidence gate before upstreaming.

Status: **In progress**.

Baseline commits for reproducibility (current local workspace snapshot):

1. Current worktree (full build / Phase D/E runtime validation):
   - `d3719dfedaaec39f33d8245d6a42f8ec6be5e711`
2. Canonical legacy worktree (stage0 cold-start bootstrap):
   - `8d7d58606bfe8e6cf7aa8fc65940436a4eb99ee5`

Latest checkpoint (2026-02-22):

1. `build/release/bun` smoke checks pass (`--version`, arithmetic, `node:fs` import).
2. Spawn and shell focused tests pass:
   - `test/js/bun/spawn/spawn.test.ts -t "Uint8Array works as stdin"` passed.
   - `test/js/bun/shell/shell-hang.test.ts` passed.
3. Watcher coverage milestone achieved:
   - `test/js/node/watch/fs.watch.test.ts` now passes on FreeBSD (`32 pass / 0 fail`).
4. Implementation notes for current watcher pass:
   - FreeBSD kqueue registration for `fs.watch` file/directory paths is fixed.
   - FreeBSD directory-event fallback rescans directories when kqueue provides no child names.
   - `fs.promises.watch()` async iterator race (lost wakeup) was fixed.
   - Current FreeBSD fallback includes a compatibility workaround (extra synthetic directory event per fallback entry) that should be revisited before upstreaming.
5. Next runtime blocker (post-watcher): resolved for current Phase E target.
   - `test/js/bun/spawn/spawn-stdin-readable-stream.test.ts` failure in `ReadableStream with large data` is fixed by `FileSink` pending-write accounting corrections.
   - Full file now passes (`20 pass / 1 todo / 0 fail`) on FreeBSD.
   - Residual follow-up (not currently in this Bun test file): ad hoc probe still shows a possible single-chunk `Uint8Array` 1 MiB truncation edge case; keep this as a runtime correctness follow-up item.
6. Expanded spawn coverage after FileSink fix:
   - `spawn-stdin-readable-stream.test.ts` passes (`20 pass / 1 todo / 0 fail`)
   - `spawn-stdin-readable-stream-edge-cases.test.ts` passes (`13 pass / 1 todo / 0 fail`)
   - `spawn-stdin-readable-stream-integration.test.ts` passes (`5 pass / 0 fail`)
   - `spawn.test.ts` passes (`108 pass / 5 skip / 0 fail`)
7. Node `fs` suite milestone achieved:
   - `test/js/node/fs/fs.test.ts` passes on FreeBSD (`234 pass / 6 skip / 0 fail`).
   - FreeBSD fixes included:
     - `copyFile`/`cp` fallback to read/write loop paths instead of Linux-only `copy_file_range`/`ioctl_ficlone` fast paths.
     - `mkdtemp(os.tmpdir())` prefix normalization (append separator when prefix is an existing directory path).
   - Current compatibility workaround:
     - `node:fs` / `node:fs/promises` `rmdir` normalize `EREMOTE` to `ENOTEMPTY` on FreeBSD in JS wrappers.
     - This is a temporary compatibility layer pending a proper FreeBSD errno table split (Bun currently aliases FreeBSD to Linux errno tables).
8. Node `process-stdio` broad slice passes on FreeBSD after `ReadableStream.text()` FreeBSD compatibility workaround:
   - `test/js/node/process/process-stdio.test.ts` => `9 pass / 0 fail`
   - Key finding: subprocess `stdout.bytes()` data is correct, but `TextDecoder.decode(bytes)` corrupts the first byte on affected FreeBSD outputs containing later Unicode text.
   - Current workaround: FreeBSD `ReadableStream.prototype.text()` decodes via `Buffer.from(bytes).toString()` instead of `TextDecoder`.
   - Follow-up: investigate/fix the underlying FreeBSD `TextDecoder` behavior and remove the workaround before upstreaming if possible.
   - Validation follow-up: `process-stdin.test.ts` also passes after mirroring stream cleanup (`stream.$reader = undefined` + `$readableStreamCloseIfPossible(stream)`) in the FreeBSD workaround path.
9. Node `child_process` broad slice passes on FreeBSD with controlled invocation:
   - `test/js/node/child_process/child_process.test.ts` => `30 pass / 1 todo / 0 fail`
   - Required invocation hygiene:
     - run from outside repo root (or otherwise avoid the repo-local `.env` file)
     - set `PATH` to include `build/release`
     - set `SHELL=/bin/sh` for clean-env runs
   - Notes:
     - earlier `spawn(..., { env })` failure was caused by Bun loading the repo `.env` (cwd-dependent), not by FreeBSD child_process runtime behavior.
10. Additional Node `child_process` slices also pass on FreeBSD (controlled invocation from `/tmp`):
   - `test/js/node/child_process/child-process-exec.test.ts` => `11 pass / 0 fail`
   - `test/js/node/child_process/child-process-stdio.test.js` => `5 pass / 0 fail`
11. Additional Node `process` and `stream` slices pass on FreeBSD:
   - `test/js/node/process/process-on.test.ts` => `3 pass / 0 fail`
   - `test/js/node/process/process-nexttick.test.js` => `7 pass / 0 fail`
   - `test/js/node/process/process-args.test.js` => `1 pass / 0 fail`
   - `test/js/node/process/stdin/stdin-fixtures.test.ts` => `5 pass / 0 fail`
   - `test/js/node/process/call-constructor.test.js` => `2 pass / 0 fail`
   - `test/js/node/process/dlopen-duplicate-load.test.ts` => `2 pass / 0 fail`
   - `test/js/node/process/dlopen-non-object-exports.test.ts` => `3 pass / 0 fail`
   - `test/js/node/stream/node-stream-uint8array.test.ts` => `5 pass / 0 fail`
   - `test/js/node/stream/node-stream.test.js` => `36 pass / 1 skip / 5 todo / 0 fail`
12. `test/js/node/process/process.test.js` remains blocked by missing local test dependency, not a confirmed FreeBSD runtime bug:
   - Top-level import requires `detect-libc`; if absent locally, the file aborts before tests execute.
   - `detect-libc` is declared in `test/package.json`.
   - Treat this as a test-environment setup blocker until test deps are installed for that slice.
13. FreeBSD errno and `node:os` parity improved substantially:
   - Added `src/errno/freebsd_errno.zig` and switched `src/sys.zig` to use it on FreeBSD.
   - `test/js/node/util/util.test.js` now passes (`192 pass / 0 fail`), including FreeBSD-specific `ENODATA` behavior:
     - `-9919 => ENODATA`
     - `-4024` remains unknown (matching Node on FreeBSD).
   - `test/js/node/os/os.test.js` now passes (`52 pass / 0 fail`) after:
     - FreeBSD `os.loadavg()` implementation via `getloadavg(3)`
     - FreeBSD `os.userInfo()` passwd fallback in clean env
     - FreeBSD `os.cpus()` implementation via `sysctl` (`hw.ncpu`, `hw.model`, `hw.clockrate`, `kern.cp_times`)
   - Test updates:
     - include `freebsd` / `FreeBSD` in `platform` / `type` expectations
     - allow passwd-based `userInfo()` values when `USER` / `SHELL` are unset in controlled runs
14. `node:dns` and `node:net` focused slices pass on FreeBSD:
   - `test/js/node/dns/node-dns.test.js` => `66 pass / 0 fail`
   - `test/js/node/net/node-net.test.ts` => `31 pass / 1 skip / 0 fail`
   - `test/js/node/net/node-net-server.test.ts` => `18 pass / 0 fail`
   - additional coverage:
     - `dns-lookup-keepalive.test.ts` => `1 pass / 0 fail`
     - `double-connect.test.ts` => `1 pass / 0 fail` (stale `.failing` marker removed)
     - `socketaddress.spec.ts` => `66 pass / 1 skip / 0 fail`
     - `node-net-allowHalfOpen.test.js` => `2 pass / 0 fail`
     - `server.spec.ts` => `38 pass / 3 skip / 0 fail`
     - `handle-leak.test.ts` stress run completes with stable RSS (non-standard "0 tests" summary but exits cleanly)
   - FreeBSD portability note:
     - client connect to `0.0.0.0` is not a valid remote destination on FreeBSD (Node on FreeBSD also fails)
     - tests were adjusted to preserve server bind assertions while using loopback for client connects / accepting FreeBSD wildcard-connect failure in the Bun-specific check
   - Test-harness note:
     - `socketaddress.spec.ts` uses `createTest()` from `node-harness`; its `expect` object lacks `.toThrowWithCode`, so invalid-family assertions were rewritten to explicit `try/catch` + `err.code` checks.
15. `node:http` focused slices pass on FreeBSD:
   - `client-timeout-error.test.ts` => `2 pass / 0 fail`
   - `numeric-header.test.ts` => `1 pass / 0 fail`
   - `node-http-parser.test.ts` => `9 pass / 0 fail`
   - `node-http-transfer-encoding.test.ts` => `1 pass / 0 fail`
   - `node-http-backpressure.test.ts` => `3 pass / 0 fail`
     - includes long `INT_MAX` / `>INT_MAX` backpressure cases (completed successfully on FreeBSD)
   - `node-http.test.ts` => `74 pass / 1 skip / 0 fail`
   - additional HTTP coverage passes:
     - `node-http-backpressure-max.test.ts` => `1 pass / 0 fail`
     - `node-http-primoridals.test.ts` => `1 pass / 0 fail`
     - `node-http-with-ws.test.ts` => `2 pass / 0 fail`
     - `node-fetch.test.js` => `11 pass / 0 fail`
     - `node-fetch-cjs.test.js` => `1 pass / 0 fail`
     - `node-fetch-primordials.test.ts` => `1 pass / 0 fail`
     - `node-http-proxy-url.test.ts` => pass (including compatibility checks spawning Node and Bun)
     - `node-http-maxHeaderSize.test.ts` => pass
   - local test dependency blockers (not yet treated as FreeBSD runtime regressions):
     - `node-http-connect.test.ts` compatibility subtests require package `proxy` (imported by `node-http-connect.node.mts`)
     - `node-http-uaf.test.ts` one fixture requires package `express` (`node-http-uaf-fixture.ts`)
     - both packages are declared in `test/package.json`, but not present in the current local test dependency setup

How to do it:

1. Run baseline smoke checks on stage0 and final.
2. Run focused spawn suite first (highest risk area from prior failures).
3. Run selected Node fs/watch and Bun shell tests (including `test/js/node/fs/fs.test.ts`).
4. Capture pass/fail and skips into `bun-bootstrap.md` with command lines.
5. Mark temporary compatibility workarounds explicitly (what is acceptable for local bootstrap vs. what must be refined before upstream).
6. Promote new blockers discovered during expanded slices into the Phase D/E priority list with isolation repro, and downgrade them once a reproducible fix is validated.

How to reproduce:

```bash
cd /home/lwhsu/killme/bun

build/release/bun --version
build/release/bun -e 'console.log(1+1)'
build/release/bun -e 'import fs from "node:fs"; console.log(typeof fs.readFile)'

build/release/bun test test/js/bun/spawn/spawn.test.ts
build/release/bun test test/js/bun/spawn/spawn-stdin-readable-stream.test.ts
build/release/bun test test/js/node/fs/fs.test.ts
build/release/bun test test/js/node/watch/fs.watch.test.ts
build/release/bun test test/js/bun/shell/shell-hang.test.ts
```

How to verify:

1. Smoke checks pass.
2. Spawn-focused tests pass without hangs.
3. fs/watch/shell selected tests pass or have documented, reproducible failure records.
4. If errno-compat shims are used (e.g., `rmdir`), they are documented with upstream follow-up scope.
4. Any temporary FreeBSD-only compatibility workaround is clearly identified and bounded.

How to review:

1. Confirm command list and outcomes are logged in `bun-bootstrap.md`.
2. Confirm no "silent skip" of known flaky or previously failing areas.
3. Confirm failures have root cause notes and next actions.

Exit criteria:

1. The gate command set is reproducible and stable on FreeBSD.
2. Remaining known gaps (if any) are isolated outside the gate or documented with specific next actions.

### Phase F: Upstream Patch Stack Preparation

Goal: convert large local delta into reviewable PR sequence.

Status: **Not started**.

How to do it:

1. Split branch changes into logical stacks:
   - build/cmake
   - bootstrap scripts
   - legacy stage0 patchset
   - runtime fixes
   - docs
2. For each stack, produce:
   - minimal diff
   - repro/verify commands
   - risk note
3. Keep each PR independently reviewable and bisectable.

How to reproduce:

```bash
cd /home/lwhsu/killme/bun
BASE=$(git merge-base origin/main HEAD)
git diff --name-status "$BASE"..HEAD
git log --oneline "$BASE"..HEAD
```

How to verify:

1. Each PR compiles independently.
2. Each PR includes a verification section in description/checklist.
3. Reviewers can apply/test without private local state.

How to review:

1. Check PR ordering and dependencies.
2. Check for accidental cross-phase coupling.
3. Check docs and scripts are aligned with code diff.

Exit criteria:

1. Patch stack is ready for upstream review in small, coherent PRs.

### Phase G: CI and Maintenance Path

Goal: prevent regressions after merge.

Status: **Not started**.

How to do it:

1. Define minimum FreeBSD CI workflow:
   - configure
   - bootstrap stage0
   - build final
   - smoke tests
2. Add CI docs and contributor command for local parity.
3. Add periodic verification for bootstrap path.

How to reproduce:

1. Use the same command set from Phase C and Phase E in CI runner scripts.

How to verify:

1. CI job runs on each relevant change.
2. Failures expose enough logs to reproduce locally.
3. FreeBSD regressions are caught before merge.

How to review:

1. Review CI script command parity with docs.
2. Review runtime/timeout settings for long Zig object emit stages.
3. Review retention of build artifacts and logs.

Exit criteria:

1. FreeBSD support is continuously validated, not manually polled.

## 4. Immediate Next Steps (Execution Order)

1. Resolve remaining out-of-workspace detached legacy worktrees in `/home/lwhsu/tmp` (Phase B closure).
2. Expand/record the Phase E gate beyond current passing slices (process/fs/watch/spawn coverage continues to improve; use controlled invocation to avoid repo `.env` contamination in compatibility checks).
3. Start Phase F patch-stack split (build/bootstrap/runtime/docs series), with the `rmdir` errno shim isolated for later replacement.

### Phase E progress update (2026-02-22, TLS)

Completed a substantial `node:tls` slice on `build/release/bun` using controlled `/tmp` invocation.

Passing coverage now includes:

1. `node-tls-connect`
2. `node-tls-server`
3. `node-tls-context`
4. `node-tls-cert`
5. `node-tls-create-secure-context-args`
6. `node-tls-no-cipher-match-error`
7. `node-tls-rootcertificates-immutable`
8. `node-tls-socket-allow-half-open-option`
9. `node-tls-upgrade`
10. `renegotiation`
11. `fetch-tls-cert` (pass/todo-only)
12. `test-node-extra-ca-certs`
13. `test-use-system-ca`

FreeBSD/runtime fixes added during this phase:

1. `src/js/node/net.ts`: do not emit `secureConnect` / run `checkServerIdentity()` when TLS handshake callback reports `success === false`; also ensure `connecting = false` before `secureConnect` in the second TLS handshake handler.
2. `src/bun.js/api/bun/socket/tls_socket_functions.zig`: `getPeerCertificate(true)` now falls back safely by trying `SSL_get_peer_certificate()` first, then chain access.

Tracked non-runtime blocker:

1. `test/js/node/tls/node-tls-internals.test.ts` currently fails in `build/release/bun` because `bun:internal-for-testing` is not exposed (`ENOENT reading "bun:internal-for-testing"`). Treat separately from FreeBSD TLS parity.

### Phase E progress update (2026-02-22, stream + zlib)

1. `node:stream` slice (`node-stream.test.js`, `node-stream-uint8array.test.ts`, `emit-readable-on-end.js`) passes with only upstream `todo`/`skip` cases.
2. `node:zlib` functional slice passes after fixing a Bun runtime compatibility bug in `src/js/node/zlib.ts`:
   - `zlib.kMaxLength.global.test.js` expects `require("node:buffer").kMaxLength` overrides to affect decompression max-output checks.
   - Bun previously cached `kMaxLength` at module-eval time in `node:zlib`, so preloading/order differences caused false passes (no `RangeError`) and test failures.
   - Fix: compute buffer max length dynamically in `ZlibBase` construction.
3. Post-fix `node:zlib` validation:
   - `zlib.kMaxLength.global.test.js` passes
   - broader functional zlib batch (`zlib.test.js`, `deflate-streaming`, `bytesWritten`, `zlib.kMaxLength.global`) passes

## 4.1 Clean Checkout Reproduction (Current Branch)

This is the current reproducible flow for a clean checkout of this branch.

### Prerequisites

1. Host: FreeBSD amd64.
2. Required packages:
   - `sudo pkg install -y cmake ninja gmake node npm perl python3 llvm19`
3. Zig:
   - legacy stage0 must use Zig 0.13.x at `/usr/local/bin/zig` (or set `BUN_FREEBSD_LEGACY_ZIG`)
   - current-tree zig can be system zig or oven-zig path (set `BUN_FREEBSD_CURRENT_ZIG`)
4. WebKit local clone:
   - `vendor/WebKit` must exist and contain required commits referenced by legacy/current trees.

### Setup from clean branch checkout

```bash
cd /home/lwhsu/killme
git clone <your-bun-remote> bun
cd /home/lwhsu/killme/bun
git fetch origin freebsd-bootstrap
git checkout freebsd-bootstrap
```

### Ensure WebKit repo is present locally

```bash
cd /home/lwhsu/killme/bun
rm -rf vendor/WebKit
git clone --filter=blob:none --no-checkout https://github.com/oven-sh/WebKit.git vendor/WebKit
```

Then ensure required commits exist in the local WebKit clone before bootstrap:

```bash
cd /home/lwhsu/killme/bun
CURRENT_WEBKIT_COMMIT=$(awk '/set\\(WEBKIT_VERSION [0-9a-f]{40}\\)/ {v=$2; gsub("\\\\)","",v); print v; exit}' cmake/tools/SetupWebKit.cmake)
git -C vendor/WebKit cat-file -e "${CURRENT_WEBKIT_COMMIT}^{commit}"
```

Legacy WebKit commit is resolved automatically by `scripts/bootstrap-freebsd.sh` from the legacy worktree CMake metadata.

### Run bootstrap (cold-start)

```bash
cd /home/lwhsu/killme/bun

export BUN_FREEBSD_ALLOW_DOWNLOADS=1
export BUN_FREEBSD_BOOTSTRAP_DIR=/home/lwhsu/killme/bun/build/freebsd-bootstrap
export BUN_FREEBSD_BUILD_DIR=/home/lwhsu/killme/bun/build/release
export BUN_FREEBSD_CMAKE_BUILD_TYPE=Release
export BUN_FREEBSD_CURRENT_ZIG=/home/lwhsu/killme/bun/build/freebsd-bootstrap/oven-zig/build-freebsd/stage3/bin/zig

./scripts/bootstrap-freebsd.sh
```

### Verify outputs

```bash
cd /home/lwhsu/killme/bun

build/freebsd-bootstrap/stage0/bun --version
build/freebsd-bootstrap/stage0/bun -e 'console.log(1+1)'
build/release/bun --version
build/release/bun -e 'console.log(1+1)'
build/release/bun -e 'import fs from "node:fs"; console.log(typeof fs.readFile)'
```

### Review checklist for clean-checkout bootstrap

1. `scripts/bootstrap-freebsd.sh` log shows legacy worktree creation, patch apply, codegen, and stage0 install.
2. Stage0 binary exists at `build/freebsd-bootstrap/stage0/bun`.
3. Final binary exists at `build/release/bun`.
4. If rerunning with different zig binary, script reports cache fingerprint reset.
5. If stage0 `node:fs` behavior differs across runs, compare WebKit package archive fingerprints:

```bash
sha256 -q build/freebsd-bootstrap/bun-webkit-legacy/lib/libJavaScriptCore.a
sha256 -q build/freebsd-bootstrap/bun-webkit-legacy/lib/libWTF.a
```

## 5. Definition of Done for This Porting Track

All items must hold simultaneously:

1. Fresh clone + documented prerequisites can bootstrap on FreeBSD without prebuilt Bun.
2. Stage0 and final binaries are reproducibly produced and runnable.
3. FreeBSD test gate passes, with tracked exceptions only.
4. Upstream patch series is minimal, documented, and review-ready.
5. Workspace state is tidy enough for handoff/migration without hidden dependencies.

## Appendix: Phase C-strict Legacy Stage0 Findings (2026-02-22)

### Context

- Goal of `C-strict`: run codegen/install steps without Node fallbacks:
  - `BUN_FREEBSD_BINDGENV2_NODE=0`
  - `BUN_FREEBSD_CODEGEN_NODE=0`
  - `BUN_FREEBSD_NPM_INSTALL=0`
- Current blocker is in legacy stage0 `bundle-modules.ts` execution on FreeBSD.

### Proven behavior and current workaround direction

1. Legacy stage0 `Bun.build(...)` works on FreeBSD for simple cases.
2. Multi-entry bundling can corrupt entrypoint paths on FreeBSD legacy stage0.
3. Single-entry (`BUN_FREEBSD_STAGE0_BUNDLER_BATCH_SIZE=1`) isolates failures deterministically.
4. A small subset of entrypoints still corrupt even in single-entry mode.
5. Those can be worked around by **bundler-time aliasing** (short temp basename only for the failing entrypoint), then remapping outputs back to canonical paths.

Why bundler-time aliasing instead of preprocess-time aliasing:
- Preprocess-time alias writes caused legacy stage0 hangs in the preprocessing loop.
- Bundler-time aliasing limits risk to one single-entry build invocation and is easier to audit.

### Current implementation notes (for reviewers)

- File: `src/codegen/bundle-modules.ts`
- Scope is explicitly limited to:
  - FreeBSD host
  - stage0 Bun (`Bun.version === "0.0.0"`)
- The workaround is heavily commented in-code with:
  - what legacy bug is being worked around
  - why `fs.copyFileSync()` is avoided on legacy FreeBSD stage0
  - why output remap tolerates two legacy output naming behaviors

### Confirmed failing entrypoints and aliases (iterative list)

- `internal/perf_hooks/monitorEventLoopDelay.ts` -> alias `29.ts`
- `internal/streams/end-of-stream.ts` -> alias `eos.ts`
- `internal/streams/lazy_transform.ts` -> alias `lazy.ts` (added; validate in next rerun)

### Repro command used for isolation

```bash
cd /home/lwhsu/killme/bun
BUN_FREEBSD_CODEGEN_TRACE=1 \
BUN_FREEBSD_STAGE0_BUNDLER_BATCH_SIZE=1 \
build/freebsd-bootstrap/stage0/bun --no-install run src/codegen/bundle-modules.ts --debug=OFF build/release
```

This is intentionally slow, but it gives deterministic evidence (`batchIndex`, `entrypoint0`) and is the best current path to finish `C-strict` while preserving a reviewable audit trail.
