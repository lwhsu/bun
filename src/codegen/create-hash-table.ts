import { spawn } from "bun";
import path from "path";
import fs from "node:fs";
import { writeIfNotChanged } from "./helpers";

const input = process.argv[2];
const output = process.argv[3];
const cwd = process.cwd();

const platform = process.env.TARGET_PLATFORM ?? process.platform;
const isFreeBSDStage0 = platform === "freebsd" && typeof Bun !== "undefined" && Bun.version === "0.0.0";
const stage0TempDir = "/tmp/bun-create-hash-stage0";

function toCwdRelativeIfPossible(filePath: string) {
  if (!path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(cwd, filePath);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  return filePath;
}

const create_hash_table = path.join(import.meta.dir, "./create_hash_table");

const input_text = await Bun.file(input).text();
const beginEndBlocks = [...input_text.matchAll(/@begin\s+.+?@end/gs)].map(m => m[0]);
const to_preprocess = beginEndBlocks.length > 0 ? beginEndBlocks.join("\n") : input_text;

const os = platform === "win32" ? "WINDOWS" : platform.toUpperCase();
const other_oses = ["WINDOWS", "DARWIN", "LINUX"].filter(x => x !== os);
const to_remove = new RegExp(`#if\\s+(!OS\\(${os}\\)|OS\\((${other_oses.join("|")})\\))\\n.*?#endif`, "gs");

const input_preprocessed = to_preprocess.replace(to_remove, "");

console.log("Generating " + output + " from " + input);
let tempInputPath: string | undefined;
let perlArgs: string[];
if (isFreeBSDStage0) {
  // Legacy FreeBSD stage0 can fail to close proc.stdin after write()+end(), which leaves the Perl
  // helper blocked forever when invoked as `create_hash_table -`. Use a temp input file instead.
  // If there are no @begin/@end blocks, the original input is already in the format consumed by the
  // Perl helper, so avoid the stage0 temp-file write path entirely (it can spuriously fail with ENOENT).
  if (beginEndBlocks.length === 0) {
    perlArgs = [create_hash_table, input];
  } else {
    fs.mkdirSync(stage0TempDir, { recursive: true });
    tempInputPath = path.join(stage0TempDir, path.basename(output) + ".input.tmp");
    try {
      const fd = fs.openSync(tempInputPath, "w");
      try {
        fs.writeSync(fd, input_preprocessed);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      await Bun.write(tempInputPath, input_preprocessed);
    }
    perlArgs = [create_hash_table, tempInputPath];
  }
} else {
  perlArgs = [create_hash_table, "-"];
}
let str: string;
if (isFreeBSDStage0) {
  // Legacy FreeBSD stage0 has multiple process I/O bugs here:
  // 1) stdin pipe close can hang Perl (`create_hash_table -`)
  // 2) `await proc.exited` can hang after the child exits
  // 3) `spawnSync` can crash
  //
  // Work around all three by using a temp input file (only when needed) and shell redirection to a
  // temp output file, then polling `proc.exitCode` without awaiting proc.exited.
  const tempOutputPath = path.join(stage0TempDir, path.basename(output) + ".output.tmp");
  const tempOutputDir = path.dirname(tempOutputPath);
  const proc = spawn({
    cmd: [
      "/bin/sh",
      "-c",
      "mkdir -p \"$4\" && exec perl \"$1\" \"$2\" > \"$3\"",
      "sh",
      create_hash_table,
      perlArgs[1]!,
      tempOutputPath,
      tempOutputDir,
    ],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });

  let waitedMs = 0;
  while (proc.exitCode == null && waitedMs < 30_000) {
    await Bun.sleep(10);
    waitedMs += 10;
  }

  if (proc.exitCode == null) {
    console.log("Failed to generate " + output + ", create_hash_table timed out on FreeBSD stage0");
    process.exit(1);
  }
  if (proc.exitCode !== 0) {
    console.log(
      "Failed to generate " +
        output +
        ", create_hash_table exited with " +
        (proc.exitCode || "") +
        (proc.signalCode || ""),
    );
    process.exit(1);
  }
  str = await Bun.file(tempOutputPath).text();
  fs.rmSync(tempOutputPath, { force: true });
} else {
  const proc = spawn({
    cmd: ["perl", ...perlArgs],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  proc.stdin.write(input_preprocessed);
  proc.stdin.end();
  await proc.exited;
  if (proc.exitCode !== 0) {
    console.log(
      "Failed to generate " +
        output +
        ", create_hash_table exited with " +
        (proc.exitCode || "") +
        (proc.signalCode || ""),
    );
    process.exit(1);
  }
  str = await new Response(proc.stdout).text();
}
str = str.replaceAll(/^\/\/.*$/gm, "");
str = str.replaceAll(/^#include.*$/gm, "");
str = str.replaceAll(`namespace JSC {`, "");
str = str.replaceAll(`} // namespace JSC`, "");
str = str.replaceAll(/NativeFunctionType,\s([a-zA-Z0-99_]+)/gm, "NativeFunctionType, &$1");
str = str.replaceAll("&Generated::", "Generated::");
str = "#pragma once" + "\n" + "// File generated via `create-hash-table.ts`\n" + str.trim() + "\n";

writeIfNotChanged(output, str);
if (tempInputPath) {
  fs.rmSync(tempInputPath, { force: true });
}
