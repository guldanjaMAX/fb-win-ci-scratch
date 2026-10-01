import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const session = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(session, "helper-scenario.json"), "utf8"));
const callsPath = join(session, "helper-calls.jsonl");
const command = `google-${process.argv[2] || "none"}`;

function priorCalls() {
  try {
    return readFileSync(callsPath, "utf8").trim().split(/\r?\n/u).filter(Boolean)
      .map((line) => JSON.parse(line)).filter((call) => call.invoked_command === command).length;
  } catch {
    return 0;
  }
}

const scripts = scenario.commands?.[command] || [];
const index = priorCalls();
const action = scripts[Math.min(index, Math.max(0, scripts.length - 1))] || {};
let outputBytes = 0;
for (const line of action.raw || []) {
  const value = `${line}\n`;
  outputBytes += Buffer.byteLength(value);
  process.stdout.write(value);
}
appendFileSync(callsPath, `${JSON.stringify({
  command: action.label || command,
  invoked_command: command,
  argv: process.argv.slice(2),
  key_matches: false,
  output_expected: action.expect_output === true || scenario.expected_output_commands?.includes(command) === true,
  output_bytes: outputBytes
})}\n`, "utf8");
process.exitCode = Number.isInteger(action.exit) ? action.exit : 0;
