import fs from "fs";
import { bundleBuiltinFunctions } from "../../src/codegen/bundle-functions";
(globalThis as any).CMAKE_BUILD_ROOT = process.argv[2] ?? "build/freebsd-host-selfhost-repro";
void fs;
void bundleBuiltinFunctions;
