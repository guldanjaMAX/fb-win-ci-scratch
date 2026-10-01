import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { armMap } from "./reference/arms.mjs";
import { canonical } from "./reference/oracle.mjs";
import { freshKey, installStub, makeFakeNode, makeSession, scenarioForSessionHelpers, scenarioForSupervisorArgv, splitCanaries } from "./fixtures.mjs";
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

const PUBLISHED_KIT = { bytes: 6668013, sha256: "0555ad1972d7f8d6c1ded78a9fc4265f873cc4f4ce8c11fd04198cc5599409b2" };

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
  const root = resolve(args.sessionRoot);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const fixture = makeSession(root, { tier2: true, marker: "tier2\n" });
  for (const name of served) copyFileSync(join(resolve(args.runnerDir), name), join(fixture.session, name));
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
  writeFileSync(join(fixture.run, "kit", "tgz"), kit);
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
