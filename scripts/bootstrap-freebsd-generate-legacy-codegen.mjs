#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function writeIfChanged(filePath, contents) {
  const normalized = contents.replaceAll("\r\n", "\n").trimEnd() + "\n";
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (existing === normalized) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, normalized);
}

function run(cmd, args, cwd) {
  console.log(`[codegen] ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
}

function listFilesRecursive(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function idToEnumName(id) {
  const words = id
    .replace(/\.[mc]?[tj]s$/, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);

  return words
    .map(word => {
      if (["jsc", "ffi", "vm", "tls", "os", "ws", "fs", "dns"].includes(word)) {
        return word.toUpperCase();
      }
      return word[0].toUpperCase() + word.slice(1);
    })
    .join("");
}

function idToPublicSpecifierOrEnumName(id) {
  id = id.replace(/\.[mc]?[tj]s$/, "");
  if (id.startsWith("node/")) {
    return "node:" + id.slice(5).replaceAll(".", "/");
  }
  if (id.startsWith("bun/")) {
    return "bun:" + id.slice(4).replaceAll(".", "/");
  }
  if (id.startsWith("internal/")) {
    return "internal:" + id.slice(9).replaceAll(".", "/");
  }
  if (id.startsWith("thirdparty/")) {
    return id.slice(11).replaceAll(".", "/");
  }
  return idToEnumName(id);
}

function collectModuleRegistryData(legacyRoot) {
  const jsBase = path.join(legacyRoot, "src/js");
  const moduleList = ["bun", "node", "thirdparty", "internal"]
    .flatMap(dir => listFilesRecursive(path.join(jsBase, dir)))
    .filter(file => file.endsWith(".js") || (file.endsWith(".ts") && !file.endsWith(".d.ts")))
    .map(file => path.relative(jsBase, file).split(path.sep).join("/"))
    .sort();

  moduleList.push("internal-for-testing.ts");

  const nativeModuleHeader = fs.readFileSync(path.join(legacyRoot, "src/bun.js/modules/_NativeModule.h"), "utf8");
  const nativeModuleDefine = nativeModuleHeader.match(/BUN_FOREACH_NATIVE_MODULE\(macro\)\s*\\\n((.*\\\n)*\n)/);
  if (!nativeModuleDefine) {
    fail("could not locate BUN_FOREACH_NATIVE_MODULE in src/bun.js/modules/_NativeModule.h");
  }

  let nextNativeModuleId = 0;
  const nativeModuleIds = {};
  const nativeModuleEnumToId = {};
  for (const match of nativeModuleDefine[0].matchAll(/macro\((.*?),(.*?)\)/g)) {
    const processedId = JSON.parse(match[1].trim().replace(/_s$/, ""));
    const enumName = match[2].trim();
    nativeModuleIds[processedId] = nextNativeModuleId++;
    nativeModuleEnumToId[enumName] = nativeModuleEnumToId[enumName] ?? Object.keys(nativeModuleEnumToId).length;
  }

  const moduleCodeById = {};
  for (const id of moduleList) {
    const fullPath = path.join(jsBase, id);
    if (!fs.existsSync(fullPath)) {
      moduleCodeById[id] = "";
      continue;
    }
    moduleCodeById[id] = fs.readFileSync(fullPath, "utf8");
  }

  return { moduleList, moduleCodeById, nativeModuleIds, nativeModuleEnumToId };
}

function declareASCIILiteral(name, value) {
  const normalized = `${value}\n`;
  const bytes = normalized
    .split("")
    .map(ch => ch.charCodeAt(0))
    .concat([0]);
  return `static constexpr const char ${name}Bytes[${bytes.length}] = {${bytes.join(",")}};
static constexpr ASCIILiteral ${name} = ASCIILiteral::fromLiteralUnsafe(${name}Bytes);`;
}

function generateResolvedSourceTag(codegenDir, data) {
  const { moduleList, nativeModuleIds } = data;

  const resolvedSourceTag = `// zig fmt: off
pub const ResolvedSourceTag = enum(u32) {
    // Predefined
    javascript = 0,
    package_json_type_module = 1,
    wasm = 2,
    object = 3,
    file = 4,
    esm = 5,
    json_for_object_loader = 6,
    exports_object = 7,

    // Built in modules are loaded through InternalModuleRegistry by numerical ID.
    // In this enum are represented as \`(1 << 9) & id\`
${moduleList.map((id, n) => `    @"${idToPublicSpecifierOrEnumName(id)}" = ${(1 << 9) | n},`).join("\n")}
    // Native modules run through a different system using ESM registry.
${Object.entries(nativeModuleIds)
  .map(([id, n]) => `    @"${id}" = ${(1 << 10) | n},`)
  .join("\n")}
};
`;

  writeIfChanged(path.join(codegenDir, "ResolvedSourceTag.zig"), resolvedSourceTag);
}

function generateInternalModuleRegistryHeaders(codegenDir, data) {
  const { moduleList, moduleCodeById } = data;

  writeIfChanged(path.join(codegenDir, "InternalModuleRegistry+numberOfModules.h"), `#define BUN_INTERNAL_MODULE_COUNT ${moduleList.length}`);

  writeIfChanged(
    path.join(codegenDir, "InternalModuleRegistry+enum.h"),
    `${moduleList.map((id, n) => `${idToEnumName(id)} = ${n},`).join("\n")}\n`,
  );

  writeIfChanged(
    path.join(codegenDir, "InternalModuleRegistry+createInternalModuleById.h"),
    `// clang-format off
JSValue InternalModuleRegistry::createInternalModuleById(JSGlobalObject* globalObject, VM& vm, Field id)
{
  switch (id) {
    // JS internal modules
    ${moduleList
      .map(id => {
        return `case Field::${idToEnumName(id)}: {
      INTERNAL_MODULE_REGISTRY_GENERATE(globalObject, vm, "${idToPublicSpecifierOrEnumName(id)}"_s, ${JSON.stringify(
        id.replace(/\.[mc]?[tj]s$/, ".js"),
      )}_s, InternalModuleRegistryConstants::${idToEnumName(id)}Code, "builtin://${id
        .replace(/\.[mc]?[tj]s$/, "")
        .replace(/[^a-zA-Z0-9]+/g, "/")}"_s);
    }`;
      })
      .join("\n    ")}
    default: {
      __builtin_unreachable();
    }
  }
}
`,
  );

  writeIfChanged(
    path.join(codegenDir, "InternalModuleRegistryConstants.h"),
    `// clang-format off
#pragma once

namespace Bun {
namespace InternalModuleRegistryConstants {
  ${moduleList.map(id => `${declareASCIILiteral(`${idToEnumName(id)}Code`, moduleCodeById[id] ?? "")}`).join("\n")}
}
}
`,
  );
}

function generateSyntheticModuleTypeHeader(codegenDir, data) {
  const { moduleList, nativeModuleEnumToId } = data;

  writeIfChanged(
    path.join(codegenDir, "SyntheticModuleType.h"),
    `enum SyntheticModuleType : uint32_t {
    JavaScript = 0,
    PackageJSONTypeModule = 1,
    Wasm = 2,
    ObjectModule = 3,
    File = 4,
    ESM = 5,
    JSONForObjectLoader = 6,
    ExportsObject = 7,

    // Built in modules are loaded through InternalModuleRegistry by numerical ID.
    // In this enum are represented as \`(1 << 9) & id\`
    InternalModuleRegistryFlag = 1 << 9,
${moduleList.map((id, n) => `    ${idToEnumName(id)} = ${(1 << 9) | n},`).join("\n")}

    // Native modules run through the same system, but with different underlying initializers.
    // They also have bit 10 set to differentiate them from JS builtins.
    NativeModuleFlag = (1 << 10) | (1 << 9),
${Object.entries(nativeModuleEnumToId)
  .map(([id, n]) => `    ${id} = ${(1 << 10) | n},`)
  .join("\n")}
};
`,
  );
}

function generateNativeModuleImplHeader(codegenDir, data) {
  const { nativeModuleEnumToId } = data;
  writeIfChanged(
    path.join(codegenDir, "NativeModuleImpl.h"),
    Object.keys(nativeModuleEnumToId)
      .map(value => `#include "../../bun.js/modules/${value}Module.h"`)
      .join("\n"),
  );
}

function generateJS2NativeStubHeader(codegenDir) {
  writeIfChanged(
    path.join(codegenDir, "GeneratedJS2Native.h"),
    `#pragma once
namespace JS2NativeGenerated {
using namespace Bun;
using namespace JSC;
using namespace WebCore;
static JSC::JSValue js2nativeStub(Zig::GlobalObject*) { return jsUndefined(); }
typedef JSC::JSValue (*JS2NativeFunction)(Zig::GlobalObject*);
static JS2NativeFunction js2nativePointers[] = {
  &js2nativeStub,
};
}
#define JS2NATIVE_COUNT 0
`,
  );
}

function generateErrorCode(legacyRoot, codegenDir) {
  const errorCodeFile = path.join(legacyRoot, "src/bun.js/bindings/ErrorCode.ts");
  if (!fs.existsSync(errorCodeFile)) {
    console.log("[codegen] skipping ErrorCode generation (legacy tree has no src/bun.js/bindings/ErrorCode.ts)");
    return;
  }
  const errorCodeSource = fs.readFileSync(errorCodeFile, "utf8");
  const entries = [...errorCodeSource.matchAll(/\[\s*"([^"]+)"\s*,\s*(TypeError|RangeError|Error|SyntaxError)\s*,\s*"([^"]+)"\s*\]/g)].map(
    match => ({
      code: match[1],
      constructor: match[2],
      name: match[3],
    }),
  );

  if (entries.length === 0) {
    fail("failed to parse src/bun.js/bindings/ErrorCode.ts");
  }

  const enumHeader = `
// clang-format off
// Generated by: scripts/bootstrap-freebsd-generate-legacy-codegen.mjs
#pragma once

namespace Bun {
  static constexpr size_t NODE_ERROR_COUNT = ${entries.length};
  enum class ErrorCode : uint8_t {
${entries.map((entry, i) => `    ${entry.code} = ${i},`).join("\n")}
};
} // namespace Bun
`;

  const listHeader = `
// clang-format off
// Generated by: scripts/bootstrap-freebsd-generate-legacy-codegen.mjs
#pragma once

struct ErrorCodeData {
    JSC::ErrorType type;
    WTF::ASCIILiteral name;
    WTF::ASCIILiteral code;
};
static constexpr ErrorCodeData errors[${entries.length}] = {
${entries.map(entry => `    { JSC::ErrorType::${entry.constructor}, "${entry.name}"_s, "${entry.code}"_s },`).join("\n")}
};
`;

  const zigNamespaceFns = entries
    .map(entry => {
      return ` /// ${entry.name}: ${entry.code} (instanceof ${entry.constructor})
 pub inline fn ${entry.code}(globalThis: *JSC.JSGlobalObject, comptime fmt: [:0]const u8, args: anytype) ErrorBuilder(Error.${entry.code}, fmt, @TypeOf(args)) {
     return .{ .globalThis = globalThis, .args = args };
 }`;
    })
    .join("\n");

  const zig = `
// Generated by: scripts/bootstrap-freebsd-generate-legacy-codegen.mjs
const std = @import("std");
const bun = @import("root").bun;
const JSC = bun.JSC;

fn ErrorBuilder(comptime code_: Error, comptime fmt_: [:0]const u8, Args: type) type {
  return struct {
      const code = code_;
      const fmt = fmt_;
      globalThis: *JSC.JSGlobalObject,
      args: Args,

      // Throw this error as a JS exception
      pub inline fn throw(this: @This()) void {
        code.throw(this.globalThis, fmt, this.args);
      }

      /// Turn this into a JSValue
      pub inline fn toJS(this: @This()) JSC.JSValue {
        return code.fmt(this.globalThis, fmt, this.args);
      }

      /// Turn this into a JSPromise that is already rejected.
      pub inline fn reject(this: @This()) JSC.JSValue {
        return JSC.JSPromise.rejectedPromiseValue(this.globalThis, code.fmt(this.globalThis, fmt, this.args));
      }

  };
}

pub const Error = enum(u8) {
${entries.map((entry, i) => `    ${entry.code} = ${i},`).join("\n")}

  extern fn Bun__createErrorWithCode(globalThis: *JSC.JSGlobalObject, code: Error, message: *bun.String) JSC.JSValue;
  
  /// Creates an Error object with the given error code.
  /// Derefs the message string.
  pub fn toJS(this: Error, globalThis: *JSC.JSGlobalObject, message: *bun.String) JSC.JSValue {
    defer message.deref();
    return Bun__createErrorWithCode(globalThis, this, message);
  }

  pub fn fmt(this: Error, globalThis: *JSC.JSGlobalObject, comptime fmt_str: [:0]const u8, args: anytype) JSC.JSValue {
    if (comptime std.meta.fieldNames(@TypeOf(args)).len == 0) {
      var message = bun.String.static(fmt_str);
      return toJS(this, globalThis, &message);
    }

    var message = bun.String.createFormat(fmt_str, args) catch bun.outOfMemory();
    return toJS(this, globalThis, &message);
  }

  pub fn throw(this: Error, globalThis: *JSC.JSGlobalObject, comptime fmt_str: [:0]const u8, args: anytype) void {
    globalThis.throwValue(fmt(this, globalThis, fmt_str, args)); 
  }

};

pub const JSGlobalObjectExtensions = struct {
${zigNamespaceFns}
};
`;

  writeIfChanged(path.join(codegenDir, "ErrorCode+List.h"), enumHeader);
  writeIfChanged(path.join(codegenDir, "ErrorCode+Data.h"), listHeader);
  writeIfChanged(path.join(codegenDir, "ErrorCode.zig"), zig);
}

function listTopLevelClassFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter(name => name.endsWith(".classes.ts"))
    .sort()
    .map(name => path.join(root, name));
}

