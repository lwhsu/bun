#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "FreeBSD" ]]; then
  echo "error: scripts/prepare-webkit-freebsd.sh must run on FreeBSD" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETUP_WEBKIT_CMAKE="${ROOT_DIR}/cmake/tools/SetupWebKit.cmake"

WEBKIT_SOURCE="${BUN_FREEBSD_WEBKIT_SOURCE:-${ROOT_DIR}/vendor/WebKit}"
WEBKIT_BUILD_TYPE="${BUN_FREEBSD_WEBKIT_BUILD_TYPE:-Release}"
WEBKIT_BUILD_DIR="${BUN_FREEBSD_WEBKIT_BUILD_DIR:-${ROOT_DIR}/build/freebsd-bootstrap/webkit-build/${WEBKIT_BUILD_TYPE}}"
WEBKIT_OUTPUT_DIR="${BUN_FREEBSD_WEBKIT_OUT_DIR:-${ROOT_DIR}/build/freebsd-bootstrap/bun-webkit}"
WEBKIT_EXPECTED_COMMIT="${BUN_FREEBSD_WEBKIT_COMMIT:-}"
REQUIRE_SIMDUTF="${BUN_FREEBSD_WEBKIT_REQUIRE_SIMDUTF:-1}"
SKIP_COMMIT_CHECK="${BUN_FREEBSD_WEBKIT_SKIP_COMMIT_CHECK:-0}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: missing command '$1'" >&2
    exit 1
  fi
}

patch_webkit_freebsd_available_memory() {
  local available_memory_cpp="${WEBKIT_SOURCE}/Source/WTF/wtf/AvailableMemory.cpp"

  if [[ ! -f "${available_memory_cpp}" ]]; then
    echo "[webkit-freebsd] skipping AvailableMemory.cpp patch (not present in this WebKit revision)"
    return 0
  fi

  if grep -q 'hw.physmem' "${available_memory_cpp}"; then
    return 0
  fi

  perl -0pi -e 's/#if OS\(FREEBSD\) \|\| OS\(LINUX\)\n#include <sys\/sysinfo\.h>\n#endif/#if OS(LINUX)\n#include <sys\/sysinfo.h>\n#endif/s' "${available_memory_cpp}"

  perl -0pi -e 's/#elif OS\(FREEBSD\)\n\s*struct sysinfo info;\n\s*if \(!sysinfo\(&info\)\)\n\s*return info\.totalram \* info\.mem_unit;\n\s*return availableMemoryGuess;/#elif OS(FREEBSD)\n    unsigned long long totalMemory = 0;\n    size_t totalMemorySize = sizeof(totalMemory);\n    if (!sysctlbyname("hw.physmem", &totalMemory, &totalMemorySize, nullptr, 0))\n        return static_cast<size_t>(totalMemory);\n    return availableMemoryGuess;/s' "${available_memory_cpp}"

  if ! grep -q 'hw.physmem' "${available_memory_cpp}"; then
    echo "error: failed to patch ${available_memory_cpp} for FreeBSD" >&2
    exit 1
  fi

  echo "[webkit-freebsd] patched AvailableMemory.cpp for FreeBSD (hw.physmem)"
}

