#!/usr/bin/env bun

import { writeSync } from "node:fs";

interface NamedTypeLike {
  name: string;
  dependencies: unknown[];
  hasCppSource: boolean;
  hasZigSource: boolean;
  cppHeader?: string;
  cppSource?: string;
  zigSource?: string;
}

const USAGE = `\
Usage: script.ts [options]

Options (all required):
  --command=<command>    Command to run (see below)
  --sources=<sources>    Comma-separated list of *.bindv2.ts files
  --codegen-path=<path>  Path to build/*/codegen

Commands:
  list-outputs  List files that will be generated, separated by semicolons (for CMake)
  generate      Generate all files
`;

let codegenPath: string;
let sources: string[];

async function writeStdout(text: string): Promise<void> {
  writeSync(1, text);
}

async function writeStderr(text: string): Promise<void> {
  writeSync(2, text);
}

async function writeIfNotChanged(filePath: string, contents: string): Promise<void> {
  const normalized = contents.replaceAll("\r\n", "\n").trimEnd() + "\n";
  const file = Bun.file(filePath);
  if (await file.exists()) {
    const existing = await file.text();
    if (existing === normalized) return;
  }
  await Bun.write(filePath, normalized);
}

function isNamedTypeLike(value: unknown): value is NamedTypeLike {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as any).name === "string" &&
    Array.isArray((value as any).dependencies) &&
    ("cppHeader" in (value as any) || "cppSource" in (value as any) || "zigSource" in (value as any))
  );
}

function argParse(keys: string[]): { [key: string]: boolean | string } {
  const options: { [key: string]: boolean | string } = {};
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith("--")) {
      throw new Error("unknown argument: " + arg);
    }
    const splitPos = arg.indexOf("=");
    let name = arg;
    let value: boolean | string = true;
    if (splitPos !== -1) {
      name = arg.slice(0, splitPos);
      value = arg.slice(splitPos + 1);
    }
    options[name.slice(2)] = value;
  }

  const unknown = new Set(Object.keys(options));
  for (const key of keys) {
    unknown.delete(key);
  }
  if (unknown.size > 0) {
    throw new Error("unknown argument: --" + Array.from(unknown).join(", --"));
  }
  return options;
}

function moduleSpecifierFromPath(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    return "file:///" + path.replaceAll("\\", "/");
  }
  if (path.startsWith("\\\\")) {
    return "file://" + path.replaceAll("\\", "/");
  }
  return path;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function getNamedExports(): Promise<NamedTypeLike[]> {
  const modules: Record<string, unknown>[] = [];
  for (const path of sources) {
    try {
      modules.push((await import(moduleSpecifierFromPath(path))) as Record<string, unknown>);
    } catch (error) {
      throw new Error(`failed to import ${path}: ${toErrorMessage(error)}`);
    }
  }
  return modules.flatMap(exports => Object.values(exports).filter(isNamedTypeLike));
}

function getNamedDependencies(type: { dependencies?: unknown[] }, result: Set<NamedTypeLike>): void {
  for (const dependency of type.dependencies ?? []) {
    if (isNamedTypeLike(dependency)) {
      result.add(dependency);
    }
    if (dependency != null && typeof dependency === "object" && Array.isArray((dependency as any).dependencies)) {
      getNamedDependencies(dependency as any, result);
    }
  }
}

function cppHeaderPath(type: NamedTypeLike): string {
  return `${codegenPath}/Generated${type.name}.h`;
}

function cppSourcePath(type: NamedTypeLike): string {
  return `${codegenPath}/Generated${type.name}.cpp`;
}

function zigSourcePath(typeOrNamespace: NamedTypeLike | string): string {
  let ns: string;
  if (typeof typeOrNamespace === "string") {
    ns = typeOrNamespace;
  } else {
    ns = toZigNamespace(typeOrNamespace.name);
  }
  return `${codegenPath}/bindgen_generated/${ns}.zig`;
}

function toZigNamespace(name: string): string {
  const result = name
    .replace(/([^A-Z_])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
  if (result === name) {
    return result + "_namespace";
  }
  return result;
}

async function listOutputs(): Promise<void> {
  const outputs: string[] = [`${codegenPath}/bindgen_generated.zig`];
  const namedExports = await getNamedExports();
  for (const type of namedExports) {
    if (type.hasCppSource) outputs.push(cppSourcePath(type));
    if (type.hasZigSource) outputs.push(zigSourcePath(type));
  }
  await writeStdout(outputs.join(";"));
}

async function generate(): Promise<void> {
  const names = new Set<string>();
  const zigRoot: string[] = [];
  const zigRootInternal: string[] = [];

  const namedExports = await getNamedExports();
  {
    const namedDependencies = new Set<NamedTypeLike>();
    for (const type of namedExports) {
      getNamedDependencies(type, namedDependencies);
    }
    const namedExportsSet = new Set(namedExports);
    for (const type of namedDependencies) {
      if (!namedExportsSet.has(type)) {
        throw new Error(`named type must be exported: ${type.name}`);
      }
    }
    const namedTypeNames = new Set<string>();
    for (const type of namedExports) {
      if (namedTypeNames.size == namedTypeNames.add(type.name).size) {
        throw new Error(`multiple types with same name: ${type.name}`);
      }
    }
  }

  for (const type of namedExports) {
    const zigNamespace = toZigNamespace(type.name);
    const size = names.size;
    names.add(type.name);
    names.add(zigNamespace);
    if (names.size !== size + 2) {
      throw new Error(`duplicate name: ${type.name}`);
    }

    const cppHeader = type.cppHeader;
    const cppSource = type.cppSource;
    const zigSource = type.zigSource;
    if (cppHeader) {
      await writeIfNotChanged(cppHeaderPath(type), cppHeader);
    }
    if (cppSource) {
      await writeIfNotChanged(cppSourcePath(type), cppSource);
    }
    if (zigSource) {
      zigRoot.push(
        `pub const ${zigNamespace} = @import("./bindgen_generated/${zigNamespace}.zig");`,
        `pub const ${type.name} = ${zigNamespace}.${type.name};`,
        "",
      );
      zigRootInternal.push(`pub const ${type.name} = ${zigNamespace}.Bindgen${type.name};`);
      await writeIfNotChanged(zigSourcePath(zigNamespace), zigSource);
    }
  }

  await writeIfNotChanged(
    `${codegenPath}/bindgen_generated.zig`,
    [
      ...zigRoot,
      `pub const internal = struct {`,
      ...zigRootInternal.map(s => "    " + s),
      `};`,
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = argParse(["command", "codegen-path", "sources", "help"]);
  if (Object.keys(args).length === 0) {
    await writeStderr(USAGE);
    process.exit(1);
  }
  const { command, "codegen-path": codegenPathArg, sources: sourcesArg, help } = args;
  if (help != null) {
    await writeStdout(USAGE);
    process.exit(0);
  }

  if (typeof codegenPathArg !== "string") {
    throw new Error("missing --codegen-path");
  }
  codegenPath = codegenPathArg;

  if (typeof sourcesArg !== "string") {
    throw new Error("missing --sources");
  }
  sources = sourcesArg.split(",").filter(x => x);

  switch (command) {
    case "list-outputs":
      await listOutputs();
      break;
    case "generate":
      await generate();
      break;
    default:
      if (typeof command === "string") {
        throw new Error("unknown command: " + command);
      }
      throw new Error("missing --command");
  }
}

main().catch(async (error: unknown) => {
  await writeStderr(`error: ${toErrorMessage(error)}\n`);
  process.exit(1);
});