function generateLUTHeader(legacyRoot, inputText, outputPath, sourceLabel) {
  const createHashTableScript = path.join(legacyRoot, "src/codegen/create_hash_table");
  if (!fs.existsSync(createHashTableScript)) {
    fail(`missing create_hash_table script: ${createHashTableScript}`);
  }

  const platform = process.env.TARGET_PLATFORM ?? process.platform;
  const os = platform === "win32" ? "WINDOWS" : platform.toUpperCase();
  const otherOSes = ["WINDOWS", "DARWIN", "LINUX"].filter(x => x !== os);
  const toRemove = new RegExp(`#if\\s+(!OS\\(${os}\\)|OS\\((${otherOSes.join("|")})\\))\\n.*?#endif`, "gs");

  const toPreprocess = [...inputText.matchAll(/@begin\s+.+?@end/gs)].map(match => match[0]).join("\n");
  const preprocessed = toPreprocess.replace(toRemove, "");

  console.log(`[codegen] generating ${path.basename(outputPath)} from ${sourceLabel}`);
  let generated = execFileSync("perl", [createHashTableScript, "-"], {
    cwd: legacyRoot,
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
    encoding: "utf8",
    input: preprocessed,
  });

  generated = generated.replaceAll(/^\/\/.*$/gm, "");
  generated = generated.replaceAll(/^#include.*$/gm, "");
  generated = generated.replaceAll("namespace JSC {", "");
  generated = generated.replaceAll("} // namespace JSC", "");
  generated = generated.replaceAll(/NativeFunctionType,\s([a-zA-Z0-99_]+)/gm, "NativeFunctionType, &$1");
  generated = `#pragma once\n// File generated via \`create-hash-table.ts\`\n${generated.trim()}\n`;

  writeIfChanged(outputPath, generated);
}

function generateLegacyLUTHeaders(legacyRoot, codegenDir) {
  const lutInputs = [
    "src/bun.js/bindings/BunObject.cpp",
    "src/bun.js/bindings/ZigGlobalObject.lut.txt",
    "src/bun.js/bindings/JSBuffer.cpp",
    "src/bun.js/bindings/BunProcess.cpp",
    "src/bun.js/bindings/ProcessBindingConstants.cpp",
    "src/bun.js/bindings/ProcessBindingNatives.cpp",
  ];

  for (const relInputPath of lutInputs) {
    const inputPath = path.join(legacyRoot, relInputPath);
    if (!fs.existsSync(inputPath)) {
      fail(`missing LUT input source: ${inputPath}`);
    }

    const resultFile = path.basename(relInputPath).replace(".lut.txt", ".cpp").replace(".cpp", ".lut.h");
    const outputPath = path.join(codegenDir, resultFile);

    const inputText = fs.readFileSync(inputPath, "utf8");
    generateLUTHeader(legacyRoot, inputText, outputPath, relInputPath);
  }
}

function generateZigGeneratedClasses(legacyRoot, codegenDir) {
  const required = [
    "ZigGeneratedClasses.zig",
    "ZigGeneratedClasses.h",
    "ZigGeneratedClasses.cpp",
    "ZigGeneratedClasses+lazyStructureHeader.h",
    "ZigGeneratedClasses+DOMClientIsoSubspaces.h",
    "ZigGeneratedClasses+DOMIsoSubspaces.h",
    "ZigGeneratedClasses+lazyStructureImpl.h",
  ];

  if (required.every(file => fs.existsSync(path.join(codegenDir, file)))) {
    return;
  }

  const esbuildBin = path.join(legacyRoot, "node_modules/.bin/esbuild");
  if (!fs.existsSync(esbuildBin)) {
    fail(`missing esbuild binary at ${esbuildBin}; run npm install in legacy worktree first`);
  }

  const tempRoot = path.join(legacyRoot, "build", "freebsd-bootstrap", "node-codegen");
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });

  const sourceScript = path.join(legacyRoot, "src/codegen/generate-classes.ts");
  const codegenSourceDir = path.dirname(sourceScript);
  let patched = fs.readFileSync(sourceScript, "utf8");
  const marker = "const result = require(path.resolve(file));";
  if (!patched.includes(marker)) {
    fail(`unexpected generate-classes.ts format; missing marker: ${marker}`);
  }

  patched = patched
    .replace('from "./helpers";', `from ${JSON.stringify(path.join(codegenSourceDir, "helpers.ts"))};`)
    .replace('from "./class-definitions";', `from ${JSON.stringify(path.join(codegenSourceDir, "class-definitions.ts"))};`);
  patched = patched.replace(marker, "const result = await import(pathToFileURL(path.resolve(file)).href);");
  patched = `import { pathToFileURL } from \"node:url\";\n${patched}`;

  const patchedScript = path.join(tempRoot, "generate-classes.patched.ts");
  const bundledScript = path.join(tempRoot, "generate-classes.mjs");
  fs.writeFileSync(patchedScript, patched);

  run(esbuildBin, [patchedScript, "--bundle", "--platform=node", "--format=esm", "--target=node20", `--outfile=${bundledScript}`], legacyRoot);

  const classInputs = [
    ...listTopLevelClassFiles(path.join(legacyRoot, "src/bun.js")),
    ...listTopLevelClassFiles(path.join(legacyRoot, "src/bun.js/api")),
    ...listTopLevelClassFiles(path.join(legacyRoot, "src/bun.js/test")),
    ...listTopLevelClassFiles(path.join(legacyRoot, "src/bun.js/webcore")),
    ...listTopLevelClassFiles(path.join(legacyRoot, "src/bun.js/node")),
  ];

  if (classInputs.length === 0) {
    fail("no .classes.ts files found for generate-classes");
  }

  const transpiledClassInputs = [];
  for (const input of classInputs) {
    const relFromSrc = path.relative(path.join(legacyRoot, "src"), input).split(path.sep).join("/");
    const outFile = path.join(tempRoot, "classes", relFromSrc.replace(/\.ts$/, ".mjs"));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    run(esbuildBin, [input, "--bundle", "--platform=node", "--format=esm", "--target=node20", `--outfile=${outFile}`], legacyRoot);
    transpiledClassInputs.push(outFile);
  }

  run(process.execPath, [bundledScript, ...transpiledClassInputs, codegenDir], legacyRoot);
}

