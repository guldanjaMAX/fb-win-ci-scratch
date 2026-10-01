import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { armMap } from "./reference/arms.mjs";
import { canonical } from "./reference/oracle.mjs";
import { freshKey, installStub, makeFakeNode, makeRealNode, makeSession, scenarioForSessionHelpers, scenarioForSupervisorArgv, splitCanaries } from "./fixtures.mjs";
import { silentExpectedStubCalls } from "./real-session-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const served = [
  "fb-win.mjs", "finish-window.txt", "fb-run.mjs", "fb-drive-state.mjs",
  "fb-manifest-edit.mjs", "fb-kit.mjs", "fb-google.mjs", "phrases.json", "facts.json",
];
const stubOutputSteps = new Set([
  "cli-version", "health", "health-key", "verify", "kit-install", "update-preview", "update",
  "deploy-recover", "google-lease", "google-scopes", "google-backup", "google-restore",
  "google-discard", "google-calendar-check", "google-connect",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--arm", "--runner-dir", "--session-root", "--expected-window-sha256"].includes(flag) || !value) throw new Error("bad arguments");
    out[flag.slice(2).replaceAll(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!out.arm || !out.runnerDir || !out.sessionRoot || !out.expectedWindowSha256) throw new Error("missing arguments");
  return out;
}

const raw = (label, lines, extra = {}) => ({ label, raw: Array.isArray(lines) ? lines : [lines], ...extra });
const facts = (label, values, extra = {}) => raw(label, Object.entries(values).map(([key, value]) => `fb:${key}=${value}`), extra);
const version = () => raw("cli-version", "0.4.9");
const nodeVersion = () => raw("node-version", "v24.0.0");
const drive = (values = {}) => facts("drive-state", { domain: "yes", drive_state: "done", terminal: "yes", review: "no", ...values });
const ready = (label = "health") => raw(label, "vector index is query-ready (0 confirmed vector(s))");
const pending = (label = "health", count = 121) => raw(label, `${count} vector operation(s) are not query-visible yet` , { exit: 1 });
const keyOk = () => raw("verify", "Cloudflare access confirmed for account fixture");
const keyBad = () => raw("verify", "Cloudflare refused the credential: fixture", { exit: 1 });
const sac = (label) => raw(label, "Windows refused to run the temporary DPAPI helper", { exit: 1 });
const edit = (label = "manifest-edit") => facts(label, { result: "pass", changed: "no", backup: "yes", desktop_copy: "yes" });
const fetchOk = (extra = {}) => facts("kit-fetch", { reason: "ok" }, extra);
const installOk = () => raw("npm-cli.js", []);
const previewOk = () => raw("update-preview", ['{"pre_update_check_complete": true,', '"projection_ready": true,']);
const updateVerified = () => raw("update", [
  "required D1 restore bookmark captured",
  "Updating your Brain from 0.4.8 to 0.4.9. For part of this your Brain won't accept new documents; asking questions keeps working. Keep this window open.",
  'deployed "paused"',
  "/health and authenticated inventory agree on fixture/paused-for-upgrade",
  "safety pause: waiting 1 minutes for older database writers to finish",
  "schema up to date (0 migration(s) applied)",
  'deployed "active"',
  "/health and authenticated inventory agree on fixture/active",
  "vector index is query-ready (fixture; 1 newly confirmed this run)",
  "vector index is query-ready (0 confirmed vector(s))",
  "acceptance suite against fixture",
  "upgrade verified, now at 0.4.9",
  "Done. Your Brain is now on version 0.4.9 and passed its checks.",
]);
const updateCpu = () => raw("update", ["update stopped during paused vector-drain health verification", "D1 DB exceeded its CPU time limit and was reset"], { exit: 1 });
const update503 = () => raw("update", ["update stopped during vector projection convergence", "drain failed (503): fixture", "brain corpus writes are paused for a verified upgrade or rollback"], { exit: 1 });
const updateNetwork = () => raw("update", "Your internet connection dropped while talking to Cloudflare.", { exit: 1 });
const updateQueued = () => raw("update", "This Brain is still paused for an update that has not finished, and it has 1 queued search update", { exit: 1 });
const updateQueueFirst = () => raw("update", "Your Brain is still indexing 1 recent items so they can be found by meaning. Updating now would interrupt that, so nothing was changed. You can keep using your Brain. Run brain update again later.", { exit: 1 });
const updateUnknown = () => raw("update", "update stopped during unknown stage", { exit: 1 });
const updatePrompt = (hidden = false) => raw("update", hidden ? "Enter a newly created scoped API token in the hidden prompt now? (y/n)" : "Use recovery API-token access now? (y/n)", { exit: 1, readStdin: true });
const updatePendingMigration = () => raw("update", ["applying 0049_fixture", "upgrade verified, now at 0.4.9"], { exit: 0 });

function commonPrefix({ health = ready(), history = false } = {}) {
  return [nodeVersion(), version(), drive(), health, keyOk()];
}

function preUpdate() {
  return [edit(), fetchOk(), installOk(), version(), previewOk()];
}

function successTail(update = updateVerified()) {
  return [...preUpdate(), update, edit(), ready(), version()];
}

function w8Plan(id) {
  const boot = [nodeVersion(), version(), drive(), ready()];
  const lease = facts("google-lease", { lease: "free" });
  const pre = facts("google-scopes", { record: "yes", account_hash: "abc123", granted_drive: "yes", granted_gmail: "yes", granted_calendar: id === "A15-partial" ? "no" : "yes" });
  const calendarReconnect = raw("google-calendar-check", "Reconnect with `brain connect google --scopes drive,gmail,calendar`, then retry the preview.", { exit: 1 });
  const finish = [ready(), version()];
  if (id === "A15-lock") return [...boot, facts("google-lease", { lease: "busy" }), ...finish];
  if (id === "A15-none") return [...boot, lease, facts("google-scopes", { record: "none" }), ...finish];
  if (id === "A15-403") return [...boot, lease, pre, raw("google-calendar-check", "Fix the calendar errors printed above, then retry the preview.", { exit: 1 }), ...finish];
  if (id === "A11b") return [...boot, lease, pre, raw("google-calendar-check", "dry run: 0 event(s) would be sent, 0 cancellation(s) would be removed"), ...finish];
  const backup = facts("google-backup", { backup: "yes" });
  const secondLease = facts("google-lease", { lease: "free" });
  if (["A15-dead", "A15-preview", "A15-scope"].includes(id)) {
    return [...boot, lease, pre, calendarReconnect, secondLease, backup,
      raw("google-connect", "timed out waiting for the browser to complete sign-in", { exit: 1 }),
      facts("google-restore", { restore: "done" }), ...finish];
  }
  const connected = raw("google-connect", "connected. Token stored in fixture");
  if (id === "PR002") {
    return [...boot, lease, pre, calendarReconnect, secondLease, backup,
      raw("google-connect", "connected. Token stored in fixture", { delay_ms: 5000 }),
      facts("google-restore", { restore: "done" }), ...finish];
  }
  if (id === "A15-partial") {
    return [...boot, lease, pre, calendarReconnect, secondLease, backup, connected,
      facts("google-scopes", { record: "yes", granted_drive: "yes", granted_gmail: "yes", granted_calendar: "no", account: "unknown" }),
      facts("google-discard", { discard: "yes" }), ...finish];
  }
  return [...boot, lease, pre, calendarReconnect, secondLease, backup, connected,
    facts("google-scopes", { record: "yes", granted_drive: "yes", granted_gmail: "yes", granted_calendar: "yes", account: "same" }),
    facts("google-discard", { discard: "yes" }), ...finish];
}

const PUBLISHED_KIT = {
  url: "https://financialbrain.ai/kit/brain-installer-0.4.9-0555ad1972d7f8d6.tgz",
  bytes: 6668013,
  sha256: "0555ad1972d7f8d6c1ded78a9fc4265f873cc4f4ce8c11fd04198cc5599409b2",
  runtimeSha256: "462d31da0b249cfaa74bb509fa8c7fd5b6a44624597f11536a652a9d2fcd46f6",
};

function planFor(id, processesPath) {
  const plan = { tier2: true, w8: false, history: false, cloud: false, sequence: [], decisions: {}, processes: [], processes_path: processesPath };
  if (["A11", "A11-empty", "A11-probe", "A11-window", "A11b-off", "A14"].includes(id)) {
    plan.tier2 = false;
    return plan;
  }
  if (id === "A11-on") return { ...plan, sequence: commonPrefix().concat(successTail()) };
  if (id === "A11b" || id.startsWith("A15-") || id === "PR002") {
    return { ...plan, tier2: false, w8: true, sequence: w8Plan(id) };
  }
  if (id === "PR008") return { ...plan, badMachine: true, sequence: [nodeVersion(), version(), drive(), ready(), ready(), version()] };
  if (id === "A8") return { ...plan, rejoin: "verified", sequence: [nodeVersion(), version(), drive(), ready(), edit(), ready(), version()] };
  if (id === "A5") return { ...plan, rejoin: "dead", decisions: { "W7 update-retry": "stop" }, sequence: [nodeVersion(), version(), drive(), ready(), ready(), version()] };
  if (id === "PR003") return { ...plan, history: true, twoCopies: true, sequence: commonPrefix().concat(successTail()) };
  if (id === "PR006") return { ...plan, decisions: { "W1 brain-paused": "deploy-recover" }, sequence: [nodeVersion(), version(), drive(), raw("health", "this Brain is paused for an update and cannot accept documents.", { exit: 1 }), keyOk(), raw("deploy", 'deployed "recovery"'), ready(), version()] };
  if (id === "A1") return { ...plan, decisions: { "W4 queue": "finish-later" }, sequence: commonPrefix({ health: pending() }).concat([ready(), version()]) };
  if (id === "A1-wait") return { ...plan, decisions: { "W4 queue": "wait" }, sequence: commonPrefix({ health: pending() }).concat([pending(), ready(), version()]) };
  if (id === "A1b") return { ...plan, sequence: [...commonPrefix(), ...preUpdate(), updateQueueFirst(), ready(), version()] };
  if (id === "A2") return { ...plan, sequence: [...commonPrefix(), ...preUpdate(), updateCpu(), updateVerified(), edit(), ready(), version()] };
  if (id === "A2-two") return { ...plan, sequence: [...commonPrefix(), ...preUpdate(), updateCpu(), updateCpu(), ready(), version()] };
  if (id === "A3") return { ...plan, sequence: [...commonPrefix(), ...preUpdate(), update503(), updateVerified(), edit(), ready(), version()] };
  if (id === "A3-two") return { ...plan, sequence: [...commonPrefix(), ...preUpdate(), update503(), update503(), ready(), version()] };
  if (id.startsWith("A4")) return { ...plan, decisions: { "W7 update-queued": id === "A4-deploy" ? "deploy-recover" : "finish-later" }, sequence: [...commonPrefix(), ...preUpdate(), updateQueued(), ...(id === "A4-deploy" ? [raw("deploy", 'deployed "recovery"')] : []), ready(), version()] };
  if (id === "A5-exit") return { ...plan, sequence: [...commonPrefix(), ...preUpdate(), updateUnknown(), ready(), version()] };
  if (id === "A6" || id === "A6-hidden") return { ...plan, sequence: [...commonPrefix(), ...preUpdate(), updatePrompt(id.endsWith("hidden")), ready(), version()] };
  if (id === "A7") return { ...plan, decisions: { "W7 update-retry": "stop" }, sequence: [...commonPrefix(), ...preUpdate(), raw("update", ["Your internet connection dropped while talking to Cloudflare."], { exit: 1, leakParts: Object.values(splitCanaries()), leak_classes: { key: 1, hex64: 1, bookmark: 1, account: 1, email: 1 } }), ready(), version()] };
  if (id === "A9") return { ...plan, sequence: [nodeVersion(), version(), drive(), sac("health"), sac("health"), ready(), keyOk(), ...successTail()] };
  if (id === "A9-three") return { ...plan, sequence: [nodeVersion(), version(), drive(), sac("health"), sac("health"), sac("health"), keyOk(), ready(), version()] };
  if (id === "A9-write") return { ...plan, decisions: { "W7 update-retry": "stop" }, sequence: [...commonPrefix(), ...preUpdate(), updateNetwork(), ready(), version()] };
  if (id === "A10") return { ...plan, repeatClipboard: true, sequence: [nodeVersion(), version(), drive(), ready(), keyBad(), keyBad(), ready(), version()] };
  if (id === "A10-control") return { ...plan, repeatClipboard: true, sequence: [nodeVersion(), version(), drive(), ready(), keyBad(), keyOk(), edit(), fetchOk(), installOk(), version(), previewOk(), updateVerified(), edit(), ready(), version()] };
  if (id === "A10-short") return { ...plan, shortClipboard: true, sequence: [nodeVersion(), version(), drive(), ready(), ready(), version()] };
  if (id === "A17") return { ...plan, keyVisible: true, emptyClipboard: true, sequence: [nodeVersion(), version(), drive(), ready(), ready(), version()] };
  if (id === "A12-review") return { ...plan, driveReview: true, sequence: [nodeVersion(), version(), drive({ drive_state: "pending", terminal: "no", review: "yes" }), ready(), keyOk(), ...successTail()] };
  if (id === "A13") return { ...plan, sequence: [...commonPrefix(), ...preUpdate(), updatePendingMigration(), ready(), version()] };
  if (id === "A16") return { ...plan, kitShaMismatch: true, sequence: commonPrefix().concat([edit(), ready(), version()]) };
  if (id === "PR004") return { ...plan, decisions: { "W7 update-retry": "continue" }, sequence: [...commonPrefix(), ...preUpdate(), updateCpu(), update503(), updateNetwork(), updateVerified(), ready(), version()] };
  if (id === "PR005") return { ...plan, loadBeforeInstall: true, sequence: commonPrefix().concat([edit(), fetchOk(), ready(), version()]) };
  return { ...plan, sequence: commonPrefix().concat(successTail()) };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function lines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean);
}

function readCalls(path) {
  return lines(path).map((line) => JSON.parse(line));
}

function prepareRejoin(session, mode) {
  if (!mode) return;
  const runid = "update-fixture";
  const folder = join(session, "run", "steps", runid);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(session, "run", "update.lock"), `pid=8100\nstart=fixture-start\nrunid=${runid}\n`, "utf8");
  writeJson(join(session, "test-processes.json"), [{ CommandLine: "node brain.mjs update fixture", ProcessId: 8100 }]);
  writeFileSync(join(folder, "meta.txt"), "step=update\nattempt=1\nstarted=fixture\nchild_pid=8100\nchild_start=fixture-start\n", "utf8");
  if (mode === "dead") {
    writeFileSync(join(folder, "out.log"), "fixture update started\n", "utf8");
    const alive = join(folder, "alive.txt");
    writeFileSync(alive, "2026-01-01T00:00:00.000Z\n", "utf8");
    const old = new Date(Date.now() - 120_000);
    utimesSync(alive, old, old);
    return;
  }
  const events = Array.from({ length: 13 }, (_, index) => `2026-10-01T08:00:${String(index).padStart(2, "0")}Z stage fixture n=${index + 1}`);
  writeFileSync(join(folder, "events.txt"), `${events.join("\n")}\n`, "utf8");
  writeFileSync(join(folder, "out.log"), "upgrade verified, now at 0.4.9\n", "utf8");
  writeFileSync(join(folder, "exit.txt"), "EXIT 0 verified 2026-10-01T08:01:00Z\n", "utf8");
}

