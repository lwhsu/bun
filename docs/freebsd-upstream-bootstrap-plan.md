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
4. Replace or narrow the bootstrap-only FreeBSD stage0 `bake-codegen.ts` placeholder fallback.
   - Current behavior (replay path): writes placeholder `bake.*.js` artifacts and exits early on stage0.
   - Rationale: legacy stage0 still crashes in Bake runtime `Bun.build()` path during fresh replay validation.
   - Impact: acceptable for bootstrap replay proof, but should be revisited before upstreaming.
5. Review and downscope/remove FreeBSD-specific debug tracing hooks before upstreaming.
   - Currently used for diagnosis during Phase C/D/E:
     - `BUN_FREEBSD_SPAWN_TRACE` (`src/bun.js/api/bun/process.zig`, `src/bun.js/api/bun/subprocess.zig`, `src/shell/subproc.zig`, spawn bindings)
     - `BUN_FREEBSD_FILESINK_TRACE` (`src/bun.js/webcore/FileSink.zig`)
     - `BUN_FREEBSD_MODULE_TRACE` (`src/bun.js/bindings/ZigGlobalObject.cpp`)
   - Desired outcome:
     - either remove once no longer needed, or
     - convert to generic debug scopes/envs if broadly useful and acceptable upstream.

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
2. Current-tree configure/build fallback behavior is controlled by env toggles in `scripts/bootstrap-freebsd.sh`:
   - `BUN_FREEBSD_BINDGENV2_NODE`
   - `BUN_FREEBSD_GENERATE_CLASSES_NODE`
   - `BUN_FREEBSD_CODEGEN_NODE`
   - `BUN_FREEBSD_NPM_INSTALL`
3. Phase C-strict (`rerun26`) confirmed full no-fallback bootstrap works with:
   - `BUN_FREEBSD_BINDGENV2_NODE=0`
   - `BUN_FREEBSD_CODEGEN_NODE=0`
   - `BUN_FREEBSD_NPM_INSTALL=0`
4. Final binary is then built in `${BUN_FREEBSD_BUILD_DIR}`.

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

Status: **Completed** (strict no-fallback bootstrap succeeds on FreeBSD, and fresh replayability is validated).

Phase C split:

1. **C-basic: completed** (deterministic bootstrap + idempotent rerun + compiler-switch rebuild succeeded).
2. **C-strict: completed** (full no-fallback mode now succeeds with documented stage0 workarounds).
3. **C-replayability: completed** (fresh legacy worktree + replay patchset reproduces strict no-fallback bootstrap).

Current C-strict status (2026-02-23):

1. Full strict no-fallback bootstrap now succeeds end-to-end:
   - `BUN_FREEBSD_BINDGENV2_NODE=0`
   - `BUN_FREEBSD_CODEGEN_NODE=0`
   - `BUN_FREEBSD_NPM_INSTALL=0`
   - `./scripts/bootstrap-freebsd.sh`
2. Key blockers resolved to reach this point:
   - legacy stage0 package install cache move failures (`rename` / directory fallback)
   - `bundle-modules.ts` no-fallback stage0 bundler/runtime failures (alias/retry workarounds)
   - duplicate Ninja `bundle-modules.ts` teardown hang (skip duplicate after standalone pregen)
   - stage0 `bindgen.ts` generated `GeneratedBindings.{cpp,zig}` missing anonymous typedef coverage
3. Legacy stage0 crash debugging / compatibility work remains tracked as replayable patch files under
   `scripts/patches/` (not as ad-hoc edits in the legacy worktree).
4. Fresh replay validation (`phase-c-replay-rerun2.log`) now completes end-to-end from recreated legacy worktree.
5. Replay-specific bootstrap-only workaround currently used:
   - `src/codegen/bake-codegen.ts` writes placeholder Bake runtime artifacts on FreeBSD stage0 because
     legacy stage0 still crashes in the Bake runtime `Bun.build()` path.

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
7. Strict mode (Phase C exit gate) currently relies on documented FreeBSD stage0 workarounds in:
   - `scripts/bootstrap-freebsd.sh`
   - `src/codegen/bundle-modules.ts`
   - `src/codegen/bindgen.ts`
   - `src/codegen/bake-codegen.ts`
   - `src/codegen/create-hash-table.ts`

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

Status: **In progress (Phase E core gate green; workaround inventory/classification still pending)**.

Phase D action plan (current):

1. Build a current-tree FreeBSD workaround inventory by subsystem:
   - `spawn/stdio`
   - `watch/fs`
   - `codegen (current-tree stage0 bootstrap paths)`
   - `os/util/errno`
   - `networking/http` (only where FreeBSD-specific behavior exists)
2. Classify each item as one of:
   - `keep` (upstreamable platform support)
   - `temporary shim` (runtime compatibility workaround to replace later)
   - `bootstrap-only` (stage0 / strict-bootstrap survival workaround)
3. Attach a concrete repro/validation reference for each high-risk item (test file or command) so review is auditable.
4. Prioritize review of temporary shims that affect runtime semantics:
   - stdin/stdout pipe behavior
   - watcher synthetic fallback events
   - `ReadableStream.text()` fallback decode path
   - `node:fs` compatibility normalization shims
5. Keep legacy stage0 replay patches (`scripts/patches/freebsd-stage0-*.patch`) tracked separately from current-tree Phase D inventory.

How to do it:

1. Audit FreeBSD-specific changes by subsystem from `git diff`.
2. Classify each patch:
   - permanent platform support
   - temporary workaround to retire
3. Replace workaround logic with native FreeBSD behavior when possible.
4. Re-check spawn/kqueue/stdio behavior under targeted load.

Initial Phase D workaround inventory (high-priority first pass):

| Area | File(s) | Classification | Why / current status | Repro / verify reference |
|---|---|---|---|---|
| stdin->stdio pipe completion | `src/js/internal/streams/readable.ts` | `temporary shim` | FreeBSD-only compatibility path ends `process.stdout/stderr` for narrow `process.stdin.pipe(process.stdout|stderr)` case to avoid chunked stdin truncation on process exit. Behavior tradeoff vs Node no-end stdio rule. | `test/js/bun/spawn/spawn-stdin-readable-stream.test.ts`; `test/js/node/process/process-stdio.test.ts`; focused 16x64KB stdin->stdout repro |
| `ReadableStream.text()` decode path | `src/js/builtins/ReadableStream.ts` | `temporary shim` | FreeBSD path decodes via `Buffer.from(bytes).toString()` instead of `TextDecoder` due first-byte corruption observed in subprocess stdout text decoding. Needs root-cause fix in decoder path later. | `test/js/node/process/process-stdio.test.ts`; Unicode subprocess stdout repros logged in `bun-bootstrap.md` |
| watcher directory rescan fallback | `src/bun.js/node/path_watcher.zig` | `keep` + `temporary shim` | FreeBSD kqueue lacks child-name payloads for directory notifications, so rescan fallback is required (`keep`). Extra synthetic duplicate event is a compatibility workaround (`temporary shim`); timestamp spacing must exceed dedupe threshold. | `test/js/node/watch/fs.watch.test.ts` (`32 pass / 0 fail`) |
| `rmdir` errno normalization | `src/js/node/fs.ts`, `src/js/node/fs.promises.ts` | `temporary shim` | Maps FreeBSD `EREMOTE` to `ENOTEMPTY` for Node compatibility in `rmdir` paths. Should be replaced/narrowed once lower-level errno handling is aligned. | `test/js/node/fs/fs.test.ts` (`234 pass / 6 skip / 0 fail`) |
| FreeBSD errno table split | `src/errno/freebsd_errno.zig`, `src/sys.zig` | `keep` | Fundamental platform support: separate errno mapping and `getSystemErrorName` parity. | `test/js/node/util/util.test.js` (`192 pass / 0 fail`) |
| FreeBSD `node:os` parity | `src/bun.js/node/node_os.zig` | `keep` | Implements `os.loadavg()`, `os.userInfo()` fallback, `os.cpus()` via FreeBSD APIs/sysctl. | `test/js/node/os/os.test.js` (`52 pass / 0 fail`) |
| stage0 `bundle-modules` workarounds | `src/codegen/bundle-modules.ts` | `bootstrap-only` | Legacy FreeBSD stage0 bundler corruption/hang workarounds (aliasing, retries, hardlink path, teardown handling) for strict bootstrap/replay. Not runtime feature behavior. | strict bootstrap / replay logs in `bun-bootstrap.md`; `scripts/bootstrap-freebsd.sh` strict mode |
| stage0 builtin-functions workarounds | `src/codegen/bundle-functions.ts` | `bootstrap-only` | Legacy FreeBSD stage0 `tmp_functions` bundling retries/transpiler fallback/entrypoint corruption handling. | strict bootstrap / replay codegen logs |
| stage0 bake codegen fallback | `src/codegen/bake-codegen.ts` | `bootstrap-only` | Placeholder Bake runtime artifact fallback for stage0 replay (legacy stage0 crashes in Bake `Bun.build()` path). High-priority cleanup item before upstreaming. | fresh replay validation logs (`phase-c-replay-rerun2.log`) |
| stage0 hash-table generator workaround | `src/codegen/create-hash-table.ts` | `bootstrap-only` | Legacy stage0 process I/O bugs (`stdin` close / `await exited` hangs) worked around via temp files + polling. | strict bootstrap codegen runs; JSSink generation path |
| stage0 bindgen compatibility shims | `src/codegen/bindgen.ts` | `bootstrap-only` | Legacy stage0 bindgen metadata/name loss recovery for `.bind.ts` processing and generated alias shims. | strict bootstrap no-fallback (`BUN_FREEBSD_BINDGENV2_NODE=0`) |

