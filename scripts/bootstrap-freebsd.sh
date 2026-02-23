#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "FreeBSD" ]]; then
  echo "error: scripts/bootstrap-freebsd.sh must run on FreeBSD" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

LEGACY_COMMIT="${BUN_FREEBSD_BOOTSTRAP_COMMIT:-8d7d58606b}"
BOOTSTRAP_DIR="${BUN_FREEBSD_BOOTSTRAP_DIR:-${ROOT_DIR}/build/freebsd-bootstrap}"
LEGACY_WORKTREE="${BOOTSTRAP_DIR}/legacy-worktree"
LEGACY_STAGE0="${LEGACY_WORKTREE}/packages/bun-freebsd-x64/bun"
STAGE0_DIR="${BOOTSTRAP_DIR}/stage0"
STAGE0_BIN="${STAGE0_DIR}/bun"
SHIM_BIN_DIR="${BOOTSTRAP_DIR}/shim-bin"
BUILD_DIR="${BUN_FREEBSD_BUILD_DIR:-${ROOT_DIR}/build/debug}"
LEGACY_ZIG="${BUN_FREEBSD_LEGACY_ZIG:-}"
LEGACY_WEBKIT_DIR="${BUN_FREEBSD_LEGACY_WEBKIT_OUT_DIR:-${BOOTSTRAP_DIR}/bun-webkit-legacy}"
WEBKIT_REPO_SOURCE="${BUN_FREEBSD_WEBKIT_REPO_SOURCE:-${ROOT_DIR}/vendor/WebKit}"
LEGACY_WEBKIT_SOURCE="${BUN_FREEBSD_LEGACY_WEBKIT_SOURCE:-${BOOTSTRAP_DIR}/webkit-src-legacy}"
CURRENT_WEBKIT_DIR="${BUN_FREEBSD_WEBKIT_OUT_DIR:-${BOOTSTRAP_DIR}/bun-webkit}"
CURRENT_WEBKIT_SOURCE="${BUN_FREEBSD_WEBKIT_SOURCE:-${BOOTSTRAP_DIR}/webkit-src-current}"
LEGACY_CODEGEN_HELPER="${ROOT_DIR}/scripts/bootstrap-freebsd-generate-legacy-codegen.mjs"
BUILD_TYPE="${BUN_FREEBSD_CMAKE_BUILD_TYPE:-Release}"
BUILD_DIR_DEFAULT_SUFFIX="$(printf '%s' "${BUILD_TYPE}" | tr '[:upper:]' '[:lower:]')"
if [[ -z "${BUN_FREEBSD_BUILD_DIR:-}" ]]; then
  BUILD_DIR="${ROOT_DIR}/build/${BUILD_DIR_DEFAULT_SUFFIX}"
fi
FINAL_TARGET="${BUN_FREEBSD_BUILD_TARGET:-}"
if [[ -z "${FINAL_TARGET}" ]]; then
  if [[ "${BUILD_TYPE}" == "Debug" ]]; then
    FINAL_TARGET="bun-debug"
  else
    FINAL_TARGET="bun"
  fi
fi
CURRENT_ZIG="${BUN_FREEBSD_CURRENT_ZIG:-}"
if [[ -z "${CURRENT_ZIG}" ]]; then
  # Current Bun tree requires the Oven Zig fork. Prefer the locally-built stage3 binary if present
  # so strict bootstrap reruns do not accidentally use /usr/local/bin/zig.
  OVEN_ZIG_STAGE3_DEFAULT="${BOOTSTRAP_DIR}/oven-zig/build-freebsd/stage3/bin/zig"
  if [[ -x "${OVEN_ZIG_STAGE3_DEFAULT}" ]]; then
    CURRENT_ZIG="${OVEN_ZIG_STAGE3_DEFAULT}"
  else
    CURRENT_ZIG="zig"
  fi
fi
CURRENT_ZIG_LIB_DIR="${BUN_FREEBSD_CURRENT_ZIG_LIB_DIR:-}"
CFG_FREEBSD_BINDGENV2_NODE="${BUN_FREEBSD_BINDGENV2_NODE:-1}"
CFG_FREEBSD_GENERATE_CLASSES_NODE="${BUN_FREEBSD_GENERATE_CLASSES_NODE:-1}"
CFG_FREEBSD_CODEGEN_NODE="${BUN_FREEBSD_CODEGEN_NODE:-1}"
CFG_FREEBSD_NPM_INSTALL="${BUN_FREEBSD_NPM_INSTALL:-1}"
LEGACY_MAKE_JOBS="${BUN_FREEBSD_MAKE_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 1)}"
LEGACY_BUILD_OBJ_TARGET="${BUN_FREEBSD_LEGACY_BUILD_OBJ_TARGET:-build-obj-safe}"

