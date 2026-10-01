#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const runDir = join(dirname(scriptPath), "run");
const ownerPattern = /^owner-([1-9][0-9]*)-([a-f0-9]{32})\.json$/;
const backupPattern = /^google-tokens\.before-w8-[0-9]{8}T[0-9]{6}Z\.json$/;
const factName = /^[a-z0-9_]{1,40}$/;
const factValue = /^[A-Za-z0-9_.:+-]{0,64}$/;

function emit(name, value) {
  const key = String(name);
  const token = String(value);
  if (!factName.test(key) || !factValue.test(token)) throw new Error("unsafe fact");
  process.stdout.write(`fb:${key}=${token}\n`);
}

function parseArgs(argv) {
  const command = argv[0] || "";
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--") || index + 1 >= argv.length) throw new Error("bad arguments");
    options[item.slice(2)] = argv[index + 1];
    index += 1;
  }
  return { command, options };
}

function testSwitches(options) {
  const names = ["token-url", "api-base", "store-path"].filter((name) => options[name] !== undefined);
  if (names.length && process.env.FB_GOOGLE_TEST !== "1") throw new Error("test switch refused");
  for (const name of ["token-url", "api-base"]) {
    if (options[name] === undefined) continue;
    const url = new URL(options[name]);
    if (url.protocol !== "http:" || !["127.0.0.1", "::1"].includes(url.hostname)) {
      throw new Error("non-loopback test endpoint refused");
    }
  }
}

function modulePath(prefix, relative) {
  if (!prefix) throw new Error("prefix required");
  return join(resolve(prefix), "node_modules", "brain-installer", relative);
}

async function googleModule(prefix) {
  return import(pathToFileURL(modulePath(prefix, join("connectors", "google-auth.mjs"))).href);
}

async function lockModule(prefix) {
  return import(pathToFileURL(modulePath(prefix, join("operations", "source-ingest-lock.mjs"))).href);
}

export function computeGoogleLockPath(home = homedir()) {
  const identity = createHash("sha256").update("shared-record-v1:provider:google").digest("hex").slice(0, 32);
  return join(resolve(home), ".brain", "locks", `source-ingest-${identity}.lock`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export function inspectLease(home = homedir(), now = Date.now()) {
  const path = computeGoogleLockPath(home);
  if (!existsSync(path)) return "free";
  let state;
  let entries;
  try {
    state = statSync(path);
    if (!state.isDirectory()) return "unreadable";
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return "unreadable";
  }
  if (entries.length === 0) return now - state.mtimeMs <= 120_000 ? "stale-recent" : "free";
  if (entries.length !== 1 || !entries[0].isFile()) return "unreadable";
  const match = entries[0].name.match(ownerPattern);
  if (!match) return "unreadable";
  let ownerState;
  let parsed;
  try {
    ownerState = statSync(join(path, entries[0].name));
    parsed = JSON.parse(readFileSync(join(path, entries[0].name), "utf8"));
  } catch {
    return "unreadable";
  }
  const pid = Number(match[1]);
  if (parsed?.pid !== pid || parsed?.token !== match[2]) return "unreadable";
  if (pidAlive(pid)) return "busy";
  return now - ownerState.mtimeMs <= 120_000 ? "stale-recent" : "free";
}

function recordPath(options, module = null) {
  if (options["store-path"]) return resolve(options["store-path"]);
  return module ? module.tokenPath() : join(homedir(), ".brain", "google-tokens.json");
}

function backups(path) {
  const folder = dirname(path);
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => backupPattern.test(name))
    .map((name) => join(folder, name));
}

function backupName(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `google-tokens.before-w8-${stamp}.json`;
}

function smartControl(error) {
  return String(error?.message || error).includes("Smart App Control");
}

function storedFact(record, name) {
  return Array.isArray(record?.scopes) && record.scopes.includes(name) ? "yes" : "no";
}

function grantedFact(granted, scope) {
  if (granted === null) return "unknown";
  return granted.has(scope) ? "yes" : "no";
}

function ensureSalt() {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = join(runDir, "google-salt");
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { }
  }
  const salt = readFileSync(path);
  if (salt.length !== 32) throw new Error("salt invalid");
  return salt;
}

function accountDigest(address, salt) {
  return createHmac("sha256", salt).update(String(address).toLowerCase()).digest("hex").slice(0, 16);
}