Phase D inventory queue (next classification passes):

Use this queue to expand the initial table into a complete current-tree FreeBSD classification before Phase F.

1. Spawn / process / stdio internals (highest remaining runtime-risk cluster after current shims)
   - `src/bun.js/api/bun/process.zig`
   - `src/bun.js/api/bun/js_bun_spawn_bindings.zig`
   - `src/bun.js/api/bun/spawn.zig`
   - `src/bun.js/api/bun/subprocess.zig`
   - `src/shell/subproc.zig`
   - `src/bun.js/webcore/FileSink.zig`
   - `src/js/builtins/ReadableStream.ts`
   - `src/js/internal/streams/readable.ts`
2. Filesystem / watcher / copy paths
   - `src/Watcher.zig`
   - `src/bun.js/node/path_watcher.zig`
   - `src/bun.js/node/node_fs.zig`
   - `src/js/node/fs.ts`
   - `src/js/node/fs.promises.ts`
   - `src/bun.js/webcore/blob/copy_file.zig`
   - `src/http/SendFile.zig`
3. Platform parity support (mostly expected `keep`)
   - `src/sys.zig`
   - `src/errno/freebsd_errno.zig`
   - `src/bun.js/node/node_os.zig`
   - `src/js/node/os.ts`
   - `src/async/posix_event_loop.zig`
   - `src/workaround_missing_symbols.zig`
   - `src/perf.zig`
4. Current-tree stage0/bootstrap codegen paths (mostly `bootstrap-only`)
   - `src/codegen/bundle-modules.ts`
   - `src/codegen/bundle-functions.ts`
   - `src/codegen/bake-codegen.ts`
   - `src/codegen/create-hash-table.ts`
   - `src/codegen/bindgen.ts`
   - `scripts/bootstrap-freebsd.sh` (strict-mode orchestration toggles)
5. Lower-priority FreeBSD conditionals / support toggles (classify after core runtime clusters)
   - `src/Global.zig`
   - `src/feature_flags.zig`
   - `src/bun.zig`
   - `src/napi/napi.zig`
   - `src/allocators/MimallocArena.zig`
   - `src/bun.js/bindings/ZigGlobalObject.cpp`
   - `src/bun.js/webcore/encoding.zig`

Classification completion criteria for each pass:

1. Every file in the pass is tagged (`keep` / `temporary shim` / `bootstrap-only` / `mixed`)
2. `mixed` entries identify the exact sub-behavior that is temporary
3. At least one validation command or test reference is recorded for runtime-impacting entries

### Phase D Detailed Pass 1: Spawn / Process / Stdio Internals

Status: **Started (classification pass 1 completed for core files below)**.

Goal of this pass:

1. Separate fundamental FreeBSD process/spawn support (`keep`) from short-term runtime compatibility shims.
2. Isolate bootstrap/debug-only toggles so they do not get mixed with runtime parity work.
3. Record exact retest references before touching any of these paths again.

Detailed classification (current-tree):

| File | FreeBSD-specific behavior | Classification | Why / replacement target | Repro / verify |
|---|---|---|---|---|
| `src/bun.js/api/bun/spawn.zig` | Uses Bun `posix_spawn_bun` path on FreeBSD; FreeBSD-specific `wait4()` wrapper behavior | `keep` | Core POSIX spawn/wait platform support. Not a workaround; this is the real FreeBSD implementation path and should remain upstream. | `test/js/node/process/process-stdio.test.ts`; `test/js/node/process/process-stdin.test.ts`; `test/js/bun/spawn/spawn-stdin-readable-stream.test.ts` |
| `src/bun.js/api/bun/process.zig` | Defaults waiter thread on FreeBSD (`NOTE_EXIT` misses for short-lived children); `reapIfExitedNoHang()` helper; FreeBSD wait loop polling | `mixed` | `keep`: waiter-thread default + WNOHANG polling are platform reliability support. `temporary shim`: if later kqueue/EVFILT_PROC handling becomes reliable enough, the default/poll interval can be revisited for overhead. | High-churn spawn/process slices; `test/js/node/process/process-stdio.test.ts`; `test/js/node/process/process-stdin.test.ts`; broader `test/js/node/child_process` runs |
| `src/bun.js/api/bun/js_bun_spawn_bindings.zig` | FreeBSD post-setup `reapIfExitedNoHang()` probe to close watch-registration race for very short-lived children | `keep` | Narrow platform race mitigation tied to FreeBSD exit notification behavior. This is runtime correctness support, not bootstrap-only. | `test/js/node/process/process-stdio.test.ts`; `test/js/node/process/process-stdin.test.ts`; short-lived spawn repros in `bun-bootstrap.md` |
| `src/shell/subproc.zig` | FreeBSD post-spawn `reapIfExitedNoHang()` probe in shell subprocess path | `keep` | Same race class as JS spawn bindings, but for shell subprocesses. Runtime correctness support for short-lived shell commands. | Shell subprocess smoke / spawn coverage used during bootstrap and Phase E |
| `src/bun.js/api/bun/subprocess.zig` | `BUN_FREEBSD_SPAWN_TRACE` debug trace helper only | `temporary shim` (debug-only) | Debug instrumentation for FreeBSD spawn diagnosis. Keep locally while Phase D/E remains active; remove or gate behind generic debug tracing before upstreaming if not broadly useful. | `BUN_FREEBSD_SPAWN_TRACE=1` ad hoc repros |
| `src/bun.js/webcore/FileSink.zig` | FreeBSD flush/resolve ordering changes in `handleResolveStream()`; defer `stream.done()` signaling to `onClose()` on FreeBSD; env-gated trace helper | `mixed` | `keep`: pending-write accounting fixes and ordering correctness if validated as general bugfix. `temporary shim`: FreeBSD-specific completion ordering and trace hooks until child-side stdin path root cause is fully resolved/confirmed. Revisit after broader stdin/pipe parity confidence. | `test/js/bun/spawn/spawn-stdin-readable-stream.test.ts`; focused 16x64KB stdin->stdout repro; `BUN_FREEBSD_FILESINK_TRACE=1` instrumentation repro |
| `src/js/builtins/ReadableStream.ts` | FreeBSD `ReadableStream.text()` fallback decodes via `Buffer.from(bytes).toString()` instead of native `TextDecoder`/fast path | `temporary shim` | Verified runtime compatibility workaround for first-byte corruption in subprocess stdout `.text()`. Replace after root-causing `TextDecoder`/decode-path corruption on FreeBSD. | `test/js/node/process/process-stdio.test.ts`; Unicode stdout repros in `bun-bootstrap.md` |
| `src/js/internal/streams/readable.ts` | FreeBSD `process.stdin.pipe(process.stdout|stderr)` flush-barrier path calls `dest.end()` for narrow stdio relay case | `temporary shim` | Compatibility workaround to avoid stdin truncation at process exit. Behavior tradeoff vs Node stdio end semantics; replace after child-side stdin/stdio pipeline root cause is fixed. | `test/js/bun/spawn/spawn-stdin-readable-stream.test.ts`; focused stdin->stdout chunked relay repro |

