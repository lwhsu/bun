# FreeBSD Bootstrap (No Prebuilt Bun)

This documents source-only bootstrap on FreeBSD when no host `bun` exists.

## Why stage0 is required

Current CMake build/codegen invokes `${BUN_EXECUTABLE}` during configure/build
(`cmake/tools/SetupBun.cmake`, `cmake/targets/BuildBun.cmake`). A host bun is
required before the normal CMake/Ninja build.

## Cold-start strategy

Use a historical Makefile-era commit to produce one native FreeBSD stage0 bun,
then reuse that binary as `-DBUN_EXECUTABLE` for the current tree.

Default bootstrap commit:

- `8d7d58606b`

## Prerequisites

```bash
sudo pkg install -y cmake ninja gmake node npm python3 rust clang
```

### Zig

Legacy bootstrap commit requires Zig `0.13.x`.

```bash
/usr/local/bin/zig version
```

If needed:

```bash
export BUN_FREEBSD_LEGACY_ZIG=/usr/local/bin/zig
```

## WebKit requirement

Two WebKit package layouts are used:

1. Legacy stage0 package (`build/freebsd-bootstrap/bun-webkit-legacy`)
   - commit comes from legacy `CMakeLists.txt` `WEBKIT_TAG`
   - for `8d7d58606b`: `147ed53838e21525677492c27099567a6cd19c6b`
2. Current package (`build/freebsd-bootstrap/bun-webkit`)
   - commit comes from current `cmake/tools/SetupWebKit.cmake` `WEBKIT_VERSION`
   - currently: `8af7958ff0e2a4787569edf64641a1ae7cfe074a`

Both packages must contain:

- `lib/libJavaScriptCore.a`
- `lib/libWTF.a`
- `include/wtf/SIMDUTF.h`

## Prepare WebKit source checkouts

Bootstrap now uses separate local WebKit source worktrees per required commit.

If WebKit git operations are slow, prepare these offline first:

```bash
cd /home/lwhsu/killme/bun/vendor/WebKit
git fetch origin 147ed53838e21525677492c27099567a6cd19c6b 8af7958ff0e2a4787569edf64641a1ae7cfe074a
git worktree add --detach -f /home/lwhsu/killme/bun/build/freebsd-bootstrap/webkit-src-legacy 147ed53838e21525677492c27099567a6cd19c6b
git worktree add --detach -f /home/lwhsu/killme/bun/build/freebsd-bootstrap/webkit-src-current 8af7958ff0e2a4787569edf64641a1ae7cfe074a
```

## One-time cold start

```bash
cd /home/lwhsu/killme/bun
export BUN_FREEBSD_ALLOW_DOWNLOADS=1
./scripts/bootstrap-freebsd.sh
```

Script behavior:

- creates legacy worktree at `build/freebsd-bootstrap/legacy-worktree`
- applies FreeBSD compatibility patches
- prepares legacy/current WebKit packages from separate source worktrees
- generates required legacy codegen outputs without host bun
- builds stage0 at `build/freebsd-bootstrap/stage0/bun`
- configures current CMake build with `-DBUN_EXECUTABLE=<stage0>`
- builds current `bun-debug`

## Current FreeBSD build toggles (required right now)

For current-tree CMake/Ninja builds on FreeBSD, set:

```bash
export BUN_FREEBSD_NPM_INSTALL=1
export BUN_FREEBSD_BINDGENV2_NODE=1
export BUN_FREEBSD_CODEGEN_NODE=1
```

Rationale:

- `BUN_FREEBSD_NPM_INSTALL=1` forces npm fallback for dependency install steps.
- `BUN_FREEBSD_BINDGENV2_NODE=1` and `BUN_FREEBSD_CODEGEN_NODE=1` use Node runners
  for bindgen/codegen paths that are still unstable with stage0 (`0.0.0`).

Example release build:

```bash
cmake -S . -B build/freebsd-release-ozig -G Ninja -DRELEASE=ON -DOS=freebsd -DARCH=x64 -DBUN_EXECUTABLE="$PWD/build/freebsd-bootstrap/stage0/bun"
cmake --build build/freebsd-release-ozig --target bun -- -j$(sysctl -n hw.ncpu)
```

## Validate

```bash
./build/freebsd-bootstrap/stage0/bun --version
./build/freebsd-bootstrap/stage0/bun -e 'console.log(1+1)'
./build/debug/bun-debug --version
./build/debug/bun-debug -e 'console.log(1+1)'
./build/freebsd-release-ozig/bun --version
./build/freebsd-release-ozig/bun -e 'console.log(1+1)'
```