function generateLegacyWebCoreJSBuiltins(legacyRoot, codegenDir) {
  const required = ["WebCoreJSBuiltins.h", "WebCoreJSBuiltins.cpp", "BunBuiltinNames+extras.h"];
  if (required.every(file => fs.existsSync(path.join(codegenDir, file)))) {
    return;
  }

  const esbuildBin = path.join(legacyRoot, "node_modules/.bin/esbuild");
  if (!fs.existsSync(esbuildBin)) {
    fail(`missing esbuild binary at ${esbuildBin}; run npm install in legacy worktree first`);
  }

  const tempRoot = path.join(legacyRoot, "build", "freebsd-bootstrap", "node-codegen-builtin-functions");
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });

  const bundleFunctionsSourcePath = path.join(legacyRoot, "src/codegen/bundle-functions.ts");
  const builtinParserSourcePath = path.join(legacyRoot, "src/codegen/builtin-parser.ts");
  const js2nativeSourcePath =
    [path.join(legacyRoot, "src/codegen/generate-js2native.ts"), path.join(legacyRoot, "src/codegen/js2native-generator.ts")].find(
      file => fs.existsSync(file),
    ) ?? null;
  if (!js2nativeSourcePath) {
    fail("missing JS2Native generator (expected src/codegen/generate-js2native.ts or src/codegen/js2native-generator.ts)");
  }
  const replacementsSourcePath = path.join(legacyRoot, "src/codegen/replacements.ts");
  const builtinParserPatchedPath = path.join(tempRoot, "builtin-parser.patched.ts");
  const js2nativePatchedPath = path.join(tempRoot, `${path.basename(js2nativeSourcePath).replace(/\.ts$/, "")}.patched.ts`);
  const replacementsPatchedPath = path.join(tempRoot, "replacements.patched.ts");
  const bundleFunctionsPatchedPath = path.join(tempRoot, "bundle-functions.patched.ts");
  let bundleFunctionsSource = fs.readFileSync(bundleFunctionsSourcePath, "utf8");
  const codegenSourceDir = path.join(legacyRoot, "src/codegen");

  let js2nativeSource = fs.readFileSync(js2nativeSourcePath, "utf8");
  js2nativeSource = js2nativeSource
    .replace('from "./helpers";', `from ${JSON.stringify(path.join(codegenSourceDir, "helpers.ts"))};`)
    .replaceAll("import.meta.dir", JSON.stringify(path.join(legacyRoot, "src/codegen")))
    .replaceAll("import.meta.path", JSON.stringify(js2nativeSourcePath))
    .replaceAll("import.meta.file", JSON.stringify(js2nativeSourcePath));
  fs.writeFileSync(js2nativePatchedPath, js2nativeSource);

  let builtinParserSource = fs.readFileSync(builtinParserSourcePath, "utf8");
  builtinParserSource = builtinParserSource.replace(
    'from "./replacements";',
    `from ${JSON.stringify(replacementsPatchedPath)};`,
  );
  fs.writeFileSync(builtinParserPatchedPath, builtinParserSource);

  let replacementsSource = fs.readFileSync(replacementsSourcePath, "utf8");
  replacementsSource = replacementsSource
    .replace('from "../api/schema";', `from ${JSON.stringify(path.join(legacyRoot, "src/api/schema.js"))};`)
    .replace(
      'from "../bun.js/bindings/ErrorCode.ts";',
      `from ${JSON.stringify(path.join(legacyRoot, "src/bun.js/bindings/ErrorCode.ts"))};`,
    )
    .replace('from "./builtin-parser";', `from ${JSON.stringify(builtinParserPatchedPath)};`)
    .replace('from "./generate-js2native";', `from ${JSON.stringify(js2nativePatchedPath)};`)
    .replace('from "./js2native-generator";', `from ${JSON.stringify(js2nativePatchedPath)};`)
    .replaceAll("import.meta.path", JSON.stringify(replacementsSourcePath))
    .replaceAll("import.meta.file", JSON.stringify(replacementsSourcePath));
  fs.writeFileSync(replacementsPatchedPath, replacementsSource);

  bundleFunctionsSource = bundleFunctionsSource
    .replace('from "./builtin-parser";', `from ${JSON.stringify(builtinParserPatchedPath)};`)
    .replace('from "./client-js";', `from ${JSON.stringify(path.join(codegenSourceDir, "client-js.ts"))};`)
    .replace('from "./generate-js2native";', `from ${JSON.stringify(js2nativePatchedPath)};`)
    .replace('from "./js2native-generator";', `from ${JSON.stringify(js2nativePatchedPath)};`)
    .replace('from "./helpers";', `from ${JSON.stringify(path.join(codegenSourceDir, "helpers.ts"))};`)
    .replace('from "./replacements";', `from ${JSON.stringify(replacementsPatchedPath)};`);

  bundleFunctionsSource = bundleFunctionsSource.replace(
    /if \(import\.meta\.main\)\s*\{\s*throw new Error\("This script is not meant to be run directly"\);\s*\}/m,
    "",
  );
  bundleFunctionsSource = bundleFunctionsSource.replaceAll(
    "import.meta.dir",
    JSON.stringify(path.join(legacyRoot, "src/codegen")),
  );
  bundleFunctionsSource = bundleFunctionsSource.replaceAll(
    "import.meta.path",
    JSON.stringify(bundleFunctionsSourcePath),
  );
  fs.writeFileSync(bundleFunctionsPatchedPath, bundleFunctionsSource);

  const runnerTsPath = path.join(tempRoot, "run-bundle-functions.ts");
  const runnerMjsPath = path.join(tempRoot, "run-bundle-functions.mjs");
  const scannerPath = path.join(legacyRoot, "src/codegen/internal-module-registry-scanner.ts");

  fs.writeFileSync(
    runnerTsPath,
    `import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const legacyRoot = process.argv[2];
const cmakeBuildRoot = process.argv[3];
if (!legacyRoot || !cmakeBuildRoot) {
  throw new Error("usage: run-bundle-functions.ts <legacy-root> <cmake-build-root>");
}

const nodeRequire = createRequire(import.meta.url);
const BUN_LEGACY_TARGET = process.env.BUN_FREEBSD_LEGACY_BUNDLE_TARGET || "es2017";

function resolveSyncCompat(specifier: string, from: string) {
  const base = fs.existsSync(from) && fs.statSync(from).isDirectory() ? from : path.dirname(from);
  return nodeRequire.resolve(specifier, { paths: [base] });
}

const BunCompat = {
  env: process.env,
  enableANSIColors: Boolean(process.stdout.isTTY),
  file(filePath: string) {
    return {
      text: async () => fs.promises.readFile(filePath, "utf8"),
    };
  },
  async write(filePath: string, data: string | Uint8Array) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, data);
  },
  sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },
  resolveSync(specifier: string, from: string) {
    return resolveSyncCompat(specifier, from);
  },
  async build(options: any) {
    try {
      const result = await esbuild.build({
        entryPoints: options.entrypoints,
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: BUN_LEGACY_TARGET,
        supported: { bigint: true },
        define: options.define,
        minifySyntax: Boolean(options.minify?.syntax),
        minifyWhitespace: Boolean(options.minify?.whitespace),
        logLevel: "silent",
        legalComments: "none",
      });

      return {
        success: true,
        logs: [],
        outputs: result.outputFiles.map(file => ({
          text: async () => Buffer.from(file.contents).toString("utf8"),
        })),
      };
    } catch (error: any) {
      return {
        success: false,
        outputs: [],
        logs: [{ text: String(error?.message ?? error) }],
      };
    }
  },
};

(globalThis as any).Bun = BunCompat;
(globalThis as any).CMAKE_BUILD_ROOT = cmakeBuildRoot;

const { createInternalModuleRegistry } = await import(${JSON.stringify(scannerPath)});
const { bundleBuiltinFunctions } = await import(${JSON.stringify(bundleFunctionsPatchedPath)});
const { requireTransformer } = createInternalModuleRegistry(path.join(legacyRoot, "src/js"));
(globalThis as any).requireTransformer = requireTransformer;
await bundleBuiltinFunctions({ requireTransformer });
`,
  );

  run(
    esbuildBin,
    [
      runnerTsPath,
      "--bundle",
      "--packages=external",
      "--platform=node",
      "--format=esm",
      "--target=node20",
      `--banner:js=import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);`,
      `--outfile=${runnerMjsPath}`,
    ],
    legacyRoot,
  );

  run(process.execPath, [runnerMjsPath, legacyRoot, path.join(legacyRoot, "build")], legacyRoot);

  const bindingsDir = path.join(legacyRoot, "src/bun.js/bindings");
  const builtinsDir = path.join(legacyRoot, "src/js/builtins");

  for (const file of ["WebCoreJSBuiltins.h", "WebCoreJSBuiltins.cpp"]) {
    const generated = path.join(codegenDir, file);
    if (!fs.existsSync(generated)) {
      fail(`missing generated ${file} at ${generated}`);
    }
    fs.mkdirSync(bindingsDir, { recursive: true });
    fs.copyFileSync(generated, path.join(bindingsDir, file));
  }

  const extrasHeader = path.join(codegenDir, "BunBuiltinNames+extras.h");
  if (fs.existsSync(extrasHeader)) {
    fs.mkdirSync(builtinsDir, { recursive: true });
    fs.copyFileSync(extrasHeader, path.join(builtinsDir, "BunBuiltinNames+extras.h"));
  }
}