Pass 1 notes / conclusions:

1. The highest-risk runtime shims in this cluster remain JS-side:
   - `ReadableStream.text()` decode fallback (`src/js/builtins/ReadableStream.ts`)
   - stdio flush-barrier in `Readable.prototype.pipe()` (`src/js/internal/streams/readable.ts`)
2. The FreeBSD `reapIfExitedNoHang()` probes and waiter-thread default are currently classified as runtime platform support (`keep` / `mixed keep-dominant`) because they address real short-lived child exit races and have broad coverage evidence.
3. Debug tracing helpers (`BUN_FREEBSD_SPAWN_TRACE`, `BUN_FREEBSD_FILESINK_TRACE`) should remain available during Phase D/E, but should be explicitly reviewed in the pre-upstream cleanup queue.

Pass 1 completion check:

1. All files listed in queue item 1 are now classified at a file level.
2. Runtime-impacting entries have test/repro references.
3. `mixed` entries identify the temporary sub-behavior to revisit.

### Phase D Detailed Pass 2: Filesystem / Watcher / Copy Paths

Status: **Started (classification pass 2 completed for core files below)**.

Goal of this pass:

1. Separate required FreeBSD kqueue/fs/copy platform support from temporary compatibility shims.
2. Isolate Zig-version/compiler-workaround paths inside `node_fs` from long-term runtime design decisions.
3. Record exact fs/watch/copy validation references before cleanup/replacement.

Detailed classification (current-tree):

| File | FreeBSD-specific behavior | Classification | Why / replacement target | Repro / verify |
|---|---|---|---|---|
| `src/Watcher.zig` | kqueue registration and fd-open handling extended to FreeBSD alongside macOS | `keep` | Fundamental watcher backend platform support (kqueue-based file/dir registration paths). This is required FreeBSD support, not a workaround. | `test/js/node/watch/fs.watch.test.ts`; FreeBSD watcher smoke/repros in `bun-bootstrap.md` |
| `src/bun.js/node/path_watcher.zig` | FreeBSD kqueue directory rescan fallback when event payload lacks names; synthetic duplicate event for higher-level consumer compatibility | `mixed` | `keep`: directory rescan fallback is required because FreeBSD kqueue directory notifications do not provide child-name/op granularity. `temporary shim`: extra synthetic duplicate event (with timestamp spacing) is a compatibility workaround to avoid starvation in `fs.promises.watch`; should be revisited with a more principled event synthesis model. | `test/js/node/watch/fs.watch.test.ts` (`32 pass / 0 fail`) |
| `src/bun.js/node/node_fs.zig` | FreeBSD copy/cp read-write fallback paths; FreeBSD `rmdir` ENOTEMPTY normalization; several FreeBSD+Zig 0.13 release-build readFile/readFileSync workarounds | `mixed` | `keep`: FreeBSD copy/cp read-write fallback and low-level `rmdir` normalization are runtime support. `temporary shim`: Zig 0.13/FreeBSD release-build miscompile workarounds in readFile/readFileSync fast-path/ArrayList/string return handling should be reevaluated when compiler baseline changes or root cause is fixed. | `test/js/node/fs/fs.test.ts` (`234 pass / 6 skip / 0 fail`); targeted `mkdtemp`, `cp`, `rmdir` repros logged in `bun-bootstrap.md` |
| `src/js/node/fs.ts` | JS-level `EREMOTE` -> `ENOTEMPTY` normalization for `rmdir` callback/sync paths | `temporary shim` | Compatibility shim compensating for incorrect errno serialization in lower layers. Target is to remove/narrow after errno/path-level mapping is fully aligned so JS wrapper shim is unnecessary. | `test/js/node/fs/fs.test.ts` (`rmdir` cases) |
| `src/js/node/fs.promises.ts` | JS-level `EREMOTE` -> `ENOTEMPTY` normalization for promises `rmdir` | `temporary shim` | Same shim class as `src/js/node/fs.ts`; should disappear once lower-level errno mapping consistently yields `ENOTEMPTY`. | `test/js/node/fs/fs.test.ts` (`promises.rmdir` cases) |
| `src/bun.js/webcore/blob/copy_file.zig` | FreeBSD copy path uses `NodeFS.copyFileUsingReadWriteLoop(...)` instead of unsupported Linux fast paths | `keep` (performance-followup) | Correct functional FreeBSD implementation for blob/file copy path. This may be less optimized than future native FreeBSD fast paths, but it is not a semantic workaround. | `test/js/node/fs/fs.test.ts`; copy/cp code paths exercised during install/package-manager tests |
| `src/http/SendFile.zig` | FreeBSD-specific `sendfile(2)` call signature/errno handling in POSIX sendfile path | `keep` | Required API/signature/platform support. This is the correct FreeBSD `sendfile` integration, not a temporary workaround. | HTTP file-send flows; `node:http`/`http2` coverage and HTTP smoke tests |

Pass 2 notes / conclusions:

1. The highest-risk temporary shims in this cluster are:
   - `path_watcher.zig` synthetic duplicate event emission (behavior workaround)
   - JS-level `rmdir` errno normalization in `src/js/node/fs.ts` and `src/js/node/fs.promises.ts`
   - `node_fs.zig` Zig 0.13/FreeBSD release-build readFile/readFileSync workarounds
2. Watcher and copy/sendfile backend support itself is now clearly classified as `keep` and should not be conflated with the temporary compatibility layers above it.
3. `node_fs.zig` should be split into sub-items during cleanup review:
   - runtime support (`copy`, `rmdir`)
   - compiler-specific temporary workarounds (`readFile*`)

Pass 2 completion check:

1. All files listed in queue item 2 are now classified at a file level.
2. `mixed` entries identify the temporary sub-behaviors (`path_watcher`, `node_fs`).
3. Runtime-impacting entries include fs/watch/copy validation references.

### Phase D Detailed Pass 3: Platform Parity Support (`sys` / `errno` / `os` / event loop)

Status: **Started (classification pass 3 completed for core files below)**.

Goal of this pass:

1. Confirm the foundational FreeBSD platform support changes are clearly classified as long-term `keep`.
2. Split out any temporary platform-adaptation choices (especially event-loop wake path decisions) from permanent support.
3. Tie platform support entries to parity tests already passing (`util`, `os`, process/runtime slices).

Detailed classification (current-tree):

| File | FreeBSD-specific behavior | Classification | Why / replacement target | Repro / verify |
|---|---|---|---|---|
| `src/errno/freebsd_errno.zig` | Dedicated FreeBSD errno table + libuv errno aliases (including `ENODATA`/`UV_E.NODATA`) | `keep` | Fundamental platform parity support. Required for correct errno names/codes and Node/libuv compatibility behavior on FreeBSD. | `test/js/node/util/util.test.js` (`192 pass / 0 fail`) |
| `src/sys.zig` | FreeBSD platform defs import; libc/syscall selection; FreeBSD-specific flags/types/syscall signatures (`fstatat`, `mkdir`, `pread/pwrite`, `writev` iovcnt types, etc.) | `keep` | Core cross-platform syscall layer support. These are required ABI/signature differences and should remain upstream. | Broad runtime coverage; `util`, `fs`, `os`, `process`, install paths exercised throughout Phase D/E |
| `src/bun.js/node/node_os.zig` | FreeBSD implementations for `os.cpus()`, `os.release()`, `os.version()`, `os.loadavg()`, `os.userInfo()`, `os.totalmem()`, `os.uptime()` and FreeBSD network interface layout support | `keep` | Core Node `os` parity implementation for FreeBSD. Not a temporary workaround. | `test/js/node/os/os.test.js` (`52 pass / 0 fail`) |
| `src/js/node/os.ts` | `os.type()` returns `\"FreeBSD\"` when `process.platform === \"freebsd\"` | `keep` | User-visible Node API parity; straightforward permanent platform support. | `test/js/node/os/os.test.js` |
| `src/workaround_missing_symbols.zig` | FreeBSD symbol bindings (`stat`, `lstat`, `fstat`, `memmem`) via `current = freebsd` selection | `keep` | Platform glue for symbol availability/signatures. This is foundational support, not a bootstrap shim. | Indirectly exercised by broad fs/runtime coverage |
| `src/perf.zig` | Explicitly disables Linux perf path on FreeBSD (`Environment.isLinux and !isFreeBSD`) | `mixed` (keep-dominant) | `keep`: correct to avoid Linux perf backend on FreeBSD. `temporary`/future follow-up: perf tracing on FreeBSD is intentionally disabled pending native implementation (not a regression blocker, but a pre-upstream capability gap to track). | Runtime smoke (no crashes when perf tracing disabled); no dedicated FreeBSD perf parity test yet |
| `src/async/posix_event_loop.zig` | FreeBSD kqueue event type/layout support and flags handling; temporary FreeBSD waker selection uses `LinuxWaker`/eventfd path instead of native kqueue user-event waker | `mixed` | `keep`: FreeBSD kqueue event-loop integration and event flag handling. `temporary shim`: documented FreeBSD waker path keeps eventfd-based wake mechanism until a native kqueue user-event waker (`KEventWaker` equivalent) is implemented. | Broad runtime/test coverage; spawn/process/watch/http slices; event-loop behavior exercised throughout bootstrap + Phase E |