if [[ ! "${LEGACY_MAKE_JOBS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: BUN_FREEBSD_MAKE_JOBS must be a positive integer (got '${LEGACY_MAKE_JOBS}')" >&2
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: missing command '$1'" >&2
    exit 1
  fi
}

require_cmd git
require_cmd cmake
require_cmd ninja
require_cmd gmake
require_cmd node
require_cmd npm
require_cmd perl
require_cmd python3
require_cmd clang
require_cmd clang++
require_cmd zig

zig_is_013() {
  local zig_bin="$1"
  local version
  version="$(${zig_bin} version 2>/dev/null || true)"
  [[ "${version}" == 0.13.* ]]
}

pick_legacy_zig() {
  if [[ -n "${LEGACY_ZIG}" ]]; then
    if ! command -v "${LEGACY_ZIG}" >/dev/null 2>&1; then
      echo "error: BUN_FREEBSD_LEGACY_ZIG was set but not found: ${LEGACY_ZIG}" >&2
      exit 1
    fi
    if ! zig_is_013 "${LEGACY_ZIG}"; then
      echo "error: ${LEGACY_ZIG} is not Zig 0.13.x (required for ${LEGACY_COMMIT})" >&2
      "${LEGACY_ZIG}" version >&2 || true
      exit 1
    fi
    return 0
  fi

  if command -v zig013 >/dev/null 2>&1; then
    LEGACY_ZIG="zig013"
    return 0
  fi

  if command -v zig >/dev/null 2>&1 && zig_is_013 zig; then
    LEGACY_ZIG="zig"
    return 0
  fi

  cat >&2 <<EOF2
error: missing Zig 0.13.x for cold-start commit ${LEGACY_COMMIT}
This bootstrap path does not compile with Zig 0.14+.

FreeBSD pkg currently provides:
  zig-0.15.2
  zig014-0.14.0

Please install Zig 0.13.0 manually and expose it as 'zig013', e.g.:
  sudo mkdir -p /opt
  # unpack zig 0.13.0 into /opt (offline/manual)
  sudo ln -sf /opt/zig-freebsd-x86_64-0.13.0/zig /usr/local/bin/zig013

Or point directly to it:
  BUN_FREEBSD_LEGACY_ZIG=/absolute/path/to/zig-0.13.0 ${0##*/}
EOF2
  exit 1
}

resolve_legacy_commit() {
  git -C "${ROOT_DIR}" rev-parse --verify "${LEGACY_COMMIT}^{commit}"
}

resolve_legacy_webkit_commit() {
  local cmakelists="${LEGACY_WORKTREE}/CMakeLists.txt"
  if [[ -f "${cmakelists}" ]]; then
    local cmake_tag
    cmake_tag="$(
      awk '/set\(WEBKIT_TAG [0-9a-f]{40}\)/ { tag=$2; gsub("\\)", "", tag); print tag; exit }' \
        "${cmakelists}"
    )"
    if [[ -n "${cmake_tag}" ]]; then
      echo "${cmake_tag}"
      return 0
    fi
  fi

  local gitlink_commit
  gitlink_commit="$(git -C "${LEGACY_WORKTREE}" ls-tree HEAD src/bun.js/WebKit | awk '{print $3}')"
  if [[ -z "${gitlink_commit}" ]]; then
    echo "error: failed to resolve legacy WebKit commit from ${LEGACY_WORKTREE}" >&2
    exit 1
  fi
  echo "${gitlink_commit}"
}

resolve_current_webkit_commit() {
  local setup_cmake="${ROOT_DIR}/cmake/tools/SetupWebKit.cmake"
  local webkit_commit
  webkit_commit="$(
    awk '/set\(WEBKIT_VERSION [0-9a-f]{40}\)/ { version=$2; gsub("\\)", "", version); print version; exit }' \
      "${setup_cmake}"
  )"
  if [[ -z "${webkit_commit}" ]]; then
    echo "error: failed to parse WEBKIT_VERSION from ${setup_cmake}" >&2
    exit 1
  fi
  echo "${webkit_commit}"
}

read_packaged_webkit_commit() {
  local package_dir="$1"
  local cmakeconfig="${package_dir}/include/cmakeconfig.h"
  if [[ -f "${cmakeconfig}" ]]; then
    local commit
    commit="$(awk -F'"' '/^#define BUN_WEBKIT_VERSION "/ { print $2; exit }' "${cmakeconfig}")"
    if [[ -n "${commit}" ]]; then
      echo "${commit}"
      return 0
    fi
  fi
  return 1
}

ensure_webkit_source_checkout() {
  local source_dir="$1"
  local expected_commit="$2"
  local label="$3"

  if [[ ! -d "${WEBKIT_REPO_SOURCE}/.git" ]]; then
    echo "error: missing WebKit git repository at ${WEBKIT_REPO_SOURCE}" >&2
    echo "  set BUN_FREEBSD_WEBKIT_REPO_SOURCE=/path/to/WebKit clone" >&2
    exit 1
  fi

  if ! git -C "${WEBKIT_REPO_SOURCE}" cat-file -e "${expected_commit}^{commit}" >/dev/null 2>&1; then
    cat >&2 <<EOF2
error: ${label} WebKit commit ${expected_commit} is not available in ${WEBKIT_REPO_SOURCE}

Please fetch this commit in the local WebKit clone (offline/manual as needed), then retry.
EOF2
    exit 1
  fi

  if [[ -e "${source_dir}/.git" ]]; then
    local current_commit
    current_commit="$(git -C "${source_dir}" rev-parse HEAD)"
    if [[ "${current_commit}" == "${expected_commit}" ]]; then
      echo "[bootstrap] using cached ${label} WebKit source checkout: ${source_dir} (${expected_commit})"
      return 0
    fi
  fi

  echo "[bootstrap] preparing ${label} WebKit source checkout at ${source_dir} (${expected_commit})"
  rm -rf "${source_dir}"
  git -C "${WEBKIT_REPO_SOURCE}" worktree prune
  git -C "${WEBKIT_REPO_SOURCE}" worktree add --detach -f "${source_dir}" "${expected_commit}"
}

apply_patch_if_needed() {
  local patch_file="$1"
  local patch_label="$2"

  if git -C "${LEGACY_WORKTREE}" apply --check --whitespace=nowarn "${patch_file}" >/dev/null 2>&1; then
    echo "[bootstrap] applying ${patch_label}"
    git -C "${LEGACY_WORKTREE}" apply --whitespace=nowarn "${patch_file}"
    return 0
  fi

  if git -C "${LEGACY_WORKTREE}" apply --reverse --check --whitespace=nowarn "${patch_file}" >/dev/null 2>&1; then
    echo "[bootstrap] skipping ${patch_label} (already applied)"
    return 0
  fi

  echo "error: ${patch_label} does not apply to ${LEGACY_WORKTREE} HEAD ($(git -C "${LEGACY_WORKTREE}" rev-parse --short HEAD))" >&2
  echo "  patch: ${patch_file}" >&2
  exit 1
}

