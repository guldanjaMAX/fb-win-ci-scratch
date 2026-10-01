import { createHash } from "node:crypto";
import { armMap, armSpecs } from "./arms.mjs";

const allowedSteps = new Set(["RUN", "W1", "W3", "W4", "W5", "W6", "W7", "W8", "W11"]);
const allowedCodes = new Set(["START", "PASS", "INFO", "SKIP", "WAITING", "STOP", "DONE"]);
const stopClasses = new Set(["preflight", "key", "kit", "update", "google", "manifest", "lead-stop"]);

const reasons = new Map([
  ["RUN", new Set(["start", "test-seam-on", "tier2-off", "w8-only", "done", "part-missing", "decision-ignored", "window-fingerprint"])],
  ["W1", new Set(["readout", "domain-yes", "domain-no", "health-ready", "health-pending", "health-mismatch", "health-paused", "health-unreadable", "health-needs-key", "sac-on", "sac-eval", "sac-off", "sac-unknown", "history-on", "history-off", "history-cloud-on", "av-defender", "av-third-party", "av-unknown", "memory-ok", "memory-low", "load-running", "update-running", "drive-terminal", "drive-loading", "drive-review", "drive-none", "drive-unreadable", "node-version", "cli-version", "tier2-off"])],
  ["W3", new Set(["key-start", "key-file-found", "key-file-rejected", "got-it", "two-candidates", "history-deleted", "history-delete-failed", "copy-key", "key-checked", "key-bad", "key-saved", "save-failed", "verify-network", "nudge", "two-bad", "key-visible", "timeout", "history-unproven", "history-cloud"])],
  ["W4", new Set(["queue-zero", "pending", "projection", "queue", "wait-elapsed", "finish-later"])],
  ["W5", new Set(["drive-not-terminal"])],
  ["W6", new Set(["sha"])],
  ["W7", new Set(["stage", "rejoin", "retry-cpu-reset", "retry-last-stage-503", "verified", "pending-migration-seen", "queue-not-empty", "update-retry", "update-queued", "queued", "second-failure", "pending-migration"])],
  ["W8", new Set(["check-start", "calendar-ok", "reconnect-needed", "connected", "scopes-all", "scope-missing-drive", "scope-missing-gmail", "scope-missing-calendar", "account-changed", "account-same", "account-unknown", "restored", "kept", "sac-refused", "google-partial", "google-account", "google-consent", "off", "google-busy", "google-none", "consent-not-finished", "check-failed", "connect-failed"])],
  ["W11", new Set(["key-removed", "done"])]
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function idFor(arm, index) {
  return createHash("sha256").update(`${arm}:${index}`).digest("hex").slice(0, 6);
}

function stamp(index) {
  return `2026-10-01T08:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`;
}

function materializeStatuses(arm, parts) {
  return parts.map((part, index) => `${stamp(index)} ${part.replace("<id>", idFor(arm, index))}`);
}

function callList(counts) {
  const calls = [];
  for (const [command, count] of Object.entries(counts || {})) {
    for (let index = 0; index < count; index += 1) calls.push({ command, key: ["update", "verify", "deploy"].includes(command) });
  }
  return calls;
}

export function simulateArm(id, mutant = null) {
  const spec = armMap.get(id);
  if (!spec) throw new Error(`unknown arm ${id}`);
  const result = {
    arm: id,
    status: "pass",
    decision_point: { required: spec.point, reached: true },
    status_lines: materializeStatuses(id, spec.statuses),
    calls: callList(spec.calls),
    stub_call_count: Object.values(spec.calls || {}).reduce((sum, count) => sum + count, 0),
    leak_scan_counts: { key: 0, account: 0, host: 0, email: 0, hex24: 0 },
    meta: clone(spec.meta || {})
  };

  if (mutant === "O1" && ["A6", "A6-hidden"].includes(id)) result.meta.stdinBytes = 1;
  if (mutant === "O2" && id === "A7") result.leak_scan_counts.key = 1;
  if (mutant === "O3" && id === "A0") result.status_lines.splice(-3, 0, `${stamp(40)} W7 STOP kit pending-migration`);
  if (mutant === "O3" && id === "A13") result.meta.controlFalsePositive = true;
  if (mutant === "O4" && id === "A2") result.calls.push({ command: "update", key: true });
  if (mutant === "O5" && ["A11", "A11-empty", "A11-probe"].includes(id)) result.meta.windowOpened = true;
  if (mutant === "O11" && id === "A11b") result.status_lines.splice(3, 0, `${stamp(30)} W3 INFO key-saved`);
  if (mutant === "O12" && id === "A10-nodigit") result.calls = [];
  if (mutant === "O6" && id === "A1") result.calls.push({ command: "health", key: false });
  if (mutant === "O6" && id === "A1-wait") result.calls.push({ command: "health", key: false });
  if (mutant === "O7" && id === "A15-403") result.calls.push({ command: "google-connect", key: false });
  if (mutant === "O8" && id === "A9-write") result.calls.push({ command: "update", key: true });
  if (mutant === "O9" && ["A4", "A4-later"].includes(id)) result.calls.push({ command: "deploy", key: true });
  if (mutant === "O10" && id === "A14") result.meta.keyRead = true;
  return result;
}

export function canonical(line) {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z /, "").replace(/id=[0-9a-f]{6}/g, "id=<id>");
}

export function parseStatus(line) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) (RUN|W1|W3|W4|W5|W6|W7|W8|W11) (START|PASS|INFO|SKIP|WAITING|STOP|DONE) (.+)$/.exec(line);
  if (!match) return { pass: false, reason: "grammar" };
  const [, , step, code, tail] = match;
  if (!allowedSteps.has(step) || !allowedCodes.has(code)) return { pass: false, reason: "token" };
  const words = tail.split(" ");
  let reasonIndex = 0;
  if (code === "WAITING") {
    if (!["lead", "owner"].includes(words[0])) return { pass: false, reason: "waiting-role" };
    reasonIndex = 1;
    if (words[0] === "lead" && (!/ id=[0-9a-f]{6}( |$)/.test(` ${tail}`) || !/ words=[a-z-]+(?:,[a-z-]+)*( |$)/.test(` ${tail} `))) return { pass: false, reason: "waiting-fields" };
  }
  if (code === "STOP") {
    if (!stopClasses.has(words[0])) return { pass: false, reason: "stop-class" };
    reasonIndex = 1;
  }
  const reason = words[reasonIndex];
  if (!reasons.get(step)?.has(reason)) return { pass: false, reason: `closed-reason:${step}:${reason}` };
  return { pass: true, step, code, reason };
}

