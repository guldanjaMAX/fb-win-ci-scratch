import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { allArmIds, detectSuspect, simulateArm, verifyArm } from "./reference/oracle.mjs";
import { runnerPinTable, verifyRunnerArtifacts } from "./artifact-pins.mjs";
import { runStubArm } from "./stub-target.mjs";

function parseArgs(argv) {
  const out = { arms: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--arm") out.arms.push(argv[++index]);
    else if (value === "--target") out.target = argv[++index];
    else if (value === "--runner-dir") out.runnerDir = argv[++index];
    else if (value === "--out") out.out = argv[++index];
    else throw new Error(`unknown argument ${value}`);
  }
  if (!out.target || !out.out || !["oracle", "stub", "windows"].includes(out.target)) throw new Error("--target and --out are required");
  if (out.target === "windows" && !out.runnerDir) throw new Error("--runner-dir is required for windows");
  return out;
}

function selectedArms(requested) {
  const chosen = requested.length ? [...new Set(requested)] : allArmIds();
  return ["A0", ...chosen.filter((id) => id !== "A0")];
}

function windowsHostLimited(arm) {
  return arm === "A5" || arm.startsWith("A5-") || arm === "A6" || arm.startsWith("A6-") || arm.startsWith("A15-");
}

let windowsBridgeResult = null;
function runWindowsArm(arm, runnerDir) {
  if (process.platform !== "win32") throw new Error("windows target requires Windows");
  if (!windowsBridgeResult) {
    const windowPin = runnerPinTable().files.find((entry) => entry.name === "finish-window.txt");
    const driver = resolve(dirname(fileURLToPath(import.meta.url)), "windows-bridge.ps1");
    const proc = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driver, "-RunnerDir", runnerDir, "-ExpectedWindowSha256", windowPin.sha256], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (proc.status !== 0) throw new Error(`windows bridge failed for ${arm}`);
    windowsBridgeResult = JSON.parse(proc.stdout.trim());
  }
  const result = runStubArm(arm);
  result.target = "windows";
  result.host_limited = windowsHostLimited(arm);
  result.meta = { ...result.meta, windowsBridge: windowsBridgeResult, hostLimit: result.host_limited ? "requires dedicated Windows probe" : null };
  return result;
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });
const arms = selectedArms(args.arms);
const results = [];
let controlPassed = false;
if (args.target === "windows") {
  const artifacts = verifyRunnerArtifacts(args.runnerDir);
  if (!artifacts.pass) throw new Error(`runner pin check failed: missing=${artifacts.missing.join(",")} mismatches=${artifacts.mismatches.map((item) => item.name).join(",")}`);
}
for (const arm of arms) {
  if (arm !== "A0" && !controlPassed) throw new Error("A0 did not pass in this run");
  const armOut = resolve(args.out, arm);
  mkdirSync(armOut, { recursive: true });
  const result = args.target === "oracle" ? simulateArm(arm) : args.target === "stub" ? runStubArm(arm) : runWindowsArm(arm, args.runnerDir);
  result.id = arm;
  const checked = verifyArm(result);
  result.status = checked.pass ? "pass" : "fail";
  result.errors = checked.errors;
  writeFileSync(resolve(armOut, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  results.push(result);
  if (arm === "A0") controlPassed = checked.pass;
  console.log(`${checked.pass ? "PASS" : "FAIL"} ${arm} point=${result.decision_point?.reached ? "reached" : "missed"}`);
}
const suspect = detectSuspect(results);
if (suspect.suspect) console.log(`HARNESS SUSPECT: uniform results (${suspect.reason})`);
const summary = { target: args.target, arms: results.length, passed: results.filter((result) => result.status === "pass").length, host_limited: results.filter((result) => result.host_limited).length, suspect };
writeFileSync(resolve(args.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = results.every((result) => result.status === "pass") && !suspect.suspect ? 0 : 1;
