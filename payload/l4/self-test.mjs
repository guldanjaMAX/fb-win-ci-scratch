import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkLegacy } from "./check-phrases.mjs";
import { checkMerged } from "./check-phrases-ci.mjs";
import { freshKey, installStub, makeFakeNode, makeLargeDriveState, makeSession, scenarioFor } from "./fixtures.mjs";
import { armSpecs, mutantExpectations } from "./reference/arms.mjs";
import { canonical, detectSuspect, simulateArm, verifyArm } from "./reference/oracle.mjs";
import { expectedRunnerNames, verifyRunnerArtifacts } from "./artifact-pins.mjs";

let failures = 0;
function check(condition, label) {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}`);
  if (!condition) failures += 1;
}

const oracle = armSpecs.map((arm) => simulateArm(arm.id));
const oracleChecks = oracle.map(verifyArm);
check(oracleChecks.every((item) => item.pass), `oracle ${oracleChecks.filter((item) => item.pass).length}/${oracleChecks.length} arms`);
check(!detectSuspect(oracle).suspect, "oracle sequences are non-uniform");

for (const [mutant, expectedFailures] of Object.entries(mutantExpectations)) {
  const actualFailures = armSpecs.filter((arm) => !verifyArm(simulateArm(arm.id, mutant)).pass).map((arm) => arm.id);
  check(JSON.stringify(actualFailures) === JSON.stringify(expectedFailures), `${mutant} caught by ${expectedFailures.join(",")}`);
}

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

const fakeNode = makeFakeNode(stubRoot);
const kitPath = join(fixture.run, "kit", "kit.tgz");
mkdirSync(join(fixture.run, "kit"), { recursive: true });
writeFileSync(kitPath, "fixture\n");
const installArgs = [fakeNode.npmCli, "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", fixture.prefix, kitPath];
const npmRun = spawnSync(fakeNode.executable, installArgs, { cwd: fixture.session, encoding: "utf8", windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
const npmCall = JSON.parse(readFileSync(join(fixture.prefix, "npm-calls.jsonl"), "utf8").trim());
check(npmRun.status === 0 && JSON.stringify(npmCall.argv) === JSON.stringify(installArgs.slice(1)), "recording npm entry point receives exact install argv");

const large = makeLargeDriveState(fixture.manifestDir);
const driveStart = process.hrtime.bigint();
const driveState = JSON.parse(readFileSync(large.path, "utf8"));
const driveMs = Number(process.hrtime.bigint() - driveStart) / 1_000_000;
const driveCount = Object.keys(driveState.done).length + Object.keys(driveState.skipped).length + Object.keys(driveState.removed).length;
check(large.bytes >= 50 * 1024 * 1024 && driveCount === 3 && driveMs < 5000, `fifty-megabyte drive read ${driveMs.toFixed(1)}ms bound=5000ms counts=3`);

const sequenceCount = new Set(oracle.map((result) => JSON.stringify(result.status_lines.map(canonical)))).size;
console.log(`SUMMARY arms=${armSpecs.length} mutants=${Object.keys(mutantExpectations).length} sequences=${sequenceCount} failures=${failures}`);
process.exitCode = failures ? 1 : 0;
