import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const ANSI_RE = /\x1b\[[0-9;]*m/gu;
const TOKEN_RE = /[A-Za-z0-9_-]{35,}/gu;
const HEX_RE = /\b[0-9a-fA-F]{24,}\b/gu;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const URL_QUERY_RE = /(\bhttps?:\/\/[^\s?]+)\?[^\s#]*/giu;
const SUPPORT_RE = /\bsupport\s+--explain\s+([A-Z][A-Z0-9_]{1,63})\b/u;
const FACT_RE = /^fb:([a-z0-9_]{1,40})=([A-Za-z0-9_.:+-]{0,64})$/u;
const RUN_ID_RE = /^[a-z0-9TZ-]{1,160}$/u;
const DECISION_RE = /^[0-9a-f]{6}$/u;
const LINE_CAP = 64 * 1024;
const STANDARD_ENV = [
  "PATH", "PATHEXT", "SystemRoot", "windir", "ComSpec", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "USERNAME", "USERDOMAIN", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "ALLUSERSPROFILE", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS",
];
const KEY_STEPS = new Set(["health-key", "verify", "update", "deploy-recover"]);
const PREFLIGHT_STEPS = new Set(["kit-install", "update", "deploy-recover"]);
const SCRIPT_STEPS = new Set([
  "drive-state", "manifest-edit", "kit-fetch", "google-lease", "google-scopes",
  "google-backup", "google-restore", "google-discard",
]);
const VARIANTS = Object.freeze({
  "drive-state": ["load-yes", "load-no"],
  "manifest-edit": ["copy", "ocr-off"],
  "google-scopes": ["pre", "post"],
});
const FORBIDDEN_ARG_RE = /^(?:--force|upgrade|rollback|forget|drain|reindex|secrets|token)$/iu;
const injectedRenameFailures = new Set();

function utc() {
  return new Date().toISOString();
}

function refuse(reason) {
  const error = new Error(reason);
  error.refusal = reason;
  throw error;
}

function readText(path, limit = 1024 * 1024) {
  const size = statSync(path).size;
  if (size > limit) refuse("bad-args");
  return readFileSync(path, "utf8");
}

function readJson(path, limit) {
  return JSON.parse(readText(path, limit));
}

function atomicWrite(path, contents, mode = 0o600) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, contents, { encoding: "utf8", mode });
  if (
    process.env.FB_TEST_FAIL_HEARTBEAT_RENAME === "1"
    && basename(path) === "alive.txt"
    && existsSync(path)
    && !injectedRenameFailures.has(path)
  ) {
    injectedRenameFailures.add(path);
    const error = new Error("injected heartbeat rename failure");
    error.code = "FB_TEST_HEARTBEAT_RENAME";
    throw error;
  }
  renameSync(temp, path);
}

