// This script is run when you change anything in src/js/*
//
// Documentation is in src/js/README.md
//
// Originally, the builtin bundler only supported function files, but then the module files were
// added to this, which has made this entire setup extremely convoluted and a mess.
//
// One day, this entire setup should be rewritten, but also it would be cool if Bun natively
// supported macros that aren't json value -> json value. Otherwise, I'd use a real JS parser/ast
// library, instead of RegExp hacks.
import fs from "fs";
import { builtinModules } from "node:module";
import path from "path";
import { spawnSync } from "node:child_process";
import jsclasses from "./../bun.js/bindings/js_classes";
import { sliceSourceCode } from "./builtin-parser";
import { createAssertClientJS, createLogClientJS } from "./client-js";
import { getJS2NativeCPP, getJS2NativeZig } from "./generate-js2native";
import { cap, declareASCIILiteral, readUtf8CompatSync, writeIfNotChanged } from "./helpers";
import { createInternalModuleRegistry } from "./internal-module-registry-scanner";
import { define } from "./replacements";
import { bundleBuiltinFunctions } from "./bundle-functions";

const BASE = path.join(import.meta.dir, "../js");
const debug = process.argv[2] === "--debug=ON";
const CMAKE_BUILD_ROOT = process.argv[3];
const traceEnabled = process.env.BUN_FREEBSD_CODEGEN_TRACE === "1";
const traceAllPreprocessItems = process.env.BUN_FREEBSD_CODEGEN_TRACE_PREPROCESS_ALL === "1";
// On FreeBSD, direct self-host codegen uses Bun's bundler path (not the node fallback path).
// For internal module parity with the node/esbuild runner, force CommonJS bundle output.
const forceCJSFormat =
  (process.platform === "freebsd" && Bun.version !== "0.0.0") || process.env.BUN_FREEBSD_CODEGEN_FORCE_CJS === "1";
const trace = (...args: any[]) => {
  if (!traceEnabled) return;
  console.error("[freebsd-codegen-trace]", ...args);
};

const timeString = 'Bundled "src/js" for ' + (debug ? "development" : "production");
console.time(timeString);

if (!CMAKE_BUILD_ROOT) {
  console.error("Usage: bun bundle-modules.ts --debug=[OFF|ON] <CMAKE_WORK_DIR>");
  process.exit(1);
}

globalThis.CMAKE_BUILD_ROOT = CMAKE_BUILD_ROOT;
trace("init", { debug, CMAKE_BUILD_ROOT });

const TMP_DIR = path.join(CMAKE_BUILD_ROOT, "tmp_modules");
const CODEGEN_DIR = path.join(CMAKE_BUILD_ROOT, "codegen");
const JS_DIR = path.join(CMAKE_BUILD_ROOT, "js");

const t = new Bun.Transpiler({ loader: "tsx" });

let start = performance.now();
const silent = process.env.BUN_SILENT === "1" || process.env.CLAUDECODE;
function markVerbose(log: string) {
  const now = performance.now();
  console.log(`${log} (${(now - start).toFixed(0)}ms)`);
  start = now;
}

const mark = silent ? (log: string) => {} : markVerbose;

trace("createInternalModuleRegistry:start", BASE);
const { moduleList, nativeModuleIds, nativeModuleEnumToId, nativeModuleEnums, requireTransformer, nativeStartIndex } =
  createInternalModuleRegistry(BASE);
trace("createInternalModuleRegistry:done", {
  moduleCount: moduleList.length,
  nativeStartIndex,
});
globalThis.requireTransformer = requireTransformer;

// these logs surround a very weird issue where writing files and then bundling sometimes doesn't
// work, so i have lot of debug logs that blow up the console because not sure what is going on.
// that is also the reason for using `retry` when theoretically writing a file the first time
// should actually write the file.
const verbose = Bun.env.VERBOSE ? console.log : () => {};
const isFreeBSD = process.platform === "freebsd";
const isStage0Bun = typeof Bun !== "undefined" && Bun.version === "0.0.0";
// Stage0 on FreeBSD can deadlock in node:child_process spawnSync() during codegen.
// Keep the tee-based path as an opt-in escape hatch, but default to fs writes now
// that the canonical stage0 runtime passes node:fs checks.
const useSpawnWriteCompat = isFreeBSD && process.env.BUN_FREEBSD_FORCE_TEE_WRITE === "1";

