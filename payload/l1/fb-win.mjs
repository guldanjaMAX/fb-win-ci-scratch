import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = "https://example.invalid/client-page"; // @base-url
const PINS = {}; // @pins

const FILES = Object.freeze([
  ["finish-window.txt", "window"],
  ["fb-run.mjs", "supervisor"],
  ["fb-drive-state.mjs", "drive-state"],
  ["fb-manifest-edit.mjs", "manifest-edit"],
  ["fb-kit.mjs", "kit"],
  ["fb-google.mjs", "google"],
  ["phrases.json", "phrases"],
  ["facts.json", "facts"],
]);
const FACTS_NAME = "facts.json";
const MARKER_NAME = "REHEARSAL.marker";
const TASK_NAME = "Financial Brain update";
const WINDOW_TITLE = "Financial Brain update";
const PAGE_SENTENCES = Object.freeze({
  nothing: "Nothing more to run here today.",
  opening: "A window called Financial Brain update is opening. It does the update steps for you.",
  open: "The update window is already open.",
  failed: "The update window did not open. Nothing was changed.",
  mismatch: "Something did not match, so nothing ran. The team will look at it.",
  closed: "The update window closed. Typing the same sentence again picks up where it left off.",
  working: "The update window is working.",
  done: "Done here. You can close this window.",
});
const STEPS = new Set(["RUN", "W1", "W3", "W4", "W5", "W6", "W7", "W8", "W11"]);
const CODES = new Set(["START", "PASS", "INFO", "SKIP", "WAITING", "STOP", "DONE"]);
const BOUNDARY_CODES = new Set(["PASS", "SKIP", "WAITING", "STOP", "DONE"]);
const DECISION_WORDS = new Set([
  "continue",
  "finish-later",
  "wait",
  "retry",
  "restore",
  "keep",
  "deploy-recover",
  "stop",
  "key-visible",
]);
const FALLBACK_CHOICES = new Map([
  ["W1 brain-paused", ["continue", "deploy-recover", "finish-later"]],
  ["W3 key-history", ["continue", "finish-later"]],
  ["W3 verify-network", ["retry", "finish-later"]],
  ["W4 queue", ["wait", "finish-later"]],
  ["W4 load-running", ["wait", "finish-later"]],
  ["W6 load-running", ["wait", "finish-later"]],
  ["W6 install-busy", ["wait", "finish-later"]],
  ["W7 update-retry", ["continue", "stop"]],
  ["W7 update-queued", ["deploy-recover", "finish-later"]],
  ["W8 google-partial", ["restore", "keep", "retry"]],
  ["W8 google-account", ["restore", "keep", "retry"]],
]);

export const STUB_TEMPLATE = String.raw`$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = '@@TITLE@@'
$SessionDir = '@@SESSION@@'
$RunDir = '@@RUN@@'
[IO.Directory]::CreateDirectory($RunDir) | Out-Null
$Started = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$Lf = [char]10
$Lock = "pid=$PID" + $Lf + "start=$Started" + $Lf
[IO.File]::WriteAllText((Join-Path $RunDir 'window.lock'), $Lock, [Text.Encoding]::ASCII)
$WindowPath = Join-Path $SessionDir 'finish-window.txt'
$Bytes = [IO.File]::ReadAllBytes($WindowPath)
$Sha = [Security.Cryptography.SHA256]::Create()
try { $Got = ([BitConverter]::ToString($Sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() } finally { $Sha.Dispose() }
if ($Got -ne '@@PIN@@') {
  $Utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $Refusal = "$Utc RUN STOP preflight window-fingerprint" + $Lf
  [IO.File]::AppendAllText((Join-Path $RunDir 'status.txt'), $Refusal, [Text.Encoding]::ASCII)
  exit 0
}
if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 239 -and $Bytes[1] -eq 187 -and $Bytes[2] -eq 191) {
  [byte[]]$Bytes = $Bytes[3..($Bytes.Length - 1)]
}
$Text = [Text.Encoding]::UTF8.GetString($Bytes)
& ([ScriptBlock]::Create($Text)) -SessionDir '@@SESSION@@'
`;