function appendTrace(session, line) {
  if (!isTestSeam(session)) return;
  const path = join(session, "fb-test-trace.log");
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, `${line}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
}

function isTestSeam(session) {
  return process.env.FB_WINDOW_TEST === "1" && existsSync(join(session, "fb-test-seam.marker"));
}

function selectedPath(session, prefix) {
  const matches = readdirSync(session).filter((name) => name.startsWith(prefix) && name.endsWith(".txt"));
  if (matches.length !== 1) refuse("bad-args");
  const value = readText(join(session, matches[0]), 64 * 1024).trim();
  if (!value) refuse("bad-args");
  return resolve(value);
}

function sessionInputs(session) {
  if (!isAbsolute(session) || !existsSync(session) || !statSync(session).isDirectory()) refuse("bad-args");
  const prefix = selectedPath(session, "selected-prefix-");
  const manifest = selectedPath(session, "selected-manifest-");
  const cli = join(prefix, "node_modules", "brain-installer", "brain.mjs");
  const factsPath = join(session, "facts.json");
  const phrasesPath = join(session, "phrases.json");
  if (!existsSync(manifest) || !existsSync(cli) || !existsSync(factsPath) || !existsSync(phrasesPath)) refuse("bad-args");
  const facts = readJson(factsPath, 1024 * 1024);
  const run = join(session, "run");
  mkdirSync(run, { recursive: true });
  return { session, prefix, manifest, cli, facts, phrasesPath, run };
}

function registry(inputs, desktop = null) {
  const npmEntry = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const backup = join(inputs.run, "backup");
  const kit = join(inputs.run, "kit");
  const entries = {
    "node-version": { argv: ["--version"], timeout: 30 },
    "cli-version": { argv: [inputs.cli, "--version"], timeout: 60 },
    health: { argv: [inputs.cli, "health", inputs.manifest], timeout: 300 },
    "health-key": { argv: [inputs.cli, "health", inputs.manifest], timeout: 300 },
    verify: { argv: [inputs.cli, "verify", inputs.manifest], timeout: 300 },
    "drive-state": {
      argv: [join(inputs.session, "fb-drive-state.mjs"), "--manifest", inputs.manifest],
      timeout: 120,
      variants: {
        "load-yes": ["--load-running", "yes"],
        "load-no": ["--load-running", "no"],
      },
    },
    "manifest-edit": {
      argv: [
        join(inputs.session, "fb-manifest-edit.mjs"), "--manifest", inputs.manifest,
        "--backup-dir", backup, "--desktop", desktop,
      ],
      timeout: 60,
      variants: { copy: [], "ocr-off": ["--ocr-off", "--cap", "10"] },
    },
    "kit-fetch": {
      argv: [
        join(inputs.session, "fb-kit.mjs"), "fetch", "--url", String(inputs.facts.kit_url || ""),
        "--sha256", String(inputs.facts.kit_sha256 || ""), "--bytes", String(inputs.facts.kit_bytes || ""),
        "--out", kit,
      ],
      timeout: 900,
    },
    "kit-install": {
      argv: [
        npmEntry, "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund",
        "--prefix", inputs.prefix, join(kit, "brain-installer.tgz"),
      ],
      timeout: 900,
    },
    "update-preview": {
      argv: [
        inputs.cli, "update", inputs.manifest, "--preview", "--json",
        "--expect-runtime-sha256", String(inputs.facts.runtime_payload_sha256 || ""),
      ],
      timeout: 300,
    },
    update: { argv: [inputs.cli, "update", inputs.manifest], timeout: null },
    "deploy-recover": { argv: [inputs.cli, "deploy", inputs.manifest], timeout: 900 },
    "google-lease": { argv: [join(inputs.session, "fb-google.mjs"), "lease"], timeout: 30 },
    "google-scopes": {
      argv: [join(inputs.session, "fb-google.mjs"), "scopes", "--prefix", inputs.prefix],
      timeout: 120,
      variants: { pre: ["--phase", "pre"], post: ["--phase", "post"] },
    },
    "google-backup": { argv: [join(inputs.session, "fb-google.mjs"), "backup"], timeout: 30 },
    "google-restore": { argv: [join(inputs.session, "fb-google.mjs"), "restore", "--prefix", inputs.prefix], timeout: 120 },
    "google-discard": { argv: [join(inputs.session, "fb-google.mjs"), "discard"], timeout: 30 },
    "google-calendar-check": {
      argv: [inputs.cli, "ingest", inputs.manifest, "--from", "calendar", "--dry-run"],
      timeout: 600,
      logPolicy: "classify-only",
    },
    "google-connect": {
      argv: [inputs.cli, "connect", "google", "--scopes", "drive,gmail,calendar"],
      timeout: 420,
    },
  };
  for (const [step, entry] of Object.entries(entries)) {
    entry.key = KEY_STEPS.has(step);
    entry.scriptStep = SCRIPT_STEPS.has(step);
    entry.logPolicy ||= "full";
  }
  return entries;
}

function readDesktop(inputs, required) {
  if (!required) return null;
  const path = join(inputs.run, "desktop-dir.txt");
  if (!existsSync(path)) refuse("bad-args");
  const desktop = readText(path, 64 * 1024).trim();
  if (!desktop || !isAbsolute(desktop) || !existsSync(desktop) || !statSync(desktop).isDirectory()) refuse("bad-args");
  return desktop;
}

function parseStart(argv) {
  if (argv.length < 2) refuse("bad-args");
  const step = argv[0];
  let session = null;
  let variant = null;
  let attempt = 1;
  let decisionId = null;
  const seenFlags = new Set();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--session", "--variant", "--attempt", "--decision-id"].includes(flag)) refuse("bad-args");
    if (seenFlags.has(flag)) refuse("bad-args");
    seenFlags.add(flag);
    if (flag === "--session" && session === null) session = resolve(value);
    else if (flag === "--variant" && variant === null) variant = value;
    else if (flag === "--attempt" && /^[1-9][0-9]*$/u.test(value)) attempt = Number(value);
    else if (flag === "--decision-id" && decisionId === null && DECISION_RE.test(value)) decisionId = value;
    else refuse("bad-args");
  }
  if (!session || !Number.isSafeInteger(attempt)) refuse("bad-args");
  return { step, session, variant, attempt, decisionId };
}

function assertDecision(inputs, decisionId) {
  if (!decisionId) refuse("bad-args");
  const path = join(inputs.run, "decision.txt");
  if (!existsSync(path)) refuse("bad-args");
  if (readText(path, 4096).trim() !== `deploy-recover id=${decisionId}`) refuse("bad-args");
}

function assertHealthKey(inputs) {
  const manifest = readJson(inputs.manifest, 1024 * 1024);
  if (manifest?.brain?.domain) refuse("bad-args");
}

function assertKitForInstall(inputs) {
  const path = join(inputs.run, "kit", "brain-installer.tgz");
  const expectedBytes = Number(inputs.facts.kit_bytes);
  const expectedSha = String(inputs.facts.kit_sha256 || "");
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || !/^[a-f0-9]{64}$/u.test(expectedSha)) refuse("bad-args");
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size !== expectedBytes) refuse("bad-args");
  const actualSha = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actualSha !== expectedSha) refuse("bad-args");
}

function buildPlan(parsed) {
  const inputs = sessionInputs(parsed.session);
  const desktop = readDesktop(inputs, parsed.step === "manifest-edit");
  const entries = registry(inputs, desktop);
  const entry = entries[parsed.step];
  if (!entry) refuse("bad-args");
  const allowedVariants = VARIANTS[parsed.step] || null;
  if ((allowedVariants && !allowedVariants.includes(parsed.variant)) || (!allowedVariants && parsed.variant !== null)) refuse("bad-args");
  if (parsed.step === "deploy-recover") assertDecision(inputs, parsed.decisionId);
  else if (parsed.decisionId !== null) refuse("bad-args");
  if (parsed.step === "health-key") assertHealthKey(inputs);
  if (parsed.step === "kit-install") assertKitForInstall(inputs);
  if (entry.key && !process.env.CLOUDFLARE_API_TOKEN) refuse("bad-args");
  const variantArgv = entry.variants ? entry.variants[parsed.variant] : [];
  let command = process.execPath;
  let argv = [...entry.argv, ...variantArgv];
  const test = isTestSeam(inputs.session);
  if (!test && Object.keys(process.env).some((name) => name.startsWith("FB_TEST_"))) refuse("bad-args");
  if (test && existsSync(join(inputs.session, "fb-test-step.json"))) {
    const override = readJson(join(inputs.session, "fb-test-step.json"), 1024 * 1024);
    if (override.command !== process.execPath || !Array.isArray(override.args) || override.args.some((item) => typeof item !== "string")) refuse("bad-args");
    command = override.command;
    argv = [...override.args];
  }
  if (argv.some((value) => FORBIDDEN_ARG_RE.test(value))) refuse("bad-args");
  return {
    step: parsed.step,
    session: inputs.session,
    runRoot: inputs.run,
    phrasesPath: inputs.phrasesPath,
    attempt: parsed.attempt,
    timeoutSeconds: entry.timeout,
    key: entry.key,
    scriptStep: entry.scriptStep,
    logPolicy: entry.logPolicy,
    command,
    argv,
    test,
  };
}

function buildStepEnvironment(keyAllowed, source, test) {
  const env = {};
  for (const name of STANDARD_ENV) {
    if (source[name] !== undefined) env[name] = String(source[name]);
  }
  env.BRAIN_NO_WRANGLER_LOGIN = "1";
  if (keyAllowed && source.CLOUDFLARE_API_TOKEN) env.CLOUDFLARE_API_TOKEN = String(source.CLOUDFLARE_API_TOKEN);
  if (test) {
    if (source.HOME) env.HOME = String(source.HOME);
    if (source.TMPDIR) env.TMPDIR = String(source.TMPDIR);
  }
  return env;
}

function childEnvironment(plan, planPath) {
  const env = buildStepEnvironment(plan.key, process.env, plan.test);
  env.FB_RUN_PLAN = planPath;
  if (plan.test) {
    env.FB_WINDOW_TEST = "1";
    for (const name of [
      "FB_TEST_HANDSHAKE_DELAY_MS", "FB_TEST_HEARTBEAT_MS",
      "FB_TEST_FAIL_HEARTBEAT_RENAME", "FB_TEST_PREFLIGHT_DELAY_MS",
      "FB_TEST_STALE_MS", "FB_TEST_START_POLL_MS",
    ]) {
      if (process.env[name]) env[name] = process.env[name];
    }
  }
  return env;
}

function runId(step) {
  const stamp = utc().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return `${step}-${stamp}-${process.pid}`;
}

function testMilliseconds(plan, name, fallback) {
  if (!plan.test || process.env[name] === undefined) return fallback;
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= 0 && value <= 120_000 ? value : fallback;
}

function startDeadlineMilliseconds(plan) {
  const normalDeadlineMs = PREFLIGHT_STEPS.has(plan.step) ? 60_000 : 5000;
  return testMilliseconds(plan, "FB_TEST_START_DEADLINE_MS", normalDeadlineMs);
}

async function testPause(plan, name) {
  const delay = testMilliseconds(plan, name, 0);
  if (delay > 0) {
    appendTrace(plan.session, `test-pause-start ${name} ms=${delay}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, delay));
    appendTrace(plan.session, `test-pause-done ${name} ms=${delay}`);
  }
}

