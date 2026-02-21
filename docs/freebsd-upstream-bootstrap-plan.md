# FreeBSD Bootstrap and Upstream Readiness Plan

Last updated: 2026-02-21
Repository: `/home/lwhsu/killme/bun`
Branch at planning time: `freebsd-bootstrap` (`6e4df755017d`)

## 1. Current Status (Re-checked)

### Verified now

- `git status --porcelain` in main worktree is clean.
- Stage0 binary exists and runs:
  - `build/20260221-2027-freebsd-bootstrap-cleanroom-step1/stage0/bun --version` -> `0.0.0`
  - `build/20260221-2027-freebsd-bootstrap-cleanroom-step1/stage0/bun -e 'console.log(1+1)'` -> `2`
- Final current-tree binary exists and runs:
  - `build/20260221-2027-current-from-cleanroom-step1/bun --version` -> `1.3.10`
  - `build/20260221-2027-current-from-cleanroom-step1/bun -e 'console.log(1+1)'` -> `2`

### State that still needs cleanup/normalization

- Multiple legacy detached worktrees at the same commit `8d7d58606b`:
  - `build/freebsd-bootstrap/legacy-worktree`
  - `build/freebsd-bootstrap-cleanroom-step1/legacy-worktree`
  - `build/20260221-1844-freebsd-bootstrap-cleanroom-step1/legacy-worktree`
  - `build/20260221-2027-freebsd-bootstrap-cleanroom-step1/legacy-worktree`
  - `/home/lwhsu/tmp/bun-stage0-compat`
  - `/home/lwhsu/tmp/bun-stage0-june2024/legacy-worktree`
- `vendor/WebKit` is intentionally not clean (local FreeBSD patching work + stash).
- `build/` has many historical experiment directories; reproducible upstream prep needs a canonical layout.

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

Status: **In progress** (not completed).

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

### Phase C: Bootstrap Pipeline Hardening

Goal: make cold-start script robust and deterministic on FreeBSD.

Status: **In progress** (script works in cleanroom, rerun matrix still pending after Phase B cleanup).

How to do it:

1. Keep `scripts/bootstrap-freebsd.sh` as the only supported entrypoint.
2. Run it from a cleaned workspace using canonical dirs.
3. Re-run without clearing caches to prove idempotence.
4. Re-run after Zig variant switch to prove cache fingerprint invalidation.

How to reproduce:

```bash
cd /home/lwhsu/killme/bun

export BUN_FREEBSD_BOOTSTRAP_DIR=/home/lwhsu/killme/bun/build/freebsd-bootstrap
export BUN_FREEBSD_BUILD_DIR=/home/lwhsu/killme/bun/build/freebsd-selfhost-stepD
export BUN_FREEBSD_CMAKE_BUILD_TYPE=Release
export BUN_FREEBSD_CURRENT_ZIG=/home/lwhsu/killme/bun/build/freebsd-bootstrap/oven-zig/build-freebsd-release/stage3/bin/zig

./scripts/bootstrap-freebsd.sh
./scripts/bootstrap-freebsd.sh
```

How to verify:

1. Script exits successfully on consecutive runs.
2. Stage0 path is deterministic:
   - `${BUN_FREEBSD_BOOTSTRAP_DIR}/stage0/bun`
3. Final binary exists at `${BUN_FREEBSD_BUILD_DIR}/bun`.

How to review:

1. Inspect `scripts/bootstrap-freebsd.sh` and patch list in `scripts/patches/`.
2. Confirm error paths are explicit (missing zig/webkit/patch failures).
3. Confirm cache fingerprint logic is still present and exercised.

Exit criteria:

1. Two consecutive runs succeed with no manual patching between runs.
2. A no-fallback configure/build run succeeds with:
   - `-DBUN_FREEBSD_BINDGENV2_NODE=0`
   - `-DBUN_FREEBSD_CODEGEN_NODE=0`
   - `-DBUN_FREEBSD_NPM_INSTALL=0`