function ensureDirSync(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
  if (fs.existsSync(dirPath)) return;
  if (isFreeBSD) {
    const fallback = spawnSync("/bin/mkdir", ["-p", dirPath], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
    if (fallback.status === 0 && fs.existsSync(dirPath)) return;
    throw new Error(`mkdir fallback failed for ${dirPath}: ${fallback.stderr || fallback.error || "unknown error"}`);
  }
  throw new Error(`directory did not exist after mkdir: ${dirPath}`);
}

function writeFileCompatSync(filePath: string, contents: string) {
  if (useSpawnWriteCompat) {
    const fallback = spawnSync("/usr/bin/tee", [filePath], {
      input: contents,
      stdio: ["pipe", "ignore", "pipe"],
      encoding: "utf8",
    });
    if (fallback.status === 0) return;
    throw new Error(`write fallback failed for ${filePath}: ${fallback.stderr || fallback.error || "unknown error"}`);
  }

  try {
    fs.writeFileSync(filePath, contents);
    return;
  } catch (err) {
    if (!isFreeBSD) throw err;
    const fallback = spawnSync("/usr/bin/tee", [filePath], {
      input: contents,
      stdio: ["pipe", "ignore", "pipe"],
      encoding: "utf8",
    });
    if (fallback.status === 0) return;
    throw new Error(`write fallback failed for ${filePath}: ${fallback.stderr || fallback.error || "unknown error"}`);
  }
}

async function retry(n, fn) {
  var err;
  while (n > 0) {
    try {
      await fn();
      return;
    } catch (e) {
      err = e;
      n--;
      await Bun.sleep(5);
    }
  }
  throw err;
}

const bunRepoRoot = path.join(CMAKE_BUILD_ROOT, "..", "..");

// Preprocess builtins
const bundledEntryPoints: string[] = [];
// Legacy FreeBSD stage0 has a path-string corruption bug in some single-entry Bun.build() calls.
// We keep a small, explicit list of problematic entrypoints and apply a short-path alias only at
// bundler invocation time (not preprocess time) because preprocess-time aliasing can deadlock stage0.
const stage0AliasedModuleBaseNames: Record<string, string> = {
  "internal/perf_hooks/monitorEventLoopDelay.ts": "29.ts",
  "internal/streams/end-of-stream.ts": "eos.ts",
  "internal/streams/lazy_transform.ts": "lazy.ts",
  "internal/streams/native-readable.ts": "s51.ts",
  "node/_http_server.ts": "s76.ts",
  "node/assert.strict.ts": "s84.ts",
  "node/child_process.ts": "s87.ts",
  "node/diagnostics_channel.ts": "s92.ts",
  "node/inspector.promises.ts": "s102.ts",
  "node/readline.promises.ts": "s112.ts",
  "node/stream.consumers.ts": "s115.ts",
};
trace("preprocess:start");
for (let i = 0; i < nativeStartIndex; i++) {
  try {
    if (traceEnabled && (traceAllPreprocessItems || i === 0 || i === nativeStartIndex - 1 || (i % 50) === 0)) {
      trace("preprocess:item", { i, id: moduleList[i] });
    }
    const file = path.join(BASE, moduleList[i]);
    let input = readUtf8CompatSync(file);

    if (!/\bexport\s+(?:function|class|const|default|{)/.test(input)) {
      if (input.includes("module.exports")) {
        throw new Error(
          "Do not use CommonJS module.exports in ESM modules. Use `export default { ... }` instead. See src/js/README.md",
        );
      } else {
        throw new Error(
          `Internal modules must have at least one ESM export statement in '${path.relative(bunRepoRoot, file)}' — see src/js/README.md`,
        );
      }
    }

    // TODO: there is no reason this cannot be converted automatically.
    // import { ... } from '...' -> `const { ... } = require('...')`
    const scannedImports = t.scan(input);
    for (const imp of scannedImports.imports) {
      if (imp.kind === "import-statement") {
        var isBuiltin = true;
        try {
          if (!builtinModules.includes(imp.path)) {
            requireTransformer(imp.path, moduleList[i]);
          }
        } catch {
          isBuiltin = false;
        }
        if (isBuiltin) {
          const err = new Error(
            `Cannot use ESM import statement within builtin modules. Use require("${imp.path}") instead. See src/js/README.md (from ${moduleList[i]})`,
          );
          err.name = "BunError";
          err["fileName"] = moduleList[i];
          throw err;
        }
      }
    }

    if (scannedImports.exports.includes("default") && scannedImports.exports.length > 1) {
      const err = new Error(
        `Using \`export default\` AND named exports together in builtin modules is unsupported. See src/js/README.md (from ${moduleList[i]})`,
      );
      err.name = "BunError";
      err["fileName"] = moduleList[i];
      throw err;
    }
    let importStatements: string[] = [];

    const processed = sliceSourceCode(
      "{" +
        input
          .replace(
            /\bimport(\s*type)?\s*(\{[^}]*\}|(\*\s*as)?\s[a-zA-Z0-9_$]+)\s*from\s*['"][^'"]+['"]/g,
            stmt => (importStatements.push(stmt), ""),
          )
          .replace(/export\s*{\s*}\s*;/g, ""),
      true,
      x => requireTransformer(x, moduleList[i]),
    );
    const stage0FreeBSD = isFreeBSD && isStage0Bun;
    const fileHeader = stage0FreeBSD
      ? ""
      : `// GENERATED TEMP FILE - DO NOT EDIT
// Sourced from src/js/${moduleList[i]}
`;
    let fileToTranspile = `${fileHeader}${importStatements.join("\n")}

${processed.result.slice(1).trim()}
;$$EXPORT$$(__intrinsic__exports).$$EXPORT_END$$;
`;

    // Attempt to optimize "$exports = ..." to a variableless return
    // otherwise, declare $exports so it works.
    let exportOptimization = false;
    fileToTranspile = fileToTranspile.replace(
      /__intrinsic__exports\s*=\s*(.*|.*\{[^\}]*}|.*\([^\)]*\))\n+\s*\$\$EXPORT\$\$\(__intrinsic__exports\).\$\$EXPORT_END\$\$;/,
      (_, a) => {
        exportOptimization = true;
        return "$$EXPORT$$(" + a.replace(/;$/, "") + ").$$EXPORT_END$$;";
      },
    );
    if (!exportOptimization) {
      if (stage0FreeBSD) {
        const stage0ExportVar = "__b0";
        fileToTranspile = `${fileHeader}${importStatements.join("\n")}

var ${stage0ExportVar};
${processed.result.slice(1).trim().replaceAll("__intrinsic__exports", stage0ExportVar)}
;$$EXPORT$$(${stage0ExportVar}).$$EXPORT_END$$;
`;
      } else {
        fileToTranspile = `var $;` + fileToTranspile.replaceAll("__intrinsic__exports", "$");
      }
    }
    const outputPath = path.join(TMP_DIR, moduleList[i].slice(0, -3) + ".ts");

    ensureDirSync(path.dirname(outputPath));
    if (!fs.existsSync(path.dirname(outputPath))) {
      verbose("directory did not exist after mkdir twice:", path.dirname(outputPath));
    }

    if (!stage0FreeBSD) {
      fileToTranspile = "// @ts-nocheck\n" + fileToTranspile;
    }

    try {
      writeFileCompatSync(outputPath, fileToTranspile);
      if (!fs.existsSync(outputPath)) {
        verbose("file did not exist after write:", outputPath);
        throw new Error("file did not exist after write: " + outputPath);
      }
      verbose("wrote to", outputPath, "successfully");
    } catch {
      await retry(3, async () => {
        ensureDirSync(path.dirname(outputPath));
        writeFileCompatSync(outputPath, fileToTranspile);
        if (!fs.existsSync(outputPath)) {
          verbose("file did not exist after write:", outputPath);
          throw new Error("file did not exist after write: " + outputPath);
        }
        verbose("wrote to", outputPath, "successfully later");
      });
    }
    bundledEntryPoints.push(outputPath);
  } catch (error) {
    console.error(error);
    console.error(`While processing: ${moduleList[i]}`);
    process.exit(1);
  }
}