function countCalls(result, command) {
  return result.calls.filter((call) => call.command === command).length;
}

export function verifyArm(result) {
  const spec = armMap.get(result.arm);
  const errors = [];
  if (!spec) return { pass: false, errors: ["unknown arm"] };
  const parsed = result.status_lines.map(parseStatus);
  parsed.forEach((item, index) => { if (!item.pass) errors.push(`status ${index}: ${item.reason}`); });
  const ids = result.status_lines.flatMap((line) => [...line.matchAll(/id=([0-9a-f]{6})/g)].map((match) => match[1]));
  if (new Set(ids).size !== ids.length) errors.push("status ids are not fresh");
  const actual = result.status_lines.map(canonical);
  if (JSON.stringify(actual) !== JSON.stringify(spec.statuses)) errors.push("status sequence differs");
  for (const [command, expected] of Object.entries(spec.calls || {})) {
    if (countCalls(result, command) !== expected) errors.push(`${command} calls ${countCalls(result, command)} != ${expected}`);
  }
  if (!result.decision_point?.reached) errors.push("decision point not reached");
  if (spec.negative && !result.decision_point?.required) errors.push("negative arm has no decision point");
  if (Object.values(result.leak_scan_counts || {}).some((count) => count !== 0)) errors.push("leak scan nonzero");
  if (["A6", "A6-hidden"].includes(result.arm) && (result.meta.stdinTty !== false || result.meta.stdinEof !== true || result.meta.stdinBytes !== 0)) errors.push("stdin contract failed");
  if (result.arm === "A7" && Object.values(result.meta.rawHits || {}).some((count) => count < 1)) errors.push("raw canary control failed");
  if (result.arm === "A13" && result.meta.controlFalsePositive) errors.push("migration control false positive");
  if (["A11", "A11-empty", "A11-probe"].includes(result.arm) && result.meta.windowOpened !== false) errors.push("tier gate opened window");
  if (result.arm === "A14" && (result.meta.keyRead || !result.meta.plantedDailyCaught)) errors.push("daily action key-read control failed");
  result.status = errors.length ? "fail" : "pass";
  return { pass: errors.length === 0, errors };
}

export function detectSuspect(results) {
  const verified = results.map((result) => verifyArm(result).pass);
  if (verified.every((pass) => !pass)) return { suspect: true, reason: "every arm failed" };
  if (verified.every(Boolean)) {
    const sequences = new Set(results.map((result) => JSON.stringify(result.status_lines.map(canonical))));
    if (sequences.size === 1) return { suspect: true, reason: "uniform passing status sequences" };
  }
  return { suspect: false, reason: null };
}

export function allArmIds() {
  return armSpecs.map((arm) => arm.id);
}