function generateLegacyModuleRegistryViaBundleModules(legacyRoot, codegenDir) {
  const required = [
    "InternalModuleRegistry+numberOfModules.h",
    "InternalModuleRegistry+enum.h",
    "InternalModuleRegistry+createInternalModuleById.h",
    "InternalModuleRegistryConstants.h",
    "ResolvedSourceTag.zig",
    "SyntheticModuleType.h",
    "NativeModuleImpl.h",
    "GeneratedJS2Native.h",
  ];

  const esbuildBin = path.join(legacyRoot, "node_modules/.bin/esbuild");
  if (!fs.existsSync(esbuildBin)) {
    fail(`missing esbuild binary at ${esbuildBin}; run npm install in legacy worktree first`);
  }

  const sourceScript = path.join(legacyRoot, "src/codegen/bundle-modules.ts");
  if (!fs.existsSync(sourceScript)) {
    fail(`missing bundle-modules script: ${sourceScript}`);
  }

  const tempRoot = path.join(legacyRoot, "build", "freebsd-bootstrap", "node-codegen-bundle-modules");
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });

  const codegenSourceDir = path.join(legacyRoot, "src/codegen");
  const bundledScript = path.join(tempRoot, "bundle-modules.mjs");
  const patchedSourceScript = path.join(codegenSourceDir, "bundle-modules.freebsd-patched.ts");
  const runnerScript = path.join(tempRoot, "run-bundle-modules.mjs");
  const buildRoot = path.join(legacyRoot, "build");
  const jsRoot = path.join(legacyRoot, "src/js");

  let bundleModulesSource = fs.readFileSync(sourceScript, "utf8");
  const captureMarker = 'let captured = `(function (){${output.replace("// @bun\\n", "").trim()}})`;';
  if (!bundleModulesSource.includes(captureMarker)) {
    fail(`unexpected bundle-modules.ts format; missing marker: ${captureMarker}`);
  }
  bundleModulesSource = bundleModulesSource.replace(
    captureMarker,
    `let bundled = output.replace("// @bun\\n", "").trim();
  bundled = bundled.replace(/^"use strict";\\s*/, "");
  bundled = bundled.replace(/^"use strict";\\s*/, "");
  if (bundled.endsWith(";")) {
    bundled = bundled.slice(0, -1);
  }
  // InternalModuleRegistry expects an anonymous function expression.
  // Return the bundled IIFE value from inside that wrapper.
  let captured = \`(function (){return (\${bundled});})\`;`,
  );
  fs.writeFileSync(patchedSourceScript, bundleModulesSource);

  run(
    esbuildBin,
    [
      patchedSourceScript,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node20",
      `--banner:js=import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);`,
      `--define:import.meta.dir=${JSON.stringify(codegenSourceDir)}`,
      `--define:import.meta.path=${JSON.stringify(sourceScript)}`,
      `--define:import.meta.file=${JSON.stringify(sourceScript)}`,
      `--outfile=${bundledScript}`,
    ],
    legacyRoot,
  );

  fs.writeFileSync(
    runnerScript,
    `import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const buildRoot = ${JSON.stringify(buildRoot)};
const jsRoot = ${JSON.stringify(jsRoot)};
const nodeRequire = createRequire(import.meta.url);
const BUN_LEGACY_TARGET = process.env.BUN_FREEBSD_LEGACY_BUNDLE_TARGET || "es2017";

class BunTranspilerCompat {
  constructor(_opts) {}
  scanImports(_input) {
    return [];
  }
}

function bunBuildCompat(cmd) {
  const args = cmd.slice(2);
  const entrypoints = [];
  const external = [];
  const define = {};
  let root = jsRoot;
  let outdir = path.join(buildRoot, "tmp_modules", "modules_out");
  let target = "esnext";
  let minifySyntax = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--root") {
      root = args[++i];
      continue;
    }
    if (arg === "--target") {
      const t = args[++i];
      target = t === "bun" ? BUN_LEGACY_TARGET : t;
      continue;
    }
    if (arg === "--external") {
      external.push(args[++i]);
      continue;
    }
    if (arg === "--define") {
      const item = args[++i];
      const eq = item.indexOf("=");
      if (eq > 0) define[item.slice(0, eq)] = item.slice(eq + 1);
      continue;
    }
    if (arg === "--outdir") {
      outdir = args[++i];
      continue;
    }
    if (arg === "--minify-syntax") {
      minifySyntax = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      entrypoints.push(arg);
    }
  }

  try {
    esbuild.buildSync({
      entryPoints: entrypoints,
      bundle: true,
      format: "iife",
      platform: "browser",
      target,
      supported: { bigint: true },
      outdir,
      outbase: root,
      define,
      external,
      minifySyntax,
      write: true,
      logLevel: "silent",
      legalComments: "none",
    });
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(String(err?.stack ?? err)),
    };
  }
}

function resolveSyncCompat(specifier, from) {
  const baseDir = (() => {
    if (!from) return process.cwd();
    const full = path.isAbsolute(from) ? from : path.resolve(from);
    try {
      const stat = fs.statSync(full);
      return stat.isDirectory() ? full : path.dirname(full);
    } catch {
      return path.dirname(full);
    }
  })();

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const abs = path.resolve(baseDir, specifier);
    const candidates = [
      abs,
      abs + ".ts",
      abs + ".js",
      abs + ".mts",
      abs + ".mjs",
      abs + ".cts",
      abs + ".cjs",
      path.join(abs, "index.ts"),
      path.join(abs, "index.js"),
      path.join(abs, "index.mts"),
      path.join(abs, "index.mjs"),
      path.join(abs, "index.cts"),
      path.join(abs, "index.cjs"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error("Cannot resolve: " + specifier + " from " + from);
  }

  return nodeRequire.resolve(specifier, { paths: [baseDir] });
}

globalThis.Bun = {
  env: { ...process.env, TARGET_PLATFORM: "linux", TARGET_ARCH: process.arch },
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },
  file(filePath) {
    return {
      async text() {
        return fs.promises.readFile(filePath, "utf8");
      },
    };
  },
  async write(filePath, data) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, data);
  },
  spawnSync(opts) {
    const cmd = opts?.cmd ?? [];
    if (Array.isArray(cmd) && cmd.length >= 2 && cmd[1] === "build") {
      return bunBuildCompat(cmd);
    }
    return {
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("unsupported Bun.spawnSync in bootstrap shim"),
    };
  },
  async build(options) {
    try {
      const result = await esbuild.build({
        entryPoints: options.entrypoints,
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: BUN_LEGACY_TARGET,
        supported: { bigint: true },
        define: options.define,
        minifySyntax: Boolean(options.minify?.syntax),
        minifyWhitespace: Boolean(options.minify?.whitespace),
        logLevel: "silent",
        legalComments: "none",
      });
      return {
        success: true,
        logs: [],
        outputs: result.outputFiles.map(file => ({
          async text() {
            return Buffer.from(file.contents).toString("utf8");
          },
        })),
      };
    } catch (error) {
      return {
        success: false,
        outputs: [],
        logs: [{ text: String(error?.message ?? error) }],
      };
    }
  },
  Transpiler: BunTranspilerCompat,
  resolveSync(specifier, from) {
    return resolveSyncCompat(specifier, from);
  },
};

// Legacy script expects this global.
globalThis.CMAKE_BUILD_ROOT = buildRoot;

await import(${JSON.stringify(bundledScript)});
`,
  );

  run(process.execPath, [runnerScript, "--debug=OFF", buildRoot], legacyRoot);

  for (const file of required) {
    const generated = path.join(codegenDir, file);
    if (!fs.existsSync(generated)) {
      fail(`bundle-modules did not generate expected file: ${generated}`);
    }
  }
}

