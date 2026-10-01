import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectJavaScript, inspectPowerShell, runRepositoryGate } from "./static-gate.mjs";

function defaultSpawn(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function checkLine(group, arm, status, reason) {
  return `CHECK ${group} ${arm} ${status} ${reason}`;
}

export async function evaluateControlledGroup(group, arms, runArm) {
  const lines = [];
  let controlFailed = false;
  for (let index = 0; index < arms.length; index += 1) {
    const arm = arms[index];
    if (index > 0 && controlFailed) {
      lines.push(checkLine(group, arm, "VOID", "control-failed"));
      continue;
    }
    const result = await runArm(arm);
    lines.push(checkLine(group, arm, result.status, result.reason));
    if (index === 0 && result.status !== "PASS" && result.status !== "SKIP") controlFailed = true;
  }
  return lines;
}

export function evaluateLaneRun(_lane, result) {
  const countMatches = [
    ...result.stdout.matchAll(/^# tests\s+(\d+)\s*$/gmu),
    ...result.stdout.matchAll(/^1\.\.(\d+)\s*$/gmu),
  ];
  const counts = countMatches.map((match) => Number.parseInt(match[1], 10));
  const tests = counts.length === 0 ? 0 : Math.max(...counts);
  if (tests === 0) return { status: "FAIL", reason: "tests=0" };
  if (result.status !== 0) return { status: "FAIL", reason: `tests=${tests}` };
  return { status: "PASS", reason: `tests=${tests}` };
}

export function evaluateEnvironmentRun(result) {
  const ok = result.status === 0 && /\bps=5(?:\.|\s)/u.test(result.stdout) && /\bedition=Desktop\b/u.test(result.stdout);
  return { status: ok ? "PASS" : "FAIL", reason: ok ? "flags-recorded" : "wrong-shell" };
}

function sequenceOf(result) {
  const value = result.status_lines ?? result.statusLines ?? result.status_sequence ?? [];
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function resultPassed(result) {
  return result.pass === true || result.status === "pass" || result.result === "pass";
}

export function evaluateL4Results(results, stdout, controlId, suspectToken) {
  const control = results.find((result) => (result.id ?? "") === controlId);
  const rest = results.filter((result) => result !== control);
  const lines = [];
  let red = false;
  if (!control) {
    lines.push(checkLine("l4", controlId, "FAIL", "control-absent"));
    for (const result of rest) lines.push(checkLine("l4", result.id ?? "unknown", "VOID", "control-failed"));
    return { lines, red: true };
  }
  const controlPass = resultPassed(control) && !control.host_limited && !control.hostLimited;
  if (!controlPass) {
    lines.push(checkLine("l4", controlId, "FAIL", "arm-failed"));
    for (const result of rest) lines.push(checkLine("l4", result.id ?? "unknown", "VOID", "control-failed"));
    return { lines, red: true };
  }
  lines.push(checkLine("l4", controlId, "PASS", "arm-passed"));
  for (const result of rest) {
    const id = result.id ?? "unknown";
    if (result.host_limited || result.hostLimited) lines.push(checkLine("l4", id, "SKIP", "host-limited"));
    else if (resultPassed(result)) lines.push(checkLine("l4", id, "PASS", "arm-passed"));
    else { lines.push(checkLine("l4", id, "FAIL", "arm-failed")); red = true; }
  }
  if (rest.length === 0) {
    lines.push(checkLine("l4", "set", "FAIL", "no-noncontrol"));
    red = true;
  }
  if (stdout.includes(suspectToken)) {
    lines.push(checkLine("l4", "set", "FAIL", "suspect-output"));
    red = true;
  }
  if (results.length > 1 && results.every((result) => resultPassed(result) && !result.host_limited && !result.hostLimited)) {
    const sequences = new Set(results.map(sequenceOf));
    if (sequences.size === 1) {
      lines.push(checkLine("l4", "set", "FAIL", "uniform-results"));
      red = true;
    }
  }
  return { lines, red };
}

async function listFiles(root) {
  const files = [];
  async function walk(folder) {
    let entries = [];
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await walk(root);
  return files;
}

async function collectResults(folder, resultFile) {
  const files = await listFiles(folder);
  const results = [];
  for (const file of files.filter((entry) => path.basename(entry) === resultFile)) {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (!value.id) value.id = path.basename(path.dirname(file));
      results.push(value);
    } catch {
      results.push({ id: path.basename(path.dirname(file)), pass: false });
    }
  }
  return results;
}

export async function runL4Adapter({ root, payloadRoot, runnerDir, outDir, adapter, spawnImpl = defaultSpawn }) {
  const missingKeys = [];
  try { await readdir(path.join(payloadRoot, "l4")); } catch { missingKeys.push("l4"); }
  for (const [served, source] of Object.entries(adapter.runner_files)) {
    try { await readFile(path.join(root, source)); } catch { missingKeys.push(served); }
  }
  if (missingKeys.length > 0) {
    return {
      lines: [checkLine("l4", "all", "SKIP", `not-delivered ${[...new Set(missingKeys)].join(",")}`)],
      missing: ["l4"],
      red: false,
    };
  }
  await rm(runnerDir, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
  await mkdir(runnerDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  for (const [served, source] of Object.entries(adapter.runner_files)) {
    const destination = path.join(runnerDir, served);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(root, source), destination);
  }
  const argv = adapter.run.map((value) => value.replaceAll("{runner}", runnerDir).replaceAll("{out}", outDir));
  const command = argv.shift();
  const run = await spawnImpl(command, argv, { cwd: root, windowsHide: true, shell: false });
  const results = await collectResults(outDir, adapter.result_file);
  const evaluated = evaluateL4Results(results, run.stdout ?? "", adapter.control_id, adapter.suspect_token);
  if (run.status !== 0 && !evaluated.red) {
    evaluated.lines.push(checkLine("l4", "runner", "FAIL", "runner-exit"));
    evaluated.red = true;
  }
  return { ...evaluated, missing: [] };
}

function parseGlob(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "*" && pattern[index + 1] === "*") { source += ".*"; index += 1; }
    else if (pattern[index] === "*") source += "[^/]*";
    else source += pattern[index].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

async function readList(file) {
  return (await readFile(file, "utf8")).split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

async function writeGroupLog(outDir, group, lines) {
  await writeFile(path.join(outDir, `${group}.log`), `${lines.join("\n")}\n`, "utf8");
}

function parseExemptions(lines) {
  const map = new Map();
  for (const line of lines) {
    const [file, rule] = line.split(/\s+/u);
    if (!map.has(file)) map.set(file, new Set());
    map.get(file).add(rule);
  }
  return map;
}

function countParseErrors(stdout) {
  const match = stdout.match(/errors=(\d+)/u);
  return match ? Number.parseInt(match[1], 10) : -1;
}

async function runAll({ root, output, spawnImpl = defaultSpawn, environment = process.env }) {
  await mkdir(output, { recursive: true });
  const tempRoot = environment.RUNNER_TEMP ? path.join(environment.RUNNER_TEMP, `wci-${process.pid}`) : output;
  await mkdir(tempRoot, { recursive: true });
  const allLines = [];
  const envFlags = [];
  const missing = new Set();

  const envRun = await spawnImpl("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "ci", "ps", "env.ps1")], {
    cwd: root, env: environment, windowsHide: true, shell: false,
  });
  const environmentResult = evaluateEnvironmentRun(envRun);
  if (envRun.status === 0 && /^ENV /mu.test(envRun.stdout)) envFlags.push(...envRun.stdout.split(/\r?\n/u).filter((line) => /^ENV /u.test(line)));
  const envLines = [checkLine("env", "control", environmentResult.status, environmentResult.reason)];
  allLines.push(...envLines);
  await writeGroupLog(output, "env", [...envLines, ...envFlags]);

  const fixtures = path.join(root, "ci", "fixtures");
  const generated = path.join(tempRoot, "sealed-negative.ps1");
  await writeFile(generated, `${String.fromCharCode(97, 108, 105, 103, 110)}\n`, "ascii");
  const staticArms = ["control", "add-type", "non-ascii", "sealed", "spawn-nohide", "payload"];
  const staticLines = await evaluateControlledGroup("static", staticArms, async (arm) => {
    if (arm === "control") {
      const hits = inspectPowerShell(await readFile(path.join(fixtures, "gate-good.ps1")), "control");
      return { status: hits.length === 0 ? "PASS" : "FAIL", reason: hits.length === 0 ? "gate-good" : "unexpected-hit" };
    }
    if (arm === "add-type" || arm === "non-ascii" || arm === "sealed") {
      const names = { "add-type": "gate-addtype.ps1", "non-ascii": "gate-nonascii.ps1", sealed: generated };
      const file = names[arm];
      const hits = inspectPowerShell(await readFile(path.isAbsolute(file) ? file : path.join(fixtures, file)), arm);
      const rule = arm === "sealed" ? "sealed-word" : arm;
      return { status: hits.some((hit) => hit.rule === rule) ? "PASS" : "FAIL", reason: `caught-${rule}` };
    }
    if (arm === "spawn-nohide") {
      const hits = inspectJavaScript(await readFile(path.join(fixtures, "spawn-nohide.mjs"), "utf8"), arm);
      return { status: hits.some((hit) => hit.rule === "spawn-options") ? "PASS" : "FAIL", reason: "caught-spawn-options" };
    }
    const targets = await readList(path.join(root, "ci", "parse-targets.txt"));
    const exemptions = parseExemptions(await readList(path.join(root, "ci", "static-exempt.txt")));
    const result = await runRepositoryGate({ root, parseTargets: targets, exemptions });
    return { status: result.hits.length === 0 ? "PASS" : "FAIL", reason: result.hits.length === 0 ? `files=${result.files},names=checked-before-push` : `hits=${result.hits.length}` };
  });
  allLines.push(...staticLines);
  await writeGroupLog(output, "static", staticLines);

  const parseScript = path.join(root, "ci", "ps", "parse.ps1");
  async function parseFile(file) {
    return spawnImpl("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", parseScript, "-Path", file], {
      cwd: root, env: environment, windowsHide: true, shell: false,
    });
  }
  const parseLines = await evaluateControlledGroup("parse", ["control", "bad", "payload"], async (arm) => {
    if (arm === "control") {
      const run = await parseFile(path.join(fixtures, "parse-good.ps1"));
      return { status: run.status === 0 && countParseErrors(run.stdout) === 0 ? "PASS" : "FAIL", reason: "errors=0" };
    }
    if (arm === "bad") {
      const run = await parseFile(path.join(fixtures, "parse-bad.ps1"));
      return { status: countParseErrors(run.stdout) > 0 ? "PASS" : "FAIL", reason: "caught-parse-error" };
    }
    const patterns = (await readList(path.join(root, "ci", "parse-targets.txt"))).map(parseGlob);
    const files = (await listFiles(root)).filter((file) => patterns.some((expression) => expression.test(path.relative(root, file).split(path.sep).join("/"))));
    for (const file of files) {
      const run = await parseFile(file);
      if (run.status !== 0 || countParseErrors(run.stdout) !== 0) return { status: "FAIL", reason: "payload-error" };
    }
    return { status: "PASS", reason: `files=${files.length}` };
  });
  allLines.push(...parseLines);
  await writeGroupLog(output, "parse", parseLines);

  const dpapiLines = await evaluateControlledGroup("dpapi", ["control", "tamper", "disk-scan"], async (arm) => {
    const run = await spawnImpl("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "ci", "ps", "dpapi.ps1"), "-Arm", arm, "-Root", path.join(tempRoot, `dpapi-${arm}`)], {
      cwd: root, env: environment, windowsHide: true, shell: false,
    });
    return { status: run.status === 0 ? "PASS" : "FAIL", reason: run.status === 0 ? `${arm}-proved` : `${arm}-failed` };
  });
  allLines.push(...dpapiLines);
  await writeGroupLog(output, "dpapi", dpapiLines);

  const taskScript = path.join(root, "ci", "ps", "task.ps1");
  const firstTask = await spawnImpl("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", taskScript, "-Arm", "control", "-LogonType", "Interactive", "-Root", path.join(tempRoot, "task-interactive")], {
    cwd: root, env: environment, windowsHide: true, shell: false,
  });
  const interactiveUnavailable = firstTask.status === 3 || /no-interactive-session/u.test(firstTask.stdout);
  const taskLines = [];
  if (interactiveUnavailable) taskLines.push(checkLine("task", "interactive", "SKIP", "no-interactive-session"));
  else taskLines.push(checkLine("task", "interactive", firstTask.status === 0 ? "PASS" : "FAIL", firstTask.status === 0 ? "control-proved" : "control-failed"));
  if (firstTask.status === 0 || interactiveUnavailable) {
    const mode = interactiveUnavailable ? "S4U" : "Interactive";
    const arms = interactiveUnavailable ? ["control", "wrong-pin", "settings", "ignore-new", "path-quoting"] : ["wrong-pin", "settings", "ignore-new", "path-quoting"];
    const runTaskArm = async (arm) => {
      const run = await spawnImpl("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", taskScript, "-Arm", arm, "-LogonType", mode, "-Root", path.join(tempRoot, `task-${arm}`)], {
        cwd: root, env: environment, windowsHide: true, shell: false,
      });
      return { status: run.status === 0 ? "PASS" : "FAIL", reason: run.status === 0 ? `${arm}-proved` : `${arm}-failed` };
    };
    let rest;
    if (interactiveUnavailable) {
      rest = await evaluateControlledGroup("task", arms, runTaskArm);
    } else {
      rest = [];
      for (const arm of arms) {
        const value = await runTaskArm(arm);
        rest.push(checkLine("task", arm, value.status, value.reason));
      }
    }
    taskLines.push(...rest);
  } else {
    for (const arm of ["wrong-pin", "settings", "ignore-new", "path-quoting"]) taskLines.push(checkLine("task", arm, "VOID", "control-failed"));
  }
  allLines.push(...taskLines);
  await writeGroupLog(output, "task", taskLines);

  const laneLines = [checkLine("lanes", "control", "PASS", "list-loaded")];
  for (const lane of await readList(path.join(root, "ci", "lane-tests.txt"))) {
    const folder = path.join(root, "payload", lane);
    let laneFiles = [];
    try {
      laneFiles = (await listFiles(path.join(folder, "test"))).filter((file) => /(?:\.test|\.win\.test)\.mjs$/u.test(file));
    } catch { laneFiles = []; }
    if (laneFiles.length === 0) {
      laneLines.push(checkLine("lanes", lane, "SKIP", "not-delivered"));
      missing.add(lane);
      continue;
    }
    const laneHome = path.join(tempRoot, `home-${lane}-${Date.now()}`);
    await mkdir(laneHome, { recursive: true });
    const run = await spawnImpl(process.execPath, ["--test", ...laneFiles], {
      cwd: folder,
      env: { ...environment, WCI: "1", HOME: laneHome, TEMP: laneHome, TMP: laneHome, BRAIN_NO_WRANGLER_LOGIN: "1" },
      windowsHide: true,
      shell: false,
    });
    const evaluated = evaluateLaneRun(lane, run);
    laneLines.push(checkLine("lanes", lane, evaluated.status, evaluated.reason));
  }
  allLines.push(...laneLines);
  await writeGroupLog(output, "lanes", laneLines);

  const adapter = JSON.parse(await readFile(path.join(root, "ci", "l4-adapter.json"), "utf8"));
  const l4 = await runL4Adapter({
    root,
    payloadRoot: path.join(root, "payload"),
    runnerDir: path.join(tempRoot, "l4-runner"),
    outDir: path.join(output, "l4-results"),
    adapter,
    spawnImpl,
  });
  l4.missing.forEach((lane) => missing.add(lane));
  allLines.push(...l4.lines);
  await writeGroupLog(output, "l4", l4.lines);

  const failures = allLines.filter((line) => / FAIL /u.test(line)).length;
  const ending = failures === 0 ? "WCI: GREEN" : `WCI: RED ${failures}`;
  allLines.push(ending);
  if (missing.size > 0) allLines.push(`WCI: MISSING ${[...missing].sort().join(",")}`);
  await writeFile(path.join(output, "summary.txt"), `${[...envFlags, ...allLines].join("\n")}\n`, "utf8");
  for (const line of allLines) process.stdout.write(`${line}\n`);
  return { code: failures === 0 ? 0 : 1, lines: allLines, missing: [...missing] };
}

async function main() {
  const index = process.argv.indexOf("--out");
  if (index === -1 || !process.argv[index + 1]) {
    process.stderr.write("usage: node ci/wci-run.mjs --out <folder>\n");
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await runAll({ root, output: path.resolve(process.argv[index + 1]) });
  process.exitCode = result.code;
}

export { runAll };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