patch_legacy_worktree_for_freebsd() {
  local makefile_file="${LEGACY_WORKTREE}/Makefile"
  local makefile_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-makefile.patch"
  if [[ -f "${makefile_file}" ]] && grep -q "release-only: release-bindings build-obj" "${makefile_file}"; then
    if [[ ! -f "${makefile_patch}" ]]; then
      echo "error: missing patch file: ${makefile_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${makefile_patch}" "FreeBSD legacy Makefile compatibility patch"
  fi

  local lshpack_include_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-lshpack-include.patch"
  if [[ -f "${makefile_file}" ]] && grep -q 'INCLUDE_DIRS += -I/usr/local/include' "${makefile_file}" && ! grep -q 'INCLUDE_DIRS += -I$(BUN_DEPS_DIR)/ls-hpack' "${makefile_file}"; then
    if [[ ! -f "${lshpack_include_patch}" ]]; then
      echo "error: missing patch file: ${lshpack_include_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${lshpack_include_patch}" "FreeBSD ls-hpack include compatibility patch"
  fi

  local makefile_link_libs_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-makefile-link-libs.patch"
  if [[ -f "${makefile_file}" ]] && ! grep -q 'ARCHIVE_FILES += -ldeflate -lmd' "${makefile_file}"; then
    if [[ ! -f "${makefile_link_libs_patch}" ]]; then
      echo "error: missing patch file: ${makefile_link_libs_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${makefile_link_libs_patch}" "FreeBSD legacy Makefile link-libs patch"
  fi

  local makefile_v8_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-makefile-v8.patch"
  if [[ -f "${makefile_file}" ]] && ! grep -q '^SRC_V8_FILES :=' "${makefile_file}"; then
    if [[ ! -f "${makefile_v8_patch}" ]]; then
      echo "error: missing patch file: ${makefile_v8_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${makefile_v8_patch}" "FreeBSD legacy Makefile V8 object patch"
  fi

  local build_zig_file="${LEGACY_WORKTREE}/build.zig"
  local build_zig_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-build-zig.patch"
  if [[ -f "${build_zig_file}" ]] && grep -q "Unsupported OS tag" "${build_zig_file}"; then
    if [[ ! -f "${build_zig_patch}" ]]; then
      echo "error: missing patch file: ${build_zig_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${build_zig_patch}" "FreeBSD legacy build.zig compatibility patch"
  fi

  local build_zig_strip_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-build-zig-strip.patch"
  if [[ -f "${build_zig_file}" ]] && grep -q 'strip = false, // stripped at the end' "${build_zig_file}"; then
    if [[ ! -f "${build_zig_strip_patch}" ]]; then
      echo "error: missing patch file: ${build_zig_strip_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${build_zig_strip_patch}" "FreeBSD legacy build.zig strip workaround"
  fi

  local env_zig_file="${LEGACY_WORKTREE}/src/env.zig"
  local env_zig_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-env.patch"
  if [[ -f "${env_zig_file}" ]] && grep -q "pub const isLinux" "${env_zig_file}"; then
    if [[ ! -f "${env_zig_patch}" ]]; then
      echo "error: missing patch file: ${env_zig_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${env_zig_patch}" "FreeBSD legacy env.zig compatibility patch"
  fi

  local process_zig_file="${LEGACY_WORKTREE}/src/bun.js/api/bun/process.zig"
  local spawn_flags_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-spawn-flags.patch"
  if [[ -f "${process_zig_file}" ]] && grep -q "var flags: i32 = bun.C.POSIX_SPAWN_SETSIGDEF | bun.C.POSIX_SPAWN_SETSIGMASK;" "${process_zig_file}"; then
    if [[ ! -f "${spawn_flags_patch}" ]]; then
      echo "error: missing patch file: ${spawn_flags_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${spawn_flags_patch}" "FreeBSD legacy posix_spawn flag compatibility patch"
  fi

  local sync_watch_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-sync-watch.patch"
  if [[ -f "${process_zig_file}" ]] \
    && grep -q "pub fn watchOrReap(this: \\*Process) JSC.Maybe(bool)" "${process_zig_file}" \
    && ! grep -q "FreeBSD stage0 currently builds through the legacy Linux event-loop path." "${process_zig_file}"; then
    if [[ ! -f "${sync_watch_patch}" ]]; then
      echo "error: missing patch file: ${sync_watch_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${sync_watch_patch}" "FreeBSD legacy sync subprocess wait compatibility patch"
  fi

  local waiter_thread_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-waiter-thread-default.patch"
  if [[ -f "${process_zig_file}" ]] \
    && grep -q "var should_use_waiter_thread = false;" "${process_zig_file}"; then
    if [[ ! -f "${waiter_thread_patch}" ]]; then
      echo "error: missing patch file: ${waiter_thread_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${waiter_thread_patch}" "FreeBSD legacy waiter-thread default patch"
  fi

  local prim_file="${LEGACY_WORKTREE}/src/deps/mimalloc/src/prim/unix/prim.c"
  if [[ -f "${prim_file}" ]] && grep -q 'try_alignment, hint);' "${prim_file}"; then
    # FreeBSD/MAP_ALIGNED path in this historical tree logs `hint` before declaration.
    sed -i '' 's/try_alignment, hint);/try_alignment, addr);/g' "${prim_file}"
  fi

  local usockets_internal_h="${LEGACY_WORKTREE}/packages/bun-usockets/src/internal/internal.h"
  local usockets_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-bun-usockets.patch"
  if [[ -f "${usockets_internal_h}" ]] && grep -q '^#if defined(LIBUS_USE_KQUEUE)$' "${usockets_internal_h}"; then
    if [[ ! -f "${usockets_patch}" ]]; then
      echo "error: missing patch file: ${usockets_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${usockets_patch}" "FreeBSD bun-usockets compatibility patch"
  fi

  local usockets_epoll_h="${LEGACY_WORKTREE}/packages/bun-usockets/src/internal/eventing/epoll_kqueue.h"
  local usockets_kevent_nowait_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-bun-usockets-kevent-nowait.patch"
  if [[ -f "${usockets_epoll_h}" ]] \
    && grep -q '(void)flags;' "${usockets_epoll_h}" \
    && ! grep -q 'effective_timeout = timeout' "${usockets_epoll_h}"; then
    if [[ ! -f "${usockets_kevent_nowait_patch}" ]]; then
      echo "error: missing patch file: ${usockets_kevent_nowait_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${usockets_kevent_nowait_patch}" "FreeBSD bun-usockets kevent no-wait patch"
  fi

  local identifier_data_file="${LEGACY_WORKTREE}/src/js_lexer/identifier_data.zig"
  local identifier_data_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-identifier-data.patch"
  if [[ -f "${identifier_data_file}" ]] && grep -Fq 'std.fs.path.dirname(@src().file).?' "${identifier_data_file}"; then
    if [[ ! -f "${identifier_data_patch}" ]]; then
      echo "error: missing patch file: ${identifier_data_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${identifier_data_patch}" "FreeBSD identifier-cache compatibility patch"
  fi

  local bun_process_file="${LEGACY_WORKTREE}/src/bun.js/bindings/BunProcess.cpp"
  local bun_process_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-bun-process.patch"
  if [[ -f "${bun_process_file}" ]] && grep -q '#error "Unknown platform"' "${bun_process_file}"; then
    if [[ ! -f "${bun_process_patch}" ]]; then
      echo "error: missing patch file: ${bun_process_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${bun_process_patch}" "FreeBSD BunProcess compatibility patch"
  fi

  local c_bindings_file="${LEGACY_WORKTREE}/src/bun.js/bindings/c-bindings.cpp"
  local c_bindings_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-c-bindings.patch"
  if [[ -f "${c_bindings_file}" ]] && grep -q 'OS(FreeBSD)' "${c_bindings_file}"; then
    if [[ ! -f "${c_bindings_patch}" ]]; then
      echo "error: missing patch file: ${c_bindings_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${c_bindings_patch}" "FreeBSD c-bindings compatibility patch"
  fi

  local c_bindings_reload_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-c-bindings-reload.patch"
  if [[ ! -f "${c_bindings_reload_patch}" ]]; then
    echo "error: missing patch file: ${c_bindings_reload_patch}" >&2
    exit 1
  fi
  apply_patch_if_needed "${c_bindings_reload_patch}" "FreeBSD c-bindings reload hook patch"

  # Additional legacy FreeBSD compatibility deltas required for a fresh worktree.
  local legacy_extra_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-legacy-extra-compat.patch"
  if [[ ! -f "${legacy_extra_patch}" ]]; then
    echo "error: missing patch file: ${legacy_extra_patch}" >&2
    exit 1
  fi
  apply_patch_if_needed "${legacy_extra_patch}" "FreeBSD legacy extra compatibility patch"

  local read_syscalls_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-read-syscalls.patch"
  local sys_zig_file="${LEGACY_WORKTREE}/src/sys.zig"
  if [[ -f "${sys_zig_file}" ]] \
    && grep -q "list.unusedCapacitySlice" "${sys_zig_file}"; then
    if [[ ! -f "${read_syscalls_patch}" ]]; then
      echo "error: missing patch file: ${read_syscalls_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${read_syscalls_patch}" "FreeBSD legacy read syscall compatibility patch"
  fi

  local zig_freebsd_file="${LEGACY_WORKTREE}/src/deps/zig/lib/std/c/freebsd.zig"
  local zig_freebsd_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-zig-stdlib-freebsd.patch"
  if [[ -f "${zig_freebsd_file}" ]] \
    && ! grep -q 'pub const rusage = extern struct' "${zig_freebsd_file}"; then
    if [[ ! -f "${zig_freebsd_patch}" ]]; then
      echo "error: missing patch file: ${zig_freebsd_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${zig_freebsd_patch}" "FreeBSD legacy zig stdlib freebsd declarations patch"
  fi

  local cache_file="${LEGACY_WORKTREE}/src/cache.zig"
  local cache_null_slice_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-cache-null-slice.patch"
  if [[ -f "${cache_file}" ]] \
    && grep -q 'allocator.free(entry.contents);' "${cache_file}"; then
    if [[ ! -f "${cache_null_slice_patch}" ]]; then
      echo "error: missing patch file: ${cache_null_slice_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${cache_null_slice_patch}" "FreeBSD legacy cache null-slice guard patch"
  fi

  local bundler_parse_file="${LEGACY_WORKTREE}/src/bundler/bundle_v2.zig"
  local bundler_parse_recover_patch="${ROOT_DIR}/scripts/patches/freebsd-stage0-bundler-parse-recover.patch"
  if [[ -f "${bundler_parse_file}" ]] \
    && ! grep -q 're-reading file after malformed cache entry' "${bundler_parse_file}"; then
    if [[ ! -f "${bundler_parse_recover_patch}" ]]; then
      echo "error: missing patch file: ${bundler_parse_recover_patch}" >&2
      exit 1
    fi
    apply_patch_if_needed "${bundler_parse_recover_patch}" "FreeBSD legacy bundler parse cache-recover patch"
  fi

}