function stepMetaCalls(session) {
  const root = join(session, "run", "steps");
  if (!existsSync(root)) return [];
  const calls = [];
  for (const folder of readdirSync(root)) {
    const path = join(root, folder, "meta.txt");
    if (!existsSync(path)) continue;
    const step = /^step=(.+)$/mu.exec(readFileSync(path, "utf8"))?.[1];
    if (step) calls.push({ command: step === "deploy-recover" ? "deploy" : step, key_matches: ["update", "deploy-recover", "verify", "health-key"].includes(step), source: "step-meta" });
  }
  return calls;
}

function emptyExpectedStubSteps(session) {
  const root = join(session, "run", "steps");
  if (!existsSync(root)) return [];
  const empty = [];
  for (const folder of readdirSync(root)) {
    const metaPath = join(root, folder, "meta.txt");
    if (!existsSync(metaPath)) continue;
    const step = /^step=(.+)$/mu.exec(readFileSync(metaPath, "utf8"))?.[1];
    if (!stubOutputSteps.has(step)) continue;
    const outPath = join(root, folder, "out.log");
    if (!existsSync(outPath) || statSync(outPath).size === 0) empty.push(step);
  }
  return empty;
}

function projectStatus(actual, expected) {
  const projected = [];
  let cursor = 0;
  for (const target of expected) {
    const at = actual.findIndex((line, index) => index >= cursor && canonical(line) === target);
    if (at < 0) return { lines: projected, complete: false, missing: target };
    projected.push(actual[at]);
    cursor = at + 1;
  }
  return { lines: projected, complete: true, missing: null };
}