async function startCommand(argv) {
  let plan;
  try {
    plan = buildPlan(parseStart(argv));
  } catch (error) {
    console.log(`REFUSED ${error.refusal || "bad-args"}`);
    process.exitCode = 3;
    return;
  }
  const id = runId(plan.step);
  const folder = join(plan.runRoot, "steps", id);
  mkdirSync(folder, { recursive: true });
  const planPath = join(folder, `.step-${process.pid}.json`);
  writeFileSync(planPath, `${JSON.stringify({ ...plan, runid: id, folder, started: utc() })}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(planPath, 0o600);
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), "__child", id], {
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: "ignore",
      env: childEnvironment(plan, planPath),
    });
    appendTrace(plan.session, `start-child pid=${child.pid}`);
    child.unref();
  } catch {
    rmSync(planPath, { force: true });
    console.log("REFUSED spawn");
    process.exitCode = 3;
    return;
  }
  const pollMs = plan.test ? Number(process.env.FB_TEST_START_POLL_MS || 10) : 50;
  const deadline = Date.now() + startDeadlineMilliseconds(plan);
  while (Date.now() < deadline) {
    const refusalPath = join(folder, "refusal.txt");
    if (existsSync(refusalPath)) {
      const reason = readText(refusalPath, 4096).trim();
      console.log(`REFUSED ${reason}`);
      process.exitCode = 3;
      return;
    }
    if (existsSync(join(folder, "meta.txt"))) {
      console.log(`RUN ${plan.step} ${id}`);
      if (plan.test && Number(process.env.FB_TEST_START_HOLD_MS || 0) > 0) {
        await new Promise((resolveWait) => setTimeout(resolveWait, Number(process.env.FB_TEST_START_HOLD_MS)));
      }
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
  appendTrace(plan.session, `handshake-timeout pid=${child.pid}`);
  killTree(child);
  const stopped = await waitForChildExit(child, plan.test ? 2000 : 5000);
  if (!stopped) {
    atomicWrite(join(folder, "meta.txt"), [
      `step=${plan.step}`,
      `attempt=${plan.attempt}`,
      `started=${plan.started}`,
      `child_pid=${child.pid}`,
      `child_start=${plan.started}`,
      "",
    ].join("\n"));
    console.log(`RUN ${plan.step} ${id}`);
    return;
  }
  rmSync(planPath, { force: true });
  console.log("REFUSED spawn");
  process.exitCode = 3;
}

function processFixture(plan) {
  const path = join(plan.session, "fb-test-processes.json");
  const list = readJson(path, 1024 * 1024);
  return list.map((item) => ({
    ...item,
    pid: item.pid === "self" ? process.pid : Number(item.pid),
    parentPid: item.parentPid === "self" ? process.pid : Number(item.parentPid || 0),
    start: item.pid === "self" ? String(item.start || "self-start") : String(item.start || ""),
  }));
}

function windowsProcesses() {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$items=Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
    "$items|ForEach-Object{[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;start=$_.CreationDate.ToUniversalTime().ToString('o');commandLine=[string]$_.CommandLine}}|ConvertTo-Json -Compress",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: buildStepEnvironment(false, process.env, false),
  });
  if (result.status !== 0) refuse("spawn");
  const parsed = JSON.parse(result.stdout || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

function getProcesses(plan) {
  appendTrace(plan.session, "cim-call");
  if (plan.test) return processFixture(plan);
  if (process.platform !== "win32") return [{ pid: process.pid, parentPid: process.ppid, start: utc(), commandLine: "supervisor", name: "node" }];
  return windowsProcesses();
}

function descendantsOfSelf(processes) {
  const excluded = new Set([process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (excluded.has(Number(item.parentPid)) && !excluded.has(Number(item.pid))) {
        excluded.add(Number(item.pid));
        changed = true;
      }
    }
  }
  return excluded;
}

function parseLock(path) {
  if (!existsSync(path)) return null;
  const values = {};
  for (const line of readText(path, 4096).split(/\r?\n/u)) {
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}

function preflightUpdate(plan) {
  const processes = getProcesses(plan);
  const self = processes.find((item) => Number(item.pid) === process.pid);
  const childStart = String(self?.start || utc());
  const lockPath = join(plan.runRoot, "update.lock");
  const lock = parseLock(lockPath);
  if (lock) {
    const locked = processes.find((item) => Number(item.pid) === Number(lock.pid));
    if (locked && String(locked.start) === String(lock.start)) {
      return { refusal: `update-running ${lock.runid || "unknown"}`, childStart };
    }
  }
  const excluded = descendantsOfSelf(processes);
  for (const item of processes) {
    if (excluded.has(Number(item.pid))) continue;
    const command = String(item.commandLine || "");
    if (/brain\.mjs"?\s+(update|upgrade|deploy)(?:\s|$)/iu.test(command)) {
      return { refusal: "update-running unknown", childStart };
    }
    if (/brain\.mjs"?\s+(load|ingest)(?:\s|$)/iu.test(command)) {
      return { refusal: "load-running", childStart };
    }
  }
  atomicWrite(lockPath, `pid=${process.pid}\nstart=${childStart}\nrunid=${plan.runid}\n`);
  return { refusal: null, childStart };
}

function preflightKitInstall(plan) {
  const processes = getProcesses(plan);
  const excluded = descendantsOfSelf(processes);
  for (const item of processes) {
    if (excluded.has(Number(item.pid))) continue;
    if (/brain\.mjs"?\s+(load|ingest)(?:\s|$)/iu.test(String(item.commandLine || ""))) return "load-running";
  }
  return null;
}

function removeOwnLock(plan) {
  const path = join(plan.runRoot, "update.lock");
  const lock = parseLock(path);
  if (lock?.runid === plan.runid && Number(lock.pid) === process.pid) unlinkSync(path);
}

function stripAnsi(value) {
  return String(value).replace(ANSI_RE, "");
}

function redactLine(value, exactKey) {
  let output = String(value);
  // MUTANT_M1_EXACT_KEY
  if (exactKey) output = output.split(exactKey).join("[R]");
  output = output.replace(TOKEN_RE, (match) => (
    /[A-Z]/u.test(match) && /[a-z]/u.test(match) && /[0-9]/u.test(match) ? "[R]" : match
  ));
  output = output.replace(HEX_RE, "[R]");
  output = output.replace(EMAIL_RE, "[R]");
  output = output.replace(URL_QUERY_RE, "$1?[R]");
  return output;
}

function entryMatches(entry, line) {
  if (entry.match && !line.includes(entry.match)) return false;
  if (entry.suffix_regex) {
    const after = line.slice(line.indexOf(entry.match) + entry.match.length);
    return new RegExp(entry.suffix_regex, "u").test(after);
  }
  return Boolean(entry.match);
}

class Classifier {
  constructor(step, table, eventWriter, key, scriptStep) {
    this.step = step;
    this.entries = (table.entries || []).filter((entry) => entry.steps?.includes(step));
    this.eventWriter = eventWriter;
    this.key = key;
    this.scriptStep = scriptStep;
    this.lastStage = 0;
    this.classes = [];
    this.seenClasses = new Set();
    this.allOf = new Map();
    this.anomalies = new Set();
  }

  emit(kind, value, extra = "") {
    const line = `${utc()} ${kind} ${value}${extra ? ` ${extra}` : ""}`;
    this.eventWriter(`${redactLine(line, this.key)}\n`);
  }

  anomaly(value) {
    if (this.anomalies.has(value)) return;
    this.anomalies.add(value);
    this.emit("anomaly", value);
  }

  inspectSecrets(line) {
    if (this.key && line.includes(this.key)) this.anomaly("key-echo");
    if (this.key && new RegExp(HEX_RE.source, "u").test(line)) this.anomaly("hex-echo");
  }

  addClass(entry) {
    if (this.seenClasses.has(entry.id)) return;
    this.seenClasses.add(entry.id);
    this.classes.push(entry);
    this.emit("class", entry.value);
  }

  observe(line) {
    this.inspectSecrets(line);
    if (line.includes("(y/n)")) this.anomaly("yn-prompt");
    const support = line.match(SUPPORT_RE);
    if (support) this.emit("support-code", support[1]);
    if (line.startsWith("fb:")) {
      const fact = line.match(FACT_RE);
      if (this.scriptStep && fact) this.emit("fact", `${fact[1]}=${fact[2]}`);
      else this.anomaly("bad-fact");
    }

    let matchedPhrase = false;
    const stages = [];
    for (const entry of this.entries) {
      if (entry.all_of) {
        const seen = this.allOf.get(entry.id) || new Set();
        entry.all_of.forEach((part, index) => {
          if (entryMatches(part, line)) {
            seen.add(index);
            matchedPhrase = true;
          }
        });
        this.allOf.set(entry.id, seen);
        if (seen.size === entry.all_of.length && entry.kind === "class") this.addClass(entry);
        continue;
      }
      if (!entryMatches(entry, line)) continue;
      matchedPhrase = true;
      if (entry.capture) {
        const captured = line.match(new RegExp(entry.capture, "u"));
        if (captured?.[1]) this.emit("metric", `${entry.value === "health-pending" ? "pending" : entry.value}=${captured[1].replaceAll(",", "")}`);
      }
      if (entry.kind === "stage") {
        // MUTANT_M8_AFTER
        if (Number(entry.n) > this.lastStage && (entry.after === undefined || this.lastStage >= Number(entry.after))) stages.push(entry);
      } else if (entry.kind === "class") {
        this.addClass(entry);
      }
    }
    if (stages.length) {
      stages.sort((left, right) => Number(left.n) - Number(right.n));
      const selected = stages[0];
      this.lastStage = Number(selected.n);
      this.emit("stage", selected.value, `n=${selected.n}`);
    }
    return matchedPhrase;
  }

  outcome(code) {
    if (code === 0) {
      const success = this.classes.filter((entry) => entry.outcome === "success")
        .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0))[0];
      if (success) return success.value;
    }
    const failure = this.classes.filter((entry) => entry.outcome === "failure")
      .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0))[0];
    return failure?.value || "other";
  }
}

class LineSink {
  constructor({ writeLine, inspect, overlap }) {
    this.writeLine = writeLine;
    this.inspect = inspect;
    this.overlap = overlap;
    this.pending = "";
    this.long = false;
    this.head = "";
    this.rolling = "";
  }

  push(value) {
    let rest = String(value);
    while (rest.length) {
      const newline = rest.indexOf("\n");
      const part = newline >= 0 ? rest.slice(0, newline) : rest;
      this.addPart(part);
      if (newline < 0) return;
      this.finishLine();
      rest = rest.slice(newline + 1);
    }
  }

  addPart(part) {
    if (!this.long) {
      this.pending += part;
      if (this.pending.length > LINE_CAP) {
        this.long = true;
        this.head = this.pending.slice(0, LINE_CAP);
        this.inspect(this.pending);
        this.rolling = this.pending.slice(-this.overlap);
        this.pending = "";
      }
      return;
    }
    const sample = this.rolling + part;
    this.inspect(sample);
    this.rolling = sample.slice(-this.overlap);
  }

  finishLine() {
    if (this.long) {
      this.writeLine(`${this.head} [line-cut]`, true);
    } else {
      this.writeLine(this.pending, false);
    }
    this.pending = "";
    this.long = false;
    this.head = "";
    this.rolling = "";
  }

  end(value = "") {
    if (value) this.push(value);
    if (this.long || this.pending) this.finishLine();
  }
}

function endStream(stream) {
  return new Promise((resolveEnd) => {
    stream.once("error", resolveEnd);
    stream.end(resolveEnd);
  });
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
      env: buildStepEnvironment(false, process.env, false),
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
}

async function waitForChildExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    try {
      process.kill(child.pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return false;
}

async function childCommand(runid) {
  const planPath = process.env.FB_RUN_PLAN;
  if (!planPath || !existsSync(planPath)) process.exit(3);
  const plan = readJson(planPath, 1024 * 1024);
  unlinkSync(planPath);
  if (plan.runid !== runid || !RUN_ID_RE.test(runid)) process.exit(3);

  await testPause(plan, "FB_TEST_HANDSHAKE_DELAY_MS");
  if (PREFLIGHT_STEPS.has(plan.step)) await testPause(plan, "FB_TEST_PREFLIGHT_DELAY_MS");

  let childStart = utc();
  if (["update", "deploy-recover"].includes(plan.step)) {
    let checked;
    try {
      checked = preflightUpdate(plan);
    } catch {
      atomicWrite(join(plan.folder, "refusal.txt"), "spawn\n");
      process.exit(3);
    }
    childStart = checked.childStart;
    if (checked.refusal) {
      atomicWrite(join(plan.folder, "refusal.txt"), `${checked.refusal}\n`);
      process.exit(3);
    }
  }
  if (plan.step === "kit-install") {
    let refusal;
    try {
      refusal = preflightKitInstall(plan);
    } catch {
      refusal = "spawn";
    }
    if (refusal) {
      atomicWrite(join(plan.folder, "refusal.txt"), `${refusal}\n`);
      process.exit(3);
    }
  }

  atomicWrite(join(plan.folder, "meta.txt"), [
    `step=${plan.step}`,
    `attempt=${plan.attempt}`,
    `started=${plan.started}`,
    `child_pid=${process.pid}`,
    `child_start=${childStart}`,
    "",
  ].join("\n"));

  const output = createWriteStream(join(plan.folder, "out.log"), { flags: "a", encoding: "utf8", mode: 0o600 });
  const events = createWriteStream(join(plan.folder, "events.txt"), { flags: "a", encoding: "utf8", mode: 0o600 });
  output.on("error", () => {});
  events.on("error", () => {});
  const exactKey = plan.key ? String(process.env.CLOUDFLARE_API_TOKEN || "") : "";
  const table = readJson(plan.phrasesPath, 1024 * 1024);
  const classifier = new Classifier(plan.step, table, (line) => events.write(line), exactKey, plan.scriptStep);
  let dropped = 0;
  const writeLine = (rawLine, overlong) => {
    const clean = stripAnsi(rawLine.replace(/\r$/u, ""));
    const matched = classifier.observe(clean);
    if (plan.logPolicy === "classify-only" && !matched) {
      dropped += 1;
      return;
    }
    // MUTANT_M5_BEFORE_DISK
    const diskLine = redactLine(clean, exactKey);
    output.write(`${diskLine}${overlong ? "" : ""}\n`);
  };
  const overlap = Math.max(4096, exactKey.length + 8);
  const stdoutSink = new LineSink({ writeLine, inspect: (line) => classifier.inspectSecrets(line), overlap });
  const stderrSink = new LineSink({ writeLine, inspect: (line) => classifier.inspectSecrets(line), overlap });
  const stdoutDecoder = new TextDecoder("utf-8");
  const stderrDecoder = new TextDecoder("utf-8");
  const stepEnv = buildStepEnvironment(plan.key, process.env, plan.test);
  appendTrace(plan.session, "step-spawn");
  let child;
  try {
    child = spawn(plan.command, plan.argv, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: stepEnv,
      detached: false,
    });
  } catch {
    child = null;
  }
  if (child) {
    try {
      atomicWrite(join(plan.folder, "meta.txt"), [
        `step=${plan.step}`,
        `attempt=${plan.attempt}`,
        `started=${plan.started}`,
        `child_pid=${process.pid}`,
        `child_start=${childStart}`,
        `step_pid=${child.pid}`,
        "",
      ].join("\n"));
    } catch {}
  }

  let code = 1;
  if (child) {
    child.stdout.on("error", () => {
      try { appendTrace(plan.session, "stdout-read-failed"); } catch {}
    });
    child.stderr.on("error", () => {
      try { appendTrace(plan.session, "stderr-read-failed"); } catch {}
    });
    child.stdout.on("data", (chunk) => stdoutSink.push(stdoutDecoder.decode(chunk, { stream: true })));
    child.stderr.on("data", (chunk) => stderrSink.push(stderrDecoder.decode(chunk, { stream: true })));
    const heartbeatMs = plan.test ? Number(process.env.FB_TEST_HEARTBEAT_MS || 40) : 10_000;
    const writeHeartbeat = () => {
      try {
        atomicWrite(join(plan.folder, "alive.txt"), `${utc()}\n`);
      } catch (error) {
        try {
          if (error?.code === "FB_TEST_HEARTBEAT_RENAME") appendTrace(plan.session, "injected-heartbeat-rename-failure");
          appendTrace(plan.session, "heartbeat-write-failed");
        } catch {}
      }
    };
    const heartbeat = setInterval(writeHeartbeat, heartbeatMs);
    writeHeartbeat();
    let timer = null;
    if (plan.timeoutSeconds !== null) {
      timer = setTimeout(() => killTree(child), Number(plan.timeoutSeconds) * 1000);
    }
    const [exitCode] = await once(child, "close");
    if (timer) clearTimeout(timer);
    clearInterval(heartbeat);
    code = Number.isInteger(exitCode) ? exitCode : 1;
  }
  stdoutSink.end(stdoutDecoder.decode());
  stderrSink.end(stderrDecoder.decode());
  if (plan.logPolicy === "classify-only") output.write(`dropped-lines=${dropped}\n`);

  await endStream(output);
  appendTrace(plan.session, "close out.log");
  await endStream(events);
  appendTrace(plan.session, "close events.txt");
  if (["update", "deploy-recover"].includes(plan.step)) removeOwnLock(plan);
  const outcome = classifier.outcome(code);
  const exitPath = join(plan.folder, "exit.txt");
  const tempExit = `${exitPath}.tmp-${process.pid}`;
  writeFileSync(tempExit, `EXIT ${code} ${outcome} ${utc()}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempExit, exitPath);
  appendTrace(plan.session, "rename exit.txt");
}