generate_legacy_codegen_files() {
  if [[ ! -f "${LEGACY_CODEGEN_HELPER}" ]]; then
    echo "error: missing codegen helper: ${LEGACY_CODEGEN_HELPER}" >&2
    exit 1
  fi

  echo "[bootstrap] generating legacy codegen files without host bun"
  node "${LEGACY_CODEGEN_HELPER}" "${LEGACY_WORKTREE}" "${LEGACY_WORKTREE}/build/codegen"
}

sync_legacy_codegen_outputs() {
  echo "[bootstrap] syncing generated legacy codegen outputs"

  local codegen_dir="${LEGACY_WORKTREE}/build/codegen"
  local bindings_dir="${LEGACY_WORKTREE}/src/bun.js/bindings"
  local builtins_dir="${LEGACY_WORKTREE}/src/js/builtins"
  local src_dir="${LEGACY_WORKTREE}/src"

  if [[ ! -d "${codegen_dir}" ]]; then
    echo "error: missing generated codegen directory: ${codegen_dir}" >&2
    exit 1
  fi

  local generated_files=(
    "ZigGeneratedClasses.h"
    "ZigGeneratedClasses.cpp"
    "ZigGeneratedClasses.zig"
    "ZigGeneratedClasses+DOMClientIsoSubspaces.h"
    "ZigGeneratedClasses+DOMIsoSubspaces.h"
    "ZigGeneratedClasses+lazyStructureHeader.h"
    "ZigGeneratedClasses+lazyStructureImpl.h"
    "SyntheticModuleType.h"
    "InternalModuleRegistry+createInternalModuleById.h"
    "InternalModuleRegistryConstants.h"
    "InternalModuleRegistry+enum.h"
    "InternalModuleRegistry+numberOfModules.h"
    "NativeModuleImpl.h"
    "GeneratedJS2Native.h"
    "BunObject.lut.h"
    "ZigGlobalObject.lut.h"
    "JSBuffer.lut.h"
    "BunProcess.lut.h"
    "ProcessBindingConstants.lut.h"
    "ProcessBindingNatives.lut.h"
    "JSSink.h"
    "JSSink.cpp"
    "JSSink.lut.h"
  )

  mkdir -p "${bindings_dir}"
  mkdir -p "${builtins_dir}"
  for name in "${generated_files[@]}"; do
    if [[ -f "${codegen_dir}/${name}" ]]; then
      cp "${codegen_dir}/${name}" "${bindings_dir}/${name}"
    fi
  done

  if [[ -f "${codegen_dir}/ResolvedSourceTag.zig" ]]; then
    cp "${codegen_dir}/ResolvedSourceTag.zig" "${src_dir}/ResolvedSourceTag.zig"
  fi
  if [[ -f "${codegen_dir}/ErrorCode.zig" ]]; then
    cp "${codegen_dir}/ErrorCode.zig" "${src_dir}/ErrorCode.zig"
  fi
  if [[ -f "${codegen_dir}/ErrorCode+Data.h" ]]; then
    cp "${codegen_dir}/ErrorCode+Data.h" "${bindings_dir}/ErrorCode+Data.h"
  fi
  if [[ -f "${codegen_dir}/ErrorCode+List.h" ]]; then
    cp "${codegen_dir}/ErrorCode+List.h" "${bindings_dir}/ErrorCode+List.h"
  fi
  if [[ -f "${codegen_dir}/WebCoreJSBuiltins.h" ]]; then
    cp "${codegen_dir}/WebCoreJSBuiltins.h" "${bindings_dir}/WebCoreJSBuiltins.h"
  fi
  if [[ -f "${codegen_dir}/WebCoreJSBuiltins.cpp" ]]; then
    cp "${codegen_dir}/WebCoreJSBuiltins.cpp" "${bindings_dir}/WebCoreJSBuiltins.cpp"
  fi
  if [[ -f "${codegen_dir}/BunBuiltinNames+extras.h" ]]; then
    cp "${codegen_dir}/BunBuiltinNames+extras.h" "${builtins_dir}/BunBuiltinNames+extras.h"
  fi
}