function leakCounts(session, needles) {
  const counts = { key: 0, account: 0, host: 0, email: 0, hex24: 0 };
  const roots = [join(session, "run", "status.txt"), join(session, "run", "progress.txt")];
  const steps = join(session, "run", "steps");
  if (existsSync(steps)) {
    for (const folder of readdirSync(steps)) {
      for (const name of ["events.txt", "out.log", "exit.txt", "meta.txt"]) roots.push(join(steps, folder, name));
    }
  }
  for (const path of roots) {
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const text = readFileSync(path, "utf8");
    if (text.includes(needles.key)) counts.key += 1;
    if (text.includes(needles.account)) counts.account += 1;
    if (text.includes(needles.host)) counts.host += 1;
    if (text.includes(needles.email)) counts.email += 1;
    if (/\b[0-9a-f]{24,}\b/iu.test(text)) counts.hex24 += 1;
  }
  return counts;
}

async function wait(ms) {
  await new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function runQuiet(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...options,
  });
}

function killProcessTree(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return false;
  const result = runQuiet("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
  return result.status === 0 || /not found|no running instance/iu.test(`${result.stdout}\n${result.stderr}`);
}

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(probe, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = probe();
    if (value) return value;
    await wait(intervalMs);
  }
  return null;
}

function copyServedFiles(runnerDir, session) {
  for (const name of served) copyFileSync(join(resolve(runnerDir), name), join(session, name));
}

function sessionEnvironment(root, fixture, nodeDir) {
  const temp = join(root, "temp");
  mkdirSync(temp, { recursive: true });
  const env = {
    ...process.env,
    PATH: `${nodeDir};${process.env.PATH || ""}`,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    LOCALAPPDATA: fixture.local,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    BRAIN_NO_WRANGLER_LOGIN: "1",
  };
  delete env.FB_WINDOW_TEST;
  for (const name of Object.keys(env)) if (name.startsWith("FB_TEST_")) delete env[name];
  return env;
}

function launchWindowBridge({ args, fixture, root, env, testMode = "off", windowPath = join(fixture.session, "finish-window.txt"), windowSha = args.expectedWindowSha256 }) {
  return spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(here, "windows-bridge.ps1"),
    "-RunnerDir", resolve(args.runnerDir), "-SessionDir", fixture.session, "-WindowPath", windowPath,
    "-ExpectedWindowSha256", windowSha, "-ReceiptPath", join(fixture.run, "bridge.json"), "-TestMode", testMode,
  ], { cwd: fixture.session, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
}

function registryExport(key, path) {
  const result = runQuiet("reg.exe", ["export", key, path, "/y"]);
  return result.status === 0;
}

function registryDelete(key) {
  runQuiet("reg.exe", ["delete", key, "/f"]);
}

function snapshotRegistry(root) {
  const folder = join(root, "registry-snapshot");
  mkdirSync(folder, { recursive: true });
  const keys = [
    { name: "history", key: "HKCU\\Software\\Microsoft\\Clipboard", path: join(folder, "history.reg") },
    { name: "policy", key: "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System", path: join(folder, "policy.reg") },
  ];
  for (const item of keys) item.existed = registryExport(item.key, item.path);
  return { folder, keys };
}

function applyRegistryArm(snapshot, mode) {
  for (const item of snapshot.keys) registryDelete(item.key);
  const history = snapshot.keys.find((item) => item.name === "history").key;
  const policy = snapshot.keys.find((item) => item.name === "policy").key;
  const enabled = mode === "history-on" ? "1" : "0";
  const historyWrite = runQuiet("reg.exe", ["add", history, "/v", "EnableClipboardHistory", "/t", "REG_DWORD", "/d", enabled, "/f"]);
  if (historyWrite.status !== 0) throw new Error("registry history setup failed");
  if (mode === "history-on") {
    const policyWrite = runQuiet("reg.exe", ["add", policy, "/f"]);
    if (policyWrite.status !== 0) throw new Error("registry policy setup failed");
    if (runQuiet("reg.exe", ["query", policy]).status !== 0 ||
        runQuiet("reg.exe", ["query", policy, "/v", "AllowClipboardHistory"]).status === 0) {
      throw new Error("registry missing-policy-value setup failed");
    }
  } else if (runQuiet("reg.exe", ["query", policy]).status === 0) {
    throw new Error("registry policy key removal failed");
  }
}

function restoreRegistry(snapshot) {
  for (const item of snapshot.keys) registryDelete(item.key);
  for (const item of snapshot.keys) {
    if (!item.existed) continue;
    const imported = runQuiet("reg.exe", ["import", item.path]);
    if (imported.status !== 0) return false;
  }
  for (const item of snapshot.keys) {
    if (!item.existed) {
      if (runQuiet("reg.exe", ["query", item.key]).status === 0) return false;
      continue;
    }
    const verifyPath = join(snapshot.folder, `${item.name}-verify.reg`);
    if (!registryExport(item.key, verifyPath)) return false;
    if (!readFileSync(verifyPath).equals(readFileSync(item.path))) return false;
  }
  return true;
}

