(globalThis as any).CMAKE_BUILD_ROOT = process.argv[2] ?? "build/freebsd-host-selfhost-repro";

const jsclasses = await import("../../src/bun.js/bindings/js_classes");
const builtinParser = await import("../../src/codegen/builtin-parser");
const clientJs = await import("../../src/codegen/client-js");
const js2native = await import("../../src/codegen/generate-js2native");
const bundleFns = await import("../../src/codegen/bundle-functions");

void jsclasses.default;
void builtinParser.sliceSourceCode;
void clientJs.createAssertClientJS;
void clientJs.createLogClientJS;
void js2native.getJS2NativeCPP;
void js2native.getJS2NativeZig;
void bundleFns.bundleBuiltinFunctions;