clean_legacy_codegen_outputs() {
  local codegen_dir="${LEGACY_WORKTREE}/build/codegen"
  local bindings_dir="${LEGACY_WORKTREE}/src/bun.js/bindings"
  local builtins_dir="${LEGACY_WORKTREE}/src/js/builtins"
  local src_dir="${LEGACY_WORKTREE}/src"

  rm -rf "${codegen_dir}"

  local generated_files=(
    "ZigGeneratedClasses.h"
    "ZigGeneratedClasses.cpp"
    "ZigGeneratedClasses.zig"
    "ZigGeneratedClasses+DOMClientIsoSubspaces.h"
    "ZigGeneratedClasses+DOMIsoSubspaces.h"
    "ZigGeneratedClasses+lazyStructureHeader.h"
    "ZigGeneratedClasses+lazyStructureImpl.h"
    "SyntheticModuleType.h"
    "InternalModuleRegistry+createInternalModuleById.h"
    "InternalModuleRegistryConstants.h"
    "InternalModuleRegistry+enum.h"
    "InternalModuleRegistry+numberOfModules.h"
    "NativeModuleImpl.h"
    "GeneratedJS2Native.h"
    "BunObject.lut.h"
    "ZigGlobalObject.lut.h"
    "JSBuffer.lut.h"
    "BunProcess.lut.h"
    "ProcessBindingConstants.lut.h"
    "ProcessBindingNatives.lut.h"
    "JSSink.h"
    "JSSink.cpp"
    "JSSink.lut.h"
    "ErrorCode+Data.h"
    "ErrorCode+List.h"
    "WebCoreJSBuiltins.h"
    "WebCoreJSBuiltins.cpp"
  )

  for name in "${generated_files[@]}"; do
    rm -f "${bindings_dir}/${name}"
  done

  rm -f "${builtins_dir}/BunBuiltinNames+extras.h"
  rm -f "${src_dir}/ResolvedSourceTag.zig" "${src_dir}/ErrorCode.zig"
}

validate_stage0_runtime() {
  local bin="$1"

  if [[ ! -x "${bin}" ]]; then
    return 1
  fi

  if ! "${bin}" --version >/dev/null 2>&1; then
    return 1
  fi

  if ! "${bin}" -e 'console.log(1+1)' >/dev/null 2>&1; then
    return 1
  fi

  if ! "${bin}" -e 'import fs from "node:fs"; console.log(typeof fs.readFile)' >/dev/null 2>&1; then
    return 1
  fi

  return 0
}

pick_legacy_ar() {
  if command -v llvm-ar >/dev/null 2>&1; then
    command -v llvm-ar
    return 0
  fi
  if command -v ar >/dev/null 2>&1; then
    command -v ar
    return 0
  fi
  echo "error: missing ar" >&2
  exit 1
}

pick_legacy_ranlib() {
  if command -v llvm-ranlib >/dev/null 2>&1; then
    command -v llvm-ranlib
    return 0
  fi
  if command -v ranlib >/dev/null 2>&1; then
    command -v ranlib
    return 0
  fi
  echo "error: missing ranlib" >&2
  exit 1
}

LEGACY_COMMIT_SHA="$(resolve_legacy_commit)"
CURRENT_WEBKIT_COMMIT="$(resolve_current_webkit_commit)"
NPM_CLIENT_OVERRIDE="$(command -v npm) --legacy-peer-deps --include=dev"
CURRENT_ZIG_BIN="$(command -v "${CURRENT_ZIG}" 2>/dev/null || true)"
if [[ -z "${CURRENT_ZIG_BIN}" ]]; then
  echo "error: current-tree zig not found: ${CURRENT_ZIG}" >&2
  exit 1
fi

resolve_current_zig_lib_dir() {
  local zig_bin="$1"
  local inferred

  if [[ -n "${CURRENT_ZIG_LIB_DIR}" ]]; then
    echo "${CURRENT_ZIG_LIB_DIR}"
    return 0
  fi

  inferred="$(cd "$(dirname "${zig_bin}")/../../.." && pwd)/lib"
  if [[ -f "${inferred}/std/std.zig" ]]; then
    echo "${inferred}"
    return 0
  fi

  echo ""
}

user_supplied_current_webkit_path() {
  for arg in "$@"; do
    case "${arg}" in
      -DWEBKIT_PATH=*|-DWEBKIT_LOCAL=*)
        return 0
        ;;
    esac
  done
  return 1
}

ensure_current_zig_cache_fingerprint() {
  local zig_bin="$1"
  local cache_root="${BUILD_DIR}/cache/zig"
  local stamp="${cache_root}/compiler-fingerprint.txt"
  local stamp_new="${stamp}.new"
  local zig_realpath
  local zig_version
  local zig_sha

  mkdir -p "${cache_root}"
  zig_realpath="$(realpath "${zig_bin}" 2>/dev/null || echo "${zig_bin}")"
  zig_version="$("${zig_bin}" version 2>/dev/null || echo unknown)"
  zig_sha="$(sha256 -q "${zig_bin}" 2>/dev/null || echo unavailable)"

  cat >"${stamp_new}" <<EOF2
zig_cmd=${CURRENT_ZIG}
zig_bin=${zig_bin}
zig_realpath=${zig_realpath}
zig_version=${zig_version}
zig_sha256=${zig_sha}
EOF2

  if [[ -f "${stamp}" ]] && ! cmp -s "${stamp}" "${stamp_new}"; then
    echo "[bootstrap] zig compiler fingerprint changed; resetting ${cache_root}/{local,global}"
    rm -rf "${cache_root}/local" "${cache_root}/global"
  fi

  mv "${stamp_new}" "${stamp}"
}

