# Bun FreeBSD Porting and Workspace Migration Plan

Last updated: 2026-02-16 (FreeBSD host)

## Scope

This document covers:

1. Full roadmap to bootstrap and port Bun on FreeBSD.
2. Current verified status of this workspace.
3. Migration plan to move the entire in-progress workspace to another machine and continue work without losing state.

## 1) Roadmap: Bootstrap + Port Bun to FreeBSD

### Phase A: Stabilize bootstrap inputs

Goals:

- Keep one canonical legacy bootstrap commit (`8d7d58606b`) for stage0 generation.
- Keep deterministic WebKit package inputs for:
  - legacy stage0
  - current-tree build

Exit criteria:

- `scripts/bootstrap-freebsd.sh` can prepare/check both WebKit package layouts without manual edits.
- Stage0 location is deterministic (`build/freebsd-bootstrap/stage0/bun`).

### Phase B: Stage0 reliability

Goals:

- Produce and keep a working FreeBSD stage0 binary.
- Ensure stage0 is stable enough to run build/codegen scripts, not only trivial JS.

Current known blocker:

- Stage0 currently runs simple JS (`--print '1+1'`) but fails on builtin imports (`node:fs`), which blocks current codegen.

Exit criteria:

- Stage0 runs at least:
  - `bun run src/codegen/generate-classes.ts ...`
  - bindgen/codegen tasks required by `cmake/targets/BuildBun.cmake`.

### Phase C: Current-tree full build

Goals:

- Configure current tree with:
  - `-DBUN_EXECUTABLE=<stage0>`
  - `-DUSE_SYSTEM_ZIG=ON`
  - `-DWEBKIT_PATH=<local-bun-webkit>`
- Build `bun-debug` successfully.

Exit criteria:

- `cmake --build build/debug --target bun-debug` passes.
- `build/debug/bun-debug --version` works.
- `build/debug/bun-debug -e 'console.log(1+1)'` works.

### Phase D: Runtime and compatibility hardening

Goals:

- Fix FreeBSD runtime parity gaps (file/process/network/watcher/etc.).
- Validate with focused Bun tests and smoke coverage.

Exit criteria:

- Critical runtime functionality works on FreeBSD.
- Reproducible documented bootstrap/build flow from clean checkout.

### Phase E: Upstream-quality patching

Goals:

- Split patches by concern:
  - CMake host/platform support
  - bootstrap scripts
  - legacy stage0 compatibility
  - runtime/porting fixes
  - docs

Exit criteria:

- Patch stack is auditable, minimal, and can be reviewed independently.

## 2) Current Verified Status

### Host/toolchain snapshot

- OS: `FreeBSD 15.0-STABLE amd64`
- Bun repo HEAD: `3debd0a2d2`
- Zig: `0.13.0`
- Clang: `19.1.7`
- CMake: `3.31.10`
- Ninja: `1.13.2`
- Node: `v24.13.0`
- npm: `11.7.0`

### Main repo status (`/home/lwhsu/killme/bun`)

Contains substantial uncommitted work in:

- `cmake/*` (FreeBSD host/platform updates, SetupZig/SetupWebKit updates, bindgen command selection)
- `scripts/*` (bootstrap, WebKit prep, Node codegen fallbacks, patches)
- docs/reports:
  - `docs/bootstrap-freebsd.md`
  - `bun-bootstrap.md`

### Stage0 status

Available binaries:

- `/home/lwhsu/killme/bun/build/freebsd-bootstrap/stage0/bun`
- `/home/lwhsu/tmp/bun-stage0-june2024/stage0/bun`

Behavior:

- Works:
  - `--version` => `0.0.0`
  - `--print '1+1'` => `2`
- Fails:
  - `-e 'import fs from "node:fs"...'` (TypeError from builtin module init path)

### Current-tree build status

`build/debug/CMakeCache.txt` is configured for:

- `BUN_EXECUTABLE=/home/lwhsu/killme/bun/build/freebsd-bootstrap/stage0/bun`
- `USE_SYSTEM_ZIG=ON`
- `WEBKIT_PATH=/home/lwhsu/killme/bun/build/freebsd-bootstrap/bun-webkit`