patch_webkit_freebsd_ram_size() {
  local ram_size_cpp="${WEBKIT_SOURCE}/Source/WTF/wtf/RAMSize.cpp"

  if [[ ! -f "${ram_size_cpp}" ]]; then
    return 0
  fi

  if grep -q 'sysctlbyname("hw.physmem"' "${ram_size_cpp}"; then
    return 0
  fi

  perl -0pi -e 's/#if OS\(LINUX\) \|\| OS\(FREEBSD\)\n#include <sys\/sysinfo\.h>\n#elif OS\(UNIX\)\n#include <unistd\.h>\n#endif \/\/ OS\(LINUX\) \|\| OS\(FREEBSD\) \|\| OS\(UNIX\)/#if OS(LINUX)\n#include <sys\/sysinfo.h>\n#elif OS(FREEBSD)\n#include <sys\/types.h>\n#include <sys\/sysctl.h>\n#elif OS(UNIX)\n#include <unistd.h>\n#endif \/\/ OS(LINUX) || OS(FREEBSD) || OS(UNIX)/s' "${ram_size_cpp}"

  perl -0pi -e 's/#if OS\(LINUX\) \|\| OS\(FREEBSD\)\n\s*struct sysinfo si;\n\s*sysinfo\(&si\);\n\s*return si\.totalram \* si\.mem_unit;\n#elif OS\(UNIX\)/#if OS(LINUX)\n    struct sysinfo si;\n    sysinfo(&si);\n    return si.totalram * si.mem_unit;\n#elif OS(FREEBSD)\n    unsigned long long totalMemory = 0;\n    size_t totalMemorySize = sizeof(totalMemory);\n    if (!sysctlbyname("hw.physmem", &totalMemory, &totalMemorySize, nullptr, 0))\n        return static_cast<size_t>(totalMemory);\n    return 0;\n#elif OS(UNIX)/s' "${ram_size_cpp}"

  if ! grep -q 'sysctlbyname("hw.physmem"' "${ram_size_cpp}"; then
    echo "error: failed to patch ${ram_size_cpp} for FreeBSD" >&2
    exit 1
  fi

  echo "[webkit-freebsd] patched RAMSize.cpp for FreeBSD (hw.physmem)"
}

patch_webkit_icu_header_api() {
  local platform_h="${WEBKIT_SOURCE}/Source/WTF/wtf/Platform.h"

  if [[ ! -f "${platform_h}" ]]; then
    return 0
  fi

  if grep -q '^#define U_SHOW_CPLUSPLUS_HEADER_API ' "${platform_h}"; then
    return 0
  fi

  if grep -q '^#define U_SHOW_CPLUSPLUS_API 0$' "${platform_h}"; then
    perl -0pi -e 's/#define U_SHOW_CPLUSPLUS_API 0\n/#define U_SHOW_CPLUSPLUS_API 0\n#define U_SHOW_CPLUSPLUS_HEADER_API 0\n/s' "${platform_h}"
    if grep -q '^#define U_SHOW_CPLUSPLUS_HEADER_API 0$' "${platform_h}"; then
      echo "[webkit-freebsd] patched Platform.h for ICU 76 header-only C++ API compatibility"
      return 0
    fi
  fi
}

patch_webkit_clang_template_keyword() {
  local patched_any=0
  local file
  while IFS= read -r -d '' file; do
    if grep -q '\.template untaggedPtr()' "${file}" || \
       grep -q '\.template taggedPtr()' "${file}" || \
       grep -q '::template inherits(' "${file}"; then
      perl -0pi -e 's/\.template untaggedPtr\(\)/.untaggedPtr()/g; s/\.template taggedPtr\(\)/.taggedPtr()/g; s/::template inherits\(/::inherits(/g;' "${file}"
      patched_any=1
    fi
  done < <(find "${WEBKIT_SOURCE}/Source/JavaScriptCore" -type f \( -name '*.h' -o -name '*.cpp' -o -name '*.inl' \) -print0)

  if [[ "${patched_any}" == "1" ]]; then
    echo "[webkit-freebsd] patched template keyword call-sites for clang compatibility"
  fi
}

require_cmd cmake
require_cmd ninja
require_cmd clang
require_cmd clang++
require_cmd git
require_cmd awk
require_cmd perl

if [[ ! -f "${SETUP_WEBKIT_CMAKE}" ]]; then
  echo "error: missing ${SETUP_WEBKIT_CMAKE}" >&2
  exit 1
fi

if [[ ! -e "${WEBKIT_SOURCE}/.git" ]]; then
  cat >&2 <<EOF2
error: missing WebKit source checkout at ${WEBKIT_SOURCE}

Create it with:
  git clone https://github.com/oven-sh/WebKit.git ${WEBKIT_SOURCE}
EOF2
  exit 1
fi

if [[ -z "${WEBKIT_EXPECTED_COMMIT}" ]]; then
  WEBKIT_EXPECTED_COMMIT="$(
    awk '/set\(WEBKIT_VERSION [0-9a-f]{40}\)/ { version=$2; gsub("\\)", "", version); print version; exit }' \
      "${SETUP_WEBKIT_CMAKE}"
  )"

  if [[ -z "${WEBKIT_EXPECTED_COMMIT}" ]]; then
    echo "error: failed to parse WEBKIT_VERSION from ${SETUP_WEBKIT_CMAKE}" >&2
    exit 1
  fi