mark("Preprocess modules");
trace("preprocess:done", { bundledEntryPoints: bundledEntryPoints.length });

const makeBundlerCli = (entryPoints: string[]) => [
  process.execPath,
  "build",
  ...entryPoints,
  ...(debug ? [] : ["--minify-syntax", "--keep-names"]),
  "--root",
  TMP_DIR,
  "--target",
  "bun",
  ...(forceCJSFormat ? ["--format", "cjs"] : []),
  ...builtinModules.map(x => ["--external", x]).flat(),
  ...Object.keys(define)
    .map(x => [`--define`, `${x}=${define[x]}`])
    .flat(),
  "--define",
  `IS_BUN_DEVELOPMENT=${String(!!debug)}`,
  "--define",
  `__intrinsic__debug=${debug ? "$debug_log_enabled" : "false"}`,
  "--outdir",
  path.join(TMP_DIR, "modules_out"),
];

const useNodeSpawnForBundler =
  isFreeBSD && isStage0Bun && process.env.BUN_FREEBSD_STAGE0_USE_NODE_SPAWN_BUNDLER === "1";
const stage0BundlerBatchSize =
  isFreeBSD && isStage0Bun
    ? Math.max(
        1,
        Number.parseInt(process.env.BUN_FREEBSD_STAGE0_BUNDLER_BATCH_SIZE || "16", 10) ||
          16,
      )
    : 0;