Current blocker:

- `cmake --build build/debug --target bun-debug` fails at first codegen step:
  - `Generating ZigGeneratedClasses.{zig,cpp,h}`
  - stage0 command aborts when running `src/codegen/generate-classes.ts`

### Legacy worktrees

Two legacy worktrees exist and are dirty at `8d7d58606b`:

- `/home/lwhsu/killme/bun/build/freebsd-bootstrap/legacy-worktree`
- `/home/lwhsu/tmp/bun-stage0-june2024/legacy-worktree`

Both include many uncommitted FreeBSD compatibility edits and generated code artifacts.

### Vendor WebKit status

- Path: `/home/lwhsu/killme/bun/vendor/WebKit`
- HEAD: `f9a0fda2d2b2fd001a00bfcf8e7917a56b382516`
- Has local modifications + stash entry.
- Related worktrees:
  - `build/freebsd-bootstrap/webkit-src-legacy`
  - `build/freebsd-bootstrap/webkit-src-current`
  - `build/freebsd-bootstrap/webkit-src-june`

## 3) Migration Plan (Move to Another Machine)

## Recommended strategy

Use a **full path-preserving transfer** first. It is the safest because Git worktree metadata and WebKit worktree metadata use absolute paths.

Path targets to preserve:

- `/home/lwhsu/killme/bun`
- `/home/lwhsu/tmp/bun-stage0-june2024`

### 3.1 What must be packed

Required:

- `/home/lwhsu/killme/bun` (entire directory, including `.git`, uncommitted files, `build/freebsd-bootstrap`, `vendor/WebKit`)
- `/home/lwhsu/tmp/bun-stage0-june2024` (active non-/tmp worktree + stage0 copy)

Strongly recommended:

- any core dumps and local logs needed for post-mortem debugging
- local Zig package file used in this effort (`zig-0.13.0-dbg.pkg`) if destination may lack it

### 3.2 Current size estimate

- `/home/lwhsu/killme/bun` ~ `23G`
- `/home/lwhsu/killme/bun/build/freebsd-bootstrap` ~ `13G`
- `/home/lwhsu/killme/bun/vendor/WebKit` ~ `6.6G`
- `/home/lwhsu/tmp/bun-stage0-june2024` ~ `1.1G`

### 3.3 Source machine: create migration snapshot + archive

```bash
set -euo pipefail

# 1) Optional: save text snapshots for auditability
mkdir -p /home/lwhsu/killme/bun/migration-artifacts
ts="$(date +%Y%m%d-%H%M%S)"
snap="/home/lwhsu/killme/bun/migration-artifacts/snapshot-${ts}"
mkdir -p "${snap}"

uname -a > "${snap}/host-uname.txt"
/usr/local/bin/zig version > "${snap}/zig-version.txt" || true
clang --version | head -n 1 > "${snap}/clang-version.txt" || true
cmake --version | head -n 1 > "${snap}/cmake-version.txt" || true
ninja --version > "${snap}/ninja-version.txt" || true
node --version > "${snap}/node-version.txt" || true
npm --version > "${snap}/npm-version.txt" || true

git -C /home/lwhsu/killme/bun rev-parse HEAD > "${snap}/bun-head.txt"
git -C /home/lwhsu/killme/bun status --short > "${snap}/bun-status-short.txt"
git -C /home/lwhsu/killme/bun diff --stat > "${snap}/bun-diff-stat.txt"
git -C /home/lwhsu/killme/bun worktree list --porcelain > "${snap}/bun-worktrees.txt"

git -C /home/lwhsu/killme/bun/vendor/WebKit rev-parse HEAD > "${snap}/webkit-head.txt"
git -C /home/lwhsu/killme/bun/vendor/WebKit status --short > "${snap}/webkit-status-short.txt"
git -C /home/lwhsu/killme/bun/vendor/WebKit stash list > "${snap}/webkit-stash-list.txt"
```

