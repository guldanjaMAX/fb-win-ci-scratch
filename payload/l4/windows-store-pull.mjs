import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const TASK_NAME = "Financial Brain store data 8AM";
const SUCCESS = "Store data will now load every day at 8:00 AM.";
const ARMS = ["S8-REG", "S8-REFUSE", "S8-LIVE-WINDOW"];
const EXPECTED_HELPER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "l1", "fb-store.mjs");

function parseArgs(argv) {
  const out = { helper: EXPECTED_HELPER };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--helper") {
      const supplied = resolve(argv[++index]);
      if (supplied !== EXPECTED_HELPER) throw new Error("helper-must-be-payload-l1-fb-store");
    }
    else if (value === "--out") out.out = resolve(argv[++index]);
    else throw new Error("bad-args");
  }
  if (!out.out) throw new Error("bad-args");
  return out;
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function powerShellPath() {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  if (!root) throw new Error("powershell-root-missing");
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function closedEnvironment(overrides = {}) {
  const allowed = [
    "SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "PSModulePath",
    "USERDOMAIN", "USERNAME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
    "ALLUSERSPROFILE", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS",
    "TEMP", "TMP",
  ];
  const env = {};
  for (const name of allowed) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...overrides };
}

function runPowerShell(source) {
  const executable = powerShellPath();
  const args = [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(source, "utf16le").toString("base64"),
  ];
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: closedEnvironment(),
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  result.commandArgv = [executable, ...args];
  return result;
}

function quotePowerShell(value) {
  return String(value).replaceAll("'", "''");
}

function firstFiveLines(value) {
  const text = String(value ?? "").replaceAll("\r\n", "\n");
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(0, 5);
}

function unregisterTask(evidence = [], phase = "cleanup") {
  const result = runPowerShell(String.raw`$ErrorActionPreference = 'Stop'
$Task = Get-ScheduledTask -TaskName '${quotePowerShell(TASK_NAME)}' -ErrorAction SilentlyContinue
if ($null -ne $Task) {
  Stop-ScheduledTask -TaskName '${quotePowerShell(TASK_NAME)}' -ErrorAction SilentlyContinue
  $StopDeadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $Task = Get-ScheduledTask -TaskName '${quotePowerShell(TASK_NAME)}' -ErrorAction SilentlyContinue
    if ($null -eq $Task -or [string]$Task.State -ne 'Running') { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $StopDeadline)
  if ($null -ne $Task -and [string]$Task.State -eq 'Running') { throw 'task did not stop' }
  Unregister-ScheduledTask -TaskName '${quotePowerShell(TASK_NAME)}' -Confirm:$false
}
$RemoveDeadline = [DateTime]::UtcNow.AddSeconds(20)
do {
  $Remaining = Get-ScheduledTask -TaskName '${quotePowerShell(TASK_NAME)}' -ErrorAction SilentlyContinue
  if ($null -eq $Remaining) { break }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $RemoveDeadline)
if ($null -ne $Remaining) { throw 'task remained registered' }
exit 0
`);
  evidence.push({
    phase,
    command_argv: result.commandArgv,
    status: result.status,
    signal: result.signal ?? null,
    error: result.error?.code ?? null,
    stdout_first_5: firstFiveLines(result.stdout),
    stderr_first_5: firstFiveLines(result.stderr),
  });
  assert.equal(result.status, 0, `task-cleanup-failed status=${result.status} signal=${result.signal ?? "none"} error=${result.error?.code ?? "none"}`);
}

function taskCount() {
  const result = runPowerShell(String.raw`$Tasks = @(Get-ScheduledTask -TaskName '${quotePowerShell(TASK_NAME)}' -ErrorAction SilentlyContinue)
[Console]::Out.Write($Tasks.Count)
`);
  assert.equal(result.status, 0, "task-count-failed");
  return Number.parseInt(result.stdout.trim() || "0", 10);
}

function taskSnapshot() {
  const result = runPowerShell(String.raw`$ErrorActionPreference = 'Stop'
$Task = Get-ScheduledTask -TaskName '${quotePowerShell(TASK_NAME)}'
$Xml = Export-ScheduledTask -TaskName '${quotePowerShell(TASK_NAME)}'
$Current = "$env:USERDOMAIN\$env:USERNAME"
[pscustomobject]@{
  Count = @($Task).Count
  Execute = $Task.Actions[0].Execute
  Arguments = $Task.Actions[0].Arguments
  TriggerType = $Task.Triggers[0].CimClass.CimClassName
  StartBoundary = $Task.Triggers[0].StartBoundary
  DaysInterval = $Task.Triggers[0].DaysInterval
  UserId = $Task.Principal.UserId
  ExpectedUser = $Current
  LogonType = [string]$Task.Principal.LogonType
  RunLevel = [string]$Task.Principal.RunLevel
  StartWhenAvailable = $Task.Settings.StartWhenAvailable
  MultipleInstances = [string]$Task.Settings.MultipleInstances
  ExecutionTimeLimit = $Task.Settings.ExecutionTimeLimit
  DisallowStartIfOnBatteries = $Task.Settings.DisallowStartIfOnBatteries
  StopIfGoingOnBatteries = $Task.Settings.StopIfGoingOnBatteries
  Xml = $Xml
} | ConvertTo-Json -Compress
`);
  assert.equal(result.status, 0, "task-readback-failed");
  return JSON.parse(result.stdout.trim());
}

