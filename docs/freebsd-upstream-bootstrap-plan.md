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

## 3. Full Roadmap

### Phase A: Freeze a Canonical Baseline

Goal: lock one known-good path before further changes.

Actions:

1. Keep one canonical successful bootstrap pair:
   - Stage0 dir: `build/20260221-2027-freebsd-bootstrap-cleanroom-step1`
   - Final dir: `build/20260221-2027-current-from-cleanroom-step1`
2. Record exact toolchain manifest in docs:
   - FreeBSD version
   - Zig version/path
   - clang/cmake/ninja/node versions
3. Add/update a single "golden command" block in docs with exact env vars used.

Exit criteria:

- Any collaborator can repeat the exact successful command path using documented inputs.

### Phase B: Sort and Tidy Workspace/Worktrees

Goal: remove ambiguity and make the repository auditable for upstream.

Actions:

1. Declare canonical active directories:
   - Main tree: `/home/lwhsu/killme/bun`
   - Legacy bootstrap worktree: `build/freebsd-bootstrap/legacy-worktree`
   - Optional scratch area: `~/tmp/*` (never `/tmp`)
2. Move old experiment directories under one archive root:
   - Example: `build/archive-freebsd-experiments/<timestamp>-<name>`
3. Reduce duplicate legacy worktrees:
   - Keep only one active legacy worktree + one optional backup copy.
4. Normalize WebKit handling:
   - Keep `vendor/WebKit` pinned at one commit.
   - Document local patch list and whether each patch should become scripted patching vs upstream WebKit prerequisite.
5. Ensure no accidental generated artifacts are tracked in Git unless intentional.

Exit criteria:

- `git worktree list` is small and purposeful.
- `build/` has clear active vs archived structure.
- WebKit local deltas are explicitly documented and reproducible.

### Phase C: Bootstrap Pipeline Hardening

Goal: make cold-start script robust and deterministic on FreeBSD.

Actions:

1. Keep `scripts/bootstrap-freebsd.sh` as the single entrypoint.
2. Validate:
   - cleanroom run
   - rerun on existing caches
   - rerun after Zig switch (cache fingerprint reset path)
3. Ensure script errors are clear and fail early (missing WebKit, wrong Zig, patch-apply failures).
4. Keep stage0 output path stable:
   - `${BUN_FREEBSD_BOOTSTRAP_DIR}/stage0/bun`

Exit criteria:

- 2 consecutive reruns succeed without manual patching between runs.

### Phase D: Runtime and Platform Parity

Goal: move from bootstrap success to maintainable FreeBSD runtime support.

Actions:

1. Audit current FreeBSD runtime patches by subsystem:
   - process/spawn
   - kqueue/event loop/uSockets
   - fs/path/fd constants
   - shell startup and stdio behavior
2. Replace temporary compatibility logic with native FreeBSD paths where applicable.
3. Confirm OS macro consistency:
   - use `OS(FREEBSD)` path where WebKit-style macros are expected.
4. Re-check kqueue wake and child-exit behavior under stress tests.

Exit criteria:

- No known deterministic deadlock or crash remains in bootstrap-critical flows.

### Phase E: Test Matrix for "Full Support"

Goal: define and execute a FreeBSD confidence gate before upstreaming.

Actions:

1. Keep minimum smoke gate:
   - `bun --version`
   - `bun -e 'console.log(1+1)'`
   - `bun -e 'import fs from "node:fs"; console.log(typeof fs.readFile)'`
2. Run focused suites tied to touched subsystems:
   - `test/js/bun/spawn/*`
   - selected fs/watcher tests
   - selected shell tests
3. Add regression tests for each FreeBSD-specific fix that previously failed.
4. Document known skips/failures with root cause and issue links.

Exit criteria:

- Planned gate passes on current branch with reproducible commands.

### Phase F: Upstream Patch Stack Preparation

Goal: convert large local delta into reviewable PR sequence.

Recommended PR order:

1. Build-system platform plumbing:
   - CMake/target detection/tool setup for FreeBSD.
2. Bootstrap infrastructure:
   - `scripts/bootstrap-freebsd.sh`, WebKit prep script, reproducibility guards.
3. Stage0 compatibility patches:
   - legacy-only patch machinery and documentation.
4. Runtime/platform fixes:
   - spawn/kqueue/fd/fs/sys constants, OS macro correctness.
5. Documentation:
   - bootstrap guide + maintenance notes.

For each PR:

1. Include exact problem statement.
2. Include smallest diff that solves it.
3. Include reproduction command and verification command.
4. Include risk notes and fallback behavior.

Exit criteria:

- Patch series can be reviewed independently without relying on private local state.

### Phase G: CI and Maintenance Path

Goal: prevent regressions after merge.

Actions:

1. Add/enable a FreeBSD CI job (or external periodic runner) with at least:
   - configure
   - bootstrap stage0
   - build final
   - smoke tests
2. Encode bootstrap prerequisites in docs and CI environment setup.
3. Add a lightweight regression command for contributors.

Exit criteria:

- FreeBSD path is tested continuously, not only manually.

## 4. Immediate Next Steps (Execution Order)

1. Workspace hygiene pass (Phase B):
   - consolidate worktrees and archive stale build dirs.
2. Re-run canonical cleanroom bootstrap once after cleanup (Phase C).
3. Run and record full FreeBSD test gate (Phase E).
4. Split current branch into upstream PR stack (Phase F), starting with build-system plumbing.

## 5. Definition of Done for This Porting Track

All items must hold simultaneously:

1. Fresh clone + documented prerequisites can bootstrap on FreeBSD without prebuilt Bun.
2. Stage0 and final binaries are reproducibly produced and runnable.
3. FreeBSD test gate passes, with tracked exceptions only.
4. Upstream patch series is minimal, documented, and review-ready.
5. Workspace state is tidy enough for handoff/migration without hidden dependencies.
