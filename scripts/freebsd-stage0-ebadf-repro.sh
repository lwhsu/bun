#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "FreeBSD" ]]; then
  echo "error: scripts/freebsd-stage0-ebadf-repro.sh must run on FreeBSD" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE0_BIN="${BUN_FREEBSD_STAGE0_BIN:-${ROOT_DIR}/build/freebsd-bootstrap/stage0/bun}"
BUILD_DIR="${BUN_FREEBSD_REPRO_BUILD_DIR:-${ROOT_DIR}/build/freebsd-release-ozig}"
CODEGEN_PATH="${BUN_FREEBSD_REPRO_CODEGEN_PATH:-${BUILD_DIR}/codegen}"
LOG_DIR="${BUN_FREEBSD_REPRO_LOG_DIR:-${ROOT_DIR}/build/freebsd-bootstrap/logs}"

mkdir -p "${LOG_DIR}"

if [[ ! -x "${STAGE0_BIN}" ]]; then
  echo "error: stage0 bun not found/executable: ${STAGE0_BIN}" >&2
  exit 1
fi

SOURCES="$(
  awk -v root="${ROOT_DIR}" '{print root"/"$0}' "${ROOT_DIR}/cmake/sources/BindgenV2Sources.txt" | paste -sd, -
)"

MIN_STDOUT_OUT="${LOG_DIR}/stage0-ebadf-min-stdout.out"
MIN_STDOUT_ERR="${LOG_DIR}/stage0-ebadf-min-stdout.err"
BINDGEN_OUT="${LOG_DIR}/stage0-ebadf-bindgen-list-outputs.out"
BINDGEN_ERR="${LOG_DIR}/stage0-ebadf-bindgen-list-outputs.err"

echo "[stage0-ebadf] stage0: ${STAGE0_BIN}"
"${STAGE0_BIN}" --version || true

echo "[stage0-ebadf] repro #1: minimal process.stdout.write()"
set +e
"${STAGE0_BIN}" -e 'process.stdout.write("ok\n")' >"${MIN_STDOUT_OUT}" 2>"${MIN_STDOUT_ERR}"
MIN_EXIT=$?
set -e
echo "[stage0-ebadf] repro #1 exit=${MIN_EXIT}"
sed -n '1,60p' "${MIN_STDOUT_ERR}" || true

echo "[stage0-ebadf] repro #2: bindgenv2 list-outputs"
set +e
"${STAGE0_BIN}" run "${ROOT_DIR}/src/codegen/bindgenv2/script.ts" \
  --command=list-outputs \
  --sources="${SOURCES}" \
  --codegen-path="${CODEGEN_PATH}" \
  >"${BINDGEN_OUT}" 2>"${BINDGEN_ERR}"
BINDGEN_EXIT=$?
set -e
echo "[stage0-ebadf] repro #2 exit=${BINDGEN_EXIT}"
sed -n '1,120p' "${BINDGEN_ERR}" || true

echo "[stage0-ebadf] logs:"
echo "  ${MIN_STDOUT_OUT}"
echo "  ${MIN_STDOUT_ERR}"
echo "  ${BINDGEN_OUT}"
echo "  ${BINDGEN_ERR}"

if [[ ${MIN_EXIT} -eq 0 || ${BINDGEN_EXIT} -eq 0 ]]; then
  echo "[stage0-ebadf] unexpected success in repro command(s)" >&2
  exit 1
fi

echo "[stage0-ebadf] reproducible EBADF failure confirmed"
