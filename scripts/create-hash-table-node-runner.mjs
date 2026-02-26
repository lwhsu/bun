#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function writeIfChanged(filePath, text) {
  try {
    if (fs.readFileSync(filePath, "utf8") === text) return;
  } catch {}
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

async function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) {
    fail("usage: create-hash-table-node-runner.mjs <input> <output>");
  }

  const platform = process.env.TARGET_PLATFORM ?? process.platform;
  const createHashTablePerl = path.join(repoRoot, "src/codegen/create_hash_table");
  const inputText = fs.readFileSync(input, "utf8");

  const toPreprocess = [...inputText.matchAll(/@begin\s+.+?@end/gs)].map(match => match[0]).join("\n");

  const os = platform === "win32" ? "WINDOWS" : platform.toUpperCase();
  const otherOses = ["WINDOWS", "DARWIN", "LINUX"].filter(name => name !== os);
  const toRemove = new RegExp(`#if\\s+(!OS\\(${os}\\)|OS\\((${otherOses.join("|")})\\))\\n.*?#endif`, "gs");
  const inputPreprocessed = toPreprocess.replace(toRemove, "");

  console.log(`Generating ${output} from ${input}`);
  const proc = spawn("perl", [createHashTablePerl, "-"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  proc.stdin.end(inputPreprocessed);

  const chunks = [];
  proc.stdout.on("data", chunk => chunks.push(chunk));

  const exitCode = await new Promise(resolve => proc.on("exit", resolve));
  if (exitCode !== 0) {
    fail(`create_hash_table exited with ${String(exitCode)}`);
  }

  let generated = Buffer.concat(chunks).toString("utf8");
  generated = generated.replaceAll(/^\/\/.*$/gm, "");
  generated = generated.replaceAll(/^#include.*$/gm, "");
  generated = generated.replaceAll("namespace JSC {", "");
  generated = generated.replaceAll("} // namespace JSC", "");
  generated = generated.replaceAll(/NativeFunctionType,\s([a-zA-Z0-99_]+)/gm, "NativeFunctionType, &$1");
  generated = generated.replaceAll("&Generated::", "Generated::");
  generated = `#pragma once\n// File generated via \`create-hash-table.ts\`\n${generated.trim()}\n`;

  writeIfChanged(output, generated);
}

main().catch(error => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