ensure_freebsd_webkit_package() {
  local package_dir="$1"
  local expected_commit="$2"
  local package_label="$3"
  local webkit_source_override="$4"
  local require_simdutf="${5:-1}"
  local commit_short="${expected_commit:0:12}"
  local webkit_build_dir="${package_dir}-build-${commit_short}"
  local packaged_commit=""
  local package_ready=0

  if [[ -f "${package_dir}/lib/libJavaScriptCore.a" \
    && -f "${package_dir}/lib/libWTF.a" ]]; then
    package_ready=1
  fi

  if [[ "${package_ready}" == "1" && "${require_simdutf}" == "1" && ! -f "${package_dir}/include/wtf/SIMDUTF.h" ]]; then
    package_ready=0
  fi

  if [[ "${package_ready}" == "1" ]]; then
    packaged_commit="$(read_packaged_webkit_commit "${package_dir}" || true)"
    if [[ -n "${packaged_commit}" && "${packaged_commit}" == "${expected_commit}" ]]; then
      echo "[bootstrap] using cached ${package_label} WebKit package: ${package_dir} (${packaged_commit})"
      return 0
    fi

    if [[ -z "${packaged_commit}" ]]; then
      echo "[bootstrap] cached ${package_label} WebKit package is missing BUN_WEBKIT_VERSION metadata: ${package_dir}"
    else
      echo "[bootstrap] cached ${package_label} WebKit package commit mismatch:"
      echo "  expected: ${expected_commit}"
      echo "  actual:   ${packaged_commit}"
    fi
  fi

  echo "[bootstrap] preparing ${package_label} FreeBSD WebKit package (${expected_commit})"
  if [[ -n "${webkit_source_override}" ]]; then
    BUN_FREEBSD_WEBKIT_SOURCE="${webkit_source_override}" \
      BUN_FREEBSD_WEBKIT_BUILD_DIR="${webkit_build_dir}" \
      BUN_FREEBSD_WEBKIT_OUT_DIR="${package_dir}" \
      BUN_FREEBSD_WEBKIT_COMMIT="${expected_commit}" \
      BUN_FREEBSD_WEBKIT_REQUIRE_SIMDUTF="${require_simdutf}" \
      "${ROOT_DIR}/scripts/prepare-webkit-freebsd.sh"
  else
    BUN_FREEBSD_WEBKIT_BUILD_DIR="${webkit_build_dir}" \
    BUN_FREEBSD_WEBKIT_OUT_DIR="${package_dir}" \
      BUN_FREEBSD_WEBKIT_COMMIT="${expected_commit}" \
      BUN_FREEBSD_WEBKIT_REQUIRE_SIMDUTF="${require_simdutf}" \
      "${ROOT_DIR}/scripts/prepare-webkit-freebsd.sh"
  fi
}

ensure_legacy_worktree() {
  if [[ -e "${LEGACY_WORKTREE}/.git" ]]; then
    local current_sha
    current_sha="$(git -C "${LEGACY_WORKTREE}" rev-parse HEAD)"
    if [[ "${current_sha}" != "${LEGACY_COMMIT_SHA}" ]]; then
      echo "[bootstrap] removing stale legacy worktree at ${LEGACY_WORKTREE}"
      rm -rf "${LEGACY_WORKTREE}"
      git -C "${ROOT_DIR}" worktree prune
    fi
  fi

  if [[ ! -e "${LEGACY_WORKTREE}/.git" ]]; then
    echo "[bootstrap] creating legacy worktree at ${LEGACY_WORKTREE} (${LEGACY_COMMIT_SHA})"
    git -C "${ROOT_DIR}" worktree add --detach -f "${LEGACY_WORKTREE}" "${LEGACY_COMMIT_SHA}"
  fi
}

mkdir -p "${BOOTSTRAP_DIR}" "${STAGE0_DIR}" "${SHIM_BIN_DIR}"
ln -sf "$(command -v gmake)" "${SHIM_BIN_DIR}/make"

STAGE0_REBUILD_REASON=""
if [[ -x "${STAGE0_BIN}" ]]; then
  if ! validate_stage0_runtime "${STAGE0_BIN}"; then
    STAGE0_REBUILD_REASON="existing stage0 failed runtime validation"
  fi
else
  STAGE0_REBUILD_REASON="stage0 binary missing"
fi

if [[ -n "${STAGE0_REBUILD_REASON}" ]]; then
  echo "[bootstrap] rebuilding stage0: ${STAGE0_REBUILD_REASON}"
  pick_legacy_zig
  LEGACY_ZIG_BIN="$(command -v "${LEGACY_ZIG}")"
  LEGACY_AR="$(pick_legacy_ar)"
  LEGACY_RANLIB="$(pick_legacy_ranlib)"
  ln -sf "${LEGACY_ZIG_BIN}" "${SHIM_BIN_DIR}/zig"

  if [[ "${BUN_FREEBSD_ALLOW_DOWNLOADS:-0}" != "1" ]]; then
    cat >&2 <<EOF2
