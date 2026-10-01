import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const prefix = resolve(packageDir, "..", "..");
const scenarioPath = resolve(prefix, "scenario.json");
const callsPath = resolve(prefix, "stub-calls.jsonl");
const controlsPath = resolve(prefix, "fixture-controls.jsonl");
const phrasePath = resolve(prefix, "phrases.json");
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
const table = JSON.parse(readFileSync(phrasePath, "utf8"));
const entries = new Map(table.entries.map((entry) => [entry.id, entry]));
const argv = process.argv.slice(2);
const fixtureStep = argv[0] === "--fixture-step";
const command = fixtureStep ? "fixture-step" : argv[0] === "--version" ? "version" : argv[0] || "none";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function priorCalls() {
  try {
    return readFileSync(callsPath, "utf8").trim().split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line)).filter((call) => (call.invoked_command || call.command) === command).length;
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

function allPriorCalls() {
  try {
    return readFileSync(callsPath, "utf8").trim().split(/\r?\n/u).filter(Boolean).length;
  } catch {
    return 0;
  }
}

const scripts = scenario.commands?.[command] || [];
const index = fixtureStep ? allPriorCalls() : priorCalls();
const action = fixtureStep
  ? scenario.sequence?.[Math.min(index, Math.max(0, (scenario.sequence?.length || 1) - 1))] || {}
  : scripts[Math.min(index, Math.max(0, scripts.length - 1))] || {};

let outputBytes = 0;
function emit(value) {
  outputBytes += Buffer.byteLength(value);
  process.stdout.write(value);
}

if (command === "version") {
  emit(`${scenario.version || "0.4.9"}\n`);
}

for (const line of action.lines || []) {
  const entry = entries.get(line.id);
  if (!entry) throw new Error(`unknown phrase id: ${line.id}`);
  emit(`${marked(line.kind || entry.kind, materialize(entry, line.inserts || []))}\n`);
}

for (const line of action.raw || []) emit(`${line}\n`);

if (Array.isArray(action.leakParts)) {
  emit(`${action.leakParts.join("")}\n`);
}
if (action.leak_classes) appendFileSync(controlsPath, `${JSON.stringify({ raw_hits: action.leak_classes })}\n`, "utf8");

const input = await stdinState(action.readStdin === true);
const names = Object.keys(process.env).filter((name) => name.startsWith("CLOUDFLARE_") || name.startsWith("BRAIN_")).sort();
const key = process.env.CLOUDFLARE_API_TOKEN || "";
const call = {
  command: action.label || command,
  invoked_command: command,
  argv,
  cwd: process.cwd(),
  stdin_tty: process.stdin.isTTY === true,
  stdin_eof: input.eof,
  stdin_bytes: input.bytes,
  env_names: names,
  key_matches: Boolean(scenario.right_key_sha256) && hash(key) === scenario.right_key_sha256,
  output_expected: action.expect_output === true || command === "version" || scenario.expected_output_commands?.includes(command) === true,
  output_bytes: outputBytes
};
appendFileSync(callsPath, `${JSON.stringify(call)}\n`, { encoding: "utf8" });
if (action.processes) writeFileSync(scenario.processes_path, `${JSON.stringify(action.processes)}\n`, "utf8");
if (Number(action.delay_ms) > 0) await new Promise((resolveWait) => setTimeout(resolveWait, Number(action.delay_ms)));
process.exitCode = Number.isInteger(action.exit) ? action.exit : 0;
