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
   - `bundle-modules.ts` deadlock under stage0
   - `bindgen.ts` functional mismatch under stage0
4. Latest crash narrowing for install path:
   - stage0 `bun install` core backtrace points at `src.sys.File.toSource` during lockfile workspace parsing (`Package.processWorkspaceName*`).
5. 2026-02-22 update:
   - Legacy stage0 with `build-obj-safe` plus FreeBSD `read`-based file-read path no longer crashes on `bun install --frozen-lockfile`.
   - This narrows remaining no-fallback work to stage0 codegen/runtime behavior rather than install lockfile parsing.

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
9. Node `child_process` broad slice passes on FreeBSD with controlled invocation:
   - `test/js/node/child_process/child_process.test.ts` => `30 pass / 1 todo / 0 fail`
   - Required invocation hygiene:
     - run from outside repo root (or otherwise avoid the repo-local `.env` file)
     - set `PATH` to include `build/release`
     - set `SHELL=/bin/sh` for clean-env runs
   - Notes:
     - earlier `spawn(..., { env })` failure was caused by Bun loading the repo `.env` (cwd-dependent), not by FreeBSD child_process runtime behavior.

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
