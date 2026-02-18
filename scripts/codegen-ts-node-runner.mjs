#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { inspect } from "node:util";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const nodeRequire = createRequire(import.meta.url);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function commandExists(cmd) {
  const result = spawnSync("sh", ["-lc", `command -v ${cmd}`], { stdio: "ignore" });
  return result.status === 0;
}

function run(cmd, args, cwd = repoRoot) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function writeIfChanged(filePath, text) {
  try {
    if (fs.readFileSync(filePath, "utf8") === text) return;
  } catch {}
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function resolveEsbuildBin() {
  const bundled = path.join(repoRoot, "node_modules/.bin/esbuild");
  if (fs.existsSync(bundled)) return bundled;
  if (commandExists("esbuild")) return "esbuild";
  fail("missing esbuild binary (install node_modules or set PATH)");
}

function parseBunBuildCli(cmd) {
  const args = cmd.slice(2);
  const entryPoints = [];
  const external = [];
  const define = {};
  let root = repoRoot;
  let outdir;
  let target = "esnext";
  let minifySyntax = false;
  let minify = false;
  let keepNames = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--root") {
      root = args[++i];
      continue;
    }
    if (arg === "--target") {
      const t = args[++i];
      target = t === "bun" ? "esnext" : t;
      continue;
    }
    if (arg === "--external") {
      external.push(args[++i]);
      continue;
    }
    if (arg === "--define") {
      const value = args[++i];
      const eq = value.indexOf("=");
      if (eq > 0) define[value.slice(0, eq)] = value.slice(eq + 1);
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
    if (arg === "--minify") {
      minify = true;
      continue;
    }
    if (arg === "--keep-names") {
      keepNames = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      entryPoints.push(arg);
    }
  }

  return { entryPoints, external, define, root, outdir, target, minifySyntax, minify, keepNames };
}

function bunBuildCompatSync(cmd, cwd) {
  const esbuild = nodeRequire("esbuild");
  const parsed = parseBunBuildCli(cmd);
  try {
    if (parsed.outdir) {
      esbuild.buildSync({
        entryPoints: parsed.entryPoints,
        bundle: true,
        format: "iife",
        platform: "browser",
        target: parsed.target,
        outdir: parsed.outdir,
        outbase: parsed.root,
        define: parsed.define,
        external: parsed.external,
        minify: parsed.minify,
        minifySyntax: true,
        keepNames: parsed.keepNames,
        write: true,
        logLevel: "silent",
        legalComments: "none",
        absWorkingDir: cwd,
      });
      return { ok: true, stderr: "", stdout: "" };
    }

    const result = esbuild.buildSync({
      entryPoints: parsed.entryPoints,
      bundle: true,
      write: false,
      minify: parsed.minify || parsed.minifySyntax,
      platform: "browser",
      target: parsed.target,
      define: parsed.define,
      external: parsed.external,
      loader: {
        ".svg": "dataurl",
      },
      logLevel: "silent",
      legalComments: "none",
      absWorkingDir: cwd,
    });
    const text = result.outputFiles?.[0] ? Buffer.from(result.outputFiles[0].contents).toString("utf8") : "";
    const escaped = JSON.stringify(text);
    return { ok: true, stderr: "", stdout: escaped };
  } catch (error) {
    return { ok: false, stderr: String(error?.stack ?? error), stdout: "" };
  }
}