const stage0PreferFirstAttemptAliasForSingleEntry =
  isFreeBSD &&
  isStage0Bun &&
  stage0BundlerBatchSize === 1 &&
  process.env.BUN_FREEBSD_STAGE0_DISABLE_ALIAS_ALL_SINGLE_ENTRY !== "1";

async function runBundlerCli(entryPoints: string[], batchIndex?: number) {
  const useStage0BunBuildAPI = isFreeBSD && isStage0Bun;
  if (useStage0BunBuildAPI) {
    const runStage0BuildOnce = async (opts?: { aliasBase?: string; aliasReason?: string }) => {
      let bundlerEntryPoints = entryPoints;
      let aliasedEntrypointOutputPath: string | undefined;

      if (entryPoints.length === 1 && opts?.aliasBase) {
        const original = entryPoints[0];
        const rel = original.slice(TMP_DIR.length + 1);
        const aliasPath = path.join(TMP_DIR, path.dirname(rel), opts.aliasBase);
        // Copy just before the single-entry Bun.build() call to avoid the preprocess-stage hangs seen
        // when legacy stage0 writes these alias paths during the preprocessing loop.
        // Use text read/write instead of fs.copyFileSync(): legacy FreeBSD stage0 can hit an internal
        // TODO path in copyFileSync even though plain file reads/writes are stable.
        trace("bun.build.api:entrypoint-alias-prepare", { original, aliasPath, batchIndex, step: "mkdir" });
        ensureDirSync(path.dirname(aliasPath));
        trace("bun.build.api:entrypoint-alias-prepare", { original, aliasPath, batchIndex, step: "read" });
        const aliasedSourceText = readUtf8CompatSync(original);
        trace("bun.build.api:entrypoint-alias-prepare", {
          original,
          aliasPath,
          batchIndex,
          step: "write",
          bytes: aliasedSourceText.length,
        });
        writeFileCompatSync(aliasPath, aliasedSourceText);
        bundlerEntryPoints = [aliasPath];
        aliasedEntrypointOutputPath = rel.replace(/\.ts$/, ".js");
        trace("bun.build.api:entrypoint-alias", { original, aliasPath, batchIndex, reason: opts.aliasReason });
      }

      trace("bun.build.api:start", {
        entryPoints: bundlerEntryPoints.length,
        entrypoint0: bundlerEntryPoints.length === 1 ? bundlerEntryPoints[0] : undefined,
        batchIndex,
        stage0BundlerBatchSize,
      });
      const result = await Bun.build({
        entrypoints: bundlerEntryPoints,
        outdir: path.join(TMP_DIR, "modules_out"),
        root: TMP_DIR,
        target: "bun",
        external: builtinModules,
        define: {
          ...define,
          IS_BUN_DEVELOPMENT: String(!!debug),
          __intrinsic__debug: debug ? "$debug_log_enabled" : "false",
        },
        minify: debug ? false : { syntax: true },
        keepNames: !debug,
      });
      trace("bun.build.api:done", {
        success: result.success,
        outputs: result.outputs?.length ?? 0,
        logs: result.logs?.length ?? 0,
        batchIndex,
      });

      if (result.success && aliasedEntrypointOutputPath && bundlerEntryPoints[0] !== entryPoints[0]) {
        // Bun.build() emits to the alias output path; remap the artifact back to the canonical module
        // path so the existing postprocess loop and generated registry logic remain unchanged.
        const aliasRelJs = bundlerEntryPoints[0].slice(TMP_DIR.length + 1).replace(/\.ts$/, ".js");
        const outdir = path.join(TMP_DIR, "modules_out");
        const aliasOutput = path.join(outdir, aliasRelJs);
        const canonicalOutput = path.join(outdir, aliasedEntrypointOutputPath);
        if (fs.existsSync(aliasOutput)) {
          ensureDirSync(path.dirname(canonicalOutput));
          // Same rationale as above: avoid legacy stage0 copyFileSync() on FreeBSD.
          writeFileCompatSync(canonicalOutput, readUtf8CompatSync(aliasOutput));
          trace("bun.build.api:entrypoint-alias-remap", { aliasOutput, canonicalOutput, batchIndex, mode: "copy" });
        } else if (fs.existsSync(canonicalOutput)) {
          // Some legacy stage0 code paths preserve the original module-derived output name even when the
          // entrypoint file path is aliased. Accept that as success and keep going.
          trace("bun.build.api:entrypoint-alias-remap", {
            aliasOutput,
            canonicalOutput,
            batchIndex,
            mode: "canonical-already-exists",
          });
        } else {
          throw new Error(
            `stage0 alias remap failed: missing both alias output '${aliasOutput}' and canonical output '${canonicalOutput}'`,
          );
        }
      }
      return result;
    };

    const explicitAliasBase =
      entryPoints.length === 1 ? stage0AliasedModuleBaseNames[entryPoints[0].slice(TMP_DIR.length + 1)] : undefined;
    const defaultSingleEntryAliasBase =
      !explicitAliasBase && entryPoints.length === 1 && stage0PreferFirstAttemptAliasForSingleEntry
        ? `s${String(batchIndex ?? 0)}.ts`
        : undefined;
    let result = await runStage0BuildOnce(
      explicitAliasBase
        ? { aliasBase: explicitAliasBase, aliasReason: "known-bad-entrypoint" }
        : defaultSingleEntryAliasBase
          ? { aliasBase: defaultSingleEntryAliasBase, aliasReason: "single-entry-stage0-default" }
          : undefined,
    );

    // FreeBSD legacy stage0 can corrupt some entrypoint paths on a small subset of modules.
    // If a single-entry build fails with the known "failed to open entry point directory ... var __b0"
    // signature, retry once with a short deterministic alias path to keep Phase C bootstrap moving.
    if (!result.success && entryPoints.length === 1 && !explicitAliasBase && !defaultSingleEntryAliasBase) {
      const joinedLogs = (result.logs ?? []).map(String).join("\n");
      const looksLikeEntrypointPathCorruption =
        joinedLogs.includes("failed to open entry point directory:") && joinedLogs.includes("var __b0;");
      if (looksLikeEntrypointPathCorruption) {
        const autoAliasBase = `s${String(batchIndex ?? 0)}.ts`;
        trace("bun.build.api:entrypoint-alias-auto-retry", {
          entrypoint: entryPoints[0],
          autoAliasBase,
          batchIndex,
        });
        result = await runStage0BuildOnce({ aliasBase: autoAliasBase, aliasReason: "auto-retry-path-corruption" });
      }
    }

    if (!result.success) {
      for (const log of result.logs ?? []) {
        console.error(log);
      }
      console.error("bundle-modules.ts: Bun.build API failed");
      process.exit(1);
    }
    return;
  }

  const config_cli = makeBundlerCli(entryPoints);
  verbose("running: ", config_cli);
  trace("bun.build.cli:start", {
    args: config_cli.length,
    entryPoints: entryPoints.length,
    batchIndex,
    stage0BundlerBatchSize,
  });
  if (traceEnabled) {
    console.error("[freebsd-codegen-trace] bun.build.cli:argv:begin");
    console.error(config_cli.join("\n"));
    console.error("[freebsd-codegen-trace] bun.build.cli:argv:end");
  }

  const out = useNodeSpawnForBundler
    ? spawnSync(config_cli[0], config_cli.slice(1), {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "inherit", "pipe"],
      })
    : Bun.spawnSync({
        cmd: config_cli,
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"],
      });
  const bundlerExitCode = useNodeSpawnForBundler ? out.status : out.exitCode;
  trace("bun.build.cli:done", { exitCode: bundlerExitCode, useNodeSpawnForBundler, batchIndex });
  if (bundlerExitCode !== 0) {
    const stderrText = out.stderr && out.stderr.length > 0 ? Buffer.from(out.stderr).toString("utf8").trim() : "";
    if (stderrText.length > 0) {
      console.error(stderrText);
    }
    console.error("bundle-modules.ts: child bun build failed");
    process.exit(bundlerExitCode ?? 1);
  }
}