export const REGISTER_TEMPLATE = String.raw`$ErrorActionPreference = 'Stop'
$TaskName = '@@TASK@@'
$Encoded = '@@STUB@@'
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $Encoded"
$User = "$env:USERDOMAIN\$env:USERNAME"
$At = (Get-Date).AddMinutes(1)
$Trigger = New-ScheduledTaskTrigger -Once -At $At
$Trigger.EndBoundary = (Get-Date).AddDays(2).ToString('s')
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -DeleteExpiredTaskAfter ([TimeSpan]::FromDays(1))
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType @@LOGON@@ -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
[Console]::Out.WriteLine('REGISTERED')
Start-ScheduledTask -TaskName $TaskName
[Console]::Out.WriteLine('STARTED')
`;

function quotePowerShell(value) {
  return String(value).replaceAll("'", "''");
}

export function fillStub({ sessionDir, runDir, sha256 }) {
  return STUB_TEMPLATE
    .replaceAll("@@TITLE@@", quotePowerShell(WINDOW_TITLE))
    .replaceAll("@@SESSION@@", quotePowerShell(sessionDir))
    .replaceAll("@@RUN@@", quotePowerShell(runDir))
    .replaceAll("@@PIN@@", sha256);
}

export function fillRegister({ taskName, stubEncoded, logonType = "Interactive" }) {
  if (!/^(Interactive|S4U)$/u.test(logonType)) throw new Error("unsupported logon type");
  return REGISTER_TEMPLATE
    .replaceAll("@@TASK@@", quotePowerShell(taskName))
    .replaceAll("@@STUB@@", stubEncoded)
    .replaceAll("@@LOGON@@", logonType);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validPin(pin) {
  return Boolean(pin) && Number.isSafeInteger(pin.bytes) && pin.bytes >= 0 &&
    /^[a-f0-9]{64}$/u.test(pin.sha256);
}

function tokenLike(text) {
  for (const match of text.matchAll(/[A-Za-z0-9_-]{35,}/gu)) {
    const value = match[0];
    if (/[A-Z]/u.test(value) && /[a-z]/u.test(value) && /[0-9]/u.test(value)) return true;
  }
  return false;
}

export function isUnsafeText(text) {
  const value = String(text);
  if (tokenLike(value)) return true;
  if (/[a-fA-F0-9]{24,}/u.test(value)) return true;
  if (/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/u.test(value)) return true;
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value)) return true;
  if (/\b(?:https?:\/\/|[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,}(?:[/:?#]|\b)/iu.test(value)) return true;
  if (/[A-Za-z]:\\/u.test(value) || /\\Users\\/iu.test(value) || /\/Users\//u.test(value)) return true;
  if (/%[A-Za-z_][A-Za-z0-9_]*%/u.test(value)) return true;
  return false;
}

function safeReason(value) {
  return /^[a-z0-9-]{1,40}$/u.test(value) && !isUnsafeText(value);
}

function parseStatusLine(line) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+(\S+)\s+(\S+)\s+(.+)$/u.exec(line.trim());
  if (!match) return null;
  const [, timestamp, step, code, tail] = match;
  if (!STEPS.has(step) || !CODES.has(code)) return null;
  const parts = tail.split(/\s+/u);
  let subject = null;
  let reason;
  let coreCount = 1;
  if (code === "WAITING") {
    if (!new Set(["lead", "owner"]).has(parts[0]) || !parts[1]) return null;
    subject = parts[0];
    reason = parts[1];
    coreCount = 2;
  } else if (code === "STOP") {
    if (!parts[0] || !parts[1]) return null;
    subject = parts[0];
    reason = parts[1];
    coreCount = 2;
  } else {
    reason = parts[0];
  }
  const metadata = Object.create(null);
  for (const part of parts.slice(coreCount)) {
    const token = /^(n|id|words)=(\S+)$/u.exec(part);
    if (!token || Object.hasOwn(metadata, token[1])) return null;
    metadata[token[1]] = token[2];
  }
  if (metadata.n && !/^\d+$/u.test(metadata.n)) return null;
  if (metadata.id && !/^[a-f0-9]{6}$/u.test(metadata.id)) return null;
  let words = null;
  if (metadata.words) {
    words = metadata.words.split(",");
    if (!words.length || words.some((word) => !DECISION_WORDS.has(word)) || new Set(words).size !== words.length) return null;
  }
  return {
    timestamp,
    step,
    code,
    subject,
    reason,
    n: metadata.n ?? null,
    id: metadata.id ?? null,
    words,
    raw: line.trim(),
  };
}

function choicesFor(event) {
  if (event?.words?.length) return event.words;
  return FALLBACK_CHOICES.get(`${event?.step} ${event?.reason}`) ?? ["continue", "finish-later", "stop"];
}

function statusValue(event) {
  const raw = event.code === "STOP" ? `${event.subject}-${event.reason}` : event.reason;
  const reason = safeReason(raw) ? raw : "hidden";
  return `${event.step}.${event.code}.${reason}`;
}

function decodeStatusRecords(buffer, offset = 0) {
  let encoding = "utf8";
  let bom = 0;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = "utf16le";
    bom = 2;
  } else if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    bom = 3;
  } else if (buffer.length >= 4 && buffer[1] === 0 && buffer[3] === 0) {
    encoding = "utf16le";
  }
  const start = offset === 0 ? bom : offset;
  if (start > buffer.length) return [];
  const text = buffer.subarray(start).toString(encoding);
  const chunks = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) ?? [];
  const records = [];
  let end = start;
  for (const chunk of chunks) {
    if (!chunk) continue;
    end += Buffer.byteLength(chunk, encoding);
    const line = chunk.replace(/[\r\n]+$/u, "");
    if (line) records.push({ line, end });
  }
  return records;
}