function generateLegacyJSSink(legacyRoot, codegenDir) {
  const required = ["JSSink.h", "JSSink.cpp", "JSSink.lut.h"];
  if (required.every(file => fs.existsSync(path.join(codegenDir, file)))) {
    return;
  }

  const esbuildBin = path.join(legacyRoot, "node_modules/.bin/esbuild");
  if (!fs.existsSync(esbuildBin)) {
    fail(`missing esbuild binary at ${esbuildBin}; run npm install in legacy worktree first`);
  }

  const sourceScript = path.join(legacyRoot, "src/codegen/generate-jssink.ts");
  if (!fs.existsSync(sourceScript)) {
    fail(`missing generate-jssink script: ${sourceScript}`);
  }

  const tempRoot = path.join(legacyRoot, "build", "freebsd-bootstrap", "node-codegen-jssink");
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });

  const codegenSourceDir = path.join(legacyRoot, "src/codegen");
  const patchedScript = path.join(tempRoot, "generate-jssink.patched.ts");
  const bundledScript = path.join(tempRoot, "generate-jssink.mjs");
  const runnerScript = path.join(tempRoot, "run-generate-jssink.mjs");
  let source = fs.readFileSync(sourceScript, "utf8");

  source = source.replaceAll("import.meta.dir", JSON.stringify(codegenSourceDir));
  source = source.replace(/Bun\.spawnSync\([\s\S]*?\);\s*$/m, "");
  fs.writeFileSync(patchedScript, source);

  run(esbuildBin, [patchedScript, "--bundle", "--platform=node", "--format=esm", "--target=node20", `--outfile=${bundledScript}`], legacyRoot);

  fs.writeFileSync(
    runnerScript,
    `import fs from "node:fs";
import path from "node:path";

globalThis.Bun = {
  async write(filePath, data) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, data);
  },
};

await import(${JSON.stringify(bundledScript)});
`,
  );

  run(process.execPath, [runnerScript, codegenDir], legacyRoot);

  const lutInputPath = path.join(codegenDir, "JSSink.lut.txt");
  if (!fs.existsSync(lutInputPath)) {
    fail(`missing generated JSSink.lut.txt at ${lutInputPath}`);
  }
  generateLUTHeader(legacyRoot, fs.readFileSync(lutInputPath, "utf8"), path.join(codegenDir, "JSSink.lut.h"), "build/codegen/JSSink.lut.txt");

  const bindingsDir = path.join(legacyRoot, "src/bun.js/bindings");
  for (const file of ["JSSink.h", "JSSink.cpp", "JSSink.lut.h"]) {
    const generated = path.join(codegenDir, file);
    if (!fs.existsSync(generated)) {
      fail(`missing generated ${file} at ${generated}`);
    }
    fs.mkdirSync(bindingsDir, { recursive: true });
    fs.copyFileSync(generated, path.join(bindingsDir, file));
  }
}