if (stage0BundlerBatchSize > 0 && bundledEntryPoints.length > stage0BundlerBatchSize) {
  trace("bun.build.cli:batches", {
    totalEntryPoints: bundledEntryPoints.length,
    batchSize: stage0BundlerBatchSize,
  });
  for (let i = 0; i < bundledEntryPoints.length; i += stage0BundlerBatchSize) {
    await runBundlerCli(
      bundledEntryPoints.slice(i, i + stage0BundlerBatchSize),
      Math.floor(i / stage0BundlerBatchSize),
    );
  }
} else {
  await runBundlerCli(bundledEntryPoints);
}

mark("Bundle modules");
trace("bundle-modules:postbuild:start");

const outputs = new Map();

for (const entrypoint of bundledEntryPoints) {
  const file_path = entrypoint.slice(TMP_DIR.length + 1).replace(/\.ts$/, ".js");
  const file = Bun.file(path.join(TMP_DIR, "modules_out", file_path));
  const output = await file.text();
  const cjsWrapped = output.includes("// @bun @bun-cjs");
  const normalizedOutput = cjsWrapped
    ? output
        .replace(/^\/\/\s*@bun\s*@bun-cjs\s*\n\(function\s*\([^)]*\)\s*{/, "")
        .replace(/\}\)\s*$/, "")
    : output.replace("// @bun\n", "");
  let captured = `(function (){${normalizedOutput.trim()}})`;
  let usesDebug = output.includes("$debug_log");
  let usesAssert = output.includes("$assert");
  const exportStubPattern = file_path === "internal-for-testing.js" ? /return \$;?\s*\nexport / : /return \$\nexport /;
  captured =
    captured
      .replace(/\$\$EXPORT\$\$\((.*)\).\$\$EXPORT_END\$\$;/, "return $1;")
      .replace(/]\s*,\s*__(debug|assert)_end__\)/g, ")")
      .replace(/]\s*,\s*__debug_end__\)/g, ")")
      .replace(/import.meta.require\((.*?)\)/g, (expr, specifier) => {
        throw new Error(`Builtin Bundler: do not use import.meta.require() (in ${file_path}))`);
      })
      .replace(/module\.exports\s*=/g, "$ = module.exports =")
      // Keep the historical rewrite for all modules. internal-for-testing may emit a semicolon variant.
      .replace(exportStubPattern, "return")
      .replace(/__intrinsic__/g, "@")
      .replace(/__no_intrinsic__/g, "") + "\n";
  captured = captured.replace(
    /function\s*\(.*?\)\s*{/,
    '$&"use strict";' +
      "var module={exports:{}};var exports=module.exports;" +
      (usesDebug
        ? createLogClientJS(
            file_path.replace(".js", ""),
            idToPublicSpecifierOrEnumName(file_path).replace(/^node:|^bun:/, ""),
          )
        : "") +
      (usesAssert ? createAssertClientJS(idToPublicSpecifierOrEnumName(file_path).replace(/^node:|^bun:/, "")) : ""),
  );
  const errors = [...captured.matchAll(/@bundleError\((.*)\)/g)];
  if (errors.length) {
    throw new Error(`Errors in ${entrypoint}:\n${errors.map(x => x[1]).join("\n")}`);
  }

  const outputPath = path.join(JS_DIR, file_path);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, captured);
  outputs.set(file_path.replace(".js", ""), captured);
}