function parseProbe(argv) {
  if (argv.length !== 4 || argv[0] !== "--session" || argv[2] !== "--run") refuse("bad-args");
  const session = resolve(argv[1]);
  const runid = argv[3];
  if (!isAbsolute(session) || !RUN_ID_RE.test(runid)) refuse("bad-args");
  return { session, runid };
}

function probeCommand(argv) {
  let parsed;
  try {
    parsed = parseProbe(argv);
  } catch {
    console.log("DEAD");
    process.exitCode = 3;
    return;
  }
  const folder = join(parsed.session, "run", "steps", parsed.runid);
  const exitPath = join(folder, "exit.txt");
  if (existsSync(exitPath)) {
    const match = readText(exitPath, 4096).match(/^EXIT\s+(-?\d+)\s+(\S+)/u);
    if (match) {
      console.log(`EXITED ${match[1]} ${match[2]}`);
      return;
    }
  }
  const metaPath = join(folder, "meta.txt");
  const alivePath = join(folder, "alive.txt");
  if (!existsSync(metaPath) || !existsSync(alivePath)) {
    console.log("DEAD");
    return;
  }
  const staleMs = isTestSeam(parsed.session) ? Number(process.env.FB_TEST_STALE_MS || 180) : 60_000;
  const age = Date.now() - Date.parse(readText(alivePath, 4096).trim());
  console.log(Number.isFinite(age) && age <= staleMs ? "RUNNING" : "DEAD");
}

