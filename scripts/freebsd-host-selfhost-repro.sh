#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "FreeBSD" ]]; then
  echo "error: scripts/freebsd-host-selfhost-repro.sh must run on FreeBSD" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_BUN="${BUN_FREEBSD_HOST_BUN:-${ROOT_DIR}/build/freebsd-release-ozig/bun-profile}"
REPRO_BUILD_DIR="${BUN_FREEBSD_HOST_REPRO_BUILD_DIR:-${ROOT_DIR}/build/freebsd-host-selfhost-repro}"
LOG_DIR="${BUN_FREEBSD_HOST_REPRO_LOG_DIR:-${ROOT_DIR}/build/freebsd-bootstrap/logs}"
EXPECT_FAIL="${BUN_FREEBSD_HOST_REPRO_EXPECT_FAIL:-1}"

mkdir -p "${LOG_DIR}" "${REPRO_BUILD_DIR}"

if [[ ! -x "${HOST_BUN}" ]]; then
  echo "error: host bun not found/executable: ${HOST_BUN}" >&2
  exit 1
fi

BUNDLE_OUT="${LOG_DIR}/host-selfhost-bundle-modules.out"
BUNDLE_ERR="${LOG_DIR}/host-selfhost-bundle-modules.err"
BUNDLE_BT="${LOG_DIR}/host-selfhost-bundle-modules.bt"
BUNDLE_CORE="${LOG_DIR}/host-selfhost-bundle-modules.core"

echo "[host-selfhost-repro] host bun: ${HOST_BUN}"
"${HOST_BUN}" --version || true
echo "[host-selfhost-repro] repro build dir: ${REPRO_BUILD_DIR}"

cd "${ROOT_DIR}"
CMD=(
  "${HOST_BUN}"
  "--no-install"
  "run"
  "src/codegen/bundle-modules.ts"
  "--debug=OFF"
  "${REPRO_BUILD_DIR}"
)

echo "[host-selfhost-repro] repro #1: bundle-modules via host bun"
echo "[host-selfhost-repro] command: ${CMD[*]}"

rm -f "${ROOT_DIR}/bun-profile.core"
set +e
"${CMD[@]}" >"${BUNDLE_OUT}" 2>"${BUNDLE_ERR}"
BUNDLE_EXIT=$?
set -e

echo "[host-selfhost-repro] repro #1 exit=${BUNDLE_EXIT}"
sed -n '1,120p' "${BUNDLE_ERR}" || true

if [[ -f "${ROOT_DIR}/bun-profile.core" ]]; then
  cp "${ROOT_DIR}/bun-profile.core" "${BUNDLE_CORE}"
  echo "[host-selfhost-repro] captured core: ${BUNDLE_CORE}"

  if command -v lldb >/dev/null 2>&1; then
    lldb -c "${BUNDLE_CORE}" -o "bt" -o "thread list" -o "quit" "${HOST_BUN}" >"${BUNDLE_BT}" 2>&1 || true
    echo "[host-selfhost-repro] captured backtrace: ${BUNDLE_BT}"
    sed -n '1,120p' "${BUNDLE_BT}" || true
  else
    echo "[host-selfhost-repro] warning: lldb not found; skipping backtrace capture"
  fi
fi

echo "[host-selfhost-repro] logs:"
echo "  ${BUNDLE_OUT}"
echo "  ${BUNDLE_ERR}"
if [[ -f "${BUNDLE_CORE}" ]]; then
  echo "  ${BUNDLE_CORE}"
fi
if [[ -f "${BUNDLE_BT}" ]]; then
  echo "  ${BUNDLE_BT}"
fi

if [[ "${EXPECT_FAIL}" == "1" ]]; then
  if [[ ${BUNDLE_EXIT} -eq 0 ]]; then
    echo "[host-selfhost-repro] unexpected success; expected failure" >&2
    exit 1
  fi
  echo "[host-selfhost-repro] reproducible host self-host failure confirmed"
else
  if [[ ${BUNDLE_EXIT} -ne 0 ]]; then
    echo "[host-selfhost-repro] unexpected failure; expected success" >&2
    exit 1
  fi
  echo "[host-selfhost-repro] host self-host command succeeded"
fi