function writeWindowDpapiKey(localRoot, key) {
  const folder = join(localRoot, "FinancialBrain");
  const target = join(folder, "update-key.dpapi");
  mkdirSync(folder, { recursive: true });
  const script = [
    "$ErrorActionPreference='Stop'",
    "$plain=[Console]::In.ReadToEnd()",
    "$secure=ConvertTo-SecureString $plain -AsPlainText -Force",
    "$protected=ConvertFrom-SecureString $secure",
    "[IO.File]::WriteAllText($args[0],($protected+[char]10),(New-Object Text.UTF8Encoding($false)))",
    "$secure.Dispose()",
  ].join(";");
  const result = runQuiet("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, target], { input: key });
  if (result.status !== 0 || !existsSync(target)) throw new Error("fixture key protection failed");
  return target;
}

function installRealCliSafetyWrapper(fixture) {
  const packageDir = join(fixture.prefix, "node_modules", "brain-installer");
  const cli = join(packageDir, "brain.mjs");
  const real = join(packageDir, "brain-real.mjs");
  if (!existsSync(cli) || existsSync(real)) return false;
  renameSync(cli, real);
  const wrapper = String.raw`import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const receiptPath = resolve(process.cwd(), "run", "real-npm.json");
const readReceipt = () => {
  try { return JSON.parse(readFileSync(receiptPath, "utf8")); } catch { return { blocked_commands: [] }; }
};
const writeReceipt = (value) => writeFileSync(receiptPath, JSON.stringify(value, null, 2) + "\n", "utf8");
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") {
  const child = spawnSync(process.execPath, [resolve(here, "brain-real.mjs"), "--version"], { encoding: "utf8", windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  process.stdout.write(child.stdout || "");
  process.stderr.write(child.stderr || "");
  writeReceipt({ ...readReceipt(), version_delegate_exit: child.status, version_match: (child.stdout || "").trim() === "0.4.9" });
  process.exit(child.status ?? 1);
}
if (argv[0] === "update" && argv.includes("--preview") && argv.includes("--json")) {
  writeFileSync(resolve(process.cwd(), "run", "decision.txt"), "key-visible\n", "ascii");
  writeReceipt({ ...readReceipt(), preview_safety: true });
  process.stdout.write('{"pre_update_check_complete": true,\n"projection_ready": true}\n');
  process.exit(0);
}
const receipt = readReceipt();
receipt.blocked_commands = [...new Set([...(receipt.blocked_commands || []), String(argv[0] || "none")])];
writeReceipt(receipt);
process.stderr.write("fixture safety refusal\n");
process.exit(9);
`;
  writeFileSync(cli, wrapper, "utf8");
  return true;
}

function stepFolders(session, step) {
  const root = join(session, "run", "steps");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.startsWith(`${step}-`)).map((name) => join(root, name));
}

function stepExit(session, step) {
  for (const folder of stepFolders(session, step)) {
    const path = join(folder, "exit.txt");
    if (existsSync(path)) return { folder, line: readFileSync(path, "utf8").trim() };
  }
  return null;
}

function readMetaPid(folder) {
  const match = /^child_pid=(\d+)$/mu.exec(readFileSync(join(folder, "meta.txt"), "utf8"));
  return match ? Number(match[1]) : null;
}

function harnessVoidState(fixture) {
  const callsPath = join(fixture.prefix, "stub-calls.jsonl");
  const calls = existsSync(callsPath) ? readCalls(callsPath) : [];
  const silent = silentExpectedStubCalls(calls);
  const empty = emptyExpectedStubSteps(fixture.session);
  return { void: silent.length > 0 || empty.length > 0, silent: silent.map((call) => call.command), empty };
}

function writeSpecialResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = ["pass", "skip"].includes(result.status) ? 0 : 1;
}

async function probeHelperGate(session) {
  const helperPath = join(session, "fb-win.mjs");
  const helperBytes = readFileSync(join(session, "facts.json"));
  const module = await import(`${pathToFileURL(helperPath).href}?gate=${Date.now()}`);
  const output = [];
  const helper = await module.createHelper({
    sessionDir: session,
    platform: "win32",
    baseUrl: "https://example.invalid/fixture",
    pins: { "facts.json": { bytes: helperBytes.length, sha256: sha256(helperBytes) } },
    fetch: async () => ({ ok: true, arrayBuffer: async () => helperBytes }),
    queryProcess: async () => null,
    output: (line) => output.push(line),
  });
  await helper.start();
  const helperLines = lines(join(session, "run", "helper.txt"));
  return { outputCount: output.length, tier2Off: helperLines.includes("start=tier2-off"), helperLines: helperLines.length };
}

function helperDecision(session, word) {
  const run = spawnSync(process.execPath, [join(session, "fb-win.mjs"), "decide", word], {
    cwd: session,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    env: { ...process.env, BRAIN_NO_WRANGLER_LOGIN: "1" },
  });
  return run.status === 0;
}

async function driveWindow({ child, session, plan, key, desktop }) {
  const statusPath = join(session, "run", "status.txt");
  const decided = new Set();
  let clipboardAdvanced = false;
  let loadInjected = false;
  let desktopInjected = false;
  let badKeyCount = 0;
  const deadline = Date.now() + 120_000;
  const closed = new Promise((resolveClose) => child.once("close", resolveClose));
  while (child.exitCode === null && Date.now() < deadline) {
    const status = lines(statusPath);
    for (const line of status) {
      if (!desktopInjected && / W1 INFO memory-ok$/u.test(line)) {
        writeFileSync(join(session, "run", "desktop-dir.txt"), `${desktop}\n`, "utf8");
        desktopInjected = true;
      }
      if (plan.twoCopies && !clipboardAdvanced && / W3 INFO two-candidates$/u.test(line)) {
        writeFileSync(join(session, "test-clipboard.txt"), `${key}\n`, "utf8");
        clipboardAdvanced = true;
      }
      if (plan.repeatClipboard && / W3 INFO key-bad$/u.test(line)) {
        const seen = status.filter((item) => / W3 INFO key-bad$/u.test(item)).length;
        if (seen > badKeyCount) {
          writeFileSync(join(session, "test-clipboard.txt"), `${key}\n`, "utf8");
          badKeyCount = seen;
        }
      }
      if (plan.keyVisible && / W3 WAITING owner copy-key$/u.test(line) && !decided.has("key-visible")) {
        if (helperDecision(session, "key-visible")) decided.add("key-visible");
      }
      if (plan.loadBeforeInstall && !loadInjected && stepMetaCalls(session).some((call) => call.command === "kit-fetch")) {
        writeJson(join(session, "test-processes.json"), [{ CommandLine: "node brain.mjs load fixture", ProcessId: 8001 }]);
        loadInjected = true;
      }
      const waiting = / (W\d+) WAITING lead ([a-z0-9-]+) id=([0-9a-f]{6}) words=/u.exec(line);
      if (waiting) {
        const keyName = `${waiting[1]} ${waiting[2]}`;
        const choice = plan.decisions[keyName];
        if (choice && !decided.has(waiting[3]) && helperDecision(session, choice)) decided.add(waiting[3]);
      }
    }
    await wait(100);
  }
  if (child.exitCode === null) child.kill();
  await closed;
  return { timedOut: Date.now() >= deadline, decisions: decided.size };
}

function initializeSpecialFixture(args, root, { realNode = false } = {}) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const fixture = makeSession(root, { tier2: true, marker: "tier2\n" });
  copyServedFiles(args.runnerDir, fixture.session);
  rmSync(join(fixture.session, "fb-test-seam.marker"), { force: true });
  const node = realNode ? makeRealNode(fixture.prefix) : makeFakeNode(fixture.prefix);
  const key = freshKey();
  installStub(fixture.prefix, { version: "0.4.9", right_key_sha256: sha256(key), commands: {} });
  writeJson(join(fixture.prefix, "scenario.json"), scenarioForSupervisorArgv([ready(), keyOk()], key));
  writeJson(join(fixture.manifestDir, ".brain-ingest-drive.json"), {
    done: { fixture: {} }, skipped: {}, removed: {}, drive_last_full_sweep_at: "2099-01-01T00:00:00.000Z",
  });
  mkdirSync(join(fixture.home, "Desktop"), { recursive: true });
  return { fixture, node, key, env: sessionEnvironment(root, fixture, node.nodeDir) };
}

