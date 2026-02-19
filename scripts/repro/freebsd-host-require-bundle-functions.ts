import { sliceSourceCode } from "../../src/codegen/builtin-parser";
import { createAssertClientJS, createLogClientJS } from "../../src/codegen/client-js";
import { getJS2NativeCPP, getJS2NativeZig } from "../../src/codegen/generate-js2native";

const cmakeBuildRoot =
  process.env.BUN_FREEBSD_HOST_REPRO_BUILD_DIR ?? `${process.cwd()}/build/freebsd-host-selfhost-repro`;
globalThis.CMAKE_BUILD_ROOT = cmakeBuildRoot;

const extra = 1;
console.error(
  "[freebsd-host-require-bundle-functions] before require",
  typeof sliceSourceCode,
  typeof createAssertClientJS,
  typeof createLogClientJS,
  typeof getJS2NativeCPP,
  typeof getJS2NativeZig,
  extra,
);

const bundleBuiltinFunctions = require("../../src/codegen/bundle-functions").bundleBuiltinFunctions;
console.error("[freebsd-host-require-bundle-functions] after require", typeof bundleBuiltinFunctions);
console.log("[freebsd-host-require-bundle-functions] ok");