Pass 3 notes / conclusions:

1. This cluster is mostly long-term `keep` support, which is the expected outcome.
2. The only notable temporary design choice here is `posix_event_loop.zig` waker selection on FreeBSD (`LinuxWaker` path), which is already documented in-code as temporary.
3. `perf.zig` is functionally correct (`keep` to avoid wrong backend), but should remain in the pre-upstream cleanup/capability-tracking queue as a disabled-on-FreeBSD subsystem.

Pass 3 completion check:

1. All files listed in queue item 3 are now classified at a file level.
2. `mixed` entries identify the temporary sub-behaviors (`posix_event_loop` waker path, `perf` backend disabled state).
3. Runtime-impacting entries include parity test references (`util`, `os`) or broader subsystem coverage references.

### Phase D Detailed Pass 4: Current-Tree Stage0 / Bootstrap Codegen Paths

Status: **Started (classification pass 4 completed for core files below)**.

Goal of this pass:

1. Explicitly separate strict-bootstrap survival logic from runtime/platform parity work.
2. Identify any `mixed` codegen files where a FreeBSD change affects normal (non-stage0) generated outputs.
3. Tie every bootstrap-only workaround to strict bootstrap / replay validation evidence.

Detailed classification (current-tree):

| File | FreeBSD-specific behavior | Classification | Why / replacement target | Repro / verify |
|---|---|---|---|---|
| `scripts/bootstrap-freebsd.sh` | FreeBSD bootstrap orchestration, legacy patch replay, strict no-fallback toggles, standalone pregen sequencing, strict-build serialization, replay controls | `bootstrap-only` | Bootstrap entrypoint and replay mechanism only. Not part of runtime semantics. Keep as local/bootstrap tooling until upstream split. | Strict no-fallback bootstrap (`BUN_FREEBSD_*_NODE=0`) and fresh replay validation logs in `bun-bootstrap.md` |
| `src/codegen/create-hash-table.ts` | FreeBSD legacy stage0 process-I/O workarounds (temp files, shell redirection, exitCode polling) for Perl helper invocation | `bootstrap-only` | Compensates for legacy stage0 spawn/stdin/exit hangs. Should be removed once stage0 path is no longer required / legacy stage0 bugs are no longer in the bootstrap path. | Strict no-fallback codegen (`generate-jssink` / hash-table generation) logs and isolated repros in `bun-bootstrap.md` |
| `src/codegen/bindgen.ts` | FreeBSD legacy stage0 bindgen recovery for unnamed `fn()` exports / missing `TypeImpl` metadata and alias shims in generated bindings | `bootstrap-only` | Legacy stage0 bindgen/module-loading compatibility path to keep strict bootstrap progressing. Does not represent desired steady-state bindgen behavior. | Strict no-fallback bootstrap and replay validation (`BUN_FREEBSD_BINDGENV2_NODE=0`) |
| `src/codegen/bundle-functions.ts` | FreeBSD legacy stage0 tmp_functions entrypoint-corruption retries, aliasing, transpiler fallback, define compat for transpiler path | `bootstrap-only` | Tmp builtins bundling survival path for legacy stage0 instability/corruption. Intended to be retired with stage0 workaround reduction. | Strict bootstrap / replay codegen logs; `bundle-functions:done` milestones in `bun-bootstrap.md` |
| `src/codegen/bake-codegen.ts` | FreeBSD legacy stage0 alias/retry/transpiler paths and bootstrap placeholder Bake artifact fallback; teardown `reallyExit` workaround | `bootstrap-only` | Explicitly bootstrap-only fallback for stage0 replay due Bake `Bun.build()` crashes on legacy stage0. Must be reduced/replaced before upstreaming. | Fresh strict replay validation (`phase-c-replay-rerun2.log`) and Phase C replay milestone in `bun-bootstrap.md` |
| `src/codegen/bundle-modules.ts` | Large FreeBSD stage0 alias/retry/hardlink/remap/teardown and duplicate-invocation workarounds; strict stage0 tracing controls; stage0-only exit handling | `mixed` | `bootstrap-only`: the majority of FreeBSD stage0 alias/retry/teardown logic. `keep`/non-stage0 codegen behavior: FreeBSD self-host `forceCJSFormat` path and generic postbuild normalization fix that corrected malformed alias-shaped multi-line default export stubs (e.g. `internal:url`) in generated builtin modules. | Strict no-fallback bootstrap and replay logs; postbuild `internal:url` baseline rebuild verification; Phase E baseline rebuild notes in `bun-bootstrap.md` |

Pass 4 notes / conclusions:

1. This cluster is overwhelmingly `bootstrap-only`, which confirms it should stay isolated from runtime parity cleanup and Phase F upstream-splitting should keep these patches grouped.
2. `src/codegen/bundle-modules.ts` is the only `mixed` file in this pass:
   - most changes are stage0 bootstrap survival workarounds
   - at least one fix (postbuild export-stub normalization) affected generated runtime modules in the normal build pipeline and should be reviewed separately from stage0-only logic
3. `src/codegen/bake-codegen.ts` placeholder artifact fallback remains one of the highest-priority pre-upstream cleanup items even though Phase C replayability is now proven.

Pass 4 completion check:

1. All files listed in queue item 4 are now classified at a file level.
2. The only `mixed` entry (`bundle-modules.ts`) is split into bootstrap-only vs non-stage0 codegen behavior.
3. All entries include strict bootstrap / replay validation references.

### Phase D Detailed Pass 5: Lower-Priority FreeBSD Conditionals / Support Toggles

Status: **Started (classification pass 5 completed for remaining queue files below)**.

Goal of this pass:

1. Close the Phase D inventory queue coverage by classifying lower-priority FreeBSD conditionals.
2. Identify which of these are harmless/expected platform support vs temporary debug or workaround code.
3. Promote any unexpectedly risky item back into the higher-priority cleanup list.

Detailed classification (current-tree):

| File | FreeBSD-specific behavior | Classification | Why / replacement target | Repro / verify |
|---|---|---|---|---|
| `src/Global.zig` | FreeBSD-specific debug allocator `deinit()` assert relaxation; FreeBSD exit path uses `std.c.exit()` branch instead of Linux `quick_exit` path | `mixed` | `keep`: FreeBSD process-exit path using libc `exit` is platform support. `temporary shim`: debug allocator assert relaxation on FreeBSD should be revisited if allocator/runtime shutdown ordering is fixed. | Broad runtime smoke/tests; crash/exit handling exercised during bootstrap + test runs |
| `src/feature_flags.zig` | `use_simdutf = ... && !isFreeBSD` | `mixed` (capability gate) | Correctly disables unsupported/unverified SIMDUTF path on FreeBSD today, but this is a capability gap to revisit (likely becomes `keep` once SIMDUTF path is validated on FreeBSD). | Build/runtime smoke; Unicode/string decoding paths; Phase E process/text decoding investigations |
| `src/bun.zig` | FreeBSD-specific reload-process branch avoids Linux pre-reload hook; FreeBSD `statfs` type and monotonic clock handling | `keep` | Core platform support / API differences. These are not bootstrap hacks. | Broad runtime coverage; process reload/shell/process operations and time APIs |
| `src/napi/napi.zig` | Treats FreeBSD with macOS for POSIX V8 mangled-name variant selection | `keep` | Platform ABI/name compatibility glue for N-API/V8 symbol declarations. | N-API build/link/runtime coverage (indirect) |
| `src/allocators/MimallocArena.zig` | FreeBSD debug path skips `mi_is_in_heap_region()` assertion and uses `mi_free()` directly | `temporary shim` | Debug-only allocator compatibility/workaround on FreeBSD. Should be reviewed against mimalloc behavior/version and narrowed or removed if assert path can be made safe. | Debug builds / allocator stress; no dedicated Phase E test currently |
| `src/bun.js/bindings/ZigGlobalObject.cpp` | `BUN_FREEBSD_MODULE_TRACE` env-gated module trace logging for FreeBSD | `temporary shim` (debug-only) | Diagnostic instrumentation added for FreeBSD module-loading debugging. Keep only while actively needed; likely remove or convert to generic debug tracing before upstream. | `BUN_FREEBSD_MODULE_TRACE=1` ad hoc module-load repros |
| `src/bun.js/webcore/encoding.zig` | FreeBSD-owned-buffer fallback copies when creating `bun.String` from converted UTF16/Latin1 buffers | `temporary shim` | FreeBSD runtime correctness workaround in encoding/string ownership path (avoids problematic external-buffer path). Needs root-cause fix/validation before upstream cleanup. | Process/stdout text decoding regressions and Unicode repros; `test/js/node/process/process-stdio.test.ts` |

