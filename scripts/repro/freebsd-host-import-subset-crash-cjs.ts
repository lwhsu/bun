(globalThis as any).CMAKE_BUILD_ROOT = process.argv[2] ?? "build/freebsd-host-selfhost-repro";

const jsclasses = require("../../src/bun.js/bindings/js_classes");
const { sliceSourceCode } = require("../../src/codegen/builtin-parser");
const { createAssertClientJS, createLogClientJS } = require("../../src/codegen/client-js");
const { getJS2NativeCPP, getJS2NativeZig } = require("../../src/codegen/generate-js2native");
const { bundleBuiltinFunctions } = require("../../src/codegen/bundle-functions");

void jsclasses;
void sliceSourceCode;
void createAssertClientJS;
void createLogClientJS;
void getJS2NativeCPP;
void getJS2NativeZig;
void bundleBuiltinFunctions;