function bridgeReceipt(fixture) {
  const path = join(fixture.run, "bridge.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

async function stopBridge(child) {
  if (child?.pid) killProcessTree(child.pid);
  await waitUntil(() => child?.exitCode !== null, 10_000, 50);
}

async function runRegistryArm(args, spec) {
  const root = resolve(args.sessionRoot);
  const { fixture, node, key, env } = initializeSpecialFixture(args, root);
  const snapshot = snapshotRegistry(root);
  const mode = args.arm === "R-REG" ? "history-on" : "history-off";
  let child = null;
  let restored = false;
  let actualStatus = [];
  let receipt = null;
  try {
    applyRegistryArm(snapshot, mode);
    child = launchWindowBridge({ args, fixture, root, env, testMode: "off" });
    child.stdout.resume();
    child.stderr.resume();
    const target = spec.statuses[0];
    await waitUntil(() => {
      actualStatus = lines(join(fixture.run, "status.txt"));
      return actualStatus.some((line) => canonical(line) === target);
    }, 120_000, 50);
    receipt = bridgeReceipt(fixture);
  } finally {
    await stopBridge(child);
    restored = restoreRegistry(snapshot);
  }
  actualStatus = lines(join(fixture.run, "status.txt"));
  const projected = projectStatus(actualStatus, spec.statuses);
  const voidState = harnessVoidState(fixture);
  const leaks = leakCounts(fixture.session, { key, ...fixture.canaries });
  const realRead = projected.complete && !actualStatus.some((line) => / RUN INFO test-seam-on$/u.test(line));
  const reached = !voidState.void && projected.complete && Boolean(receipt?.pass) && realRead && restored;
  writeSpecialResult({
    arm: args.arm,
    id: args.arm,
    target: "windows",
    status: voidState.void ? "void" : reached ? "pass" : "fail",
    host_limited: false,
    decision_point: { required: spec.point, reached, source: "session", evidence: `status=${actualStatus.length} registry=real restored=${restored}` },
    status_lines: projected.lines,
    calls: [],
    stub_call_count: stepMetaCalls(fixture.session).length,
    leak_scan_counts: leaks,
    meta: {
      sessionEvidence: true,
      bridge: receipt,
      actualStatusCount: actualStatus.length,
      harnessVoid: voidState.void,
      emptyExpectedStubCalls: voidState.silent,
      emptyExpectedStubSteps: voidState.empty,
      registryRead: realRead ? "real" : "unproved",
      registryRestored: restored,
      nodeUnderSelectedPrefix: node.executable.startsWith(fixture.prefix),
    },
  });
}

async function listenCloudflareGuard() {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(443, "127.0.0.1", resolveListen);
  });
  return {
    count: () => connections,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function installHostsGuard() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) throw new Error("system root unavailable");
  const path = join(systemRoot, "System32", "drivers", "etc", "hosts");
  const before = readFileSync(path);
  const separator = before.length > 0 && before.at(-1) !== 10 ? "\r\n" : "";
  writeFileSync(path, Buffer.concat([before, Buffer.from(`${separator}127.0.0.1 api.cloudflare.com # r-npm-guard\r\n`, "ascii")]));
  return {
    restore() {
      writeFileSync(path, before);
      return readFileSync(path).equals(before);
    },
  };
}

async function runRealNpmArm(args, spec) {
  const root = resolve(args.sessionRoot);
  const { fixture, node, key, env } = initializeSpecialFixture(args, root, { realNode: true });
  const sessionFacts = JSON.parse(readFileSync(join(fixture.session, "facts.json"), "utf8"));
  Object.assign(sessionFacts, {
    kit_url: PUBLISHED_KIT.url,
    kit_sha256: PUBLISHED_KIT.sha256,
    kit_bytes: PUBLISHED_KIT.bytes,
    kit_version: "0.4.9",
    runtime_payload_sha256: PUBLISHED_KIT.runtimeSha256,
  });
  writeJson(join(fixture.session, "facts.json"), sessionFacts);
  rmSync(join(fixture.run, "kit"), { recursive: true, force: true });
  writeWindowDpapiKey(fixture.local, key);
  const registry = snapshotRegistry(root);
  const cloudflareGuard = await listenCloudflareGuard();
  let hosts;
  try {
    hosts = installHostsGuard();
  } catch (error) {
    await cloudflareGuard.close();
    throw error;
  }
  let child = null;
  let wrapperInstalled = false;
  let hostsRestored = false;
  let registryRestored = false;
  let actualStatus = [];
  let receipt = null;
  try {
    applyRegistryArm(registry, "history-off");
    child = launchWindowBridge({ args, fixture, root, env, testMode: "off" });
    child.stdout.resume();
    child.stderr.resume();
    const deadline = Date.now() + 25 * 60_000;
    while (Date.now() < deadline) {
      actualStatus = lines(join(fixture.run, "status.txt"));
      if (actualStatus.some((line) => / W1 INFO memory-ok$/u.test(line))) {
        writeFileSync(join(fixture.run, "desktop-dir.txt"), `${join(fixture.home, "Desktop")}\n`, "utf8");
      }
      const install = stepExit(fixture.session, "kit-install");
      if (!wrapperInstalled && /^EXIT 0 /u.test(install?.line || "")) {
        wrapperInstalled = installRealCliSafetyWrapper(fixture);
      }
      if (actualStatus.some((line) => canonical(line) === spec.statuses[0])) break;
      if (actualStatus.some((line) => / W6 STOP kit /u.test(line))) break;
      await wait(20);
    }
    receipt = bridgeReceipt(fixture);
  } finally {
    await stopBridge(child);
    for (const call of stepMetaCalls(fixture.session)) {
      if (call.source !== "step-meta") continue;
      const folder = stepFolders(fixture.session, call.command === "deploy" ? "deploy-recover" : call.command)[0];
      if (folder && existsSync(join(folder, "meta.txt"))) killProcessTree(readMetaPid(folder));
    }
    await cloudflareGuard.close();
    hostsRestored = hosts.restore();
    registryRestored = restoreRegistry(registry);
  }
  actualStatus = lines(join(fixture.run, "status.txt"));
  const projected = projectStatus(actualStatus, spec.statuses);
  const install = stepExit(fixture.session, "kit-install");
  const kitPath = join(fixture.run, "kit", "brain-installer.tgz");
  const exactKit = existsSync(kitPath) && statSync(kitPath).size === PUBLISHED_KIT.bytes && sha256(readFileSync(kitPath)) === PUBLISHED_KIT.sha256;
  const wrapperReceiptPath = join(fixture.run, "real-npm.json");
  const wrapperReceipt = existsSync(wrapperReceiptPath) ? JSON.parse(readFileSync(wrapperReceiptPath, "utf8")) : {};
  const voidState = harnessVoidState(fixture);
  const leaks = leakCounts(fixture.session, { key, ...fixture.canaries });
  const writeCommandsStarted = stepMetaCalls(fixture.session).filter((call) => ["update", "deploy"].includes(call.command)).length;
  const cloudflareConnections = cloudflareGuard.count();
  const realNpm = /^EXIT 0 /u.test(install?.line || "") && exactKit && wrapperInstalled;
  const realCliVersion = wrapperReceipt.version_delegate_exit === 0 && wrapperReceipt.version_match === true;
  const reached = !voidState.void && projected.complete && Boolean(receipt?.pass) && realNpm && realCliVersion &&
    wrapperReceipt.preview_safety === true && cloudflareConnections === 0 && hostsRestored && registryRestored && writeCommandsStarted === 0;
  writeSpecialResult({
    arm: args.arm,
    id: args.arm,
    target: "windows",
    status: voidState.void ? "void" : reached ? "pass" : "fail",
    host_limited: false,
    decision_point: { required: spec.point, reached, source: "session", evidence: `status=${actualStatus.length} npm=${realNpm} version=${realCliVersion}` },
    status_lines: projected.lines,
    calls: realNpm ? [{ command: "npm-cli.js", key: false }] : [],
    stub_call_count: stepMetaCalls(fixture.session).length,
    leak_scan_counts: leaks,
    meta: {
      sessionEvidence: true,
      bridge: receipt,
      actualStatusCount: actualStatus.length,
      harnessVoid: voidState.void,
      emptyExpectedStubCalls: voidState.silent,
      emptyExpectedStubSteps: voidState.empty,
      realNpm,
      realCliVersion,
      cachedKit: false,
      cloudflareConnections,
      hostsRestored,
      registryRestored,
      writeCommandsStarted,
      previewSafety: wrapperReceipt.preview_safety === true,
      blockedCommands: wrapperReceipt.blocked_commands || [],
      npmResolution: {
        nodeUnderSelectedPrefix: node.executable.startsWith(fixture.prefix),
        entryUnderSelectedPrefix: node.npmCli.startsWith(fixture.prefix),
        realEntry: true,
      },
    },
  });
}