fi

WEBKIT_SOURCE_COMMIT="$(git -C "${WEBKIT_SOURCE}" rev-parse HEAD)"

if [[ "${SKIP_COMMIT_CHECK}" != "1" && "${WEBKIT_SOURCE_COMMIT}" != "${WEBKIT_EXPECTED_COMMIT}" ]]; then
  cat >&2 <<EOF2
error: WebKit checkout commit does not match the expected WebKit commit
  expected: ${WEBKIT_EXPECTED_COMMIT}
  actual:   ${WEBKIT_SOURCE_COMMIT}

Fix it with:
  cd ${WEBKIT_SOURCE}
  git fetch origin
  git checkout ${WEBKIT_EXPECTED_COMMIT}

Or bypass this check intentionally:
  BUN_FREEBSD_WEBKIT_SKIP_COMMIT_CHECK=1 ${0##*/}
EOF2
  exit 1
fi

patch_webkit_freebsd_available_memory
patch_webkit_freebsd_ram_size
patch_webkit_icu_header_api
patch_webkit_clang_template_keyword

echo "[webkit-freebsd] configuring WebKit (JSCOnly) in ${WEBKIT_BUILD_DIR}"
cmake \
  -S "${WEBKIT_SOURCE}" \
  -B "${WEBKIT_BUILD_DIR}" \
  -G Ninja \
  -DPORT=JSCOnly \
  -DENABLE_STATIC_JSC=ON \
  -DUSE_THIN_ARCHIVES=OFF \
  -DENABLE_FTL_JIT=ON \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DUSE_BUN_JSC_ADDITIONS=ON \
  -DUSE_BUN_EVENT_LOOP=ON \
  -DUSE_SYSTEM_MALLOC=ON \
  -DUSE_MIMALLOC=OFF \
  -DENABLE_BUN_SKIP_FAILING_ASSERTIONS=ON \
  -DALLOW_LINE_AND_COLUMN_NUMBER_IN_BUILTINS=ON \
  -DENABLE_REMOTE_INSPECTOR=ON \
  -DCMAKE_BUILD_TYPE="${WEBKIT_BUILD_TYPE}" \
  -DCMAKE_C_COMPILER="${CC:-clang}" \
  -DCMAKE_CXX_COMPILER="${CXX:-clang++}"

echo "[webkit-freebsd] building WebKit target: jsc"
cmake --build "${WEBKIT_BUILD_DIR}" --config "${WEBKIT_BUILD_TYPE}" --target jsc

echo "[webkit-freebsd] packaging bun-webkit layout at ${WEBKIT_OUTPUT_DIR}"
rm -rf "${WEBKIT_OUTPUT_DIR}"
mkdir -p \
  "${WEBKIT_OUTPUT_DIR}/lib" \
  "${WEBKIT_OUTPUT_DIR}/include" \
  "${WEBKIT_OUTPUT_DIR}/include/JavaScriptCore" \
  "${WEBKIT_OUTPUT_DIR}/include/wtf" \
  "${WEBKIT_OUTPUT_DIR}/include/bmalloc" \
  "${WEBKIT_OUTPUT_DIR}/Source/JavaScriptCore"

copy_tree_if_exists() {
  local from="$1"
  local to="$2"
  if [[ -d "${from}" ]]; then
    cp -R "${from}/." "${to}/"
  fi
}

required_libs=(libJavaScriptCore.a libWTF.a)
optional_libs=(libbmalloc.a)

for lib in "${required_libs[@]}"; do
  if [[ ! -f "${WEBKIT_BUILD_DIR}/lib/${lib}" ]]; then
    echo "error: expected WebKit library not found: ${WEBKIT_BUILD_DIR}/lib/${lib}" >&2
    exit 1
  fi
  cp "${WEBKIT_BUILD_DIR}/lib/${lib}" "${WEBKIT_OUTPUT_DIR}/lib/"
done

for lib in "${optional_libs[@]}"; do
  if [[ -f "${WEBKIT_BUILD_DIR}/lib/${lib}" ]]; then
    cp "${WEBKIT_BUILD_DIR}/lib/${lib}" "${WEBKIT_OUTPUT_DIR}/lib/"
  fi
done

if [[ -f "${WEBKIT_BUILD_DIR}/cmakeconfig.h" ]]; then
  cp "${WEBKIT_BUILD_DIR}/cmakeconfig.h" "${WEBKIT_OUTPUT_DIR}/include/cmakeconfig.h"
  printf '#define BUN_WEBKIT_VERSION "%s"\n' "${WEBKIT_SOURCE_COMMIT}" >>"${WEBKIT_OUTPUT_DIR}/include/cmakeconfig.h"
fi

copy_tree_if_exists "${WEBKIT_BUILD_DIR}/JavaScriptCore/Headers/JavaScriptCore" "${WEBKIT_OUTPUT_DIR}/include/JavaScriptCore"
copy_tree_if_exists "${WEBKIT_BUILD_DIR}/JavaScriptCore/PrivateHeaders/JavaScriptCore" "${WEBKIT_OUTPUT_DIR}/include/JavaScriptCore"
copy_tree_if_exists "${WEBKIT_BUILD_DIR}/WTF/Headers/wtf" "${WEBKIT_OUTPUT_DIR}/include/wtf"
copy_tree_if_exists "${WEBKIT_BUILD_DIR}/WTF/DerivedSources" "${WEBKIT_OUTPUT_DIR}/include/wtf"
copy_tree_if_exists "${WEBKIT_BUILD_DIR}/bmalloc/Headers/bmalloc" "${WEBKIT_OUTPUT_DIR}/include/bmalloc"
copy_tree_if_exists "${WEBKIT_BUILD_DIR}/ICU/Headers" "${WEBKIT_OUTPUT_DIR}/include"

if [[ -d "${WEBKIT_SOURCE}/Source/JavaScriptCore/Scripts" ]]; then
  cp -R "${WEBKIT_SOURCE}/Source/JavaScriptCore/Scripts" "${WEBKIT_OUTPUT_DIR}/Source/JavaScriptCore/"
fi
if [[ -f "${WEBKIT_SOURCE}/Source/JavaScriptCore/create_hash_table" ]]; then
  cp "${WEBKIT_SOURCE}/Source/JavaScriptCore/create_hash_table" "${WEBKIT_OUTPUT_DIR}/Source/JavaScriptCore/"
fi

ARCH_NAME_RAW="$(uname -m)"
PACKAGE_CPU="${ARCH_NAME_RAW}"
case "${ARCH_NAME_RAW}" in
  x86_64|amd64) PACKAGE_CPU="x64" ;;
  arm64|aarch64) PACKAGE_CPU="aarch64" ;;