function resolveFrom(specifier, from) {
  const baseDir = (() => {
    if (!from) return process.cwd();
    const full = path.isAbsolute(from) ? from : path.resolve(from);
    try {
      return fs.statSync(full).isDirectory() ? full : path.dirname(full);
    } catch {
      return path.dirname(full);
    }
  })();

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const abs = path.resolve(baseDir, specifier);
    const candidates = [
      abs,
      `${abs}.ts`,
      `${abs}.js`,
      `${abs}.mts`,
      `${abs}.mjs`,
      `${abs}.cts`,
      `${abs}.cjs`,
      path.join(abs, "index.ts"),
      path.join(abs, "index.js"),
      path.join(abs, "index.mjs"),
      path.join(abs, "index.cjs"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`Cannot resolve ${specifier} from ${from}`);
  }

  const jsRoot = path.join(repoRoot, "src/js");
  const builtinCandidates = [
    path.join(jsRoot, specifier),
    path.join(jsRoot, `${specifier}.ts`),
    path.join(jsRoot, `${specifier}.js`),
    path.join(jsRoot, `${specifier}.mts`),
    path.join(jsRoot, `${specifier}.mjs`),
    path.join(jsRoot, specifier, "index.ts"),
    path.join(jsRoot, specifier, "index.js"),
    path.join(jsRoot, specifier, "index.mjs"),
  ];
  for (const candidate of builtinCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return nodeRequire.resolve(specifier, { paths: [baseDir] });
}

function globScanSync(pattern) {
  if (!pattern.endsWith("*.ts")) return [];
  const baseDir = path.dirname(pattern);
  if (!fs.existsSync(baseDir)) return [];
  return fs
    .readdirSync(baseDir)
    .filter(name => name.endsWith(".ts"))
    .map(name => path.join(baseDir, name))
    .sort();
}

function createBunCompat(scriptPath) {
  return {
    env: { ...process.env, TARGET_PLATFORM: process.env.TARGET_PLATFORM ?? "linux", TARGET_ARCH: process.arch },
    enableANSIColors: process.stdout.isTTY,
    inspect,
    hash(value) {
      const text = String(value ?? "");
      let h = 5381 >>> 0;
      for (let i = 0; i < text.length; i++) {
        h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
      }
      return h >>> 0;
    },
    stringWidth(value) {
      return String(value ?? "").length;
    },
    sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },
    file(filePath) {
      const resolved = String(filePath);
      return {
        async text() {
          return fs.promises.readFile(resolved, "utf8");
        },
        async json() {
          return JSON.parse(await fs.promises.readFile(resolved, "utf8"));
        },
      };
    },
    async write(filePath, data) {
      const resolved = String(filePath);
      const text = typeof data === "string" ? data : Buffer.from(data);
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
      try {
        const old = await fs.promises.readFile(resolved);
        const next = Buffer.isBuffer(text) ? text : Buffer.from(text);
        if (Buffer.compare(old, next) === 0) return;
      } catch {}
      await fs.promises.writeFile(resolved, text);
    },
    resolveSync(specifier, from) {
      return resolveFrom(specifier, from);
    },
    spawn(opts) {
      const cmd = opts?.cmd ?? [];
      if (!Array.isArray(cmd) || cmd.length === 0) {
        throw new Error("Bun.spawn compat requires opts.cmd");
      }
      const child = spawn(cmd[0], cmd.slice(1), {
        cwd: opts?.cwd ?? process.cwd(),
        env: opts?.env ?? process.env,
        stdio: opts?.stdio ?? ["pipe", "pipe", "pipe"],
      });
      const wrapped = {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        get exitCode() {
          return child.exitCode;
        },
        get signalCode() {
          return child.signalCode;
        },
        exited: new Promise(resolve => child.on("exit", code => resolve(code ?? 0))),
      };
      return wrapped;
    },
    spawnSync(arg1, arg2 = {}) {
      let cmd;
      let opts;
      if (Array.isArray(arg1)) {
        cmd = arg1;
        opts = arg2 ?? {};
      } else {
        cmd = arg1?.cmd ?? [];
        opts = arg1 ?? {};
      }

      if (!Array.isArray(cmd) || cmd.length === 0) {
        throw new Error("Bun.spawnSync compat requires cmd");
      }

      if (cmd.length >= 2 && cmd[1] === "build") {
        const built = bunBuildCompatSync(cmd, opts.cwd ?? process.cwd());
        if (!built.ok) {
          return {
            success: false,
            exitCode: 1,
            signalCode: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(built.stderr),
          };
        }
        return {
          success: true,
          exitCode: 0,
          signalCode: null,
          stdout: Buffer.from(built.stdout ?? ""),
          stderr: Buffer.alloc(0),
        };
      }

      if (cmd.length >= 4 && cmd[1] === "run" && String(cmd[2]).endsWith("create-hash-table.ts")) {
        const runner = path.join(repoRoot, "scripts/create-hash-table-node-runner.mjs");
        const proxied = spawnSync(process.execPath, [runner, cmd[3], cmd[4]], {
          cwd: opts.cwd ?? process.cwd(),
          env: opts.env ?? process.env,
          stdio: opts.stdio ?? ["pipe", "pipe", "pipe"],
        });
        return {
          success: proxied.status === 0,
          exitCode: proxied.status ?? 1,
          signalCode: proxied.signal,
          stdout: proxied.stdout ?? Buffer.alloc(0),
          stderr: proxied.stderr ?? Buffer.alloc(0),
        };
      }

      const result = spawnSync(cmd[0], cmd.slice(1), {
        cwd: opts.cwd ?? process.cwd(),
        env: opts.env ?? process.env,
        stdio: opts.stdio ?? ["pipe", "pipe", "pipe"],
      });
      return {
        success: result.status === 0,
        exitCode: result.status ?? 1,
        signalCode: result.signal,
        stdout: result.stdout ?? Buffer.alloc(0),
        stderr: result.stderr ?? Buffer.alloc(0),
      };
    },
    async build(options) {
      const esbuild = nodeRequire("esbuild");
      try {
        const runtimeTarget = options?.target ?? "browser";
        const target = "esnext";
        const platform = runtimeTarget === "node" ? "node" : "browser";
        const minifyFlag = options?.minify;
        const drop =
          Array.isArray(options?.drop) && options.drop.length > 0
            ? options.drop.filter(value => value === "console" || value === "debugger")
            : undefined;
        const result = await esbuild.build({
          entryPoints: options?.entrypoints ?? [],
          bundle: true,
          write: false,
          format: options?.format ?? "iife",
          platform,
          target,
          define: options?.define ?? {},
          external: options?.external ?? [],
          minify: typeof minifyFlag === "boolean" ? minifyFlag : false,
          minifySyntax: typeof minifyFlag === "object" ? Boolean(minifyFlag.syntax) : false,
          minifyWhitespace: typeof minifyFlag === "object" ? Boolean(minifyFlag.whitespace) : false,
          keepNames: Boolean(options?.keepNames),
          drop,
          conditions: options?.conditions,
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
          logs: [{ text: String(error?.stack ?? error) }],
          outputs: [
            {
              async text() {
                return "";
              },
            },
          ],
        };
      }
    },
    Transpiler: class {
      constructor(_opts) {}
      scan(_input) {
        return { imports: [], exports: [] };
      }
      scanImports(_input) {
        return [];
      }
    },
    Glob: class {
      constructor(pattern) {
        this.pattern = pattern;
      }
      scanSync() {
        return globScanSync(this.pattern);
      }
    },
  };
}

function main() {
  const [entryScript, ...scriptArgs] = process.argv.slice(2);
  if (!entryScript) {
    fail("usage: codegen-ts-node-runner.mjs <script.ts> [args...]");
  }

  const scriptPath = path.resolve(entryScript);
  if (!fs.existsSync(scriptPath)) {
    fail(`missing script: ${scriptPath}`);
  }

  const esbuildBin = resolveEsbuildBin();
  const scriptDir = path.dirname(scriptPath);
  const scriptBase = path.basename(scriptPath, path.extname(scriptPath));
  const useUnbundledTsEntry = scriptPath.endsWith(path.join("src", "codegen", "bindgen.ts"));
  const tempRoot = path.join(repoRoot, "build", "freebsd-bootstrap", "node-codegen-current", scriptBase);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });

  const bundledScript = path.join(tempRoot, `${scriptBase}.mjs`);
  const runnerScript = path.join(tempRoot, `run-${scriptBase}.mjs`);
  const bunTestShim = path.join(tempRoot, "bun-test-shim.mjs");
  const bunTestShimCjs = path.join(tempRoot, "bun-test-shim.cjs");
  const bindgenShim = path.join(tempRoot, "bindgen-lib.mjs");
  const bindgenShimCjs = path.join(tempRoot, "bindgen-lib.cjs");
  writeIfChanged(
    bunTestShim,
    `export function expect(value) {
  return {
    toEndWith(suffix) {
      const text = String(value ?? "");
      const end = String(suffix ?? "");
      if (!text.endsWith(end)) {
        throw new Error(\`expected "\${text}" to end with "\${end}"\`);
      }
    },
  };
}
`,
  );
  writeIfChanged(
    bunTestShimCjs,
    `module.exports = {
  expect(value) {
    return {
      toEndWith(suffix) {
        const text = String(value ?? "");
        const end = String(suffix ?? "");
        if (!text.endsWith(end)) {
          throw new Error(\`expected "\${text}" to end with "\${end}"\`);
        }
      },
    };
  },
};
`,
  );

  run(
    esbuildBin,
    [
      path.join(repoRoot, "src/codegen/bindgen-lib.ts"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node20",
      `--define:process.platform="linux"`,
      `--define:process.arch="x64"`,
      `--alias:bun:test=${bunTestShim}`,
      `--outfile=${bindgenShim}`,
    ],
    repoRoot,
  );
  run(
    esbuildBin,
    [
      path.join(repoRoot, "src/codegen/bindgen-lib.ts"),
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--target=node20",
      `--define:Bun=globalThis.Bun`,
      `--define:process.platform="linux"`,
      `--define:process.arch="x64"`,
      `--define:import.meta.dir=${JSON.stringify(scriptDir)}`,
      `--define:import.meta.dirname=${JSON.stringify(scriptDir)}`,
      `--define:import.meta.path=${JSON.stringify(path.join(repoRoot, "src/codegen/bindgen-lib.ts"))}`,
      `--define:import.meta.file=${JSON.stringify(path.join(repoRoot, "src/codegen/bindgen-lib.ts"))}`,
      `--alias:bun:test=${bunTestShimCjs}`,
      `--outfile=${bindgenShimCjs}`,
    ],
    repoRoot,
  );

  if (!useUnbundledTsEntry) {
    run(
      esbuildBin,
      [
        scriptPath,
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node20",
        `--define:Bun=globalThis.Bun`,
        `--define:process.platform="linux"`,
        `--define:process.arch="x64"`,
        `--define:import.meta.dir=${JSON.stringify(scriptDir)}`,
        `--define:import.meta.dirname=${JSON.stringify(scriptDir)}`,
        `--define:import.meta.path=${JSON.stringify(scriptPath)}`,
        `--define:import.meta.file=${JSON.stringify(scriptPath)}`,
        `--define:import.meta.main=true`,
        `--define:import.meta.require=require`,
        `--alias:bun:test=${bunTestShim}`,
        `--alias:bindgen=${bindgenShim}`,
        `--banner:js=import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);`,
        `--outfile=${bundledScript}`,
      ],
      repoRoot,
    );
  }

  const bunCompatSource = `
const __bunCompat = (${createBunCompat.toString()})(${JSON.stringify(scriptPath)});
globalThis.Bun = __bunCompat;
`;
  writeIfChanged(
    runnerScript,
    `import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { inspect } from "node:util";

const repoRoot = ${JSON.stringify(repoRoot)};
const nodeRequire = createRequire(import.meta.url);
const esbuild = nodeRequire("esbuild");
const bindgenShimPath = ${JSON.stringify(bindgenShim)};
const bunTestShimPath = ${JSON.stringify(bunTestShim)};
const bindgenSourcePath = ${JSON.stringify(path.join(repoRoot, "src/codegen/bindgen-lib.ts"))};
const bunTestShimCjsPath = ${JSON.stringify(bunTestShimCjs)};
function registerTsRequireExtension(ext, loader) {
  nodeRequire.extensions[ext] = function(module, filename) {
    let source = fs.readFileSync(filename, "utf8");
    const fileDir = path.dirname(filename);
    source = source
      .replaceAll('"bindgen"', JSON.stringify(bindgenSourcePath))
      .replaceAll("'bindgen'", JSON.stringify(bindgenSourcePath))
      .replaceAll('"bun:test"', JSON.stringify(bunTestShimCjsPath))
      .replaceAll("'bun:test'", JSON.stringify(bunTestShimCjsPath));
    const out = esbuild.transformSync(source, {
      loader,
      format: "cjs",
      target: "node20",
      define: {
        Bun: "globalThis.Bun",
        "process.platform": "\\"linux\\"",
        "process.arch": "\\"x64\\"",
        "import.meta.dir": JSON.stringify(fileDir),
        "import.meta.dirname": JSON.stringify(fileDir),
        "import.meta.path": JSON.stringify(filename),
        "import.meta.file": JSON.stringify(filename),
        "import.meta.require": "require",
      },
      sourcefile: filename,
    });
    module._compile(out.code, filename);
  };
}
registerTsRequireExtension(".ts", "ts");
registerTsRequireExtension(".tsx", "tsx");
registerTsRequireExtension(".mts", "ts");
registerTsRequireExtension(".cts", "ts");
${resolveFrom.toString()}
${globScanSync.toString()}
${parseBunBuildCli.toString()}
${bunBuildCompatSync.toString()}
${createBunCompat.toString()}
${bunCompatSource}
${useUnbundledTsEntry ? `nodeRequire(${JSON.stringify(scriptPath)});` : `await import(${JSON.stringify(bundledScript)});`}
`,
  );

  run(process.execPath, [runnerScript, ...scriptArgs], repoRoot);
}

main();
