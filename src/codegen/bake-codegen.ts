import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { argParse, readUtf8CompatSync, writeIfNotChanged } from "./helpers";

const assert = (value: unknown, message?: string): asserts value => {
  if (!value) throw new Error(message ?? "Assertion failed");
};

// arg parsing
let { "codegen-root": codegenRoot, debug, ...rest } = argParse(["codegen-root", "debug"]);
if (debug === "false" || debug === "0" || debug == "OFF") debug = false;
if (!codegenRoot) {
  console.error("Missing --codegen-root=...");
  process.exit(1);
}
codegenRoot = resolve(codegenRoot);

const base_dir = join(import.meta.dirname, "../bake");
process.chdir(base_dir); // to make bun build predictable in development
const isFreeBSDStage0 = process.platform === "freebsd" && typeof Bun !== "undefined" && Bun.version === "0.0.0";
const freebsdStage0BakeTranspiler = isFreeBSDStage0 ? new Bun.Transpiler({ loader: "ts" }) : null;

async function writeIfNotChangedCompat(file: string, contents: string) {
  if (!isFreeBSDStage0) {
    writeIfNotChanged(file, contents);
    return;
  }

  if (Array.isArray(contents)) contents = contents.join("");
  contents = contents.replaceAll("\r\n", "\n").trim() + "\n";

  try {
    if (readUtf8CompatSync(file) === contents) return;
  } catch {}

  mkdirSync(dirname(file), { recursive: true });
  // Stage0 FreeBSD workaround: fs.writeFileSync() can fail with bogus ENOENT for file creation.
  await Bun.write(file, contents);
  if (readUtf8CompatSync(file) !== contents) {
    throw new Error(`Failed to write file ${file}`);
  }
}

let stage0BakeBuildCounter = 0;
async function buildCompat(label: string, options: Parameters<typeof Bun.build>[0]) {
  if (!isFreeBSDStage0 || !options.entrypoints || options.entrypoints.length !== 1) {
    return await Bun.build(options);
  }

  const originalEntrypoint = options.entrypoints[0]!;
  const aliasEntrypoint = join(codegenRoot, `b${stage0BakeBuildCounter++}.ts`);
  await Bun.write(aliasEntrypoint, readUtf8CompatSync(originalEntrypoint));

  const result = await Bun.build({
    ...options,
    entrypoints: [aliasEntrypoint],
  });
  if (result.success) return result;

  const logsText = (result.logs ?? [])
    .map(log => (typeof log?.message === "string" ? log.message : String(log)))
    .join("\n");
  if (
    logsText.includes("failed to open entry point directory") ||
    logsText.includes("File not found")
  ) {
    // Retry once with a fresh shorter alias. Legacy FreeBSD stage0 can poison a first attempt.
    const retryAlias = join(codegenRoot, `r${stage0BakeBuildCounter++}.ts`);
    await Bun.write(retryAlias, readUtf8CompatSync(originalEntrypoint));
    return await Bun.build({
      ...options,
      entrypoints: [retryAlias],
    });
  }

  return result;
}

function convertZigEnum(zig: string, names: string[]) {
  let output = "/** Generated from DevServer.zig */\n";
  for (const name of names) {
    const startTrigger = `\npub const ${name} = enum(u8) {`;
    const start = zig.indexOf(startTrigger) + startTrigger.length;
    const endTrigger = /\n    pub (inline )?fn |\n};/g;
    const end = zig.slice(start).search(endTrigger) + start;
    const enumText = zig.slice(start, end);
    const values = enumText.replaceAll("\n    ", "\n  ").replace(/\n\s*(\w+)\s*=\s*'(.+?)',/g, (_, name, value) => {
      return `\n  ${name} = ${value.charCodeAt(0)},`;
    });
    output += `export const enum ${name} {${values}}\n`;
  }
  return output;
}