function recordAccountPhase(phase, address) {
  const salt = ensureSalt();
  const currentHash = address ? accountDigest(address, salt) : "unknown";
  const hashPath = join(runDir, "google-account-hash.txt");
  if (phase === "pre") {
    writeFileSync(hashPath, `${currentHash}\n`, { encoding: "ascii", mode: 0o600 });
    emit("account_hash", currentHash);
    return;
  }
  let prior = "unknown";
  try { prior = readFileSync(hashPath, "ascii").trim(); } catch { }
  const result = currentHash === "unknown" || prior === "unknown"
    ? "unknown"
    : currentHash === prior ? "same" : "changed";
  emit("account", result);
}

function apiFetch(apiBase) {
  if (!apiBase) return fetch;
  return (input, init) => {
    const original = new URL(String(input));
    const target = new URL(apiBase);
    target.pathname = original.pathname;
    target.search = original.search;
    return fetch(target, init);
  };
}

async function scopes(options) {
  const phase = options.phase;
  if (!["pre", "post"].includes(phase)) throw new Error("phase required");
  const module = await googleModule(options.prefix);
  const path = recordPath(options, module);
  let store;
  try {
    store = module.loadTokensReadOnly(path);
  } catch (error) {
    emit("reason", smartControl(error) ? "sac" : "error");
    return;
  }
  const record = store?.google;
  if (!record?.refresh_token) {
    emit("record", "none");
    return;
  }
  emit("record", "present");
  for (const name of ["drive", "gmail", "calendar"]) emit(`stored_${name}`, storedFact(record, name));

  const body = new URLSearchParams({
    client_id: record.client_id || "",
    refresh_token: record.refresh_token,
    grant_type: "refresh_token",
  });
  if (record.client_secret) body.set("client_secret", record.client_secret);
  const tokenUrl = options["token-url"] || module.TOKEN_URL;
  let response;
  let json;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    json = await response.json().catch(() => ({}));
  } catch (error) {
    emit("refresh", "failed");
    emit("reason", smartControl(error) ? "sac" : "error");
    return;
  }
  if (!response.ok) {
    emit("refresh", json?.error === "invalid_grant" ? "dead" : "failed");
    for (const name of ["drive", "gmail", "calendar"]) emit(`granted_${name}`, "unknown");
    recordAccountPhase(phase, null);
    return;
  }
  emit("refresh", "ok");
  const granted = typeof json.scope === "string" ? new Set(json.scope.split(/\s+/).filter(Boolean)) : null;
  for (const name of ["drive", "gmail", "calendar"]) {
    emit(`granted_${name}`, grantedFact(granted, module.SCOPES[name]));
  }

  let address = null;
  try {
    address = await module.fetchConnectedAccountEmail(
      json.access_token,
      Array.isArray(record.scopes) ? record.scopes : [],
      apiFetch(options["api-base"]),
    );
  } catch (error) {
    if (smartControl(error)) emit("reason", "sac");
  }
  recordAccountPhase(phase, address);
}

function backup(options) {
  const path = recordPath(options);
  if (!existsSync(path) || backups(path).length) {
    emit("backup", "none");
    return;
  }
  const target = join(dirname(path), backupName());
  copyFileSync(path, target, 1);
  emit("backup", "yes");
}

async function restore(options) {
  const module = await googleModule(options.prefix);
  const locks = await lockModule(options.prefix);
  const path = recordPath(options, module);
  let lease;
  try {
    lease = locks.acquireSourceIngestLock({ sourceName: "google", sharedRecord: "provider:google" });
  } catch (error) {
    emit("restore", String(error?.message || error).includes("ingest is already running on this computer.") ? "busy" : "failed");
    return;
  }
  try {
    const found = backups(path);
    if (found.length !== 1) {
      emit("restore", "failed");
      return;
    }
    const expected = module.loadTokensReadOnly(found[0]);
    module.saveTokens(expected, options["store-path"] ? path : undefined);
    const actual = module.loadTokensReadOnly(options["store-path"] ? path : undefined);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      emit("restore", "failed");
      return;
    }
    unlinkSync(found[0]);
    emit("restore", "done");
  } catch {
    emit("restore", "failed");
  } finally {
    lease.release();
  }
}

function discard(options) {
  const path = recordPath(options);
  const found = backups(path);
  for (const item of found) unlinkSync(item);
  emit("discard", found.length ? "yes" : "none");
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { command, options } = parseArgs(argv);
    testSwitches(options);
    if (command === "lease") emit("lease", inspectLease());
    else if (command === "scopes") await scopes(options);
    else if (command === "backup") backup(options);
    else if (command === "restore") await restore(options);
    else if (command === "discard") discard(options);
    else throw new Error("unknown command");
  } catch (error) {
    emit("reason", smartControl(error) ? "sac" : "refused");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) await main();