error: cold-start build may fetch git submodules, npm packages, and vendored deps.
Set BUN_FREEBSD_ALLOW_DOWNLOADS=1 to proceed intentionally.
EOF2
    exit 1
  fi

  ensure_legacy_worktree
  LEGACY_WEBKIT_COMMIT="${BUN_FREEBSD_LEGACY_WEBKIT_COMMIT:-$(resolve_legacy_webkit_commit)}"
  ensure_webkit_source_checkout "${LEGACY_WEBKIT_SOURCE}" "${LEGACY_WEBKIT_COMMIT}" "legacy stage0"
  patch_legacy_worktree_for_freebsd
  ensure_freebsd_webkit_package "${LEGACY_WEBKIT_DIR}" "${LEGACY_WEBKIT_COMMIT}" "legacy stage0" "${LEGACY_WEBKIT_SOURCE}" "1"
  mkdir -p "${LEGACY_WORKTREE}/build/bun-deps"

  LEGACY_UWS_LDFLAGS="-I${LEGACY_WORKTREE}/src/deps/boringssl/include -I${LEGACY_WORKTREE}/src/deps/zlib -I${LEGACY_WORKTREE}/src/deps/libdeflate -I${LEGACY_WORKTREE}/src/deps/ls-hpack -I${LEGACY_WEBKIT_DIR}/include"

  echo "[bootstrap] building stage0 from legacy source tree"
  echo "[bootstrap] legacy vendor step parallelism: -j1"
  echo "[bootstrap] legacy build parallelism: -j${LEGACY_MAKE_JOBS}"
  echo "[bootstrap] legacy zig object target: ${LEGACY_BUILD_OBJ_TARGET}"
  (
    cd "${LEGACY_WORKTREE}"
    PATH="${SHIM_BIN_DIR}:${PATH}" \
      gmake -j1 AR="${LEGACY_AR}" RANLIB="${LEGACY_RANLIB}" ZIG="${LEGACY_ZIG_BIN}" NPM_CLIENT="${NPM_CLIENT_OVERRIDE}" UWS_LDFLAGS="${LEGACY_UWS_LDFLAGS}" JSC_BASE_DIR="${LEGACY_WEBKIT_DIR}" vendor

    patch_legacy_worktree_for_freebsd
    clean_legacy_codegen_outputs
    generate_legacy_codegen_files
    sync_legacy_codegen_outputs

    PATH="${SHIM_BIN_DIR}:${PATH}" \
      gmake -j"${LEGACY_MAKE_JOBS}" AR="${LEGACY_AR}" RANLIB="${LEGACY_RANLIB}" ZIG="${LEGACY_ZIG_BIN}" NPM_CLIENT="${NPM_CLIENT_OVERRIDE}" UWS_LDFLAGS="${LEGACY_UWS_LDFLAGS}" JSC_BASE_DIR="${LEGACY_WEBKIT_DIR}" identifier-cache

    PATH="${SHIM_BIN_DIR}:${PATH}" \
      gmake -j"${LEGACY_MAKE_JOBS}" AR="${LEGACY_AR}" RANLIB="${LEGACY_RANLIB}" ZIG="${LEGACY_ZIG_BIN}" NPM_CLIENT="${NPM_CLIENT_OVERRIDE}" UWS_LDFLAGS="${LEGACY_UWS_LDFLAGS}" JSC_BASE_DIR="${LEGACY_WEBKIT_DIR}" sqlite
    PATH="${SHIM_BIN_DIR}:${PATH}" \
      gmake -j"${LEGACY_MAKE_JOBS}" AR="${LEGACY_AR}" RANLIB="${LEGACY_RANLIB}" ZIG="${LEGACY_ZIG_BIN}" NPM_CLIENT="${NPM_CLIENT_OVERRIDE}" UWS_LDFLAGS="${LEGACY_UWS_LDFLAGS}" JSC_BASE_DIR="${LEGACY_WEBKIT_DIR}" release-bindings
    PATH="${SHIM_BIN_DIR}:${PATH}" \
      gmake -j"${LEGACY_MAKE_JOBS}" AR="${LEGACY_AR}" RANLIB="${LEGACY_RANLIB}" ZIG="${LEGACY_ZIG_BIN}" NPM_CLIENT="${NPM_CLIENT_OVERRIDE}" UWS_LDFLAGS="${LEGACY_UWS_LDFLAGS}" JSC_BASE_DIR="${LEGACY_WEBKIT_DIR}" "${LEGACY_BUILD_OBJ_TARGET}"
    PATH="${SHIM_BIN_DIR}:${PATH}" \
      gmake -j"${LEGACY_MAKE_JOBS}" AR="${LEGACY_AR}" RANLIB="${LEGACY_RANLIB}" ZIG="${LEGACY_ZIG_BIN}" NPM_CLIENT="${NPM_CLIENT_OVERRIDE}" UWS_LDFLAGS="${LEGACY_UWS_LDFLAGS}" JSC_BASE_DIR="${LEGACY_WEBKIT_DIR}" bun-link-lld-release
  )

  if [[ ! -x "${LEGACY_STAGE0}" ]]; then
    echo "error: expected stage0 binary not found at ${LEGACY_STAGE0}" >&2
    exit 1
  fi

  install -m 0755 "${LEGACY_STAGE0}" "${STAGE0_BIN}"
fi

echo "[bootstrap] stage0 ready: ${STAGE0_BIN}"
"${STAGE0_BIN}" --version
if ! validate_stage0_runtime "${STAGE0_BIN}"; then
  echo "error: stage0 runtime validation failed after build (${STAGE0_BIN})" >&2
  echo "  expected stage0 to run: --version, -e '1+1', and import node:fs" >&2
  exit 1
fi

CURRENT_ZIG_LIB_DIR="$(resolve_current_zig_lib_dir "${CURRENT_ZIG_BIN}")"
if [[ -n "${CURRENT_ZIG_LIB_DIR}" ]]; then
  if [[ ! -f "${CURRENT_ZIG_LIB_DIR}/std/std.zig" ]]; then
    echo "error: invalid current zig lib dir: ${CURRENT_ZIG_LIB_DIR}" >&2
    exit 1
  fi
  CURRENT_ZIG_WRAPPER="${SHIM_BIN_DIR}/zig-current"
  cat >"${CURRENT_ZIG_WRAPPER}" <<EOF2
#!/usr/bin/env sh
set -eu
zig_bin="${CURRENT_ZIG_BIN}"
zig_lib="${CURRENT_ZIG_LIB_DIR}"
cmd="\${1:-}"
if [ -z "\${cmd}" ]; then
  exec "\${zig_bin}"
fi
shift
case "\${cmd}" in
  build|build-exe|build-lib|build-obj|test|test-obj|run)
    exec "\${zig_bin}" "\${cmd}" --zig-lib-dir "\${zig_lib}" "\$@"
    ;;
  *)
    exec "\${zig_bin}" "\${cmd}" "\$@"
    ;;
esac
EOF2
  chmod 0755 "${CURRENT_ZIG_WRAPPER}"
  CURRENT_ZIG_BIN="${CURRENT_ZIG_WRAPPER}"
  echo "[bootstrap] current zig wrapper enabled with --zig-lib-dir=${CURRENT_ZIG_LIB_DIR}"
fi

ensure_current_zig_cache_fingerprint "${CURRENT_ZIG_BIN}"

if ! user_supplied_current_webkit_path "$@"; then
  ensure_webkit_source_checkout "${CURRENT_WEBKIT_SOURCE}" "${CURRENT_WEBKIT_COMMIT}" "current"
  ensure_freebsd_webkit_package "${CURRENT_WEBKIT_DIR}" "${CURRENT_WEBKIT_COMMIT}" "current" "${CURRENT_WEBKIT_SOURCE}" "1"
fi

