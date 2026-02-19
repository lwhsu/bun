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
SECOND_REPRO="${BUN_FREEBSD_HOST_SECOND_REPRO:-scripts/repro/freebsd-host-require-bundle-functions.ts}"

if [[ "${SECOND_REPRO}" = /* ]]; then
  SECOND_REPRO_PATH="${SECOND_REPRO}"
  if [[ "${SECOND_REPRO_PATH}" == "${ROOT_DIR}/"* ]]; then
    SECOND_REPRO_CMD="${SECOND_REPRO_PATH#${ROOT_DIR}/}"
  else
    SECOND_REPRO_CMD="${SECOND_REPRO_PATH}"
  fi
else
  SECOND_REPRO_PATH="${ROOT_DIR}/${SECOND_REPRO}"
  SECOND_REPRO_CMD="${SECOND_REPRO}"
fi

mkdir -p "${LOG_DIR}" "${REPRO_BUILD_DIR}"

if [[ ! -x "${HOST_BUN}" ]]; then
  echo "error: host bun not found/executable: ${HOST_BUN}" >&2
  exit 1
fi

BUNDLE_OUT="${LOG_DIR}/host-selfhost-bundle-modules.out"
BUNDLE_ERR="${LOG_DIR}/host-selfhost-bundle-modules.err"
BUNDLE_BT="${LOG_DIR}/host-selfhost-bundle-modules.bt"
BUNDLE_CORE="${LOG_DIR}/host-selfhost-bundle-modules.core"
SECOND_OUT="${LOG_DIR}/host-selfhost-require-bundle-functions.out"
SECOND_ERR="${LOG_DIR}/host-selfhost-require-bundle-functions.err"
SECOND_BT="${LOG_DIR}/host-selfhost-require-bundle-functions.bt"
SECOND_CORE="${LOG_DIR}/host-selfhost-require-bundle-functions.core"

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

SECOND_EXIT=0
if [[ -f "${SECOND_REPRO_PATH}" ]]; then
  echo "[host-selfhost-repro] repro #2: minimal bundle-functions load"
  rm -f "${ROOT_DIR}/bun-profile.core"
  set +e
  "${HOST_BUN}" --no-install run "${SECOND_REPRO_CMD}" >"${SECOND_OUT}" 2>"${SECOND_ERR}"
  SECOND_EXIT=$?
  set -e
  echo "[host-selfhost-repro] repro #2 exit=${SECOND_EXIT}"
  sed -n '1,120p' "${SECOND_ERR}" || true

  if [[ -f "${ROOT_DIR}/bun-profile.core" ]]; then
    cp "${ROOT_DIR}/bun-profile.core" "${SECOND_CORE}"
    echo "[host-selfhost-repro] captured core: ${SECOND_CORE}"

    if command -v lldb >/dev/null 2>&1; then
      lldb -c "${SECOND_CORE}" -o "bt" -o "thread list" -o "quit" "${HOST_BUN}" >"${SECOND_BT}" 2>&1 || true
      echo "[host-selfhost-repro] captured backtrace: ${SECOND_BT}"
      sed -n '1,100p' "${SECOND_BT}" || true
    fi
  fi
else
  echo "[host-selfhost-repro] repro #2 skipped (missing ${SECOND_REPRO_PATH})"
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
if [[ -f "${SECOND_REPRO_PATH}" ]]; then
  echo "  ${SECOND_OUT}"
  echo "  ${SECOND_ERR}"
  if [[ -f "${SECOND_CORE}" ]]; then
    echo "  ${SECOND_CORE}"
  fi
  if [[ -f "${SECOND_BT}" ]]; then
    echo "  ${SECOND_BT}"
  fi
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
