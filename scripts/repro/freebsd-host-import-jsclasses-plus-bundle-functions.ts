import jsclasses from "../../src/bun.js/bindings/js_classes";
import { bundleBuiltinFunctions } from "../../src/codegen/bundle-functions";
(globalThis as any).CMAKE_BUILD_ROOT = process.argv[2] ?? "build/freebsd-host-selfhost-repro";
void jsclasses;
void bundleBuiltinFunctions;
