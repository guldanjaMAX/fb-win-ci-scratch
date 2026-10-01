import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkLegacy } from "./check-phrases.mjs";
import { checkMerged } from "./check-phrases-ci.mjs";
import { freshKey, installStub, makeFakeNode, makeLargeDriveState, makeSession, scenarioFor, scenarioForSessionHelpers, scenarioForSupervisorArgv } from "./fixtures.mjs";
import { armSpecs } from "./reference/arms.mjs";
import { canonical, detectSuspect, simulateArm, verifyArm } from "./reference/oracle.mjs";
import { expectedRunnerNames, verifyRunnerArtifacts } from "./artifact-pins.mjs";
import { silentExpectedStubCalls, validateRealSessionEvidence } from "./real-session-evidence.mjs";
import { applyProductionMutant, productionMutants } from "./production-mutants.mjs";

let failures = 0;
function check(condition, label) {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}`);
  if (!condition) failures += 1;
}

const oracle = armSpecs.map((arm) => simulateArm(arm.id));
const oracleChecks = oracle.map(verifyArm);
check(oracleChecks.every((item) => item.pass), `oracle ${oracleChecks.filter((item) => item.pass).length}/${oracleChecks.length} arms`);
check(!detectSuspect(oracle).suspect, "oracle sequences are non-uniform");

const nullResults = armSpecs.map((arm) => ({
  arm: arm.id,
  decision_point: { required: arm.point, reached: false },
  status_lines: [],
  calls: [],
  leak_scan_counts: { key: 0, account: 0, host: 0, email: 0, hex24: 0 },
  meta: {}
}));
check(nullResults.every((result) => !verifyArm(result).pass), "null oracle fails every arm");
check(detectSuspect(nullResults).suspect, "null oracle trips uniform detector");

const alwaysDone = armSpecs.map((arm) => {
  if (arm.id === "A0") return simulateArm("A0");
  const result = simulateArm(arm.id);
  result.status_lines = ["2026-10-01T08:00:00Z W11 DONE done"];
  return result;
});
const alwaysDonePasses = alwaysDone.filter((result) => verifyArm(result).pass).map((result) => result.arm);
check(JSON.stringify(alwaysDonePasses) === JSON.stringify(["A0"]), "always-done oracle passes only A0");
check(!detectSuspect(alwaysDone).suspect, "always-done oracle does not trip uniform detector");

const missingSessionEvidence = simulateArm("A0");
missingSessionEvidence.target = "windows";
missingSessionEvidence.meta = { sessionEvidence: false, actualStatusCount: 0 };
missingSessionEvidence.decision_point = { ...missingSessionEvidence.decision_point, source: "oracle" };
const refusedSyntheticWindows = validateRealSessionEvidence(missingSessionEvidence);
check(!refusedSyntheticWindows.pass && refusedSyntheticWindows.errors.includes("decision-not-session") && refusedSyntheticWindows.errors.includes("window-not-launched"), "windows PASS refuses oracle or stub evidence without a real launched session");

const realSessionShape = {
  ...simulateArm("A0"),
  target: "windows",
  decision_point: { required: "control", reached: true, source: "session" },
  meta: { sessionEvidence: true, actualStatusCount: 1, sessionRunnerExit: 0, bridge: { pass: true, launched: true } }
};
check(validateRealSessionEvidence(realSessionShape).pass, "windows evidence guard accepts the complete real-session shape");
const silentStub = [{ command: "verify", output_expected: true, output_bytes: 0 }];
const nonSilentStub = [{ command: "verify", output_expected: true, output_bytes: 1 }];
check(silentExpectedStubCalls(silentStub).length === 1 && silentExpectedStubCalls(silentStub)[0].command === "verify" && silentExpectedStubCalls(nonSilentStub).length === 0, "reached expected stub call makes empty output VOID while the non-empty control stays valid");

for (const [id, mutant] of Object.entries(productionMutants)) {
  const source = `before\n${mutant.find}\nafter\n`;
  const changed = applyProductionMutant(source, id);
  check(changed !== source && changed.includes(mutant.replace), `${id} rewrite anchor applies to ${mutant.file}`);
}

const windowsSessionSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "windows-session.mjs"), "utf8");
const armRunnerSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run-arms.mjs"), "utf8");
const windowsFunctionSource = armRunnerSource.slice(armRunnerSource.indexOf("function runWindowsArm"), armRunnerSource.indexOf("const args ="));
check(!windowsSessionSource.includes("simulateArm(") && !windowsSessionSource.includes("runStubArm("), "Windows session builder never sources evidence from oracle or stub targets");
check(armRunnerSource.includes("windows-session.mjs") && !windowsFunctionSource.includes("runStubArm("), "Windows arm path launches the per-arm session runner");
check(["PR002", "PR003", "PR004", "PR005", "PR006", "PR008"].every((id) => armSpecs.some((arm) => arm.id === id)), "six fixed-path real-window arms are registered");
check(!windowsSessionSource.includes("fb-test-step.json") && windowsSessionSource.includes("scenarioForSupervisorArgv"), "Windows fixtures use production argv instead of the dropped supervisor test environment");
check(windowsSessionSource.includes("emptyExpectedStubSteps") && armRunnerSource.includes('result.status = "void"'), "empty expected stub output is preserved as VOID through the arm runner");
check(windowsSessionSource.includes("makeFakeNode(fixture.prefix)"), "Windows session keeps the selected prefix, fake node, and npm entry on one production resolution path");
check(windowsSessionSource.includes('join(fixture.prefix, "npm-calls.jsonl")'), "Windows session projects the recording npm call into session evidence");

const scratch = mkdtempSync(join(tmpdir(), "phrase-self-test-"));
check(expectedRunnerNames().length === 9, "runner bridge pins helper plus eight served files");
const pinProbe = verifyRunnerArtifacts(join(scratch, "missing-runner"), { allowMissing: true });
check(pinProbe.missing.length === 9, "runner bridge identifies every missing pinned input");
mkdirSync(join(scratch, "kit"));
writeFileSync(join(scratch, "kit", "sample.mjs"), "zero\nfixed phrase\nlast\n");
const good = { schema: 1, minimum: 1, entries: [{ id: "real", fragments: ["fixed phrase"], kind: "ok", file: "sample.mjs", line: 2, used_by: "stub" }] };
const miss = { schema: 1, minimum: 1, entries: [{ id: "miss", fragments: ["fixed pharse"], kind: "ok", file: "sample.mjs", line: 2, used_by: "stub" }] };
const off = { schema: 1, minimum: 1, entries: [{ id: "off", fragments: ["fixed phrase"], kind: "ok", file: "sample.mjs", line: 3, used_by: "stub" }] };
for (const [name, value] of [["good", good], ["miss", miss], ["off", off]]) writeFileSync(join(scratch, `${name}.json`), `${JSON.stringify(value)}\n`);
check(checkLegacy(join(scratch, "kit"), join(scratch, "good.json"), { print: false }).pass, "phrase checker accepts cited phrase");
check(!checkLegacy(join(scratch, "kit"), join(scratch, "miss.json"), { print: false }).pass, "phrase checker rejects misspelling");
check(!checkLegacy(join(scratch, "kit"), join(scratch, "off.json"), { print: false }).pass, "phrase checker rejects one-line-off citation");

const mergedGood = { schema: 1, entries: [{ id: "merged", match: "fixed phrase", source: "sample.mjs:2" }] };
const mergedBad = { schema: 1, entries: [{ id: "merged", match: "fixed pharse", source: "sample.mjs:2" }] };
writeFileSync(join(scratch, "merged-good.json"), `${JSON.stringify(mergedGood)}\n`);
writeFileSync(join(scratch, "merged-bad.json"), `${JSON.stringify(mergedBad)}\n`);
check(checkMerged(join(scratch, "kit"), join(scratch, "merged-good.json"), { print: false }).pass, "merged phrase checker accepts source");
check(!checkMerged(join(scratch, "kit"), join(scratch, "merged-bad.json"), { print: false }).pass, "merged phrase checker rejects mutation");

const stubRoot = join(scratch, "stub run");
const fixture = makeSession(stubRoot, { marker: "tier2\n" });
const key = freshKey();
installStub(fixture.prefix, scenarioFor({ update: [{ lines: [{ id: "bookmark" }], readStdin: true }] }, key));
const stubCli = join(fixture.prefix, "node_modules", "brain-installer", "brain.mjs");
const stubRun = spawnSync(process.execPath, [stubCli, "update", fixture.manifest], {
  cwd: fixture.session,
  encoding: "utf8",
  input: "",
  windowsHide: true,
  shell: false,
  env: {
    HOME: fixture.home,
    TMPDIR: process.env.TMPDIR,
    BRAIN_NO_WRANGLER_LOGIN: "1",
    BRAIN_GOOGLE_TOKEN_STORE: "file",
    CLOUDFLARE_API_TOKEN: key
  }
});
const stubCall = JSON.parse(readFileSync(join(fixture.prefix, "stub-calls.jsonl"), "utf8").trim());
check(stubRun.status === 0 && stubRun.stdout.startsWith("·    required D1 restore bookmark captured"), "stub emits real UTF-8 mark and pinned phrase");
check(stubCall.stdin_tty === false && stubCall.stdin_eof === true && stubCall.stdin_bytes === 0, "stub records closed non-TTY stdin");
check(stubCall.key_matches === true && !readFileSync(join(fixture.prefix, "stub-calls.jsonl"), "utf8").includes(key), "stub records key comparison without key text");
check(!existsSync(join(fixture.prefix, "stub-brain-cmd-called.txt")), "node path did not invoke command trap");

const argvRoot = join(scratch, "supervisor argv");
const argvFixture = makeSession(argvRoot, { marker: "tier2\n" });
const argvKey = freshKey();
installStub(argvFixture.prefix, scenarioForSupervisorArgv([
  { label: "verify", raw: ["Cloudflare access confirmed for account fixture"] }
], argvKey));
const argvCli = join(argvFixture.prefix, "node_modules", "brain-installer", "brain.mjs");
const argvRun = spawnSync(process.execPath, [argvCli, "verify", argvFixture.manifest], {
  cwd: argvFixture.session,
  encoding: "utf8",
  windowsHide: true,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  env: { HOME: argvFixture.home, TMPDIR: process.env.TMPDIR, BRAIN_NO_WRANGLER_LOGIN: "1", CLOUDFLARE_API_TOKEN: argvKey }
});
check(argvRun.status === 0 && argvRun.stdout.includes("Cloudflare access confirmed"), "supervisor argv fixture emits expected verify output without a test-only environment name");

const updateRoot = join(scratch, "supervisor update argv");
const updateFixture = makeSession(updateRoot, { marker: "tier2\n" });
const updateKey = freshKey();
installStub(updateFixture.prefix, scenarioForSupervisorArgv([
  { label: "update-preview", raw: ['{"pre_update_check_complete": true,', '"projection_ready": true,'] },
  { label: "update", raw: ["required D1 restore bookmark captured", "Done. Your Brain is now on version 0.4.9 and passed its checks."] }
], updateKey));
const updateCli = join(updateFixture.prefix, "node_modules", "brain-installer", "brain.mjs");
const updateEnv = { HOME: updateFixture.home, TMPDIR: process.env.TMPDIR, BRAIN_NO_WRANGLER_LOGIN: "1", CLOUDFLARE_API_TOKEN: updateKey };
const previewRun = spawnSync(process.execPath, [updateCli, "update", updateFixture.manifest, "--preview", "--json"], { cwd: updateFixture.session, encoding: "utf8", windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env: updateEnv });
const updateRun = spawnSync(process.execPath, [updateCli, "update", updateFixture.manifest], { cwd: updateFixture.session, encoding: "utf8", windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env: updateEnv });
const updateCalls = readFileSync(join(updateFixture.prefix, "stub-calls.jsonl"), "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
check(previewRun.stdout.includes("pre_update_check_complete") && updateRun.stdout.includes("Done. Your Brain") && updateCalls.map((call) => call.command).join(",") === "update-preview,update", "repeated update argv advances from preview to update output");

const helperScenario = scenarioForSessionHelpers([
  { label: "google-lease", raw: ["fb:lease=free"] },
  { label: "google-scopes", raw: ["fb:record=present"] },
  { label: "google-scopes", raw: ["fb:record=present", "fb:account=same"] },
  { label: "google-backup", raw: ["fb:backup=yes"] },
  { label: "google-restore", raw: ["fb:restore=done"] },
]);
check(helperScenario.commands["google-scopes"].length === 2 && helperScenario.commands["google-restore"][0].raw[0] === "fb:restore=done", "session helper fixtures are selected by the supervisor's fixed helper argv");
const helperRoot = join(scratch, "session helper argv");
const helperFixture = makeSession(helperRoot, { marker: "tier2\nw8\n" });
const helperStub = join(helperFixture.session, "fb-google.mjs");
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "stub", "fb-google.mjs"), helperStub);
writeFileSync(join(helperFixture.session, "helper-scenario.json"), `${JSON.stringify(helperScenario, null, 2)}\n`);
const helperLease = spawnSync(process.execPath, [helperStub, "lease"], { cwd: helperFixture.session, encoding: "utf8", windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { HOME: helperFixture.home, TMPDIR: process.env.TMPDIR, BRAIN_NO_WRANGLER_LOGIN: "1" } });
const helperScopes1 = spawnSync(process.execPath, [helperStub, "scopes", "--prefix", helperFixture.prefix, "--phase", "pre"], { cwd: helperFixture.session, encoding: "utf8", windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { HOME: helperFixture.home, TMPDIR: process.env.TMPDIR, BRAIN_NO_WRANGLER_LOGIN: "1" } });
const helperScopes2 = spawnSync(process.execPath, [helperStub, "scopes", "--prefix", helperFixture.prefix, "--phase", "post"], { cwd: helperFixture.session, encoding: "utf8", windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { HOME: helperFixture.home, TMPDIR: process.env.TMPDIR, BRAIN_NO_WRANGLER_LOGIN: "1" } });
check(helperLease.stdout.includes("fb:lease=free") && helperScopes1.stdout.trim() === "fb:record=present" && helperScopes2.stdout.includes("fb:account=same"), "session helper stub advances repeated argv actions without environment routing");

const fakeNode = makeFakeNode(fixture.prefix);
const kitPath = join(fixture.run, "kit", "kit.tgz");
mkdirSync(join(fixture.run, "kit"), { recursive: true });
writeFileSync(kitPath, "fixture\n");
const installArgs = [fakeNode.npmCli, "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", fixture.prefix, kitPath];
const npmRun = spawnSync(fakeNode.executable, installArgs, { cwd: fixture.session, encoding: "utf8", windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
const npmCall = JSON.parse(readFileSync(join(fixture.prefix, "npm-calls.jsonl"), "utf8").trim());
check(fakeNode.executable.startsWith(fixture.prefix) && fakeNode.npmCli.startsWith(fixture.prefix), "fake node and npm entry are beneath the selected prefix");
check(npmRun.status === 0 && npmRun.stdout === "added 1 package in 1s\n" && JSON.stringify(npmCall.argv) === JSON.stringify(installArgs.slice(1)), "recording npm entry point emits deterministic npm success output and receives exact install argv");
check(npmCall.command === "npm-cli.js" && npmCall.output_expected === true && npmCall.output_bytes === Buffer.byteLength(npmRun.stdout), "recording npm call carries non-silent evidence metadata");

const large = makeLargeDriveState(fixture.manifestDir);
const driveStart = process.hrtime.bigint();
const driveState = JSON.parse(readFileSync(large.path, "utf8"));
const driveMs = Number(process.hrtime.bigint() - driveStart) / 1_000_000;
const driveCount = Object.keys(driveState.done).length + Object.keys(driveState.skipped).length + Object.keys(driveState.removed).length;
check(large.bytes >= 50 * 1024 * 1024 && driveCount === 3 && driveMs < 5000, `fifty-megabyte drive read ${driveMs.toFixed(1)}ms bound=5000ms counts=3`);

const sequenceCount = new Set(oracle.map((result) => JSON.stringify(result.status_lines.map(canonical)))).size;
console.log(`SUMMARY arms=${armSpecs.length} sequences=${sequenceCount} failures=${failures}`);
process.exitCode = failures ? 1 : 0;