async function readMaybe(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path, data, encoding = undefined) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, data, encoding);
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function clampCap(value) {
  const parsed = Number.parseInt(String(value ?? "540"), 10);
  if (!Number.isFinite(parsed)) return 540;
  return Math.max(5, Math.min(590, parsed));
}

function defaultSleep(ms) {
  return new Promise((accept) => setTimeout(accept, ms));
}

function defaultNow() {
  return Date.now();
}

function processRoot(env) {
  const root = env.SystemRoot ?? env.WINDIR;
  if (!root || typeof root !== "string") return null;
  return root.replace(/[\\/]+$/u, "");
}

function powerShellPath(env) {
  const root = processRoot(env);
  return root ? win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;
}

function invokePowerShell(spawn, env, source) {
  const executable = powerShellPath(env);
  if (!executable) return { status: 1, stdout: "", stderr: "" };
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  return spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8",
    env: {
      SystemRoot: processRoot(env),
      WINDIR: processRoot(env),
      USERDOMAIN: env.USERDOMAIN,
      USERNAME: env.USERNAME,
    },
    maxBuffer: 64 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    windowsHide: true,
  });
}

function defaultProcessQuery({ pid, spawn, env }) {
  const source = String.raw`$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue
if ($null -ne $p) { [Console]::Out.Write($p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) }
`;
  const result = invokePowerShell(spawn, env, source);
  if (result?.status !== 0) return null;
  return String(result.stdout ?? "").trim() || null;
}

function parseLock(bytes) {
  if (!bytes || bytes.length > 1024) return null;
  const text = bytes.toString("ascii");
  const pid = /^pid=(\d+)$/mu.exec(text)?.[1];
  const start = /^start=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/mu.exec(text)?.[1];
  if (!pid || !start) return null;
  return { pid: Number(pid), start };
}

async function markerTurnsOn(path) {
  const bytes = await readMaybe(path);
  if (!bytes || bytes.length > 1024 || bytes.some((byte) => byte > 0x7f)) return false;
  return bytes.toString("ascii").split(/\r?\n/u)[0].trim() === "tier2";
}