Pass 5 notes / conclusions:

1. Phase D inventory queue coverage is now complete across all queued subsystems/files.
2. Remaining lower-priority temporary items cluster into three categories:
   - debug instrumentation (`ZigGlobalObject.cpp`, tracing env hooks)
   - capability gating (`feature_flags.zig` SIMDUTF disabled on FreeBSD)
   - runtime/debug allocator/encoding workarounds (`MimallocArena.zig`, `encoding.zig`, part of `Global.zig`)
3. `src/bun.js/webcore/encoding.zig` should be treated as a higher-priority temporary runtime shim than the rest of this pass because it intersects with the earlier `ReadableStream.text()`/Unicode debugging path.

Pass 5 completion check:

1. All files listed in queue item 5 are now classified at a file level.
2. Temporary/debug-only entries are explicitly identified and cross-linked to the pre-upstream cleanup queue.
3. Phase D inventory queue coverage is complete.

### Phase D Cleanup Prioritization (Post-Inventory)

Status: **Started (initial ranking + replacement/removal criteria documented)**.

Purpose:

1. Convert the Phase D inventory from classification into an execution order.
2. Identify which temporary shims are most likely to block upstream review or hide real runtime defects.
3. Distinguish:
   - must-reduce before Phase F (upstream patch split),
   - can remain temporarily with strong documentation,
   - bootstrap-only items that should stay isolated.

Ranking criteria (used for this branch):

1. Runtime semantic risk (does it intentionally change user-visible behavior?)
2. Breadth of impact (how many subsystems/tests rely on the path?)
3. Upstream review friction (hard to justify as permanent?)
4. Availability of a concrete replacement target/repro
5. Whether the workaround is bootstrap-only (lower priority for runtime hardening)

Prioritized cleanup list (temporary shims + `mixed` sub-behaviors):

| Priority | Item | File(s) | Type | Current status / risk | Replacement target | Removal / downgrade condition |
|---|---|---|---|---|---|---|
| P0 | `ReadableStream.text()` FreeBSD Buffer decode fallback | `src/js/builtins/ReadableStream.ts` | `temporary shim` | High runtime semantic risk; masks underlying decode-path/TextDecoder corruption on subprocess stdout buffers. Impacts general `.text()` behavior and is difficult to upstream as-is. | Root-cause and fix the FreeBSD decode corruption in native/text decoding path (likely `TextDecoder`/buffer ownership/encoding path). Then restore normal fast-path behavior. | Unicode subprocess stdout repros and `test/js/node/process/process-stdio.test.ts` pass with fallback removed. |
| P0 | stdin->stdio flush-barrier (`dest.end()`) in `Readable.prototype.pipe()` | `src/js/internal/streams/readable.ts` | `temporary shim` | High runtime semantic risk; explicitly trades off Node stdio-end semantics for reliability in a narrow path. Broadly visible if user code pipes `process.stdin` to stdio. | Fix child-side stdin/stdio pipeline completion/exit ordering so chunked writes are not truncated without ending stdio. Remove special-case branch. | Focused stdin->stdout chunked repro passes without special-case `dest.end()`, and `spawn-stdin-readable-stream` suite remains green. |
| P0 | FreeBSD encoding owned-buffer copy workaround | `src/bun.js/webcore/encoding.zig` | `temporary shim` | Runtime correctness workaround intersects with prior Unicode/text corruption investigations. Likely related to broader string ownership/decoding behavior. | Identify ownership/lifetime issue in external string creation path; restore external-buffer path or a principled FreeBSD-safe equivalent. | Process/unicode decoding repros pass with workaround removed or reduced; no regressions in process/text slices. |
| P1 | `FileSink` FreeBSD completion-order workaround (`stream.done()` defer) | `src/bun.js/webcore/FileSink.zig` | `mixed` sub-behavior | Cleanup in progress: FreeBSD-only defer branch has been removed on this branch and targeted tests are green; continue watching for regressions while the higher-level stdio flush-barrier shim still exists. | Keep generic pending-write accounting fixes; validate the shared completion path under broader coverage, then downgrade/remove remaining FreeBSD-specific `FileSink` behavior/debug hooks. | `spawn-stdin-readable-stream`, `process-stdio`, and `process-stdin` remain green after removing the FreeBSD-only defer branch. |
| P1 | watcher synthetic duplicate event workaround | `src/bun.js/node/path_watcher.zig` | `mixed` sub-behavior | Medium risk; synthetic duplicate event intentionally shapes higher-level behavior and may produce extra notifications. Cleanup attempt on current branch regressed `fs.promises.watch` timeout, so the workaround remains required. | Improve FreeBSD directory fallback event synthesis / consumer readiness so one synthetic event is sufficient, or model explicit create/remove reconciliation more precisely. | `fs.watch.test.ts` remains green without duplicate synthetic event emission. |
| P1 | JS `rmdir` errno normalization (`EREMOTE -> ENOTEMPTY`) | `src/js/node/fs.ts`, `src/js/node/fs.promises.ts` | `temporary shim` | Cleanup completed on current branch: JS shims removed after confirming lower layers already return `ENOTEMPTY` for sync/callback/promise `rmdir` paths. | Keep lower-layer normalization (currently in `node_fs.zig`) or replace with more principled errno serialization once the FreeBSD errno path is fully cleaned up. | `fs.test.ts` `rmdir` cases pass after removing JS shims. |
| P1 | `node_fs.zig` FreeBSD + Zig 0.13 readFile* compiler workarounds | `src/bun.js/node/node_fs.zig` | `mixed` sub-behavior | Cleanup in progress: small-file pre-stat fast-path disable has been removed and validated on current baseline; other FreeBSD readFile branches remain under review. | Re-test remaining branches on supported compiler baseline (current/Oven Zig path) and reduce/remove workarounds that no longer reproduce. | `fs.test.ts` + targeted small-file `readFileSync` string paths pass with each reduction step. |
| P2 | FreeBSD waiter-thread default / polling interval tuning | `src/bun.js/api/bun/process.zig` | `mixed` sub-behavior (keep-dominant) | Low-medium risk; current behavior addresses real exit-race reliability and is likely acceptable. Main concern is overhead/tuning, not correctness regression. | Optional: revisit if native kqueue NOTE_EXIT handling proves reliable enough under stress. | High-churn spawn/child_process stress remains reliable with changed/default strategy (if revisited). |
| P2 | FreeBSD event loop waker uses `LinuxWaker`/eventfd path | `src/async/posix_event_loop.zig` | `mixed` sub-behavior | Low runtime risk relative to P0/P1, but architectural cleanup item. In-code marked temporary. | Implement native kqueue user-event waker for FreeBSD (`KEventWaker` equivalent) and retire eventfd-based path. | Event-loop regression tests/smokes remain green with native FreeBSD waker. |
| P2 | `feature_flags.zig` SIMDUTF disabled on FreeBSD | `src/feature_flags.zig` | `mixed` capability gate | Low correctness risk; conservative capability disable. Review friction is “why disabled?” more than runtime bug risk. | Validate SIMDUTF path on FreeBSD toolchains/ABI and enable if safe. | Bench/tests and correctness checks pass with `use_simdutf` enabled on FreeBSD. |
| P2 | Debug allocator assert relaxations | `src/Global.zig`, `src/allocators/MimallocArena.zig` | `temporary shim` / `mixed` sub-behavior | Debug-only paths; low production risk but cleanup-worthy before upstream. | Reconcile allocator shutdown/assert behavior with FreeBSD+mimalloc and restore assertions where valid. | Debug builds/stress runs pass with assertions restored or narrowed. |
| P3 | FreeBSD-specific debug trace hooks | `src/bun.js/api/bun/process.zig`, `src/bun.js/api/bun/subprocess.zig`, `src/shell/subproc.zig`, `src/bun.js/webcore/FileSink.zig`, `src/bun.js/bindings/ZigGlobalObject.cpp` | `temporary shim` (debug-only) | Low runtime risk, high review-noise risk. Useful for local diagnosis but should not ship as-is unless generalized. | Remove after D/E stabilization or convert to generic debug scopes/envs. | No active blocker requires them; equivalent diagnostics available through generic logging/debug scopes. |
| P3 | Bootstrap-only codegen/stage0 workarounds | `scripts/bootstrap-freebsd.sh`, `src/codegen/*` stage0-specific branches | `bootstrap-only` / `mixed` (`bundle-modules.ts`) | Not runtime parity blockers. Important for replayability, but can be isolated and reviewed separately in Phase F. | Keep isolated; reduce only pre-upstream placeholders/high-friction items (e.g. `bake-codegen.ts` placeholder fallback) unless they interfere with runtime work. | Phase F patch split cleanly isolates bootstrap-only changes; pre-upstream cleanup queue items addressed/documented. |