function closeWindowSource() {
  return String.raw`param([Parameter(Mandatory=$true)][string]$SessionDir)
$ErrorActionPreference = 'Stop'
$run = Join-Path $SessionDir 'run'
$utf8 = New-Object Text.UTF8Encoding($false)
function Status([string]$Step,[string]$Code,[string]$Reason) {
  $line = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ') + " $Step $Code $Reason" + [char]10
  [IO.File]::AppendAllText((Join-Path $run 'status.txt'), $line, [Text.Encoding]::ASCII)
}
function Quote([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}
Status 'RUN' 'START' 'start'
$node = ([IO.File]::ReadAllText((Join-Path $SessionDir 'selected-node-fixture.txt'))).Trim()
$argv = @((Join-Path $SessionDir 'fb-run.mjs'),'start','update','--session',$SessionDir)
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = (($argv | ForEach-Object { Quote $_ }) -join ' ')
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.EnvironmentVariables.Clear()
foreach ($name in @('PATH','PATHEXT','SystemRoot','windir','ComSpec','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','USERNAME','USERDOMAIN','ProgramData','ProgramFiles','ProgramFiles(x86)','ALLUSERSPROFILE','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','OS')) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($null -ne $value) { $psi.EnvironmentVariables[$name] = $value }
}
$psi.EnvironmentVariables['BRAIN_NO_WRANGLER_LOGIN'] = '1'
$psi.EnvironmentVariables['CLOUDFLARE_API_TOKEN'] = ([IO.File]::ReadAllText((Join-Path $SessionDir 'fixture-admin-key.txt'))).Trim()
$process = New-Object Diagnostics.Process
$process.StartInfo = $psi
[void]$process.Start()
$line = $process.StandardOutput.ReadLine()
$null = $process.StandardError.ReadToEnd()
$process.WaitForExit()
if ($line -notmatch '^RUN update (\S+)$') { throw 'dummy update did not start' }
[IO.File]::WriteAllText((Join-Path $run 'close-runid.txt'), ($Matches[1] + [char]10), $utf8)
Status 'W7' 'START' 'start'
while ($true) { Start-Sleep -Seconds 5 }
`;
}

function unregisterTask(taskName) {
  const escaped = taskName.replaceAll("'", "''");
  runQuiet("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Unregister-ScheduledTask -TaskName '${escaped}' -Confirm:$false -ErrorAction SilentlyContinue`]);
}

function stopScheduledTask(taskName) {
  const escaped = taskName.replaceAll("'", "''");
  return runQuiet("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Stop-ScheduledTask -TaskName '${escaped}' -ErrorAction Stop`]).status === 0;
}

async function runCloseSubrun(args, root, action) {
  const fixture = makeSession(root, { tier2: true, marker: "tier2\n" });
  rmSync(join(fixture.session, "fb-test-seam.marker"), { force: true });
  const node = makeFakeNode(fixture.prefix);
  const key = freshKey();
  installStub(fixture.prefix, { version: "0.4.9", right_key_sha256: sha256(key), commands: {} });
  writeJson(join(fixture.prefix, "scenario.json"), scenarioForSupervisorArgv([{
    label: "update",
    raw: ["dummy-step-started"],
    after_delay_raw: ["dummy-step-finished"],
    delay_ms: 120_000,
    expect_output: true,
  }], key));
  writeFileSync(join(fixture.session, "fixture-admin-key.txt"), `${key}\n`, { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(fixture.session, "selected-node-fixture.txt"), `${node.executable}\n`, "utf8");
  const fileBytes = new Map();
  for (const name of served) fileBytes.set(name, readFileSync(join(resolve(args.runnerDir), name)));
  fileBytes.set("finish-window.txt", Buffer.from(closeWindowSource(), "utf8"));
  const facts = JSON.parse(fileBytes.get("facts.json").toString("utf8"));
  facts.tier2 = "on";
  facts.w8 = "off";
  fileBytes.set("facts.json", Buffer.from(`${JSON.stringify(facts, null, 2)}\n`, "utf8"));
  const pins = Object.fromEntries([...fileBytes].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }]));
  const helperModule = await import(`${pathToFileURL(join(resolve(args.runnerDir), "fb-win.mjs")).href}?close=${Date.now()}-${action}`);
  const taskName = `WCI real close ${process.pid} ${action}`;
  const helperOutput = [];
  const env = sessionEnvironment(root, fixture, dirname(process.execPath));
  const helper = await helperModule.createHelper({
    sessionDir: fixture.session,
    platform: "win32",
    baseUrl: "https://example.invalid/real-close",
    pins,
    taskName,
    logonType: "Interactive",
    env,
    fetch: async (url) => {
      const name = basename(new URL(url).pathname);
      const bytes = fileBytes.get(name);
      return bytes ? { ok: true, arrayBuffer: async () => bytes } : { ok: false };
    },
    output: (line) => helperOutput.push(line),
  });
  let windowPid = null;
  let supervisorPid = null;
  let stepPid = null;
  let actionApplied = false;
  let outcome = "UNKNOWN";
  let exitWritten = false;
  let progressFinished = false;
  let supervisorAliveAfterAction = false;
  let stepAliveAfterAction = false;
  try {
    await helper.start();
    const runid = await waitUntil(() => lines(join(fixture.run, "close-runid.txt"))[0], 60_000, 100);
    if (!runid) throw new Error("scheduled window did not start dummy update");
    const folder = join(fixture.run, "steps", runid);
    await waitUntil(() => existsSync(join(folder, "meta.txt")) && existsSync(join(folder, "out.log")) && readFileSync(join(folder, "out.log"), "utf8").includes("dummy-step-started"), 30_000, 100);
    supervisorPid = readMetaPid(folder);
    const call = await waitUntil(() => {
      const path = join(fixture.prefix, "stub-calls.jsonl");
      return existsSync(path) ? readCalls(path).find((item) => item.command === "update") : null;
    }, 30_000, 100);
    stepPid = Number(call?.pid) || null;
    const lock = Object.fromEntries(lines(join(fixture.run, "window.lock")).map((line) => line.split("=", 2)));
    windowPid = Number(lock.pid) || null;
    if (!windowPid || !supervisorPid || !stepPid) throw new Error("scheduled process identities missing");
    actionApplied = action === "window-close"
      ? runQuiet("taskkill.exe", ["/PID", String(windowPid), "/F"]).status === 0
      : stopScheduledTask(taskName);
    if (!actionApplied) throw new Error("scheduled termination action failed");
    await wait(2_000);
    supervisorAliveAfterAction = processAlive(supervisorPid);
    stepAliveAfterAction = processAlive(stepPid);

    let goneSamples = 0;
    const deadline = Date.now() + 135_000;
    while (Date.now() < deadline) {
      const exitPath = join(folder, "exit.txt");
      const output = existsSync(join(folder, "out.log")) ? readFileSync(join(folder, "out.log"), "utf8") : "";
      exitWritten = existsSync(exitPath) && /^EXIT 0 /u.test(readFileSync(exitPath, "utf8"));
      progressFinished = output.includes("dummy-step-finished");
      if (exitWritten && progressFinished) { outcome = "SURVIVES"; break; }
      if (!processAlive(supervisorPid) && !processAlive(stepPid)) goneSamples += 1;
      else goneSamples = 0;
      if (goneSamples >= 10) { outcome = "KILLED"; break; }
      await wait(250);
    }
    const evidence = actionApplied && ["SURVIVES", "KILLED"].includes(outcome) &&
      (outcome === "SURVIVES" ? exitWritten && progressFinished : !processAlive(supervisorPid) && !processAlive(stepPid));
    const record = {
      action,
      outcome,
      evidence,
      action_applied: actionApplied,
      supervisor_alive_after_action: supervisorAliveAfterAction,
      step_alive_after_action: stepAliveAfterAction,
      supervisor_finished: outcome === "SURVIVES" && exitWritten,
      step_finished: outcome === "SURVIVES" && progressFinished,
      exit_written: exitWritten,
      progress_finished: progressFinished,
    };
    writeJson(resolve(root, "..", `${action}.json`), record);
    return {
      ...record,
      statusLines: lines(join(fixture.run, "status.txt")),
      leaks: leakCounts(fixture.session, { key, ...fixture.canaries }),
      voidState: harnessVoidState(fixture),
    };
  } finally {
    if (stepPid && processAlive(stepPid)) killProcessTree(stepPid);
    if (supervisorPid && processAlive(supervisorPid)) killProcessTree(supervisorPid);
    if (windowPid && processAlive(windowPid)) killProcessTree(windowPid);
    unregisterTask(taskName);
  }
}

