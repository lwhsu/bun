import { mkdir, writeFile } from "fs/promises";
import { builtinModules } from "node:module";
import jsclasses from "../../src/bun.js/bindings/js_classes";
import { sliceSourceCode } from "../../src/codegen/builtin-parser";
import { createAssertClientJS, createLogClientJS } from "../../src/codegen/client-js";
import { getJS2NativeCPP, getJS2NativeZig } from "../../src/codegen/generate-js2native";
import { bundleBuiltinFunctions } from "../../src/codegen/bundle-functions";

globalThis.CMAKE_BUILD_ROOT = process.argv[2] ?? "build/freebsd-host-selfhost-repro";

console.error(
  "[freebsd-host-import-subset-crash] loaded",
  typeof mkdir,
  typeof writeFile,
  typeof builtinModules,
  typeof jsclasses,
  typeof sliceSourceCode,
  typeof createAssertClientJS,
  typeof createLogClientJS,
  typeof getJS2NativeCPP,
  typeof getJS2NativeZig,
  typeof bundleBuiltinFunctions,
);

console.log("[freebsd-host-import-subset-crash] done");