function startTask() {
  const result = runPowerShell(`$ErrorActionPreference = 'Stop'\nStart-ScheduledTask -TaskName '${quotePowerShell(TASK_NAME)}'\n`);
  assert.equal(result.status, 0, "task-start-failed");
}

function processWindowHandle(pid) {
  const result = runPowerShell(`$Process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue\nif ($null -ne $Process) { [Console]::Out.Write($Process.MainWindowHandle) }\n`);
  assert.equal(result.status, 0, "window-handle-query-failed");
  return result.stdout.trim();
}

function processCreation(pid) {
  const result = runPowerShell(`$Process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop\n[Console]::Out.Write($Process.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'))\n`);
  assert.equal(result.status, 0, "process-start-query-failed");
  assert.match(result.stdout.trim(), /^\d{4}-\d{2}-\d{2}T/u, "process-start-missing");
  return result.stdout.trim();
}

function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = runPowerShell(`$Process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue\nif ($null -ne $Process) { [Console]::Out.Write('1') }\n`);
    assert.equal(result.status, 0, "live-process-exit-query-failed");
    if (result.stdout.trim() !== "1") return true;
    pause(100);
  }
  return false;
}

function waitFor(path, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    pause(100);
  }
  return false;
}

function waitForTaskReady(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = runPowerShell(`$Task = Get-ScheduledTask -TaskName '${quotePowerShell(TASK_NAME)}'\n[Console]::Out.Write([string]$Task.State)\n`);
    if (result.status === 0 && result.stdout.trim() === "Ready") return true;
    pause(200);
  }
  return false;
}

function stubSource() {
  return `import { appendFileSync, readFileSync } from "node:fs";
const manifestPath = process.argv[3];
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const watched = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "BRAIN_ADMIN_KEY"];
const record = {
  argv: process.argv.slice(2),
  pid: process.pid,
  stdout_tty: process.stdout.isTTY === true,
  stderr_tty: process.stderr.isTTY === true,
  credential_env: watched.filter((name) => Object.hasOwn(process.env, name)),
};
appendFileSync(manifest.fixture_record, JSON.stringify(record) + "\\n", "utf8");
setTimeout(() => {}, 5000);
`;
}

function makeFixture(root, helper, { customApi = true } = {}) {
  const session = join(root, "session owner's folder");
  const prefix = join(root, "installed owner's folder");
  const home = join(root, "home");
  const manifest = join(root, "manifest owner's file.json");
  const record = join(root, "stub-calls.jsonl");
  const cli = join(prefix, "node_modules", "brain-installer", "brain.mjs");
  mkdirSync(dirname(cli), { recursive: true });
  mkdirSync(join(session, "run"), { recursive: true });
  mkdirSync(home, { recursive: true });
  copyFileSync(helper, join(session, "fb-store.mjs"));
  writeFileSync(cli, stubSource(), "utf8");
  const corpora = customApi ? { custom_api: { cadence: 86400 } } : {};
  writeFileSync(manifest, `${JSON.stringify({ corpora, fixture_record: record })}\n`, "utf8");
  writeFileSync(join(session, "selected-prefix-fixture.txt"), `${prefix}\n`, "utf8");
  writeFileSync(join(session, "selected-manifest-fixture.txt"), `${manifest}\n`, "utf8");
  writeFileSync(join(session, "fixture-admin-key.txt"), "fixture-only\n", { encoding: "ascii", mode: 0o600 });
  return { root, session, prefix, home, manifest, record, helper: join(session, "fb-store.mjs") };
}

