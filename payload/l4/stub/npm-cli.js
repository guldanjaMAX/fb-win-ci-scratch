const { appendFileSync } = require("node:fs");
const { resolve } = require("node:path");

const args = process.argv.slice(2);
const prefixIndex = args.indexOf("--prefix");
if (prefixIndex < 0 || !args[prefixIndex + 1]) process.exit(3);
const prefix = resolve(args[prefixIndex + 1]);
appendFileSync(resolve(prefix, "npm-calls.jsonl"), `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })}\n`);