export async function createHelper(options = {}) {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const sessionDir = await realpath(options.sessionDir ?? moduleDir);
  const runDir = join(sessionDir, "run");
  const platform = options.platform ?? process.platform;
  const nodeMajor = options.nodeMajor ?? Number.parseInt(process.versions.node.split(".")[0], 10);
  const spawn = options.spawn ?? spawnSync;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? defaultNow;
  const sleep = options.sleep ?? defaultSleep;
  const kill = options.kill ?? process.kill.bind(process);
  const env = options.env ?? process.env;
  const baseUrl = options.baseUrl ?? BASE_URL;
  const pins = options.pins ?? PINS;
  const taskName = options.taskName ?? TASK_NAME;
  const logonType = options.logonType ?? "Interactive";
  const queryProcess = options.queryProcess ?? ((value) => defaultProcessQuery({ ...value, spawn, env }));
  const output = options.output ?? ((line) => process.stdout.write(`${line}\n`));

  await mkdir(runDir, { recursive: true });

  async function appendHelper(key, value) {
    if (!/^[a-z0-9_.]{1,40}$/u.test(key) || !/^[A-Za-z0-9_.:()-]{0,64}$/u.test(value)) {
      throw new Error("helper outcome outside contract");
    }
    await appendFile(join(runDir, "helper.txt"), `${key}=${value}\n`, "ascii");
  }

  async function guardedPage(kind, line) {
    let shown = line;
    if (isUnsafeText(line)) {
      shown = kind === "start" ? PAGE_SENTENCES.mismatch : PAGE_SENTENCES.working;
      await appendHelper("hidden", "1");
    }
    output(shown);
    return [shown];
  }

  async function nowSentence(fallback) {
    const bytes = await readMaybe(join(runDir, "now.txt"));
    if (!bytes) return { line: fallback, hidden: 0 };
    let line = bytes.toString("utf8").replace(/^\uFEFF/u, "").trim();
    let cut = false;
    if (line.length > 160) {
      line = line.slice(0, 160);
      cut = true;
    }
    if (cut) await appendHelper("now_cut", "yes");
    if (!line || isUnsafeText(line)) return { line: fallback, hidden: 1 };
    return { line, hidden: 0 };
  }

  async function fullAlive() {
    const lock = parseLock(await readMaybe(join(runDir, "window.lock")));
    if (!lock) return false;
    const created = await queryProcess({ pid: lock.pid, start: lock.start });
    if (!created) return false;
    const delta = Math.abs(Date.parse(created) - Date.parse(lock.start));
    return Number.isFinite(delta) && delta <= 2000;
  }

  async function quickAlive() {
    const lock = parseLock(await readMaybe(join(runDir, "window.lock")));
    if (!lock) return false;
    try {
      kill(lock.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function download(name, key) {
    const pin = pins[name];
    if (!validPin(pin)) return { ok: false, outcome: `stop-fingerprint-${key}` };
    let response = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetchImpl(`${baseUrl}/${name}`, { signal: AbortSignal.timeout(60_000) });
        if (response?.ok) break;
      } catch {
        response = null;
      }
    }
    if (!response?.ok) return { ok: false, outcome: `stop-download-${key}` };
    let bytes;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      return { ok: false, outcome: `stop-download-${key}` };
    }
    const temp = join(sessionDir, `.${name}.download-${process.pid}-${now()}`);
    await writeFile(temp, bytes);
    const matches = bytes.length === pin.bytes && sha256(bytes) === pin.sha256;
    if (!matches) {
      await rm(temp, { force: true });
      return { ok: false, outcome: `stop-fingerprint-${key}` };
    }
    const destination = join(sessionDir, name);
    const existing = await readMaybe(destination);
    if (existing && existing.length === pin.bytes && sha256(existing) === pin.sha256) {
      await rm(temp, { force: true });
      return { ok: true, bytes: existing };
    }
    if (existing) await rm(destination, { force: true });
    await rename(temp, destination);
    return { ok: true, bytes };
  }

  async function unregister() {
    const source = `$ErrorActionPreference = 'SilentlyContinue'\nUnregister-ScheduledTask -TaskName '${quotePowerShell(taskName)}' -Confirm:$false\n`;
    invokePowerShell(spawn, env, source);
  }

  async function finishStart(outcome, sentence) {
    await appendHelper("start", outcome);
    return guardedPage("start", sentence);
  }

  async function start() {
    if (platform !== "win32") return finishStart("stop-not-windows", PAGE_SENTENCES.failed);
    if (!Number.isFinite(nodeMajor) || nodeMajor < 22) return finishStart("stop-node-version", PAGE_SENTENCES.failed);
    if (baseUrl === "https://example.invalid/client-page" || Object.keys(pins).length === 0) {
      return finishStart("stop-not-built", PAGE_SENTENCES.mismatch);
    }
    if (await fullAlive()) return finishStart("already-open", PAGE_SENTENCES.open);

    const factsResult = await download(FACTS_NAME, "facts");
    if (!factsResult.ok) return finishStart(factsResult.outcome, PAGE_SENTENCES.mismatch);
    let facts;
    try {
      facts = JSON.parse(factsResult.bytes.toString("utf8"));
    } catch {
      return finishStart("stop-fingerprint-facts", PAGE_SENTENCES.mismatch);
    }
    if (Object.hasOwn(facts, "marker") && facts.marker !== MARKER_NAME) {
      return finishStart("stop-marker-mismatch", PAGE_SENTENCES.mismatch);
    }
    const markerOn = await markerTurnsOn(join(sessionDir, MARKER_NAME));
    const enabled = facts.tier2 === "on" || facts.w8 === "on" || markerOn;
    if (!enabled) return finishStart("tier2-off", PAGE_SENTENCES.nothing);

    for (const [name, key] of FILES) {
      if (name === FACTS_NAME) continue;
      const result = await download(name, key);
      if (!result.ok) return finishStart(result.outcome, PAGE_SENTENCES.mismatch);
    }

    const windowPin = pins["finish-window.txt"];
    const stub = fillStub({ sessionDir, runDir, sha256: windowPin.sha256 });
    const stubEncoded = Buffer.from(stub, "utf16le").toString("base64");
    if (stubEncoded.length >= 8000) throw new Error("stub exceeds encoded size limit");
    const registration = fillRegister({ taskName, stubEncoded, logonType });
    let child;
    try {
      child = invokePowerShell(spawn, env, registration);
    } catch {
      child = null;
    }
    if (!child || child.status !== 0 || child.error || child.signal) {
      const registered = String(child?.stdout ?? "").includes("REGISTERED");
      await unregister();
      return finishStart(registered ? "not-opened-start-failed" : "not-opened-register-failed", PAGE_SENTENCES.failed);
    }
    const deadline = now() + 30_000;
    while (now() <= deadline) {
      if (await fullAlive()) return finishStart("opened", PAGE_SENTENCES.opening);
      await sleep(250);
    }
    await unregister();
    return finishStart("not-opened-no-heartbeat", PAGE_SENTENCES.failed);
  }

  async function allStatusEvents() {
    const bytes = await readMaybe(join(runDir, "status.txt"));
    if (!bytes) return null;
    return decodeStatusRecords(bytes, 0).map(({ line }) => parseStatusLine(line)).filter(Boolean);
  }

  async function status() {
    const events = await allStatusEvents();
    if (events === null) {
      await appendHelper("status", "RUN.INFO.none");
      return guardedPage("status", PAGE_SENTENCES.nothing);
    }
    const boundary = [...events].reverse().find((event) => BOUNDARY_CODES.has(event.code));
    if (!boundary) {
      if (!(await quickAlive())) {
        await appendHelper("status", "RUN.STOP.closed");
        return guardedPage("status", PAGE_SENTENCES.closed);
      }
      const sentence = await nowSentence(PAGE_SENTENCES.working);
      await appendHelper("status", "RUN.INFO.working");
      if (sentence.hidden) await appendHelper("hidden", String(sentence.hidden));
      return guardedPage("status", sentence.line);
    }
    await appendHelper("status", statusValue(boundary));
    if (boundary.code !== "DONE" && !(await quickAlive())) {
      return guardedPage("status", PAGE_SENTENCES.closed);
    }
    let line;
    if (boundary.code === "WAITING" && boundary.subject === "lead") {
      line = `WAITING lead ${boundary.step} ${boundary.reason} [${choicesFor(boundary).join(" / ")}]`;
    } else if (boundary.code === "WAITING" && boundary.subject === "owner") {
      const sentence = await nowSentence(PAGE_SENTENCES.working);
      if (sentence.hidden) await appendHelper("hidden", String(sentence.hidden));
      line = `WAITING owner: ${sentence.line}`;
    } else if (boundary.code === "STOP") {
      line = `STOP ${boundary.step} ${boundary.subject} ${boundary.reason}`;
    } else if (boundary.code === "DONE") {
      const sentence = await nowSentence(PAGE_SENTENCES.done);
      if (sentence.hidden) await appendHelper("hidden", String(sentence.hidden));
      line = sentence.line;
    } else {
      const sentence = await nowSentence(PAGE_SENTENCES.working);
      if (sentence.hidden) await appendHelper("hidden", String(sentence.hidden));
      line = sentence.line;
    }
    return guardedPage("status", line);
  }

  async function decide(wordInput) {
    const word = String(wordInput ?? "");
    if (!DECISION_WORDS.has(word)) {
      await appendHelper("decide", "unknown");
      return guardedPage("decide", "DECIDE: UNKNOWN WORD");
    }
    if (word === "key-visible") {
      await atomicWrite(join(runDir, "decision.txt"), "key-visible\n", "ascii");
      await appendHelper("decide", word);
      return guardedPage("decide", `DECIDED: ${word}`);
    }
    const events = await allStatusEvents();
    const newestBoundary = events ? [...events].reverse().find((event) => BOUNDARY_CODES.has(event.code)) : null;
    if (!newestBoundary || newestBoundary.code !== "WAITING" || newestBoundary.subject !== "lead" || !newestBoundary.id) {
      await appendHelper("decide", "not-now");
      return guardedPage("decide", "DECIDE: NOT NOW");
    }
    const choices = choicesFor(newestBoundary);
    if (!choices.includes(word)) {
      await appendHelper("decide", "not-now");
      return guardedPage("decide", "DECIDE: NOT NOW");
    }
    const existing = await readMaybe(join(runDir, "decision.txt"));
    if (existing) {
      const sent = /^(\S+)(?: id=([a-f0-9]{6}))?/u.exec(existing.toString("ascii").trim());
      if (sent?.[2] === newestBoundary.id) {
        await appendHelper("decide", "already-sent");
        return guardedPage("decide", "DECIDE: ALREADY SENT");
      }
    }
    await atomicWrite(join(runDir, "decision.txt"), `${word} id=${newestBoundary.id}\n`, "ascii");
    await appendHelper("decide", word);
    return guardedPage("decide", `DECIDED: ${word}`);
  }

  async function follow(capInput) {
    const cap = clampCap(capInput);
    const cursorPath = join(runDir, "follow.cursor");
    const cursorBytes = await readMaybe(cursorPath);
    let cursor = cursorBytes && /^\d+$/u.test(cursorBytes.toString("ascii").trim())
      ? Number(cursorBytes.toString("ascii").trim())
      : 0;
    const started = now();
    let lastLiveness = Number.NEGATIVE_INFINITY;
    const lines = [];
    let hidden = 0;
    while (true) {
      const bytes = await readMaybe(join(runDir, "status.txt"));
      if (bytes) {
        for (const record of decodeStatusRecords(bytes, cursor)) {
          cursor = record.end;
          await atomicWrite(cursorPath, `${cursor}\n`, "ascii");
          const event = parseStatusLine(record.line);
          if (!event) {
            hidden += 1;
            continue;
          }
          const reasonParts = event.code === "WAITING" || event.code === "STOP"
            ? [event.subject, event.reason]
            : [event.reason];
          let reasonText = reasonParts.join(" ");
          if (reasonParts.some((part) => !safeReason(part))) {
            reasonText = "(hidden)";
            hidden += 1;
          }
          let line = `EVENT ${event.step} ${event.code} ${reasonText}`;
          if (event.n) line += ` n=${event.n}`;
          if (isUnsafeText(line)) {
            hidden += 1;
          } else {
            lines.push(line);
          }
          if (BOUNDARY_CODES.has(event.code)) {
            const sentence = await nowSentence(event.code === "DONE" ? PAGE_SENTENCES.done : PAGE_SENTENCES.working);
            hidden += sentence.hidden;
            lines.push(`SAY: ${sentence.line}`);
            if (event.code === "WAITING" && event.subject === "lead") {
              lines.push(`CHOICES: ${choicesFor(event).join(" / ")}`);
              lines.push("NEXT: decide");
            } else if (event.code === "DONE") {
              lines.push("NEXT: none");
            } else {
              lines.push("NEXT: follow");
            }
            if (hidden) lines.push(`HIDDEN: ${hidden}`);
            for (const outputLine of lines) output(outputLine);
            return lines;
          }
        }
      }
      const elapsed = now() - started;
      if (elapsed - lastLiveness >= 10_000) {
        lastLiveness = elapsed;
        if (!(await quickAlive())) {
          lines.push("WINDOW: CLOSED", PAGE_SENTENCES.closed, "NEXT: none");
          if (hidden) lines.push(`HIDDEN: ${hidden}`);
          for (const outputLine of lines) output(outputLine);
          return lines;
        }
      }
      if (elapsed >= cap * 1000) {
        lines.push("FOLLOW: CAP", "NEXT: follow");
        if (hidden) lines.push(`HIDDEN: ${hidden}`);
        for (const outputLine of lines) output(outputLine);
        return lines;
      }
      await sleep(2000);
    }
  }

  return Object.freeze({ start, status, decide, follow, sessionDir, runDir });
}

async function main() {
  const helper = await createHelper();
  const [verb, argument] = process.argv.slice(2);
  if (verb === "start") await helper.start();
  else if (verb === "status") await helper.status();
  else if (verb === "decide") await helper.decide(argument);
  else if (verb === "follow") await helper.follow(argument);
  else throw new Error("unknown helper verb");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write("HELPER: ERROR internal\n");
    process.exitCode = 1;
  });
}
