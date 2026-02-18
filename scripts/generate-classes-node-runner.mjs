#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function run(cmd, args, cwd = repoRoot) {
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
}

function commandExists(cmd) {
  try {
    execFileSync("sh", ["-lc", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function listTopLevelClassFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter(name => name.endsWith(".classes.ts"))
    .sort()
    .map(name => path.join(root, name));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    fail("usage: generate-classes-node-runner.mjs <classes...> <out-dir>");
  }

  const outDir = path.resolve(args.at(-1));
  const classesFromArgs = args.slice(0, -1).map(file => path.resolve(file));

  const classInputs = classesFromArgs.length
    ? classesFromArgs
    : [
        ...listTopLevelClassFiles(path.join(repoRoot, "src/bun.js")),
        ...listTopLevelClassFiles(path.join(repoRoot, "src/bun.js/api")),
        ...listTopLevelClassFiles(path.join(repoRoot, "src/bun.js/test")),
        ...listTopLevelClassFiles(path.join(repoRoot, "src/bun.js/webcore")),
        ...listTopLevelClassFiles(path.join(repoRoot, "src/bun.js/node")),
      ];

  if (classInputs.length === 0) {
    fail("no .classes.ts files found");
  }

  const bundledEsbuild = path.join(repoRoot, "node_modules/.bin/esbuild");
  const esbuildBin = process.env.ESBUILD_BIN || (fs.existsSync(bundledEsbuild) ? bundledEsbuild : "esbuild");
  if (esbuildBin === "esbuild" && !commandExists("esbuild")) {
    fail("missing esbuild binary (set ESBUILD_BIN or install esbuild)");
  }

  const tempParent = path.join(repoRoot, "build", "freebsd-bootstrap", "node-codegen-current");
  fs.mkdirSync(tempParent, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(tempParent, "generate-classes-"));

  try {
    const sourceScript = path.join(repoRoot, "src/codegen/generate-classes.ts");
    const bundledScript = path.join(tempRoot, "generate-classes.mjs");
    const launcherScript = path.join(tempRoot, "launch-generate-classes.mjs");

    run(esbuildBin, [
      sourceScript,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node20",
      "--define:Bun=globalThis.Bun",
      "--banner:js=import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      `--outfile=${bundledScript}`,
    ]);

    fs.writeFileSync(
      launcherScript,
      `import { inspect } from "node:util";
globalThis.Bun ??= { inspect };
await import(${JSON.stringify(bundledScript)});
`,
    );

    const transpiledClassInputs = [];
    for (const input of classInputs) {
      const relFromSrc = path.relative(path.join(repoRoot, "src"), input).split(path.sep).join("/");
      const outFile = path.join(tempRoot, "classes", relFromSrc.replace(/\.ts$/, ".cjs"));
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      run(esbuildBin, [input, "--bundle", "--platform=node", "--format=cjs", "--target=node20", `--outfile=${outFile}`]);
      transpiledClassInputs.push(outFile);
    }

    run(process.execPath, [launcherScript, ...transpiledClassInputs, outDir]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