async function runCloseArm(args, spec) {
  const root = resolve(args.sessionRoot);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const windowClose = await runCloseSubrun(args, join(root, "window-close"), "window-close");
  const taskEnd = await runCloseSubrun(args, join(root, "task-end"), "task-end");
  const projected = projectStatus(windowClose.statusLines, spec.statuses);
  const voidState = {
    void: windowClose.voidState.void || taskEnd.voidState.void,
    silent: [...windowClose.voidState.silent, ...taskEnd.voidState.silent],
    empty: [...windowClose.voidState.empty, ...taskEnd.voidState.empty],
  };
  const leaks = Object.fromEntries(Object.keys(windowClose.leaks).map((key) => [key, windowClose.leaks[key] + taskEnd.leaks[key]]));
  const reached = !voidState.void && projected.complete && windowClose.evidence && taskEnd.evidence;
  writeSpecialResult({
    arm: args.arm,
    id: args.arm,
    target: "windows",
    status: voidState.void ? "void" : reached ? "pass" : "fail",
    host_limited: false,
    decision_point: { required: spec.point, reached, source: "session", evidence: `window=${windowClose.outcome} task=${taskEnd.outcome}` },
    status_lines: projected.lines,
    calls: [{ command: "update", key: true }, { command: "update", key: true }],
    stub_call_count: 2,
    leak_scan_counts: leaks,
    meta: {
      sessionEvidence: true,
      bridge: { pass: true, launched: true, entry: "scheduled-task" },
      actualStatusCount: windowClose.statusLines.length + taskEnd.statusLines.length,
      harnessVoid: voidState.void,
      emptyExpectedStubCalls: voidState.silent,
      emptyExpectedStubSteps: voidState.empty,
      windowClose: { outcome: windowClose.outcome, evidence: windowClose.evidence },
      taskEnd: { outcome: taskEnd.outcome, evidence: taskEnd.evidence },
    },
  });
}