### Phase D: Runtime and Platform Parity

Goal: move from bootstrap success to maintainable FreeBSD runtime support.

Status: **In progress**.

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

How to do it:

1. Run baseline smoke checks on stage0 and final.
2. Run focused spawn suite first (highest risk area from prior failures).
3. Run selected Node fs/watch and Bun shell tests.
4. Capture pass/fail and skips into `bun-bootstrap.md` with command lines.

How to reproduce:

```bash
cd /home/lwhsu/killme/bun

build/20260221-2027-current-from-cleanroom-step1/bun --version
build/20260221-2027-current-from-cleanroom-step1/bun -e 'console.log(1+1)'
build/20260221-2027-current-from-cleanroom-step1/bun -e 'import fs from "node:fs"; console.log(typeof fs.readFile)'

build/20260221-2027-current-from-cleanroom-step1/bun test test/js/bun/spawn/spawn.test.ts
build/20260221-2027-current-from-cleanroom-step1/bun test test/js/bun/spawn/spawn-stdin-readable-stream.test.ts
build/20260221-2027-current-from-cleanroom-step1/bun test test/js/node/fs/fs.test.ts
build/20260221-2027-current-from-cleanroom-step1/bun test test/js/node/watch/fs.watch.test.ts
build/20260221-2027-current-from-cleanroom-step1/bun test test/js/bun/shell/shell-hang.test.ts
```

How to verify:

1. Smoke checks pass.
2. Spawn-focused tests pass without hangs.
3. fs/watch/shell selected tests pass or have documented, reproducible failure records.

How to review:

1. Confirm command list and outcomes are logged in `bun-bootstrap.md`.
2. Confirm no "silent skip" of known flaky or previously failing areas.
3. Confirm failures have root cause notes and next actions.

Exit criteria:

1. The gate command set is reproducible and stable on FreeBSD.

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

1. Workspace hygiene pass (Phase B):
   - consolidate worktrees and archive stale build dirs.
2. Re-run canonical cleanroom bootstrap once after cleanup (Phase C).
3. Run and record full FreeBSD test gate (Phase E).
4. Split current branch into upstream PR stack (Phase F), starting with build-system plumbing.

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
export BUN_FREEBSD_BUILD_DIR=/home/lwhsu/killme/bun/build/freebsd-selfhost-stepD
export BUN_FREEBSD_CMAKE_BUILD_TYPE=Release
export BUN_FREEBSD_CURRENT_ZIG=/home/lwhsu/killme/bun/build/freebsd-bootstrap/oven-zig/build-freebsd-release/stage3/bin/zig

./scripts/bootstrap-freebsd.sh
```

### Verify outputs

```bash
cd /home/lwhsu/killme/bun

build/freebsd-bootstrap/stage0/bun --version
build/freebsd-bootstrap/stage0/bun -e 'console.log(1+1)'
build/freebsd-selfhost-stepD/bun --version
build/freebsd-selfhost-stepD/bun -e 'console.log(1+1)'
build/freebsd-selfhost-stepD/bun -e 'import fs from "node:fs"; console.log(typeof fs.readFile)'
```

### Review checklist for clean-checkout bootstrap

1. `scripts/bootstrap-freebsd.sh` log shows legacy worktree creation, patch apply, codegen, and stage0 install.
2. Stage0 binary exists at `build/freebsd-bootstrap/stage0/bun`.
3. Final binary exists at `build/freebsd-selfhost-stepD/bun`.
4. If rerunning with different zig binary, script reports cache fingerprint reset.

## 5. Definition of Done for This Porting Track

All items must hold simultaneously:

1. Fresh clone + documented prerequisites can bootstrap on FreeBSD without prebuilt Bun.
2. Stage0 and final binaries are reproducibly produced and runnable.
3. FreeBSD test gate passes, with tracked exceptions only.
4. Upstream patch series is minimal, documented, and review-ready.
5. Workspace state is tidy enough for handoff/migration without hidden dependencies.
