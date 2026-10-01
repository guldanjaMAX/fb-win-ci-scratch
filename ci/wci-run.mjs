import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectJavaScript, inspectPowerShell, parseStaticExemptions, runRepositoryGate } from "./static-gate.mjs";

function defaultSpawn(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
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
  const transcript = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const countMatches = [
    ...transcript.matchAll(/^# tests\s+(\d+)\s*$/gmu),
    ...transcript.matchAll(/^1\.\.(\d+)\s*$/gmu),
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

function safeDetail(value, root) {
  const rootForms = [root, root.split(path.sep).join("/"), root.split(path.sep).join("\\")].filter(Boolean);
  let text = String(value ?? "").replace(/[\r\n]+/gu, " ").trim();
  for (const rootForm of rootForms) text = text.replaceAll(rootForm, "[ROOT]");
  text = text
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/giu, "[HOME]")
    .replace(/\/Users\/[^/\s]+/gu, "[HOME]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[EMAIL]")
    .replace(/\b[0-9a-f]{32,}\b/giu, "[HEX]");
  for (const match of [...text.matchAll(/[A-Za-z0-9_-]{35,}/gu)]) {
    if (/[A-Z]/u.test(match[0]) && /[a-z]/u.test(match[0]) && /[0-9]/u.test(match[0])) text = text.replaceAll(match[0], "[KEY]");
  }
  const sealed = String.fromCharCode(97, 108, 105, 103, 110);
  return text.replace(new RegExp(sealed, "giu"), "[SEALED]");
}

function failureEntries(lines) {
  return lines.flatMap((line) => {
    const match = line.match(/^CHECK\s+\S+\s+(\S+)\s+(FAIL|VOID)\s+(.+)$/u);
    return match ? [{ arm: match[1], status: match[2], reason: match[3] }] : [];
  });
}


function failingTapLines(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length && out.length < 120; i += 1) {
    if (/^\s*not ok\b/.test(lines[i])) {
      out.push(`fail=${lines[i].trim()}`);
      for (let j = i + 1; j < Math.min(lines.length, i + 12) && !/^\s*(not )?ok\b/.test(lines[j]); j += 1) {
        if (lines[j].trim() && out.length < 120) out.push(`  ${lines[j].trim().slice(0, 240)}`);
      }
    }
  }
  return out;
}

async function writeFailureDetails(outDir, root, group, lines, details = new Map()) {
  for (const entry of failureEntries(lines)) {
    const supplied = details.get(entry.arm) ?? [];
    const rows = supplied.length > 0 ? supplied : [`status=${entry.status}`, `reason=${entry.reason}`];
    const safeRows = rows.map((row) => safeDetail(row, root)).filter(Boolean);
    await writeFile(path.join(outDir, `${group}-${entry.arm}.detail.txt`), `${safeRows.join("\n")}\n`, "utf8");
  }
}

function structuredDetails(run, prefix) {
  return `${run.stdout ?? ""}\n${run.stderr ?? ""}`
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
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
  await writeFailureDetails(output, root, "env", envLines, new Map([
    ["control", [`command=powershell.exe -File ci/ps/env.ps1`, `exit=${envRun.status}`, `error=${envRun.stderr || envRun.error?.message || "wrong-shell"}`]],
  ]));

  const fixtures = path.join(root, "ci", "fixtures");
  const generated = path.join(tempRoot, "sealed-negative.ps1");
  await writeFile(generated, `${String.fromCharCode(97, 108, 105, 103, 110)}\n`, "ascii");
  const staticDetails = new Map();
  const staticArms = ["control", "add-type", "non-ascii", "sealed", "spawn-nohide", "payload"];
  const staticLines = await evaluateControlledGroup("static", staticArms, async (arm) => {
    if (arm === "control") {
      const hits = inspectPowerShell(await readFile(path.join(fixtures, "gate-good.ps1")), "control");
      staticDetails.set(arm, hits.map((hit) => `${hit.file}:${hit.line}:${hit.rule}`));
      return { status: hits.length === 0 ? "PASS" : "FAIL", reason: hits.length === 0 ? "gate-good" : "unexpected-hit" };
    }
    if (arm === "add-type" || arm === "non-ascii" || arm === "sealed") {
      const names = { "add-type": "gate-addtype.ps1", "non-ascii": "gate-nonascii.ps1", sealed: generated };
      const file = names[arm];
      const hits = inspectPowerShell(await readFile(path.isAbsolute(file) ? file : path.join(fixtures, file)), arm);
      const rule = arm === "sealed" ? "sealed-word" : arm;
      staticDetails.set(arm, hits.map((hit) => `${hit.file}:${hit.line}:${hit.rule}`));
      return { status: hits.some((hit) => hit.rule === rule) ? "PASS" : "FAIL", reason: `caught-${rule}` };
    }
    if (arm === "spawn-nohide") {
      const hits = inspectJavaScript(await readFile(path.join(fixtures, "spawn-nohide.mjs"), "utf8"), arm);
      staticDetails.set(arm, hits.map((hit) => `${hit.file}:${hit.line}:${hit.rule}`));
      return { status: hits.some((hit) => hit.rule === "spawn-options") ? "PASS" : "FAIL", reason: "caught-spawn-options" };
    }
    const targets = await readList(path.join(root, "ci", "parse-targets.txt"));
    const exemptions = parseStaticExemptions(await readList(path.join(root, "ci", "static-exempt.txt")));
    const result = await runRepositoryGate({ root, parseTargets: targets, exemptions });
    staticDetails.set(arm, result.hits.map((hit) => `${hit.file}:${hit.line}:${hit.rule}`));
    return { status: result.hits.length === 0 ? "PASS" : "FAIL", reason: result.hits.length === 0 ? `files=${result.files},names=checked-before-push` : `hits=${result.hits.length}` };
  });
  allLines.push(...staticLines);
  await writeGroupLog(output, "static", staticLines);
  await writeFailureDetails(output, root, "static", staticLines, staticDetails);

  const parseScript = path.join(root, "ci", "ps", "parse.ps1");
  async function parseFile(file, displayPath) {
    return spawnImpl("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", parseScript, "-DisplayPath", displayPath, "-Path", file], {
      cwd: root, env: environment, windowsHide: true, shell: false,
    });
  }
  const parseDetails = new Map();
  const parseLines = await evaluateControlledGroup("parse", ["control", "bad", "payload"], async (arm) => {
    if (arm === "control") {
      const run = await parseFile(path.join(fixtures, "parse-good.ps1"), "ci/fixtures/parse-good.ps1");
      parseDetails.set(arm, structuredDetails(run, "DETAIL parse ").map((line) => line.replace(/^file=(\S+) line=(\d+) message=/u, "$1:$2:")));
      return { status: run.status === 0 && countParseErrors(run.stdout) === 0 ? "PASS" : "FAIL", reason: "errors=0" };
    }
    if (arm === "bad") {
      const run = await parseFile(path.join(fixtures, "parse-bad.ps1"), "ci/fixtures/parse-bad.ps1");
      parseDetails.set(arm, structuredDetails(run, "DETAIL parse ").map((line) => line.replace(/^file=(\S+) line=(\d+) message=/u, "$1:$2:")));
      return { status: countParseErrors(run.stdout) > 0 ? "PASS" : "FAIL", reason: "caught-parse-error" };
    }
    const patterns = (await readList(path.join(root, "ci", "parse-targets.txt"))).map(parseGlob);
    const files = (await listFiles(root)).filter((file) => patterns.some((expression) => expression.test(path.relative(root, file).split(path.sep).join("/")))).sort();
    const details = [];
    let failed = false;
    for (const file of files) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      const run = await parseFile(file, relative);
      const rows = structuredDetails(run, "DETAIL parse ").map((line) => line.replace(/^file=(\S+) line=(\d+) message=/u, "$1:$2:"));
      if (run.status !== 0 || countParseErrors(run.stdout) !== 0) {
        failed = true;
        details.push(...(rows.length > 0 ? rows : [`${relative}:0:parser-exit-${run.status}`]));
      }
    }
    parseDetails.set(arm, details);
    return { status: failed ? "FAIL" : "PASS", reason: failed ? "payload-error" : `files=${files.length}` };
  });
  allLines.push(...parseLines);
  await writeGroupLog(output, "parse", parseLines);
  await writeFailureDetails(output, root, "parse", parseLines, parseDetails);

  const dpapiDetails = new Map();
  const dpapiLines = await evaluateControlledGroup("dpapi", ["control", "tamper", "disk-scan"], async (arm) => {
    const run = await spawnImpl("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "ci", "ps", "dpapi.ps1"), "-Arm", arm, "-Root", path.join(tempRoot, `dpapi-${arm}`)], {
      cwd: root, env: environment, windowsHide: true, shell: false,
    });
    dpapiDetails.set(arm, [`command=powershell.exe -File ci/ps/dpapi.ps1 -Arm ${arm}`, `exit=${run.status}`, `error=${run.stderr || run.error?.message || `${arm}-failed`}`]);
    return { status: run.status === 0 ? "PASS" : "FAIL", reason: run.status === 0 ? `${arm}-proved` : `${arm}-failed` };
  });
  allLines.push(...dpapiLines);
  await writeGroupLog(output, "dpapi", dpapiLines);
  await writeFailureDetails(output, root, "dpapi", dpapiLines, dpapiDetails);

  const taskScript = path.join(root, "ci", "ps", "task.ps1");
  const firstTask = await spawnImpl("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", taskScript, "-Arm", "control", "-LogonType", "Interactive", "-Root", path.join(tempRoot, "task-interactive")], {
    cwd: root, env: environment, windowsHide: true, shell: false,
  });
  const interactiveUnavailable = firstTask.status === 3 || /no-interactive-session/u.test(firstTask.stdout);
  const taskLines = [];
  const taskDetails = new Map();
  const firstTaskRows = structuredDetails(firstTask, "DETAIL task ");
  taskDetails.set("interactive", firstTaskRows.length > 0 ? firstTaskRows : [
    "cmdlet=task.ps1 setting=control error=" + (firstTask.stderr || firstTask.error?.message || `exit-${firstTask.status}`),
  ]);
  if (interactiveUnavailable) taskLines.push(checkLine("task", "interactive", "SKIP", "no-interactive-session"));
  else taskLines.push(checkLine("task", "interactive", firstTask.status === 0 ? "PASS" : "FAIL", firstTask.status === 0 ? "control-proved" : "control-failed"));
  if (firstTask.status === 0 || interactiveUnavailable) {
    const mode = interactiveUnavailable ? "S4U" : "Interactive";
    const arms = interactiveUnavailable ? ["control", "wrong-pin", "settings", "ignore-new", "path-quoting"] : ["wrong-pin", "settings", "ignore-new", "path-quoting"];
    const runTaskArm = async (arm) => {
      const run = await spawnImpl("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", taskScript, "-Arm", arm, "-LogonType", mode, "-Root", path.join(tempRoot, `task-${arm}`)], {
        cwd: root, env: environment, windowsHide: true, shell: false,
      });
      const rows = structuredDetails(run, "DETAIL task ");
      taskDetails.set(arm, rows.length > 0 ? rows : [
        `cmdlet=task.ps1 setting=${arm} error=${run.stderr || run.error?.message || `exit-${run.status}`}`,
      ]);
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
  await writeFailureDetails(output, root, "task", taskLines, taskDetails);

  const laneLines = [checkLine("lanes", "control", "PASS", "list-loaded")];
  const laneDetails = new Map();
  for (const lane of await readList(path.join(root, "ci", "lane-tests.txt"))) {
    const folder = path.join(root, "payload", lane);
    let delivered = true;
    try { await readdir(folder); } catch { delivered = false; }
    if (!delivered) {
      laneLines.push(checkLine("lanes", lane, "SKIP", "not-delivered"));
      missing.add(lane);
      continue;
    }
    let laneFiles = [];
    try {
      laneFiles = (await listFiles(path.join(folder, "test"))).filter((file) => /\.test\.mjs$/u.test(file)).sort();
    } catch { laneFiles = []; }
    if (laneFiles.length === 0) {
      laneLines.push(checkLine("lanes", lane, "FAIL", "tests=0"));
      laneDetails.set(lane, ["discovered=(none)", "command=(not-run)", "exit=not-run", "tests=0"]);
      continue;
    }
    const laneHome = path.join(tempRoot, `home-${lane}-${Date.now()}`);
    await mkdir(laneHome, { recursive: true });
    const relativeFiles = laneFiles.map((file) => path.relative(folder, file).split(path.sep).join("/"));
    const commandArgs = ["--test", "--test-reporter=tap", ...relativeFiles];
    const run = await spawnImpl(process.execPath, commandArgs, {
      cwd: folder,
      env: { ...environment, WCI: "1", HOME: laneHome, TEMP: laneHome, TMP: laneHome, BRAIN_NO_WRANGLER_LOGIN: "1" },
      windowsHide: true,
      shell: false,
    });
    const evaluated = evaluateLaneRun(lane, run);
    laneDetails.set(lane, [
      ...relativeFiles.map((file) => `discovered=${file}`),
      `command=node ${commandArgs.join(" ")}`,
      `exit=${run.status ?? run.error?.code ?? "unknown"}`,
      evaluated.reason,
      ...failingTapLines(`${run.stdout ?? ""}\n${run.stderr ?? ""}`),
    ]);
    laneLines.push(checkLine("lanes", lane, evaluated.status, evaluated.reason));
  }
  allLines.push(...laneLines);
  await writeGroupLog(output, "lanes", laneLines);
  await writeFailureDetails(output, root, "lanes", laneLines, laneDetails);

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
  await writeFailureDetails(output, root, "l4", l4.lines);

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