function runHelper(fixture, verb) {
  const env = closedEnvironment({
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    TEMP: fixture.home,
    TMP: fixture.home,
    BRAIN_NO_WRANGLER_LOGIN: "1",
  });
  return spawnSync(process.execPath, [fixture.helper, verb], {
    cwd: fixture.session,
    encoding: "utf8",
    env,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function decodeAction(argumentsText) {
  const match = /-EncodedCommand\s+([A-Za-z0-9+/=]+)\s*$/u.exec(argumentsText);
  assert.ok(match, "hidden-action-encoding-missing");
  return Buffer.from(match[1], "base64").toString("utf16le");
}

function assertNoCredentialMaterial(text) {
  assert.doesNotMatch(String(text), /(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|BRAIN_ADMIN_KEY|--key(?:\s|=))/iu,
    "credential-material-present");
}

function runRegistrationArm(helper, root, cleanup) {
  const fixture = makeFixture(join(root, "registration"), helper);
  writeFileSync(join(fixture.session, "run", "status.txt"), "2026-10-01T15:00:00Z W11 DONE done\n", "ascii");
  unregisterTask(cleanup, "before-arm");
  const first = runHelper(fixture, "schedule-store-pull");
  assert.equal(first.status, 0, "registration-command-failed");
  assert.equal(first.stdout, `${SUCCESS}\n`, "registration-output-wrong");
  assert.equal(first.stderr, "", "registration-stderr-not-empty");
  assert.equal(existsSync(fixture.record), false, "registration-ran-pull");

  const task = taskSnapshot();
  assert.equal(task.Count, 1, "task-count-not-one");
  assert.equal(String(task.Execute).toLowerCase(), powerShellPath().toLowerCase(), "task-executable-wrong");
  assert.match(task.Arguments, /-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand/u, "task-action-not-hidden");
  assert.equal(task.TriggerType, "MSFT_TaskDailyTrigger", "task-trigger-not-daily");
  assert.match(task.StartBoundary, /T08:00:00(?:[.+-]|$)/u, "task-trigger-not-eight");
  assert.equal(task.DaysInterval, 1, "task-trigger-not-every-day");
  // Task Scheduler reads the principal back without the domain on some hosts; compare the account name.
  const bareUser = (value) => String(value).toLowerCase().split("\\").pop();
  assert.equal(bareUser(task.UserId), bareUser(task.ExpectedUser), "task-user-not-current");
  assert.equal(task.LogonType, "Interactive", "task-logon-not-interactive");
  assert.equal(task.RunLevel, "Limited", "task-runlevel-not-limited");
  assert.equal(task.StartWhenAvailable, true, "task-start-when-available-off");
  assert.equal(task.MultipleInstances, "IgnoreNew", "task-multiple-instance-policy-wrong");
  assert.equal(task.ExecutionTimeLimit, "PT30M", "task-time-limit-wrong");
  assert.equal(task.DisallowStartIfOnBatteries, false, "task-battery-start-blocked");
  assert.equal(task.StopIfGoingOnBatteries, false, "task-battery-stop-on");
  assertNoCredentialMaterial(task.Xml);

  const action = decodeAction(task.Arguments);
  assert.match(action, /CreateNoWindow = \$true/u, "child-console-not-suppressed");
  assert.match(action, /ProcessWindowStyle\]::Hidden/u, "child-window-not-hidden");
  assert.match(action, /BRAIN_NO_WRANGLER_LOGIN/u, "credential-login-guard-missing");
  assert.match(action, / custom-api /u, "custom-api-argv-missing");
  assert.ok(action.includes(fixture.manifest.replaceAll("'", "''")), "manifest-argv-missing");
  assertNoCredentialMaterial(action);

  startTask();
  assert.equal(waitFor(fixture.record), true, "stub-not-invoked");
  const records = readFileSync(fixture.record, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(records.length, 1, "stub-call-count-not-one");
  assert.deepEqual(records[0].argv, ["custom-api", fixture.manifest], "stub-argv-wrong");
  assert.deepEqual(records[0].credential_env, [], "stub-received-credential-env");
  assert.equal(records[0].stdout_tty, false, "stub-stdout-visible");
  assert.equal(records[0].stderr_tty, false, "stub-stderr-visible");
  assert.equal(processWindowHandle(records[0].pid), "0", "stub-had-visible-window");
  assert.equal(waitForTaskReady(), true, "task-did-not-finish");

  const second = runHelper(fixture, "schedule-store-pull");
  assert.equal(second.status, 0, "replacement-command-failed");
  assert.equal(second.stdout, `${SUCCESS}\n`, "replacement-output-wrong");
  assert.equal(taskCount(), 1, "replacement-created-second-task");
  assert.equal(readFileSync(fixture.record, "utf8").trim().split(/\r?\n/u).length, 1, "replacement-ran-pull");

  const removed = runHelper(fixture, "unschedule-store-pull");
  assert.equal(removed.status, 0, "unschedule-command-failed");
  assert.equal(removed.stdout, "The store data schedule was removed.\n", "unschedule-output-wrong");
  assert.equal(taskCount(), 0, "unschedule-left-task");
  return "registered-read-started-replaced-removed";
}

function runManifestRefusalArm(helper, root, cleanup) {
  const fixture = makeFixture(join(root, "manifest-refusal"), helper, { customApi: false });
  writeFileSync(join(fixture.session, "run", "status.txt"), "2026-10-01T15:00:00Z W11 DONE done\n", "ascii");
  unregisterTask(cleanup, "before-arm");
  const result = runHelper(fixture, "schedule-store-pull");
  assert.notEqual(result.status, 0, "manifest-refusal-exit-zero");
  assert.equal(result.stdout, "This install does not have store data set up.\n", "manifest-refusal-output-wrong");
  assert.equal(result.stderr, "", "manifest-refusal-stderr-not-empty");
  assert.equal(taskCount(), 0, "manifest-refusal-created-task");
  assert.equal(existsSync(fixture.record), false, "manifest-refusal-ran-pull");
  return "custom-api-decision-reached-no-task";
}

function runLiveWindowArm(helper, root, cleanup) {
  const fixture = makeFixture(join(root, "live-window"), helper);
  const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    cwd: fixture.session,
    env: closedEnvironment({
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      TEMP: fixture.home,
      TMP: fixture.home,
      BRAIN_NO_WRANGLER_LOGIN: "1",
    }),
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
  assert.ok(Number.isSafeInteger(live.pid) && live.pid > 0, "live-process-not-started");
  try {
    const started = new Date().toISOString();
    writeFileSync(join(fixture.session, "run", "window.lock"), `pid=${live.pid}\nstart=${started}\n`, "ascii");
    writeFileSync(join(fixture.session, "run", "status.txt"), [
      "2026-10-01T13:59:00Z W11 DONE done",
      "2026-10-01T14:00:00Z RUN START start",
      "",
    ].join("\n"), "ascii");
    unregisterTask(cleanup, "before-arm");
    const result = runHelper(fixture, "schedule-store-pull");
    assert.notEqual(result.status, 0, "live-window-refusal-exit-zero");
    assert.equal(result.stdout, "The update window is still working.\n", "live-window-refusal-output-wrong");
    assert.equal(result.stderr, "", "live-window-refusal-stderr-not-empty");
    assert.equal(taskCount(), 0, "live-window-refusal-created-task");
    assert.equal(existsSync(fixture.record), false, "live-window-refusal-ran-pull");
    assert.ok(Math.abs(Date.parse(processCreation(live.pid)) - Date.parse(started)) <= 2000, "live-lock-identity-window-missed");
    return "live-lock-decision-reached-no-task";
  } finally {
    assert.equal(live.kill(), true, "live-process-kill-failed");
    assert.equal(waitForProcessExit(live.pid), true, "live-process-did-not-exit");
  }
}

function runArm(id, helper, root, cleanup) {
  if (id === "S8-REG") return runRegistrationArm(helper, root, cleanup);
  if (id === "S8-REFUSE") return runManifestRefusalArm(helper, root, cleanup);
  if (id === "S8-LIVE-WINDOW") return runLiveWindowArm(helper, root, cleanup);
  throw new Error("unknown-arm");
}

function safeResult(id, status, reason, cleanup = []) {
  return { id, status, reason, cleanup };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.platform !== "win32") throw new Error("windows-required");
  if (!isAbsolute(args.helper) || !existsSync(args.helper)) throw new Error("helper-missing");
  mkdirSync(args.out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "store-pull-wci-"));
  const results = [];
  let controlPassed = false;
  try {
    for (const id of ARMS) {
      const cleanup = [];
      if (id !== "S8-REG" && !controlPassed) {
        results.push(safeResult(id, "VOID", "control-failed", cleanup));
        continue;
      }
      let result;
      try {
        const reason = runArm(id, args.helper, scratch, cleanup);
        result = safeResult(id, "PASS", reason, cleanup);
        if (id === "S8-REG") controlPassed = true;
      } catch (error) {
        result = safeResult(id, "FAIL", String(error?.message ?? "arm-failed").replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 120), cleanup);
      } finally {
        try { unregisterTask(cleanup, "after-arm"); } catch { /* cleanup evidence records the failure */ }
      }
      results.push(result);
    }
  } finally {
    try { unregisterTask([], "final"); } catch { /* final best effort */ }
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(join(args.out, "store-pull-results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  for (const result of results) process.stdout.write(`STORE-ARM ${result.id} ${result.status} ${result.reason}\n`);
  process.exitCode = results.every((result) => result.status === "PASS") ? 0 : 1;
}

main();
