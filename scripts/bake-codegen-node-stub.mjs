#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function argParse() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) continue;
    out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function write(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

const args = argParse();
const codegenRoot = args["codegen-root"];
if (!codegenRoot) {
  fail("usage: bake-codegen-node-stub.mjs --codegen-root=<dir>");
}

write(path.join(codegenRoot, "bake.client.js"), "export default {};\n");
write(path.join(codegenRoot, "bake.error.js"), "export default {};\n");
write(path.join(codegenRoot, "bake.server.js"), "export default {};\n");
write(path.join(codegenRoot, "bake_empty_file"), "freebsd-bootstrap-node-stub\n");