function parseRunTarget(argv) {
  if (argv.length !== 4 || argv[0] !== "--session" || argv[2] !== "--run") refuse("bad-args");
  const session = resolve(argv[1]);
  const runid = argv[3];
  if (!isAbsolute(session) || !RUN_ID_RE.test(runid)) refuse("bad-args");
  return { session, runid, folder: join(session, "run", "steps", runid) };
}

async function cancelCommand(argv) {
  let target;
  try {
    target = parseRunTarget(argv);
  } catch (error) {
    console.log(`REFUSED ${error.refusal || "bad-args"}`);
    process.exitCode = 3;
    return;
  }
  const exitPath = join(target.folder, "exit.txt");
  if (existsSync(exitPath)) {
    console.log(`CANCELLED ${target.runid}`);
    return;
  }
  const metaPath = join(target.folder, "meta.txt");
  if (!existsSync(metaPath)) {
    console.log("REFUSED not-running");
    process.exitCode = 3;
    return;
  }
  const meta = parseLock(metaPath);
  const pids = [Number(meta?.child_pid), Number(meta?.step_pid)].filter((pid) => Number.isSafeInteger(pid) && pid >= 2);
  if (!pids.length) {
    console.log("REFUSED not-running");
    process.exitCode = 3;
    return;
  }
  for (const pid of [...pids].reverse()) killTree({ pid });
  const deadline = Date.now() + 30_000;
  let exited = false;
  while (Date.now() < deadline) {
    const alive = pids.some((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (!alive) { exited = true; break; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (!exited) {
    console.log("REFUSED still-running");
    process.exitCode = 3;
    return;
  }
  if (!existsSync(exitPath)) atomicWrite(exitPath, `EXIT 1 cancelled ${utc()}\n`);
  console.log(`CANCELLED ${target.runid}`);
}

export function registrySnapshotForTest({ session }) {
  const inputs = sessionInputs(resolve(session));
  const desktop = readDesktop(inputs, true);
  const entries = registry(inputs, desktop);
  const snapshot = {};
  for (const [step, entry] of Object.entries(entries)) {
    if (entry.variants) {
      snapshot[step] = { argv: [...entry.argv], variants: {} };
      for (const [variant, suffix] of Object.entries(entry.variants)) {
        snapshot[step].variants[variant] = [...entry.argv, ...suffix];
      }
    } else {
      snapshot[step] = { argv: [...entry.argv] };
    }
  }
  return snapshot;
}

export function redactForTest(value, exactKey = "") {
  return redactLine(value, exactKey);
}

export function startDeadlineForTest(step) {
  return startDeadlineMilliseconds({ step, test: false });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "start") await startCommand(args);
  else if (command === "__child" && args.length === 1) await childCommand(args[0]);
  else if (command === "probe") probeCommand(args);
  else if (command === "cancel") await cancelCommand(args);
  else {
    console.log("REFUSED bad-args");
    process.exitCode = 3;
  }
}