Execution guidance after ranking:

1. Start with one P0 item and keep the Phase E core gate as the regression floor.
2. Prefer fixes that reduce multiple shims at once (e.g. if `encoding.zig` root cause resolves `ReadableStream.text()` fallback).
3. Defer P2/P3 items unless they block reviewability or mask active runtime issues.

Recommended next cleanup target (current branch evidence):

1. `src/bun.js/webcore/encoding.zig` + `src/js/builtins/ReadableStream.ts` pair (investigate together)
   - Reason: both relate to the same Unicode/text-decoding symptom cluster and may share root cause.

#### P0-1 Progress Update: TextDecoder / `ReadableStream.text()` Unicode corruption

Status: **Resolved on current branch (native fix landed; JS fallback removed)**.

What was fixed:

1. Root cause was not the `ReadableStream` JS path itself and not the `encoding.zig` ownership workaround.
2. The actual bug was in `src/string/immutable/unicode.zig`:
   - `toUTF16AllocMaybeBuffered(...)` initialized its scan loop with `non_ascii = 0`
   - when a UTF-8 string started with ASCII and later contained non-ASCII, the decoder incorrectly treated byte 0 as a non-ASCII sequence
   - result: first character became `U+FFFD` while the rest decoded correctly
3. Fix:
   - initialize the scan loop with `strings.firstNonASCII(remaining)` instead of `0`

Why this matches the observed symptom:

1. ASCII-only strings were unaffected (`toUTF16AllocMaybeBuffered` returned `null` early).
2. Strings starting with a non-ASCII code point decoded correctly.
3. Strings starting with ASCII but containing later UTF-8 multibyte sequences were corrupted at the first character.

Cleanup result:

1. Removed the FreeBSD-specific `ReadableStream.text()` JS fallback in `src/js/builtins/ReadableStream.ts`
   - no more `Buffer.from(bytes).toString()` workaround in the builtin path

Validation performed:

1. Plain TextDecoder repros (literal `Uint8Array`) now decode correctly for mixed ASCII+UTF-8 cases.
2. Subprocess stdout repro now decodes correctly via:
   - `new TextDecoder().decode(bytes)`
   - `await p.stdout.text()`
3. Tests:
   - `test/js/node/process/process-stdio.test.ts` => pass
   - `test/js/node/process/process-stdin.test.ts` => pass

Impact on prioritization:

1. `src/js/builtins/ReadableStream.ts` FreeBSD decode fallback can be removed from the active P0 queue (done on branch).
2. `src/bun.js/webcore/encoding.zig` remains a tracked temporary shim (`Pass 5`) but is no longer the primary suspected cause of this TextDecoder bug.

#### P0-2 Cleanup Attempt: stdin->stdio flush-barrier (`Readable.prototype.pipe()`)

Status: **Attempted; workaround still required (kept)**.

What was tested:

1. Temporarily disabled the FreeBSD `useFreeBSDStdioFlushBarrier` branch in:
   - `src/js/internal/streams/readable.ts`
2. Rebuilt and reran:
   - focused 16x64KB stdin->stdout relay repro
   - `test/js/bun/spawn/spawn-stdin-readable-stream.test.ts`
   - `test/js/node/process/process-stdio.test.ts`

Results:

1. Focused repro still passed (not sufficient to prove safety).
2. `process-stdio.test.ts` still passed.
3. `spawn-stdin-readable-stream.test.ts` regressed immediately:
   - `ReadableStream with large data` failed
   - `ReadableStream with very large chunked data` failed
   - observed truncation example: `393216 / 1048576`

Conclusion:

1. The FreeBSD flush-barrier in `Readable.prototype.pipe()` is still masking a real remaining completion/exit race.
2. The workaround must remain for now.
3. Next cleanup target should move to the lower-level path:
   - `src/bun.js/webcore/FileSink.zig` FreeBSD completion-order branch
   - then reattempt `readable.ts` removal after lower-level fixes.

#### P1 Cleanup Progress: `FileSink` FreeBSD completion-order defer removed

Status: **Completed on current branch (targeted regression floor green)**.

What was changed:

1. Removed the FreeBSD-only `handleResolveStream()` completion deferral in:
   - `src/bun.js/webcore/FileSink.zig`
2. FreeBSD now uses the shared `stream.done(globalThis)` path again.

Validation (after rebuild):

1. `test/js/bun/spawn/spawn-stdin-readable-stream.test.ts` => `20 pass / 1 todo / 0 fail`
2. `test/js/node/process/process-stdio.test.ts` => `9 pass / 0 fail`
3. `test/js/node/process/process-stdin.test.ts` => `6 pass / 0 fail`

Conclusion:

1. The FreeBSD-only `FileSink` completion-order defer branch is not required on the current branch.
2. Keep `FileSink` under regression watch while the higher-level `Readable.prototype.pipe()` stdio flush-barrier remains.
3. Next cleanup retry should return to:
   - `src/js/internal/streams/readable.ts` flush-barrier (`dest.end()`)
   - with the same targeted regression floor and focused chunked relay repro.

#### P0-2 Cleanup Retry (after `FileSink` cleanup): flush-barrier still required

Status: **Retried after `FileSink` cleanup; workaround still required (kept)**.

What was tested:

1. Removed the FreeBSD `useFreeBSDStdioFlushBarrier` branch in `src/js/internal/streams/readable.ts` again, this time
   after the `FileSink` completion-order defer branch had already been removed.
2. Rebuilt and reran:
   - focused 16x64KB stdin->stdout relay repro
   - `test/js/node/process/process-stdio.test.ts`
   - `test/js/node/process/process-stdin.test.ts`
   - `test/js/bun/spawn/spawn-stdin-readable-stream.test.ts`

Results:

1. Focused relay repro passed (`COUNT=1048576`)
2. `process-stdio.test.ts` passed
3. `process-stdin.test.ts` passed
4. `spawn-stdin-readable-stream.test.ts` regressed again:
   - `ReadableStream with large data` timeout/failure
   - `ReadableStream with very large chunked data` truncation
   - observed truncation example: `983040 / 1048576`

Conclusion:

1. Removing the `FileSink` FreeBSD completion-order defer branch was a valid cleanup, but it is not sufficient to
   eliminate the higher-level stdin->stdio flush-barrier workaround.
2. The `Readable.prototype.pipe()` FreeBSD stdio flush-barrier remains required on the current branch and has been
   restored.
3. The remaining race is further narrowed to behavior above/beyond the removed `FileSink` defer branch; future cleanup
   work should target the child-side stdio pipeline/exit ordering more directly.

#### P1 Cleanup Attempt: watcher synthetic duplicate event still required

Status: **Attempted; workaround still required (kept)**.