```bash
set -euo pipefail

# 2) Full archive with absolute-path-friendly restore
out="/home/lwhsu/killme/bun/migration-artifacts/bun-freebsd-migration-${ts}.tar.zst"
tar -C / -I zstd -cf "${out}" \
  home/lwhsu/killme/bun \
  home/lwhsu/tmp/bun-stage0-june2024

sha256 -q "${out}" > "${out}.sha256"
ls -lh "${out}" "${out}.sha256"
```

### 3.4 Transfer

- Copy archive + checksum to destination using your preferred transfer method (`scp`, `rsync`, external disk, etc.).

### 3.5 Destination machine: restore

```bash
set -euo pipefail

sha256 -c bun-freebsd-migration-<timestamp>.tar.zst.sha256
sudo tar -C / -I zstd -xf bun-freebsd-migration-<timestamp>.tar.zst
```

Install required tools if missing:

```bash
sudo pkg install -y cmake ninja gmake node npm
sudo pkg install -y /path/to/zig-0.13.0-dbg.pkg
```

### 3.6 Post-restore validation

```bash
/home/lwhsu/killme/bun/build/freebsd-bootstrap/stage0/bun --print '1+1'
/home/lwhsu/tmp/bun-stage0-june2024/stage0/bun --print '1+1'
cd /home/lwhsu/killme/bun
cmake --build build/debug --target bun-debug -j1
```

Expected currently: same codegen-stage failure at `generate-classes` with stage0 host.

## 4) If absolute paths cannot be preserved

If you must restore to different paths:

1. Extract data where desired.
2. Recreate worktrees from the main repo instead of trusting old `.git` pointers:

```bash
git -C <new-root>/bun worktree prune
git -C <new-root>/bun worktree add --detach <new-root>/bun/build/freebsd-bootstrap/legacy-worktree 8d7d58606b
git -C <new-root>/bun worktree add --detach <new-root>/tmp/bun-stage0-june2024/legacy-worktree 8d7d58606b
```

3. Reapply uncommitted diffs (export them before move, or extract from copied trees).
4. Reattach WebKit worktrees similarly under `vendor/WebKit`.

## 5) Immediate next technical step after migration

Focus on one blocker only:

- make stage0 reliably run codegen/builtin imports (especially path through internal module loading and JS2Native)

Once that is fixed, current-tree configure/build should progress past the first codegen gate.

## 6) Codex Session Memory Migration (`~/.codex`)

This workspace migration preserves code/build state. To also preserve local Codex session history and local configuration, migrate `~/.codex`.

What this includes:

- session/history files (`sessions`, `history.jsonl`, `history.json`)
- local config/rules/skills (`config.toml`, `rules`, `skills`)
- optional auth token (`auth.json`)

### 6.1 Pack Codex state on source machine

```bash
set -euo pipefail

ts="$(date +%Y%m%d-%H%M%S)"
out="/home/lwhsu/killme/bun/migration-artifacts/codex-state-${ts}.tar.zst"
mkdir -p /home/lwhsu/killme/bun/migration-artifacts

# Include auth.json (seamless login on destination)
tar -C /home/lwhsu -I zstd -cf "${out}" .codex

sha256 -q "${out}" > "${out}.sha256"
ls -lh "${out}" "${out}.sha256"
```

If you do not want to migrate credentials:

```bash
set -euo pipefail

ts="$(date +%Y%m%d-%H%M%S)"
out="/home/lwhsu/killme/bun/migration-artifacts/codex-state-noauth-${ts}.tar.zst"
tar -C /home/lwhsu -I zstd --exclude='.codex/auth.json' -cf "${out}" .codex
sha256 -q "${out}" > "${out}.sha256"
```

### 6.2 Restore Codex state on destination machine

```bash
set -euo pipefail

sha256 -c codex-state-<timestamp>.tar.zst.sha256
tar -C /home/lwhsu -I zstd -xf codex-state-<timestamp>.tar.zst

chmod 700 /home/lwhsu/.codex
chmod 600 /home/lwhsu/.codex/config.toml /home/lwhsu/.codex/history.jsonl 2>/dev/null || true
chmod 600 /home/lwhsu/.codex/auth.json 2>/dev/null || true
```

### 6.3 Verify Codex memory restore

```bash
ls -la /home/lwhsu/.codex
find /home/lwhsu/.codex/sessions -type f | tail -n 20
```