const legacyRootArg = process.argv[2];
const legacyRoot = legacyRootArg ? path.resolve(legacyRootArg) : "";
const codegenDir = process.argv[3] ? path.resolve(process.argv[3]) : legacyRoot ? path.join(legacyRoot, "build/codegen") : "";

if (!legacyRoot) {
  fail("usage: bootstrap-freebsd-generate-legacy-codegen.mjs <legacy-worktree> [codegen-dir]");
}
if (!fs.existsSync(legacyRoot)) {
  fail(`legacy worktree not found: ${legacyRoot}`);
}

fs.mkdirSync(codegenDir, { recursive: true });

const moduleRegistryData = collectModuleRegistryData(legacyRoot);
generateZigGeneratedClasses(legacyRoot, codegenDir);
generateLegacyLUTHeaders(legacyRoot, codegenDir);
generateLegacyModuleRegistryViaBundleModules(legacyRoot, codegenDir);
generateLegacyWebCoreJSBuiltins(legacyRoot, codegenDir);
generateLegacyJSSink(legacyRoot, codegenDir);
if (!fs.existsSync(path.join(codegenDir, "ResolvedSourceTag.zig"))) {
  generateResolvedSourceTag(codegenDir, moduleRegistryData);
}
if (!fs.existsSync(path.join(codegenDir, "InternalModuleRegistry+createInternalModuleById.h"))) {
  generateInternalModuleRegistryHeaders(codegenDir, moduleRegistryData);
}
if (!fs.existsSync(path.join(codegenDir, "SyntheticModuleType.h"))) {
  generateSyntheticModuleTypeHeader(codegenDir, moduleRegistryData);
}
if (!fs.existsSync(path.join(codegenDir, "NativeModuleImpl.h"))) {
  generateNativeModuleImplHeader(codegenDir, moduleRegistryData);
}
generateErrorCode(legacyRoot, codegenDir);
console.log(`[codegen] wrote legacy codegen outputs in ${codegenDir}`);