What was tested:

1. Removed the extra FreeBSD synthetic duplicate event in the directory-rescan fallback in:
   - `src/bun.js/node/path_watcher.zig`
2. Kept the FreeBSD directory rescan fallback itself intact (only reduced duplicate emission).
3. Rebuilt and ran:
   - `test/js/node/watch/fs.watch.test.ts`

Results:

1. `fs.watch.test.ts` regressed:
   - `fs.promises.watch > add file/folder to folder` timed out
2. Restored the duplicate synthetic event (with timestamp spacing beyond dedupe threshold), rebuilt, and reran:
   - `fs.watch.test.ts` => `32 pass / 0 fail`

Conclusion:

1. The FreeBSD directory rescan fallback remains correct/required.
2. The extra synthetic duplicate event is still required for `fs.promises.watch` parity on the current branch.
3. Future cleanup should target a more principled FreeBSD directory event synthesis or consumer-readiness fix, not just
   removal of the duplicate emission.

#### P1 Cleanup Progress: remove JS `rmdir` errno normalization shims

Status: **Completed on current branch (JS shims removed)**.

What was tested:

1. Probed `rmdir` behavior on a non-empty directory before code changes (sync, callback, and promise paths):
   - all returned `ENOTEMPTY` already (not `EREMOTE`)
2. Removed JS normalization shims from:
   - `src/js/node/fs.ts`
   - `src/js/node/fs.promises.ts`
3. Rebuilt and reran:
   - non-empty-directory `rmdir` probe (sync/callback/promise)
   - `test/js/node/fs/fs.test.ts`

Results:

1. Probe after rebuild still reports:
   - `sync ENOTEMPTY`
   - `cb ENOTEMPTY`
   - `prom ENOTEMPTY`
2. `fs.test.ts` remains green:
   - `234 pass / 6 skip / 0 fail`
   - `rmdir` / `rmdirSync` / `fs.promises.rmdir` cases all pass

Conclusion:

1. The JS `EREMOTE -> ENOTEMPTY` normalization shims were redundant on the current branch and have been removed.
2. The remaining FreeBSD-specific normalization in `src/bun.js/node/node_fs.zig` should stay for now, but its stale
   comment/history should be cleaned up in a later pass.

#### P1 Cleanup Progress: re-enable `node_fs.zig` small-file `readFile` pre-stat fast path

Status: **Completed on current branch (fast path re-enabled)**.

What was changed:

1. Removed the FreeBSD-only disablement of the small-file pre-stat `readFile` fast path in:
   - `src/bun.js/node/node_fs.zig`
2. This re-enables the optimization path that attempts to read up to 256 KB before calling `stat()`.

Validation (after rebuild):

1. Focused UTF-8 `readFileSync` stress probe (small file, `20,000` iterations) passed:
   - no string corruption
   - no spurious `ENOMEM`
2. `test/js/node/fs/fs.test.ts` => `234 pass / 6 skip / 0 fail`
   - includes broad `readFile` / `readFileSync` coverage

Conclusion:

1. The FreeBSD small-file pre-stat fast-path disable workaround is no longer needed on the current build baseline.
2. Additional FreeBSD `readFileWithOptions()` workaround branches remain and should be evaluated independently.

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

Status: **In progress (core gate green, expansion triage ongoing)**.

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
   - Current FreeBSD fallback includes a compatibility workaround (extra synthetic directory event per fallback entry) and the synthetic timestamp must be spaced beyond the duplicate-filter threshold (`time_diff > 1`) or the extra event is dropped.
5. Next runtime blocker (post-watcher): resolved for current Phase E target.
   - `test/js/bun/spawn/spawn-stdin-readable-stream.test.ts` had two FreeBSD issues:
     - parent-side `FileSink` pending-write accounting bug (fixed)
     - child-side `process.stdin.pipe(process.stdout)` truncation (later isolated and fixed in JS stream pipe behavior)
   - Current FreeBSD compatibility workaround in `src/js/internal/streams/readable.ts`:
     - for the narrow `process.stdin -> process.stdout|stderr` relay case, Bun ends stdio on source end to flush pending writes before process exit.
   - Full file now passes (`20 pass / 1 todo / 0 fail`) on FreeBSD.
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
9. Additional FreeBSD `spawn`/stdio runtime follow-up (later Phase E):
   - child-side `process.stdin.pipe(process.stdout)` could truncate chunked stdin data on process exit.
   - Current narrow workaround in `Readable.prototype.pipe()` ends stdio for `process.stdin -> process.stdout|stderr` on FreeBSD when default pipe end semantics are used.
   - Revalidated after this fix:
     - `spawn-stdin-readable-stream.test.ts` passes (`20 pass / 1 todo / 0 fail`)
     - `process-stdio.test.ts` passes (`9 pass / 0 fail`)
     - `process-stdin.test.ts` passes (`6 pass / 0 fail`)
10. Node `child_process` broad slice passes on FreeBSD with controlled invocation:
   - `test/js/node/child_process/child_process.test.ts` => `30 pass / 1 todo / 0 fail`
   - Required invocation hygiene:
     - run from outside repo root (or otherwise avoid the repo-local `.env` file)
     - set `PATH` to include `build/release`
   - Broader `test/js/node/child_process` directory runs are also mostly green under the same hygiene.
     A remaining `spawn(..., { env })` failure observed from repo root was traced to child Bun `.env` autoload contamination, not `node:child_process` env replacement semantics.

Phase E core-gate status (current baseline):
- The current core-gate slices used for FreeBSD bootstrap/runtime confidence are all passing:
  - `spawn-stdin-readable-stream.test.ts`
  - `process-stdio.test.ts`
  - `process-stdin.test.ts`
  - `util.test.js`
  - `fs.test.ts`
  - `fs.watch.test.ts`

Additional Phase E expansion progress (current branch):
- `test/js/node/url` passes (`186 pass / 2 skip / 9 todo / 0 fail`)
- `test/js/node/crypto` passes (`789 pass / 22 skip / 1 todo / 0 fail`)
- `test/js/node/child_process` broader directory run is mostly green with invocation hygiene (avoid repo-root `.env`, set `PATH`), with remaining issues classified separately.
- `test/js/node/http` directory run currently exposes:
  - local missing test dependencies (`proxy`, `express`, `https-proxy-agent`)
  - a major HTTP/2 timeout cluster sourced from `test/js/node/http2/node-http2.test.js` (`Client Basics` matrix)
  - full `test/js/node/http2/node-http2.test.js` passes in isolation (`245 pass / 6 skip / 0 fail`), confirming a suite interaction/cascading issue rather than a standalone HTTP/2 client failure
  - rerunning the `node:http` set without the missing-dependency files passes (`113 pass / 1 skip / 1 todo / 0 fail`), confirming the timeout cluster is tied to suite/dependency-failure interaction
- Initial package-manager/install slice checks pass:
  - `lockfile-only.test.ts`
  - `bun-install-pathname-trailing-slash.test.ts`
- Additional local install/link coverage passes:
  - `bun-link.test.ts`
- `bun-workspaces.test.ts` is locally blocked by missing `verdaccio` test dependency (environment setup), not yet classified as a FreeBSD runtime issue.
- `isolated-install.test.ts` and `bun-lock.test.ts` are also locally blocked by the same missing `verdaccio` dependency.
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

1. **Phase D first**: inventory and classify current FreeBSD-specific changes by subsystem.
   - Deliverable: documented classification table (`keep` / `temporary shim` / `bootstrap-only`) with repro references.
   - Scope target: current-tree runtime and codegen workarounds first; legacy stage0 patchset remains separately tracked under `scripts/patches/`.
2. Freeze the now-green Phase E core gate in docs (current baseline command list + exact pass counts) and keep it as the regression floor.
3. Continue Phase E expansion only for high-value slices that are:
   - self-contained, or
   - clearly marked as blocked by missing local test dependencies (`verdaccio`, `proxy`, `express`, `https-proxy-agent`, etc.).
4. Finish high-priority Pre-Upstream Cleanup Queue items that directly affect reviewability:
   - classify/narrow `bake-codegen.ts` stage0 placeholder fallback
   - classify temporary runtime shims (`ReadableStream.text`, stdin->stdio pipe workaround, watcher synthetic duplicates)
   - stage0 version string reporting (`Linux x64`) classification/fix
