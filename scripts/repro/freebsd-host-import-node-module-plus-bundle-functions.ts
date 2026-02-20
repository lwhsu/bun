import { builtinModules } from "node:module";
import { bundleBuiltinFunctions } from "../../src/codegen/bundle-functions";
(globalThis as any).CMAKE_BUILD_ROOT = process.argv[2] ?? "build/freebsd-host-selfhost-repro";
void builtinModules;
void bundleBuiltinFunctions;