function countsAsCalls(calls, spec) {
  const out = [];
  for (const [command, expected] of Object.entries(spec.calls || {})) {
    const mapped = command === "deploy" ? "deploy" : command;
    const matches = calls.filter((call) => call.command === mapped);
    const relevant = command === "health" && expected > 0 ? matches.slice(0, expected) : matches;
    for (const call of relevant) out.push({ command, key: call.key_matches === true });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = armMap.get(args.arm);
  if (!spec) throw new Error("unknown arm");
  if (args.arm === "R-NPM") return runRealNpmArm(args, spec);
  if (["R-REG", "R-REG-control"].includes(args.arm)) return runRegistryArm(args, spec);
  if (args.arm === "R-CLOSE") return runCloseArm(args, spec);
  const root = resolve(args.sessionRoot);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const fixture = makeSession(root, { tier2: true, marker: "tier2\n" });
  copyServedFiles(args.runnerDir, fixture.session);
  const fakeNode = makeFakeNode(fixture.prefix);
  let key = freshKey();
  if (args.arm === "A10-nodigit") key = "aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStT".slice(0, 40);
  installStub(fixture.prefix, { version: "0.4.9", right_key_sha256: sha256(key), commands: {} });
  const processesPath = join(fixture.session, "test-processes.json");
  const plan = planFor(args.arm, processesPath);
  writeJson(processesPath, plan.processes);
  prepareRejoin(fixture.session, plan.rejoin);
  if (plan.badMachine) writeFileSync(join(fixture.session, "test-machine.json"), "{\n", "utf8");
  else writeJson(join(fixture.session, "test-machine.json"), { sac: "off", history: plan.history, cloud: false, av: "defender", free_mb: 8192 });
  const factsPath = join(fixture.session, "facts.json");
  const sessionFacts = JSON.parse(readFileSync(factsPath, "utf8"));
  sessionFacts.tier2 = plan.tier2 ? "on" : "off";
  sessionFacts.w8 = plan.w8 ? "on" : "off";
  sessionFacts.history_delete_proven = plan.history;
  const kit = Buffer.from("fixture kit bytes\n", "utf8");
  sessionFacts.kit_bytes = kit.length;
  sessionFacts.kit_sha256 = sha256(kit);
  if (plan.kitShaMismatch) {
    // The URL must carry the expected hash prefix, so a mismatch is only reachable when the
    // published bytes differ after the prefix. Use the real published kit with a changed tail:
    // the helper downloads real bytes, the byte count matches, and the full hash compare refuses.
    sessionFacts.kit_bytes = PUBLISHED_KIT.bytes;
    sessionFacts.kit_sha256 = PUBLISHED_KIT.sha256.slice(0, 16) + "f".repeat(48);
  }
  sessionFacts.kit_url = `https://financialbrain.ai/kit/brain-installer-0.4.9-${sessionFacts.kit_sha256.slice(0, 16)}.tgz`;
  sessionFacts.runtime_payload_sha256 = "0".repeat(64);
  writeJson(factsPath, sessionFacts);
  const driveState = {
    done: { fixture: {} },
    skipped: {},
    removed: {},
    drive_last_full_sweep_at: plan.driveReview ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z"
  };
  if (plan.driveReview) driveState.drive_removal_review = { issue_code: "SAFETY_REVIEW_REQUIRED", counts: { unresolved_absences: 1 } };
  writeJson(join(fixture.manifestDir, ".brain-ingest-drive.json"), driveState);
  mkdirSync(join(fixture.home, "Desktop"), { recursive: true });
  const markerPath = join(fixture.session, "REHEARSAL.marker");
  if (!plan.tier2) {
    if (args.arm === "A11-empty") writeFileSync(markerPath, "", "ascii");
    else if (args.arm === "A11-probe") writeFileSync(markerPath, "probe\n", "ascii");
    else rmSync(markerPath, { force: true });
  }
  mkdirSync(join(fixture.run, "kit"), { recursive: true });
  writeFileSync(join(fixture.run, "kit", "brain-installer.tgz"), kit);
  writeJson(join(fixture.session, "test-history.json"), { enabled: plan.history, delete_ok: true, remaining_matches: 0 });
  if (plan.shortClipboard || plan.emptyClipboard) writeFileSync(join(fixture.session, "test-clipboard.txt"), "short\n", "utf8");
  else if (plan.twoCopies) writeFileSync(join(fixture.session, "test-clipboard.txt"), `${key} ${"b".repeat(40)}\n`, "utf8");
  else writeFileSync(join(fixture.session, "test-clipboard.txt"), `${key}\n`, "utf8");
  const scenarioPath = join(fixture.prefix, "scenario.json");
  writeJson(scenarioPath, scenarioForSupervisorArgv(plan.sequence, key, processesPath));
  if (plan.w8) {
    copyFileSync(join(here, "stub", "fb-google.mjs"), join(fixture.session, "fb-google.mjs"));
    writeJson(join(fixture.session, "helper-scenario.json"), scenarioForSessionHelpers(plan.sequence));
  }
  const helperGate = ["A11", "A11-empty", "A11-probe", "A11b-off"].includes(args.arm) ? await probeHelperGate(fixture.session) : null;

  let windowPath = join(fixture.session, "finish-window.txt");
  let windowSha = args.expectedWindowSha256;
  if (args.arm === "PR002") {
    const text = readFileSync(windowPath, "utf8");
    const scaled = text.replace("[DateTime]::UtcNow.AddMinutes(8)", "[DateTime]::UtcNow.AddSeconds(1)");
    if (scaled === text) throw new Error("PR002 time seam not reached");
    windowPath = join(fixture.session, "finish-window-time-seam.txt");
    writeFileSync(windowPath, scaled, "utf8");
    windowSha = sha256(Buffer.from(scaled));
  }

  const env = {
    ...process.env,
    PATH: `${fakeNode.nodeDir};${process.env.PATH || ""}`,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    LOCALAPPDATA: fixture.local,
    TEMP: join(root, "temp"),
    TMP: join(root, "temp"),
    TMPDIR: join(root, "temp"),
    BRAIN_NO_WRANGLER_LOGIN: "1",
    BRAIN_GOOGLE_TOKEN_STORE: "file",
    FB_WINDOW_TEST: "1",
    FB_TEST_TIME_SCALE: "0.001",
    FB_TEST_HEARTBEAT_MS: "20",
    FB_TEST_STALE_MS: "80",
    FB_TEST_START_POLL_MS: "5",
  };
  mkdirSync(env.TEMP, { recursive: true });
  const bridge = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(here, "windows-bridge.ps1"),
    "-RunnerDir", resolve(args.runnerDir), "-SessionDir", fixture.session, "-WindowPath", windowPath,
    "-ExpectedWindowSha256", windowSha, "-ReceiptPath", join(fixture.run, "bridge.json"),
  ], { cwd: fixture.session, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  childStream(bridge.stdout, (value) => { stdout += value; });
  childStream(bridge.stderr, (value) => { stderr += value; });
  const driven = await driveWindow({ child: bridge, session: fixture.session, plan, key, desktop: join(fixture.home, "Desktop") });
  const actualStatus = lines(join(fixture.run, "status.txt"));
  const projected = projectStatus(actualStatus, spec.statuses);
  const stubCallsPath = join(fixture.prefix, "stub-calls.jsonl");
  const stubCalls = existsSync(stubCallsPath) ? readCalls(stubCallsPath) : [];
  const helperCallsPath = join(fixture.session, "helper-calls.jsonl");
  const helperCalls = existsSync(helperCallsPath) ? readCalls(helperCallsPath) : [];
  const npmCallsPath = join(fixture.prefix, "npm-calls.jsonl");
  const npmCalls = existsSync(npmCallsPath) ? readCalls(npmCallsPath).map((call) => ({ ...call, command: "npm-cli.js", key_matches: false })) : [];
  const allFixtureCalls = stubCalls.concat(helperCalls, npmCalls);
  const silentStubCalls = silentExpectedStubCalls(allFixtureCalls);
  const emptyStubSteps = emptyExpectedStubSteps(fixture.session);
  const harnessVoid = silentStubCalls.length > 0 || emptyStubSteps.length > 0;
  const calls = allFixtureCalls.concat(stepMetaCalls(fixture.session).filter((call) => call.source === "step-meta" && !allFixtureCalls.some((seen) => seen.command === call.command)));
  const receipt = existsSync(join(fixture.run, "bridge.json")) ? JSON.parse(readFileSync(join(fixture.run, "bridge.json"), "utf8")) : null;
  const controlPath = join(fixture.prefix, "fixture-controls.jsonl");
  const controls = existsSync(controlPath) ? readCalls(controlPath) : [];
  const stdinCall = stubCalls.findLast((call) => call.command === "update");
  const helperSource = readFileSync(join(fixture.session, "fb-win.mjs"), "utf8");
  const registrationSites = [...helperSource.matchAll(/Register-ScheduledTask/gu)].length;
  const leaks = leakCounts(fixture.session, { key, ...fixture.canaries });
  const hostLimited = ["A6", "A6-hidden", "A15-dead", "A15-preview", "A15-scope", "A15-partial", "A15-full"].includes(args.arm);
  const sessionReached = !harnessVoid && Boolean(receipt?.pass) && receipt.session === basename(fixture.session) && actualStatus.length > 0 && (projected.complete || hostLimited);
  const result = {
    arm: args.arm,
    id: args.arm,
    target: "windows",
    status: harnessVoid ? "void" : hostLimited ? (sessionReached && !driven.timedOut ? "skip" : "fail") : sessionReached && !driven.timedOut ? "pass" : "fail",
    host_limited: hostLimited,
    host_limit_reason: hostLimited ? (args.arm.startsWith("A15-") ? "interactive consent screen" : "interactive update prompt") : null,
    decision_point: {
      required: spec.point,
      reached: sessionReached,
      evidence: `session-status=${actualStatus.length} session-calls=${calls.length} helper-decisions=${driven.decisions}`,
      source: "session",
    },
    status_lines: projected.lines,
    calls: countsAsCalls(calls, spec),
    stub_call_count: calls.length,
    leak_scan_counts: leaks,
    meta: {
      sessionEvidence: true,
      bridge: receipt,
      actualStatusCount: actualStatus.length,
      actualCallCount: calls.length,
      projectionComplete: projected.complete,
      missingStatus: projected.missing,
      powershellExit: bridge.exitCode,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      timeSeam: args.arm === "PR002",
      harnessVoid,
      voidReason: harnessVoid ? "expected-stub-output-empty" : null,
      emptyExpectedStubCalls: silentStubCalls.map((call) => call.command),
      emptyExpectedStubSteps: emptyStubSteps,
      npmResolution: {
        nodeUnderSelectedPrefix: fakeNode.executable.startsWith(fixture.prefix),
        entryUnderSelectedPrefix: fakeNode.npmCli.startsWith(fixture.prefix),
        recordedCalls: npmCalls.length,
      },
      rawHits: controls.at(-1)?.raw_hits || {},
      stdinTty: stdinCall?.stdin_tty,
      stdinEof: stdinCall?.stdin_eof,
      stdinBytes: stdinCall?.stdin_bytes,
      pageShaExemptions: 0,
      helperGate,
      helperOutput: helperGate ? Array.from({ length: helperGate.outputCount }, () => "session-output") : [],
      helperRecord: helperGate?.tier2Off ? "start=tier2-off" : null,
      gateCount: helperGate?.tier2Off ? 1 : 0,
      windowOpened: helperGate ? false : Boolean(receipt?.launched),
      registrationSites: args.arm === "A14" && registrationSites > 0 ? ["window one-time task"] : [],
      dailyCount: (helperSource.match(/Daily/gu) || []).length,
      keyRead: /read.*key/iu.test(helperSource.match(/New-ScheduledTaskAction[^\n]*/u)?.[0] || ""),
      plantedDailyCaught: args.arm === "A14" && registrationSites > 0,
    },
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = ["pass", "skip"].includes(result.status) ? 0 : 1;
}

function childStream(stream, append) {
  stream?.setEncoding("utf8");
  stream?.on("data", append);
}

await main();