5. Start Phase F patch-stack split only after:
   - Phase D workaround inventory is complete
   - Phase E core gate remains green
   - major temporary shims have an explicit keep/replace/defer rationale

### 4.1 Phase D Scope & Effort Estimate (Current Branch)

This estimate is for the **current-tree** FreeBSD delta review and classification work, not the legacy stage0 replay patchset maintenance.

1. Inventory + classification pass (docs + references):
   - scope: ~25-40 current-tree files with FreeBSD-specific logic or FreeBSD bootstrap/runtime toggles
   - effort: ~0.5-1.5 days
2. High-priority shim review (design + targeted retest):
   - `src/js/internal/streams/readable.ts` stdin->stdio workaround
   - `src/js/builtins/ReadableStream*` FreeBSD `text()` fallback
   - `src/bun.js/node/path_watcher.zig` synthetic duplicate event workaround
   - `src/js/node/fs.ts` / `src/js/node/fs.promises.ts` compatibility shims (`rmdir`, etc.)
   - effort: ~1-3 days depending on whether any shim is replaced immediately vs deferred
3. Bootstrap-only workaround classification (current-tree codegen):
   - `src/codegen/bake-codegen.ts`, `bundle-modules.ts`, `bundle-functions.ts`, `bindgen.ts`, `create-hash-table.ts`
   - effort: ~0.5-1.5 days (classification/docs), more only if replacement work is attempted now

Overall Phase D-before-F estimate:

1. Minimum (classification-focused, with deferrals): ~2-4 days
2. Aggressive (replace several temporary shims before F): ~4-8+ days

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
- `internal/streams/lazy_transform.ts` -> alias `lazy.ts`
- `internal/streams/native-readable.ts` -> alias `s51.ts` (promoted from auto-retry)
- `internal-for-testing.ts` -> alias `s137.ts` (promoted from auto-retry)
- `node/_http_server.ts` -> alias `s76.ts` (promoted from auto-retry)
- `node/assert.strict.ts` -> alias `s84.ts` (promoted from auto-retry)
- `node/child_process.ts` -> alias `s87.ts` (promoted from auto-retry)
- `node/diagnostics_channel.ts` -> alias `s92.ts` (promoted from auto-retry)
- `node/inspector.promises.ts` -> alias `s102.ts` (promoted from auto-retry)
- `node/readline.promises.ts` -> alias `s112.ts` (promoted from auto-retry)
- `node/stream.consumers.ts` -> alias `s115.ts` (promoted from auto-retry)
- `node/stream.promises.ts` -> alias `s116.ts` (promoted from auto-retry)
- `node/timers.promises.ts` -> alias `s120.ts` (promoted from auto-retry)
- `node/trace_events.ts` -> alias `s123.ts` (promoted from auto-retry)
- `thirdparty/vercel_fetch.ts` -> alias `s135.ts` (promoted from auto-retry)

### Explicit alias vs auto-retry behavior (important)

- The generic auto-retry is useful and remains enabled for unknown cases.
- However, some entries show a "retry-poisoning" pattern:
  - first `Bun.build()` attempt fails with path corruption (expected signature)
  - alias retry in the same stage0 process hangs before alias `Bun.build()` starts
- For those entries, we promote them to the explicit alias list so the first attempt already uses
  the alias path and avoids poisoning the process.

This keeps the workaround auditable:
- generic behavior covers new cases automatically
- explicit list documents exceptions where retry-in-place is unstable
- latest known late-stage retry-poisoning cases:
  - `thirdparty/vercel_fetch.ts` (batch `135`)
  - `internal-for-testing.ts` (batch `137`, final batch)
  Both hung after auto-retry alias file write and before alias `Bun.build()` start and are now
  promoted to explicit first-attempt aliases (`s135.ts`, `s137.ts`).

### Batch-1 acceleration mode (current local workaround)

- For the stage0 isolation run (`BUN_FREEBSD_STAGE0_BUNDLER_BATCH_SIZE=1`), the current branch now
  defaults to first-attempt aliasing for `node/*` single-entry builds (FreeBSD stage0 only).
- Rationale:
  - avoids repeated failed-first-attempt poisoning before auto-retry
  - significantly reduces manual promotion churn while preserving traceability
- Scope note:
  - not enabled for all single-entry modules because early modules (e.g. `bun/ffi.ts`) can hang when
    first-attempt aliasing is forced.
- Opt-out (for debugging parity):
  - `BUN_FREEBSD_STAGE0_DISABLE_ALIAS_ALL_SINGLE_ENTRY=1`

### Repro command used for isolation

```bash
cd /home/lwhsu/killme/bun
BUN_FREEBSD_CODEGEN_TRACE=1 \
BUN_FREEBSD_STAGE0_BUNDLER_BATCH_SIZE=1 \
build/freebsd-bootstrap/stage0/bun --no-install run src/codegen/bundle-modules.ts --debug=OFF build/release
```

This is intentionally slow, but it gives deterministic evidence (`batchIndex`, `entrypoint0`) and is the best current path to finish `C-strict` while preserving a reviewable audit trail.

### Follow-on blocker after module batch completion (postbuild builtin functions)

- With the explicit alias list extended through `batch 137`, the stage0 FreeBSD run now completes the
  full module bundling pass (`batchIndex 0..137`) and reaches `bundle-modules` postbuild.
- New blocker: builtin-functions bundling (`src/codegen/bundle-functions.ts`) fails on `Bake.ts` in
  `tmp_functions` with the same legacy stage0 entrypoint corruption signature:
  `failed to open entry point directory ... var __b0;`
- Current mitigation (bootstrap-only, stage0 FreeBSD scoped):
  - `bundle-functions.ts` retries a failed `Bun.build()` with a short alias tmp filename when the
    corruption signature is detected.
  - No output remap is required in this path because builtin-functions consumes `build.outputs[0].text()`
    directly.

### Phase C-strict codegen gate update (2026-02-22, later)

Status change:
- The traced no-fallback stage0 `bundle-modules.ts` run now completes end-to-end and exits `0`.

Command (deterministic isolation / evidence mode):

```bash
cd /home/lwhsu/killme/bun
BUN_FREEBSD_CODEGEN_TRACE=1 \
BUN_FREEBSD_STAGE0_BUNDLER_BATCH_SIZE=1 \
BUN_FREEBSD_STAGE0_DISABLE_ALIAS_ALL_SINGLE_ENTRY=1 \
build/freebsd-bootstrap/stage0/bun --no-install run src/codegen/bundle-modules.ts --debug=OFF build/release
```

Observed terminal evidence:
- `bundle-modules:postbuild:done { outputs: 138 }`
- `bundle-functions:done`
- `[155.98s] Bundled "src/js" for production`
- `EXIT:0`

Additional stage0 runtime workarounds required to reach this point:

1. `src/codegen/bundle-functions.ts` (builtin temp functions / `tmp_functions`)
   - Legacy FreeBSD stage0 `Bun.build()` remained unstable for some entries (`Bake*.ts`), including
     corrupted entrypoint paths and malformed "successful" outputs.
   - Bootstrap-only FreeBSD stage0 workaround:
     - use `Bun.Transpiler` by default for builtin temp function sources
     - keep `Bun.build()` path available for debugging via
       `BUN_FREEBSD_STAGE0_BUNDLE_FUNCTIONS_USE_BUILD=1`
   - Rationale:
     - builtin-function extraction only needs transformed JS text with `$$capture_*$$` markers intact
     - the transpiler path preserves those markers reliably on stage0

2. `src/codegen/bundle-modules.ts` (`Generate Code` eval discovery)
   - Legacy FreeBSD stage0 throws `ReferenceError: __yieldStar` when touching
     `Bun.Glob(...).scanSync()` iterators in this file (including `.next()` probes).
   - Workaround:
     - replace `eval/*.ts` discovery with `fs.readdirSync(...).filter(...).sort()` for deterministic
       file enumeration without the iterator helper path

Implication for roadmap:
- The long-running `bundle-modules.ts` no-fallback stage0 runtime blocker is no longer the gating item
  for `C-strict`.
- Remaining `C-strict` exit work should focus on **full no-fallback bootstrap validation**
  (`BUN_FREEBSD_BINDGENV2_NODE=0`, `BUN_FREEBSD_CODEGEN_NODE=0`, `BUN_FREEBSD_NPM_INSTALL=0`) using the
  documented bootstrap entrypoint.
