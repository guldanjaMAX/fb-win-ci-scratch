const { appendFileSync } = require("node:fs");
const { resolve } = require("node:path");

const args = process.argv.slice(2);
const prefixIndex = args.indexOf("--prefix");
if (prefixIndex < 0 || !args[prefixIndex + 1]) process.exit(3);
const prefix = resolve(args[prefixIndex + 1]);
const output = "added 1 package in 1s\n";
appendFileSync(resolve(prefix, "npm-calls.jsonl"), `${JSON.stringify({
  command: "npm-cli.js",
  argv: args,
  cwd: process.cwd(),
  output_expected: true,
  output_bytes: Buffer.byteLength(output),
})}\n`);
process.stdout.write(output);
