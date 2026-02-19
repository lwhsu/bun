import jsclasses from "../../src/bun.js/bindings/js_classes";
import { sliceSourceCode } from "../../src/codegen/builtin-parser";
import { createAssertClientJS, createLogClientJS } from "../../src/codegen/client-js";
import { getJS2NativeCPP, getJS2NativeZig } from "../../src/codegen/generate-js2native";
import { bundleBuiltinFunctions } from "../../src/codegen/bundle-functions";

globalThis.CMAKE_BUILD_ROOT = process.argv[2] ?? "build/freebsd-host-selfhost-repro";

void jsclasses;
void sliceSourceCode;
void createAssertClientJS;
void createLogClientJS;
void getJS2NativeCPP;
void getJS2NativeZig;
void bundleBuiltinFunctions;