mark("Postprocesss modules");
trace("bundle-modules:postbuild:done", { outputs: outputs.size });

function idToEnumName(id: string) {
  return id
    .replace(/\.[mc]?[tj]s$/, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .map(x => (["jsc", "ffi", "vm", "tls", "os", "ws", "fs", "dns"].includes(x) ? x.toUpperCase() : cap(x)))
    .join("");
}

function idToPublicSpecifierOrEnumName(id: string) {
  if (id === "internal-for-testing.ts") return "bun:internal-for-testing"; // not in the `bun/` folder because it's added conditionally
  id = id.replace(/\.[mc]?[tj]s$/, "");
  if (id.startsWith("node/")) {
    return "node:" + id.slice(5).replaceAll(".", "/");
  } else if (id.startsWith("bun/")) {
    return "bun:" + id.slice(4).replaceAll(".", "/");
  } else if (id.startsWith("internal/")) {
    return "internal:" + id.slice(9).replaceAll(".", "/");
  } else if (id.startsWith("thirdparty/")) {
    return id.slice(11).replaceAll(".", "/");
  }
  return idToEnumName(id);
}

await bundleBuiltinFunctions({
  requireTransformer,
});
trace("bundle-functions:done");

mark("Bundle Functions");

// This is a file with a single macro that is used in defining InternalModuleRegistry.h
writeIfNotChanged(
  path.join(CODEGEN_DIR, "InternalModuleRegistry+numberOfModules.h"),
  `#define BUN_INTERNAL_MODULE_COUNT ${moduleList.length}
#define BUN_NATIVE_MODULE_START_INDEX ${nativeStartIndex}
`,
);

// This code slice is used in InternalModuleRegistry.h for inlining the enum. I dont think we
// actually use this enum but it's probably a good thing to include.
writeIfNotChanged(
  path.join(CODEGEN_DIR, "InternalModuleRegistry+enum.h"),
  `${
    moduleList
      .map((id, n) => {
        return `${idToEnumName(id)} = ${n},`;
      })
      .join("\n") + "\n"
  }
`,
);

// This code slice is used in InternalModuleRegistry.cpp. It defines the loading function for modules.
writeIfNotChanged(
  path.join(CODEGEN_DIR, "InternalModuleRegistry+createInternalModuleById.h"),
  `// clang-format off
JSValue InternalModuleRegistry::createInternalModuleById(JSGlobalObject* globalObject, VM& vm, Field id)
{
  switch (id) {
    // JS internal modules
    ${moduleList
      .map((id, n) => {
        const moduleName = idToPublicSpecifierOrEnumName(id);
        const fileBase = JSON.stringify(id.replace(/\.[mc]?[tj]s$/, ".js"));
        const urlString = "builtin://" + id.replace(/\.[mc]?[tj]s$/, "").replace(/[^a-zA-Z0-9]+/g, "/");
        const inner =
          n >= nativeStartIndex
            ? `return generateNativeModule(globalObject, vm, generateNativeModule_${nativeModuleEnums[id]});`
            : `INTERNAL_MODULE_REGISTRY_GENERATE(globalObject, vm, "${moduleName}"_s, ${fileBase}_s, InternalModuleRegistryConstants::${idToEnumName(id)}Code, "${urlString}"_s);`;
        return `case Field::${idToEnumName(id)}: {
      ${inner}
    }`;
      })
      .join("\n    ")}
    default: {
      __builtin_unreachable();
    }
  }
  __builtin_unreachable();
}
`,
);

// This header is used by InternalModuleRegistry.cpp, and should only be included in that file.
// It inlines all the strings for the module IDs.
//
// We cannot use ASCIILiteral's `_s` operator for the module source code because for long
// strings it fails a constexpr assert. Instead, we do that assert in JS before we format the string
if (!debug) {
  writeIfNotChanged(
    path.join(CODEGEN_DIR, "InternalModuleRegistryConstants.h"),
    `// clang-format off
#pragma once

namespace Bun {
namespace InternalModuleRegistryConstants {
  ${moduleList
    .slice(0, nativeStartIndex)
    .map((id, n) => {
      const out = outputs.get(id.slice(0, -3).replaceAll("/", path.sep));
      if (!out) {
        throw new Error(`Missing output for ${id}`);
      }
      return declareASCIILiteral(`${idToEnumName(id)}Code`, out);
    })
    .join("\n")}
}
}`,
  );
} else {
  // In debug builds, we write empty strings to prevent recompilation. These are loaded from disk instead.
  writeIfNotChanged(
    path.join(CODEGEN_DIR, "InternalModuleRegistryConstants.h"),
    `// clang-format off
#pragma once

namespace Bun {
namespace InternalModuleRegistryConstants {
  ${moduleList
    .slice(0, nativeStartIndex)
    .map((id, n) => `${declareASCIILiteral(`${idToEnumName(id)}Code`, "")}`)
    .join("\n")}
}
}`,
  );
}

// This is a generated enum for zig code (exports.zig)
writeIfNotChanged(
  path.join(CODEGEN_DIR, "ResolvedSourceTag.zig"),
  `// zig fmt: off
pub const ResolvedSourceTag = enum(u32) {
    javascript = 0,
    package_json_type_module = 1,
    package_json_type_commonjs = 2,
    wasm = 3,
    object = 4,
    file = 5,
    esm = 6,
    json_for_object_loader = 7,
    /// Generate an object with "default" set to all the exports, including a "default" property
    exports_object = 8,
    /// Generate a module that only exports default the input JSValue
    export_default_object = 9,
    /// Signal upwards that the matching value in 'require.extensions' should be used.
    common_js_custom_extension = 10,

    // Built in modules are loaded through InternalModuleRegistry by numerical ID.
    // In this enum are represented as \`(1 << 9) & id\`
${moduleList
  .slice(0, nativeStartIndex)
  .map((id, n) => `    @"${idToPublicSpecifierOrEnumName(id)}" = ${(1 << 9) | n},`)
  .join("\n")}
    // Native modules come after the JS modules
${Object.entries(nativeModuleEnumToId)
  .map(([id, n], i) => `    @"${moduleList[nativeStartIndex + i]}" = ${(1 << 9) | (n + nativeStartIndex)},`)
  .join("\n")}
};
`,
);

// This is a generated enum for c++ code (headers-handwritten.h)
writeIfNotChanged(
  path.join(CODEGEN_DIR, "SyntheticModuleType.h"),
  `enum SyntheticModuleType : uint32_t {
    JavaScript = 0,
    PackageJSONTypeModule = 1,
    PackageJSONTypeCommonJS = 2,
    Wasm = 3,
    ObjectModule = 4,
    File = 5,
    ESM = 6,
    JSONForObjectLoader = 7,
    ExportsObject = 8,
    ExportDefaultObject = 9,
    CommonJSCustomExtension = 10,
    // Built in modules are loaded through InternalModuleRegistry by numerical ID.
    // In this enum are represented as \`(1 << 9) & id\`
    InternalModuleRegistryFlag = 1 << 9,
${moduleList
  .slice(0, nativeStartIndex)
  .map((id, n) => `    ${idToEnumName(id)} = ${(1 << 9) | n},`)
  .join("\n")}
    // Native modules come after the JS modules
${Object.entries(nativeModuleEnumToId)
  .map(([id, n], i) => `    ${id} = ${(1 << 9) | (i + nativeStartIndex)},`)
  .join("\n")}
};

`,
);

// This is used in ModuleLoader.cpp to link to all the headers for native modules.
writeIfNotChanged(
  path.join(CODEGEN_DIR, "NativeModuleImpl.h"),
  Object.values(nativeModuleEnums)
    .map(value => `#include "../../bun.js/modules/${value}Module.h"`)
    .join("\n") + "\n",
);

writeIfNotChanged(path.join(CODEGEN_DIR, "GeneratedJS2Native.h"), getJS2NativeCPP());

// zig will complain if this file is outside of the module
const js2nativeZigPath = path.join(import.meta.dir, "../bun.js/bindings/GeneratedJS2Native.zig");
writeIfNotChanged(js2nativeZigPath, getJS2NativeZig(js2nativeZigPath));

const generatedDTSPath = path.join(CODEGEN_DIR, "generated.d.ts");
writeIfNotChanged(
  generatedDTSPath,
  (() => {
    let dts = `
// GENERATED TEMP FILE - DO NOT EDIT
// generated by ${import.meta.path}

declare module "module" {
  global {
    interface PropertyDescriptor {
      __proto__?: any;
    }

    interface Function {
      readonly $call: Function.prototype["call"];
      readonly $apply: Function.prototype["apply"];
    }

    namespace NodeJS {
      interface Require {

`;

    dts += `        (id: "bun"): typeof import("bun");\n`;
    dts += `        (id: "bun:test"): typeof import("bun:test");\n`;
    dts += `        (id: "bun:jsc"): typeof import("bun:jsc");\n`;

    for (let i = 0; i < nativeStartIndex; i++) {
      const id = moduleList[i];
      const out = outputs.get(id.slice(0, -3).replaceAll("/", path.sep));
      if (!out) {
        throw new Error(`Missing output for ${id}`);
      }
      let internalName = idToPublicSpecifierOrEnumName(id);
      if (internalName.startsWith("internal:")) internalName = internalName.replace(":", "/");

      dts += `        (id: "${internalName}"): typeof import("${path.join(BASE, id)}").default;\n`;
    }

    dts += `
      }
    }
  }
}
`;

    for (const [name] of jsclasses) {
      dts += `\ndeclare function $inherits${name}(value: any): value is ${name};`;
    }

    return dts;
  })(),
);

mark("Generate Code");

const evalFiles = new Bun.Glob(path.join(BASE, "eval", "*.ts")).scanSync();
for (const file of evalFiles) {
  const {
    outputs: [output],
  } = await Bun.build({
    entrypoints: [file],

    // Shrink it.
    minify: !debug,

    target: "bun",
    format: "esm",
    env: "disable",
    define: {
      "process.platform": JSON.stringify(process.platform),
      "process.arch": JSON.stringify(process.arch),
    },
  });
  writeIfNotChanged(path.join(CODEGEN_DIR, "eval", path.basename(file)), await output.text());
}

if (!silent) {
  console.log("");
  console.timeEnd(timeString);
  console.log(
    `  %s kb`,
    Math.floor(
      (moduleList
        .slice(0, nativeStartIndex)
        .reduce((a, b) => a + outputs.get(b.slice(0, -3).replaceAll("/", path.sep)).length, 0) +
        globalThis.internalFunctionJSSize) /
        1000,
    ),
  );
  console.log(`  %s internal modules`, nativeStartIndex);
  console.log(`  %s native modules`, Object.keys(nativeModuleIds).length);
  console.log(
    `  %s internal functions across %s files`,
    globalThis.internalFunctionCount,
    globalThis.internalFunctionFileCount,
  );
}
