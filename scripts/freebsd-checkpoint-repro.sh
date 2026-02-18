#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "FreeBSD" ]]; then
  echo "error: scripts/freebsd-checkpoint-repro.sh must run on FreeBSD" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE0_BIN="${BUN_FREEBSD_STAGE0_BIN:-${ROOT_DIR}/build/freebsd-bootstrap/stage0/bun}"
BUILD_DIR="${BUN_FREEBSD_REPRO_BUILD_DIR:-${ROOT_DIR}/build/freebsd-release-ozig}"
TARGET="${BUN_FREEBSD_REPRO_TARGET:-bun}"
BUILD_TYPE="${BUN_FREEBSD_REPRO_BUILD_TYPE:-Release}"
JOBS="${BUN_FREEBSD_REPRO_JOBS:-$(sysctl -n hw.ncpu)}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: missing command '$1'" >&2
    exit 1
  fi
}

require_cmd cmake
require_cmd ninja
require_cmd node
require_cmd npm

if [[ ! -x "${STAGE0_BIN}" ]]; then
  echo "error: stage0 bun not found/executable: ${STAGE0_BIN}" >&2
  echo "hint: run ./scripts/bootstrap-freebsd.sh first" >&2
  exit 1
fi

if [[ "${BUN_FREEBSD_REPRO_CLEAN:-1}" == "1" ]]; then
  echo "[freebsd-repro] removing existing build dir: ${BUILD_DIR}"
  rm -rf "${BUILD_DIR}"
fi

export BUN_FREEBSD_NPM_INSTALL=1
export BUN_FREEBSD_BINDGENV2_NODE=1
export BUN_FREEBSD_CODEGEN_NODE=1

echo "[freebsd-repro] stage0: ${STAGE0_BIN}"
"${STAGE0_BIN}" --version
"${STAGE0_BIN}" -e 'console.log(1+1)'

echo "[freebsd-repro] configuring ${BUILD_DIR} (${BUILD_TYPE})"
cmake -S "${ROOT_DIR}" -B "${BUILD_DIR}" -G Ninja \
  -DRELEASE=ON \
  -DCMAKE_BUILD_TYPE="${BUILD_TYPE}" \
  -DOS=freebsd \
  -DARCH=x64 \
  -DBUN_EXECUTABLE="${STAGE0_BIN}"

if [[ "${BUN_FREEBSD_REPRO_CONFIGURE_ONLY:-0}" == "1" ]]; then
  echo "[freebsd-repro] configure-only mode complete"
  exit 0
fi

echo "[freebsd-repro] building target=${TARGET} jobs=${JOBS}"
cmake --build "${BUILD_DIR}" --target "${TARGET}" -- -j"${JOBS}"

FINAL_BUN="${BUILD_DIR}/${TARGET}"
if [[ "${TARGET}" == "bun-debug" ]]; then
  FINAL_BUN="${BUILD_DIR}/bun-debug"
elif [[ "${TARGET}" == "bun-profile" ]]; then
  FINAL_BUN="${BUILD_DIR}/bun-profile"
else
  FINAL_BUN="${BUILD_DIR}/bun"
fi

if [[ ! -x "${FINAL_BUN}" ]]; then
  echo "error: expected output binary missing: ${FINAL_BUN}" >&2
  exit 1
fi

echo "[freebsd-repro] smoke checks: ${FINAL_BUN}"
"${FINAL_BUN}" --version
"${FINAL_BUN}" -e 'console.log(1+1)'

echo "[freebsd-repro] checkpoint reproducibility OK"