function css(file: string, is_development: boolean): string {
  if (isFreeBSDStage0) {
    // Legacy FreeBSD stage0 still crashes on spawn/spawnSync paths. Use raw CSS content for bootstrap
    // codegen; the final build regenerates artifacts with the normal path.
    return JSON.stringify(readUtf8CompatSync(join(import.meta.dir, file)));
  }
  const { success, stdout, stderr } = Bun.spawnSync({
    cmd: [process.execPath, "build", file, "--minify"],
    cwd: import.meta.dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!success) throw new Error(stderr.toString("utf-8"));
  return stdout.toString("utf-8");
}

async function run() {
  const devServerZig = readUtf8CompatSync(join(base_dir, "DevServer.zig"));
  await writeIfNotChangedCompat(
    join(base_dir, "generated.ts"),
    convertZigEnum(devServerZig, ["IncomingMessageId", "MessageId"]),
  );

  const results = await Promise.allSettled(
    ["client", "server", "error"].map(async file => {
      const side = file === "error" ? "client" : file;
      let result = await buildCompat(`first-pass-${file}`, {
        entrypoints: [join(base_dir, `hmr-runtime-${file}.ts`)],
        define: {
          side: JSON.stringify(side),
          IS_ERROR_RUNTIME: String(file === "error"),
          IS_BUN_DEVELOPMENT: String(!!debug),
          OVERLAY_CSS: css("../bake/client/overlay.css", !!debug),
        },
        minify: {
          syntax: !debug,
        },
        target: side === "server" ? "bun" : "browser",
        drop: debug ? [] : ["ASSERT", "DEBUG"],
        conditions: [side],
      });
      if (!result.success) throw new AggregateError(result.logs);
      assert(result.outputs.length === 1, "must bundle to a single file");
      // @ts-ignore
      let code = await result.outputs[0].text();

      // A second pass is used to convert global variables into parameters, while
      // allowing for renaming to properly function when minification is enabled.
      const in_names = [
        file !== "error" && "unloadedModuleRegistry",
        file !== "error" && "config",
        file === "server" && "server_exports",
        file === "server" && "$separateSSRGraph",
        file === "server" && "$importMeta",
      ].filter(Boolean);
      const combined_source =
        file === "error"
          ? code
          : `
            __marker__;
            ${in_names.length > 0 ? "let" : ""} ${in_names.join(",")};
            __marker__(${in_names.join(",")});
            ${code};
          `;
      // Legacy FreeBSD stage0 can fail to create hidden dotfiles via fs.writeFileSync() with a bogus
      // ENOENT even when the parent directory exists. Use a non-dot temporary filename in stage0.
      const generated_entrypoint = join(
        isFreeBSDStage0 ? codegenRoot : base_dir,
        isFreeBSDStage0 ? `bake-runtime-${file}.generated.ts` : `.runtime-${file}.generated.ts`,
      );

      await writeIfNotChangedCompat(generated_entrypoint, combined_source);

      if (isFreeBSDStage0) {
        // Legacy FreeBSD stage0 can corrupt single-entry Bun.build() outputs in this second pass,
        // which drops the __marker__ call and breaks name extraction below. The source is already
        // self-contained after the first pass, so a plain transpile is sufficient for bootstrap.
        code = freebsdStage0BakeTranspiler!.transformSync(readUtf8CompatSync(generated_entrypoint)).trim();
      } else {
        result = await buildCompat(`second-pass-${file}`, {
          entrypoints: [generated_entrypoint],
          minify: !debug,
          drop: debug ? [] : ["DEBUG"],
          target: side === "server" ? "bun" : "browser",
        });
        if (!result.success) throw new AggregateError(result.logs);
        assert(result.outputs.length === 1, "must bundle to a single file");
        code = (await result.outputs[0].text()).replace(`// ${basename(generated_entrypoint)}`, "").trim();
      }

      rmSync(generated_entrypoint);

      if (code.includes("export default ")) {
        throw new AggregateError([
          new Error("export default is not allowed in bake codegen. this became a commonjs module!"),
        ]);
      }

      if (file !== "error") {
        let names: string = "";
        code = code
          .replace(/(\n?)\s*__marker__.*__marker__\((.+?)\);\s*/s, (_, n, captured) => {
            names = captured;
            return n;
          })
          .trim();
        assert(names, "missing name");
        const split_names = names.split(",").map(x => x.trim());
        const out_names = Object.fromEntries(in_names.map((x, i) => [x, split_names[i]]));
        function outName(name) {
          if (!out_names[name]) throw new Error(`missing out name for ${name}`);
          return out_names[name];
        }

        if (debug) {
          code = "\n  " + code.replace(/\n/g, "\n  ") + "\n";
        }

        if (code[code.length - 1] === ";") code = code.slice(0, -1);

        if (side === "server") {
          code = debug
            ? `${code}  return ${outName("server_exports")};\n`
            : `${code};return ${outName("server_exports")};`;

          const params = `${outName("$separateSSRGraph")},${outName("$importMeta")}`;
          code = code
            .replaceAll("import.meta", outName("$importMeta"))
            .replaceAll(outName("$importMeta") + ".hot", "import.meta.hot");
          code = `let ${outName("unloadedModuleRegistry")}={},${outName("config")}={separateSSRGraph:${outName("$separateSSRGraph")}},${outName("server_exports")};${code}`;

          code = debug ? `((${params}) => {${code}})\n` : `((${params})=>{${code}})\n`;
        } else {
          code = debug ? `(async (${names}) => {${code}})({\n` : `(async(${names})=>{${code}})({`;
        }
      }

      if (side === "client" && code.match(/\beval\(|,\s*eval\s*\)/)) {
        throw new AggregateError([
          new Error(
            "eval is not allowed in the HMR runtime. there are problems in all " +
              "browsers regarding stack traces from eval'd frames and source maps. " +
              "you must find an alternative solution to your problem.",
          ),
        ]);
      }

      await writeIfNotChangedCompat(join(codegenRoot, `bake.${file}.js`), code);
    }),
  );

  // print failures in a de-duplicated fashion.
  interface Err {
    kind: ("client" | "server" | "error")[];
    err: any;
  }
  const failed = [
    { kind: ["client"], result: results[0] },
    { kind: ["server"], result: results[1] },
    { kind: ["error"], result: results[2] },
  ]
    .filter(x => x.result.status === "rejected")
    // @ts-ignore
    .map(x => ({ kind: x.kind, err: x.result.reason })) as Err[];
  if (failed.length > 0) {
    const flattened_errors: Err[] = [];
    for (const { kind, err } of failed) {
      if (err instanceof AggregateError) {
        flattened_errors.push(...err.errors.map(err => ({ kind, err })));
      }
      flattened_errors.push({ kind, err });
    }
    for (let i = 0; i < flattened_errors.length; i++) {
      const x = flattened_errors[i];
      if (!x.err?.message) continue;
      for (const other of flattened_errors.slice(0, i)) {
        if (other.err?.message === x.err.message || other.err.stack === x.err.stack) {
          other.kind = [...x.kind, ...other.kind];
          flattened_errors.splice(i, 1);
          i -= 1;
          continue;
        }
      }
    }
    for (const { kind, err } of flattened_errors) {
      const map = { error: "error runtime", client: "client runtime", server: "server runtime" };
      console.error(`Errors while bundling Bake ${kind.map(x => map[x]).join(" and ")}:`);
      console.error(err);
    }
    process.exit(1);
  } else {
    console.log("-> bake.client.js, bake.server.js, bake.error.js");

    const empty_file = join(codegenRoot, "bake_empty_file");
    if (!existsSync(empty_file)) {
      await writeIfNotChangedCompat(empty_file, "this is used to fulfill a cmake dependency");
    }
  }
}

await run();
