import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const prefix = resolve(packageDir, "..", "..");
const scenarioPath = resolve(prefix, "scenario.json");
const callsPath = resolve(prefix, "stub-calls.jsonl");
const phrasePath = resolve(prefix, "phrases.json");
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
const table = JSON.parse(readFileSync(phrasePath, "utf8"));
const entries = new Map(table.entries.map((entry) => [entry.id, entry]));
const argv = process.argv.slice(2);
const command = argv[0] === "--version" ? "version" : argv[0] || "none";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function priorCalls() {
  try {
    return readFileSync(callsPath, "utf8").trim().split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line)).filter((call) => call.command === command).length;
  } catch {
    return 0;
  }
}

function materialize(entry, inserts = []) {
  let text = "";
  entry.fragments.forEach((fragment, index) => {
    text += fragment;
    if (index < entry.fragments.length - 1) text += inserts[index] ?? "1";
  });
  return text;
}

function marked(kind, text) {
  if (kind === "ok") return `·    ${text}`;
  if (kind === "info") return `\u001b[2m·\u001b[0m     ${text}`;
  if (kind === "warn") return `\u001b[33mwarn\u001b[0m  ${text}`;
  if (kind === "die") return `\u001b[31mfail\u001b[0m  ${text}`;
  if (kind === "prompt") return `  ${text}`;
  return text;
}

async function stdinState(readIt) {
  if (!readIt) return { eof: null, bytes: 0 };
  let bytes = 0;
  for await (const chunk of process.stdin) bytes += chunk.length;
  return { eof: true, bytes };
}

const scripts = scenario.commands?.[command] || [];
const index = priorCalls();
const action = scripts[Math.min(index, Math.max(0, scripts.length - 1))] || {};

if (command === "version") {
  process.stdout.write(`${scenario.version || "0.4.9"}\n`);
}

for (const line of action.lines || []) {
  const entry = entries.get(line.id);
  if (!entry) throw new Error(`unknown phrase id: ${line.id}`);
  process.stdout.write(`${marked(line.kind || entry.kind, materialize(entry, line.inserts || []))}\n`);
}

if (Array.isArray(action.leakParts)) {
  process.stdout.write(`${action.leakParts.join("")}\n`);
}

const input = await stdinState(action.readStdin === true);
const names = Object.keys(process.env).filter((name) => name.startsWith("CLOUDFLARE_") || name.startsWith("BRAIN_")).sort();
const key = process.env.CLOUDFLARE_API_TOKEN || "";
const call = {
  command,
  argv,
  cwd: process.cwd(),
  stdin_tty: process.stdin.isTTY === true,
  stdin_eof: input.eof,
  stdin_bytes: input.bytes,
  env_names: names,
  key_matches: Boolean(scenario.right_key_sha256) && hash(key) === scenario.right_key_sha256
};
appendFileSync(callsPath, `${JSON.stringify(call)}\n`, { encoding: "utf8" });
process.exitCode = Number.isInteger(action.exit) ? action.exit : 0;
