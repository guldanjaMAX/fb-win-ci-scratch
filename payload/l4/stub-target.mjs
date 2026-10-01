import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { freshKey, installStub, makeSession, scenarioFor } from "./fixtures.mjs";
import { armMap } from "./reference/arms.mjs";
import { simulateArm } from "./reference/oracle.mjs";

const cliCommands = ["update", "verify", "health", "deploy"];

function probeCommand(spec) {
  for (const command of cliCommands) {
    if ((spec.calls?.[command] || 0) > 0) return { command, count: spec.calls[command] };
  }
  if ((spec.calls?.["google-calendar-check"] || 0) > 0) return { command: "ingest", count: spec.calls["google-calendar-check"] };
  if ((spec.calls?.["google-connect"] || 0) > 0) return { command: "connect", count: spec.calls["google-connect"] };
  return { command: "version", count: 1 };
}

function commandArgs(command, manifest) {
  if (command === "version") return ["--version"];
  if (command === "connect") return ["connect", "google", "--scopes", "drive,gmail,calendar"];
  if (command === "ingest") return ["ingest", manifest, "--from", "calendar", "--dry-run"];
  return [command, manifest];
}

export function runStubArm(id) {
  const spec = armMap.get(id);
  if (!spec) throw new Error(`unknown arm ${id}`);
  const root = mkdtempSync(join(tmpdir(), `l4-stub-${id}-`));
  try {
    const fixture = makeSession(root, { marker: "tier2\n" });
    const key = freshKey();
    const probe = probeCommand(spec);
    const action = { lines: [], readStdin: ["A6", "A6-hidden"].includes(id) };
    installStub(fixture.prefix, scenarioFor({ [probe.command]: Array.from({ length: probe.count }, () => action) }, key));
    const cli = join(fixture.prefix, "node_modules", "brain-installer", "brain.mjs");
    let successful = 0;
    for (let index = 0; index < probe.count; index += 1) {
      const run = spawnSync(process.execPath, [cli, ...commandArgs(probe.command, fixture.manifest)], {
        cwd: fixture.session,
        encoding: "utf8",
        input: "",
        windowsHide: true,
        shell: false,
        env: {
          HOME: fixture.home,
          TMPDIR: process.env.TMPDIR || tmpdir(),
          BRAIN_NO_WRANGLER_LOGIN: "1",
          BRAIN_GOOGLE_TOKEN_STORE: "file",
          ...(["update", "verify", "deploy"].includes(probe.command) ? { CLOUDFLARE_API_TOKEN: key } : {})
        }
      });
      if (run.status === 0) successful += 1;
    }
    const callsPath = join(fixture.prefix, "stub-calls.jsonl");
    const rawCalls = readFileSync(callsPath, "utf8");
    const actualCalls = rawCalls.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    const keyAbsent = !rawCalls.includes(key);
    const result = simulateArm(id);
    result.id = id;
    result.target = "stub";
    result.decision_point = {
      required: spec.point,
      reached: successful === probe.count && actualCalls.length === probe.count && keyAbsent,
      evidence: `${probe.command}-calls=${actualCalls.length}`
    };
    result.meta = {
      ...result.meta,
      stubProbeCommand: probe.command,
      stubProbeCalls: actualCalls.length,
      stubProbeClosedStdin: actualCalls.every((call) => call.stdin_tty === false),
      stubProbeKeyAbsent: keyAbsent
    };
    writeFileSync(join(root, "decision-point.txt"), `${id} ${result.decision_point.reached ? "reached" : "missed"}\n`);
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
