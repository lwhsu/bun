#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const USAGE = `\
Usage: bindgenv2-node-runner.mjs [options]

Options (all required):
  --command=<command>    list-outputs | generate
  --sources=<sources>    Comma-separated list of *.bindv2.ts files
  --codegen-path=<path>  Path to build/*/codegen
`;

function parseArgs(argv) {
  const out = Object.create(null);
  for (const arg of argv) {
    if (arg === "--help") {
      out.help = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      out[arg.slice(2)] = true;
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

function writeIfNotChanged(filePath, contents) {
  const normalized = contents.replaceAll("\r\n", "\n").trimEnd() + "\n";
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (existing === normalized) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, normalized);
}

function toZigNamespace(name) {
  const result = name
    .replace(/([^A-Z_])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
  return result === name ? `${result}_namespace` : result;
}

function isNamedTypeLike(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.name === "string" &&
    Array.isArray(value.dependencies) &&
    ("cppHeader" in value || "cppSource" in value || "zigSource" in value)
  );
}

function getNamedDependencies(type, result) {
  for (const dependency of type.dependencies ?? []) {
    if (isNamedTypeLike(dependency)) result.add(dependency);
    if (dependency && typeof dependency === "object" && Array.isArray(dependency.dependencies)) {
      getNamedDependencies(dependency, result);
    }
  }
}

function cppHeaderPath(codegenPath, type) {
  return `${codegenPath}/Generated${type.name}.h`;
}

function cppSourcePath(codegenPath, type) {
  return `${codegenPath}/Generated${type.name}.cpp`;
}

function zigSourcePath(codegenPath, typeOrNamespace) {
  const ns = typeof typeOrNamespace === "string" ? typeOrNamespace : toZigNamespace(typeOrNamespace.name);
  return `${codegenPath}/bindgen_generated/${ns}.zig`;
}

function normalizeSourcePath(source) {
  return path.isAbsolute(source) ? source : path.resolve(repoRoot, source);
}

function loadSourceModules(sources) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bun-bindgenv2-node-"));
  const entry = path.join(tmpDir, "entry.ts");
  const bundled = path.join(tmpDir, "bundle.cjs");

  const lines = sources.map((source, i) => {
    const abs = normalizeSourcePath(source);
    return `import * as m${i} from ${JSON.stringify(abs)};`;
  });
  lines.push(`export const modules = [${sources.map((_, i) => `m${i}`).join(", ")}];`);
  fs.writeFileSync(entry, `${lines.join("\n")}\n`);

  execFileSync(
    process.env.ESBUILD_BIN || "esbuild",
    [
      entry,
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--target=node20",
      `--outfile=${bundled}`,
      `--alias:bindgenv2=${path.join(repoRoot, "src/codegen/bindgenv2/lib.ts")}`,
      "--log-level=error",
    ],
    { cwd: repoRoot, stdio: "pipe" },
  );

  const mod = require(bundled);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return Array.isArray(mod?.modules) ? mod.modules : [];
}

function getNamedExports(sources) {
  const modules = loadSourceModules(sources);
  return modules.flatMap(mod => Object.values(mod).filter(isNamedTypeLike));
}

function listOutputs(codegenPath, sources) {
  const outputs = [`${codegenPath}/bindgen_generated.zig`];
  for (const type of getNamedExports(sources)) {
    if (type.hasCppSource) outputs.push(cppSourcePath(codegenPath, type));
    if (type.hasZigSource) outputs.push(zigSourcePath(codegenPath, type));
  }
  process.stdout.write(outputs.join(";"));
}

function generate(codegenPath, sources) {
  const names = new Set();
  const zigRoot = [];
  const zigRootInternal = [];
  const namedExports = getNamedExports(sources);

  const namedDependencies = new Set();
  for (const type of namedExports) getNamedDependencies(type, namedDependencies);
  const namedExportsSet = new Set(namedExports);
  for (const type of namedDependencies) {
    if (!namedExportsSet.has(type)) {
      throw new Error(`named type must be exported: ${type.name}`);
    }
  }

  const namedTypeNames = new Set();
  for (const type of namedExports) {
    if (namedTypeNames.has(type.name)) {
      throw new Error(`multiple types with same name: ${type.name}`);
    }
    namedTypeNames.add(type.name);
  }

  for (const type of namedExports) {
    const zigNamespace = toZigNamespace(type.name);
    const size = names.size;
    names.add(type.name);
    names.add(zigNamespace);
    if (names.size !== size + 2) throw new Error(`duplicate name: ${type.name}`);

    const cppHeader = type.cppHeader;
    const cppSource = type.cppSource;
    const zigSource = type.zigSource;
    if (cppHeader) writeIfNotChanged(cppHeaderPath(codegenPath, type), cppHeader);
    if (cppSource) writeIfNotChanged(cppSourcePath(codegenPath, type), cppSource);
    if (zigSource) {
      zigRoot.push(
        `pub const ${zigNamespace} = @import("./bindgen_generated/${zigNamespace}.zig");`,
        `pub const ${type.name} = ${zigNamespace}.${type.name};`,
        "",
      );
      zigRootInternal.push(`pub const ${type.name} = ${zigNamespace}.Bindgen${type.name};`);
      writeIfNotChanged(zigSourcePath(codegenPath, zigNamespace), zigSource);
    }
  }

  writeIfNotChanged(
    `${codegenPath}/bindgen_generated.zig`,
    [
      ...zigRoot,
      "pub const internal = struct {",
      ...zigRootInternal.map(s => `    ${s}`),
      "};",
      "",
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (typeof args["command"] !== "string") throw new Error("missing --command");
  if (typeof args["codegen-path"] !== "string") throw new Error("missing --codegen-path");
  if (typeof args["sources"] !== "string") throw new Error("missing --sources");

  const codegenPath = args["codegen-path"];
  const sources = args["sources"].split(",").filter(Boolean);

  switch (args["command"]) {
    case "list-outputs":
      listOutputs(codegenPath, sources);
      break;
    case "generate":
      generate(codegenPath, sources);
      break;
    default:
      throw new Error(`unknown --command: ${args["command"]}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`error: ${error?.message ?? String(error)}`);
  process.exit(1);
}
