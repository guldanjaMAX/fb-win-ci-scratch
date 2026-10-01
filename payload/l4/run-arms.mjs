import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { allArmIds, detectSuspect, simulateArm, verifyArm } from "./reference/oracle.mjs";

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
  if (!out.target || !out.out || !["oracle", "windows"].includes(out.target)) throw new Error("--target and --out are required");
  if (out.target === "windows" && !out.runnerDir) throw new Error("--runner-dir is required for windows");
  return out;
}

function selectedArms(requested) {
  const chosen = requested.length ? [...new Set(requested)] : allArmIds();
  return ["A0", ...chosen.filter((id) => id !== "A0")];
}

function runWindowsArm(arm, runnerDir, armOut) {
  if (process.platform !== "win32") throw new Error("windows target requires Windows");
  const required = ["finish-window.txt", "fb-run.mjs", "fb-drive-state.mjs", "fb-manifest-edit.mjs", "fb-kit.mjs", "fb-google.mjs", "phrases.json", "facts.json"];
  const missing = required.filter((file) => !existsSync(resolve(runnerDir, file)));
  if (missing.length) throw new Error(`runner missing: ${missing.join(",")}`);
  const driver = resolve(runnerDir, "harness-windows-driver.ps1");
  if (!existsSync(driver)) throw new Error("runner missing harness-windows-driver.ps1 integration bridge");
  const proc = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver, "-Arm", arm, "-OutDir", armOut], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (proc.status !== 0) throw new Error(`windows driver failed for ${arm}`);
  return JSON.parse(readFileSync(resolve(armOut, "result.json"), "utf8"));
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });
const arms = selectedArms(args.arms);
const results = [];
let controlPassed = false;
for (const arm of arms) {
  if (arm !== "A0" && !controlPassed) throw new Error("A0 did not pass in this run");
  const armOut = resolve(args.out, arm);
  mkdirSync(armOut, { recursive: true });
  const result = args.target === "oracle" ? simulateArm(arm) : runWindowsArm(arm, args.runnerDir, armOut);
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
const summary = { target: args.target, arms: results.length, passed: results.filter((result) => result.status === "pass").length, suspect };
writeFileSync(resolve(args.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = results.every((result) => result.status === "pass") && !suspect.suspect ? 0 : 1;