echo "[bootstrap] configuring current tree"
echo "[bootstrap] FreeBSD fallback toggles: bindgenv2=${CFG_FREEBSD_BINDGENV2_NODE} generate_classes=${CFG_FREEBSD_GENERATE_CLASSES_NODE} codegen=${CFG_FREEBSD_CODEGEN_NODE} npm_install=${CFG_FREEBSD_NPM_INSTALL}"
BUN_FREEBSD_BINDGENV2_NODE="${CFG_FREEBSD_BINDGENV2_NODE}" \
BUN_FREEBSD_GENERATE_CLASSES_NODE="${CFG_FREEBSD_GENERATE_CLASSES_NODE}" \
BUN_FREEBSD_CODEGEN_NODE="${CFG_FREEBSD_CODEGEN_NODE}" \
BUN_FREEBSD_NPM_INSTALL="${CFG_FREEBSD_NPM_INSTALL}" \
cmake \
  -S "${ROOT_DIR}" \
  -B "${BUILD_DIR}" \
  -GNinja \
  -DCMAKE_BUILD_TYPE="${BUILD_TYPE}" \
  -DSKIP_CODEGEN=OFF \
  -DBUN_EXECUTABLE="${STAGE0_BIN}" \
  -DUSE_SYSTEM_ZIG=ON \
  -DZIG_EXECUTABLE="${CURRENT_ZIG_BIN}" \
  -DWEBKIT_PATH="${CURRENT_WEBKIT_DIR}" \
  "$@"

echo "[bootstrap] building ${FINAL_TARGET} (${BUILD_TYPE})"
if [[ "${CFG_FREEBSD_NPM_INSTALL}" == "0" ]]; then
  # FreeBSD stage0 no-fallback mode: some codegen targets (e.g. cppbind.ts) can run before Ninja's
  # root `bun install` edge, but still depend on root node_modules entries. Preinstall once here with
  # stage0 to make the build graph deterministic while keeping the package-manager path on stage0.
  #
  # Legacy FreeBSD stage0 package-manager/runtime can leave transitive @lezer/* deps only reachable
  # through nested symlinks under @lezer/cpp, but the same stage0 resolver used by cppbind.ts fails
  # to follow that path. We repair top-level symlinks after install so cppbind.ts can run without
  # Node fallback while we keep investigating the underlying resolver bug.
  echo "[bootstrap] preinstalling root dependencies with stage0 (no-fallback npm install mode)"
  (
    cd "${ROOT_DIR}"
    "${STAGE0_BIN}" install --frozen-lockfile

    mkdir -p node_modules/@lezer
    for lezer_pkg in common highlight lr; do
      lezer_store="$(echo "node_modules/.bun/@lezer+${lezer_pkg}@"* 2>/dev/null | awk '{print $1}')"
      if [[ -d "${lezer_store}/node_modules/@lezer/${lezer_pkg}" ]]; then
        ln -sfn "../.bun/$(basename "${lezer_store}")/node_modules/@lezer/${lezer_pkg}" "node_modules/@lezer/${lezer_pkg}"
      fi
    done
  )
fi

if [[ "${CFG_FREEBSD_CODEGEN_NODE}" == "0" ]]; then
  # Legacy FreeBSD stage0 can hang during teardown when bundle-modules.ts is launched by Ninja even
  # after it successfully generates all outputs. Running it once standalone avoids the in-Ninja exit
  # hang and leaves fresh outputs that Ninja can reuse.
  echo "[bootstrap] pregenerating bundled JS modules with stage0 (strict no-fallback codegen mode)"
  (
    cd "${ROOT_DIR}"
    local_codegen_build_root="${BUILD_DIR}"
    if [[ "${local_codegen_build_root}" == "${ROOT_DIR}/"* ]]; then
      local_codegen_build_root="${local_codegen_build_root#${ROOT_DIR}/}"
    fi
    BUN_FREEBSD_STAGE0_BUNDLER_BATCH_SIZE="${BUN_FREEBSD_STAGE0_BUNDLER_BATCH_SIZE:-1}" \
    BUN_FREEBSD_CODEGEN_TRACE="${BUN_FREEBSD_CODEGEN_TRACE:-1}" \
    "${STAGE0_BIN}" --no-install run "./src/codegen/bundle-modules.ts" --debug=OFF "${local_codegen_build_root}"
  )
fi

build_parallel_arg=()
if [[ "${CFG_FREEBSD_CODEGEN_NODE}" == "0" ]]; then
  # Legacy FreeBSD stage0 codegen can deadlock when Ninja launches multiple stage0 codegen scripts
  # concurrently (bundle-modules.ts + hash-table/jssink generators). Serialize the build in strict
  # no-fallback mode until the underlying multi-process stage0 deadlock is fixed.
  build_parallel_arg=(--parallel "${BUN_FREEBSD_STRICT_BUILD_JOBS:-1}")
fi

BUN_FREEBSD_STAGE0_BUNDLER_BATCH_SIZE="${BUN_FREEBSD_STAGE0_BUNDLER_BATCH_SIZE:-1}" \
BUN_FREEBSD_CODEGEN_TRACE="$(
  if [[ "${CFG_FREEBSD_CODEGEN_NODE}" == "0" ]]; then
    # Legacy FreeBSD stage0 bundle-modules.ts still has a timing-sensitive deadlock in no-trace mode.
    # Trace logging changes scheduling enough for the known no-fallback path to complete reliably.
    # Keep this as a bootstrap workaround until the underlying stage0 deadlock is fixed.
    echo "${BUN_FREEBSD_CODEGEN_TRACE:-1}"
  else
    echo "${BUN_FREEBSD_CODEGEN_TRACE:-0}"
  fi
)" \
BUN_FREEBSD_STAGE0_SKIP_DUPLICATE_BUNDLE_MODULES="$(
  if [[ "${CFG_FREEBSD_CODEGEN_NODE}" == "0" ]]; then
    # We already executed bundle-modules.ts standalone just above in strict no-fallback mode.
    # The duplicate Ninja invocation is only a teardown-hang hazard on legacy FreeBSD stage0.
    echo "1"
  else
    echo "${BUN_FREEBSD_STAGE0_SKIP_DUPLICATE_BUNDLE_MODULES:-0}"
  fi
)" \
cmake --build "${BUILD_DIR}" --target "${FINAL_TARGET}" "${build_parallel_arg[@]}"

echo "[bootstrap] complete"
echo "  stage0: ${STAGE0_BIN}"
echo "  final : ${BUILD_DIR}/${FINAL_TARGET}"
