#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const outdir = args[0];
const files = args.slice(1);
if (!outdir || files.length === 0) {
  fail("usage: node-fallbacks-node-runner.mjs <outdir> <files...>");
}

fs.mkdirSync(outdir, { recursive: true });
for (const file of files) {
  const name = path.basename(file);
  fs.copyFileSync(file, path.join(outdir, name));
}
