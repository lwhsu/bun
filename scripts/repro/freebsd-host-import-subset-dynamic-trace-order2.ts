import fs from "fs";
const log = (msg: string) => fs.writeSync(2, `[dyn-trace-2] ${msg}\n`);

log("start");
(globalThis as any).CMAKE_BUILD_ROOT = process.argv[2] ?? "build/freebsd-host-selfhost-repro";
log("set-build-root");

log("import:bundle-functions:begin");
const bundleFns = await import("../../src/codegen/bundle-functions");
log("import:bundle-functions:ok");

log("import:js_classes:begin");
const jsclasses = await import("../../src/bun.js/bindings/js_classes");
log("import:js_classes:ok");

log("import:builtin-parser:begin");
const builtinParser = await import("../../src/codegen/builtin-parser");
log("import:builtin-parser:ok");

log("import:client-js:begin");
const clientJs = await import("../../src/codegen/client-js");
log("import:client-js:ok");

log("import:generate-js2native:begin");
const js2native = await import("../../src/codegen/generate-js2native");
log("import:generate-js2native:ok");

void bundleFns.bundleBuiltinFunctions;
void jsclasses.default;
void builtinParser.sliceSourceCode;
void clientJs.createAssertClientJS;
void clientJs.createLogClientJS;
void js2native.getJS2NativeCPP;
void js2native.getJS2NativeZig;
log("done");