esac

cat >"${WEBKIT_OUTPUT_DIR}/package.json" <<EOF2
{ "name": "bun-webkit-freebsd-${PACKAGE_CPU}", "version": "0.0.1-${WEBKIT_SOURCE_COMMIT}", "os": ["freebsd"], "cpu": ["${PACKAGE_CPU}"], "repository": "https://github.com/oven-sh/WebKit" }
EOF2

if [[ "${REQUIRE_SIMDUTF}" == "1" && ! -f "${WEBKIT_OUTPUT_DIR}/include/wtf/SIMDUTF.h" ]]; then
  cat >&2 <<EOF2
error: ${WEBKIT_OUTPUT_DIR}/include/wtf/SIMDUTF.h was not produced

This mirrors Linux/macOS packaging (copying WebKit's WTF headers into bun-webkit/include/wtf).
If this header is missing, the selected WebKit commit/build does not provide it.
EOF2
  exit 1
fi

echo "[webkit-freebsd] complete"
echo "  output: ${WEBKIT_OUTPUT_DIR}"
if [[ -f "${WEBKIT_OUTPUT_DIR}/include/wtf/SIMDUTF.h" ]]; then
  echo "  SIMDUTF: ${WEBKIT_OUTPUT_DIR}/include/wtf/SIMDUTF.h"
else
  echo "  SIMDUTF: (not present in this WebKit revision)"
fi
