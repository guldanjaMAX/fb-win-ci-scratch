import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const STORE_PULL_TASK_NAME = "Financial Brain store data 8AM";
const STORE_PULL_SUCCESS = "Store data will now load every day at 8:00 AM.";
const STEPS = new Set(["RUN", "W1", "W3", "W4", "W5", "W6", "W7", "W8", "W11"]);
const CODES = new Set(["START", "PASS", "INFO", "SKIP", "WAITING", "STOP", "DONE"]);
const DECISION_WORDS = new Set([
  "continue", "finish-later", "wait", "retry", "restore", "keep", "deploy-recover", "stop", "key-visible",
]);
const CREDENTIAL_ACTION = /(?:--key(?:\s|=)|CLOUDFLARE_API_TOKEN|CF_API_TOKEN|BRAIN_ADMIN_KEY)/iu;

function quotePowerShell(value) {
  return String(value).replaceAll("'", "''");
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

export function quoteWindowsArgument(value) {
  const text = String(value);
  if (!text || /[\s"]/u.test(text)) {
    let quoted = '"';
    let backslashes = 0;
    for (const character of text) {
      if (character === "\\") {
        backslashes += 1;
      } else if (character === '"') {
        quoted += "\\".repeat(backslashes * 2 + 1) + '"';
        backslashes = 0;
      } else {
        quoted += "\\".repeat(backslashes) + character;
        backslashes = 0;
      }
    }
    return quoted + "\\".repeat(backslashes * 2) + '"';
  }
  return text;
}

function checkedActionPath(value, label) {
  const text = String(value);
  if (!text || /[\0\r\n"]/u.test(text)) throw new Error(`${label} is not safe for a Windows task action`);
  return text;
}

export function buildStorePullAction({ nodePath, cliPath, manifestPath }) {
  const node = checkedActionPath(nodePath, "node path");
  const cli = checkedActionPath(cliPath, "CLI path");
  const manifest = checkedActionPath(manifestPath, "manifest path");
  const argumentsLine = [quoteWindowsArgument(cli), "custom-api", quoteWindowsArgument(manifest)].join(" ");
  const source = String.raw`$ErrorActionPreference = 'Stop'
$StartInfo = New-Object System.Diagnostics.ProcessStartInfo
$StartInfo.FileName = '${quotePowerShell(node)}'
$StartInfo.Arguments = '${quotePowerShell(argumentsLine)}'
$StartInfo.UseShellExecute = $false
$StartInfo.RedirectStandardOutput = $true
$StartInfo.RedirectStandardError = $true
$StartInfo.CreateNoWindow = $true
$StartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$StartInfo.EnvironmentVariables['BRAIN_NO_WRANGLER_LOGIN'] = '1'
$Process = [System.Diagnostics.Process]::Start($StartInfo)
if ($null -eq $Process) { exit 1 }
$ExitCode = 1
try {
  $StdoutDrain = $Process.StandardOutput.BaseStream.CopyToAsync([System.IO.Stream]::Null)
  $StderrDrain = $Process.StandardError.BaseStream.CopyToAsync([System.IO.Stream]::Null)
  while (-not $Process.WaitForExit(250)) {
    if ($StdoutDrain.IsFaulted -or $StdoutDrain.IsCanceled -or $StderrDrain.IsFaulted -or $StderrDrain.IsCanceled) {
      if (-not $Process.HasExited) { throw 'store pull output drain failed' }
    }
  }
  $ExitCode = $Process.ExitCode
  try {
    [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($StdoutDrain, $StderrDrain), 1000)
  } catch { }
} catch {
  try {
    if ($Process.HasExited) { $ExitCode = $Process.ExitCode }
    else { $Process.Kill(); [void]$Process.WaitForExit(1000) }
  } catch { }
} finally {
  try { $Process.StandardOutput.Close() } catch { }
  try { $Process.StandardError.Close() } catch { }
  try { $Process.Dispose() } catch { }
}
exit $ExitCode
`;
  if (CREDENTIAL_ACTION.test(argumentsLine) || CREDENTIAL_ACTION.test(source)) {
    throw new Error("credential material is not allowed in the task action");
  }
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  return Object.freeze({ source, encoded, argumentsLine });
}

export function fillStorePullRegister({ taskName = STORE_PULL_TASK_NAME, powerShell, actionEncoded }) {
  const actionArguments = `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${actionEncoded}`;
  return String.raw`$ErrorActionPreference = 'Stop'
$TaskName = '${quotePowerShell(taskName)}'
$Action = New-ScheduledTaskAction -Execute '${quotePowerShell(powerShell)}' -Argument '${quotePowerShell(actionArguments)}'
$Trigger = New-ScheduledTaskTrigger -Daily -At '08:00'
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(30))
$User = "$env:USERDOMAIN\$env:USERNAME"
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
`;
}

function storePullUnregisterSource(taskName) {
  return String.raw`$ErrorActionPreference = 'Stop'
$TaskName = '${quotePowerShell(taskName)}'
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $Task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $StopDeadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $Task -or [string]$Task.State -ne 'Running') { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $StopDeadline)
  if ($null -ne $Task -and [string]$Task.State -eq 'Running') { throw 'task did not stop' }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
$RemoveDeadline = [DateTime]::UtcNow.AddSeconds(20)
do {
  $Remaining = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $Remaining) { break }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $RemoveDeadline)
if ($null -ne $Remaining) { throw 'task remained registered' }
exit 0
`;
}

async function regularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readMaybe(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function selectedStorePath(sessionDir, prefix) {
  const matches = (await readdir(sessionDir)).filter((name) => name.startsWith(prefix) && name.endsWith(".txt"));
  if (matches.length !== 1) return null;
  const bytes = await readFile(join(sessionDir, matches[0]));
  if (bytes.length === 0 || bytes.length > 64 * 1024) return null;
  const value = bytes.toString("utf8").trim();
  if (!value || /[\0\r\n]/u.test(value)) return null;
  return resolve(value);
}

function parseLock(bytes) {
  if (!bytes || bytes.length > 1024) return null;
  const text = bytes.toString("ascii");
  const pid = /^pid=(\d+)$/mu.exec(text)?.[1];
  const start = /^start=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/mu.exec(text)?.[1];
  if (!pid || !start) return null;
  return { pid: Number(pid), start };
}

function parseStatusLine(line) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+(\S+)\s+(\S+)\s+(.+)$/u.exec(line.trim());
  if (!match) return null;
  const [, , step, code, tail] = match;
  if (!STEPS.has(step) || !CODES.has(code)) return null;
  const parts = tail.split(/\s+/u);
  let coreCount = 1;
  if (code === "WAITING" || code === "STOP") {
    if (!parts[0] || !parts[1]) return null;
    if (code === "WAITING" && !new Set(["lead", "owner"]).has(parts[0])) return null;
    coreCount = 2;
  }
  const metadata = Object.create(null);
  for (const part of parts.slice(coreCount)) {
    const token = /^(n|id|words)=(\S+)$/u.exec(part);
    if (!token || Object.hasOwn(metadata, token[1])) return null;
    metadata[token[1]] = token[2];
  }
  if (metadata.n && !/^\d+$/u.test(metadata.n)) return null;
  if (metadata.id && !/^[a-f0-9]{6}$/u.test(metadata.id)) return null;
  if (metadata.words) {
    const words = metadata.words.split(",");
    if (!words.length || words.some((word) => !DECISION_WORDS.has(word)) || new Set(words).size !== words.length) return null;
  }
  return { step, code };
}

function decodeStatusRecords(buffer) {
  let encoding = "utf8";
  let start = 0;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = "utf16le";
    start = 2;
  } else if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    start = 3;
  } else if (buffer.length >= 4 && buffer[1] === 0 && buffer[3] === 0) {
    encoding = "utf16le";
  }
  return buffer.subarray(start).toString(encoding).split(/\r\n|\n|\r/u).filter(Boolean);
}

async function storeWindowAlive({ sessionDir, queryProcess }) {
  const lock = parseLock(await readMaybe(join(sessionDir, "run", "window.lock")));
  if (!lock) return false;
  const created = await queryProcess({ pid: lock.pid, start: lock.start });
  if (!created) return false;
  const delta = Math.abs(Date.parse(created) - Date.parse(lock.start));
  return Number.isFinite(delta) && delta <= 2000;
}

async function storeWindowDone(sessionDir) {
  const bytes = await readMaybe(join(sessionDir, "run", "status.txt"));
  if (!bytes) return false;
  const events = decodeStatusRecords(bytes).map(parseStatusLine).filter(Boolean);
  const newest = events.at(-1);
  return newest?.step === "W11" && newest.code === "DONE";
}

function defaultProcessQuery({ pid, spawn, env }) {
  const source = String.raw`$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue
if ($null -ne $p) { [Console]::Out.Write($p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) }
`;
  const result = invokePowerShell(spawn, env, source);
  if (result?.status !== 0) return null;
  return String(result.stdout ?? "").trim() || null;
}

export async function createStorePullScheduler(options = {}) {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const sessionDir = await realpath(options.sessionDir ?? moduleDir);
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? spawnSync;
  const env = options.env ?? process.env;
  const output = options.output ?? ((line) => process.stdout.write(`${line}\n`));
  const taskName = options.taskName ?? STORE_PULL_TASK_NAME;
  const nodePath = resolve(options.nodePath ?? process.execPath);
  const queryProcess = options.queryProcess ?? ((value) => defaultProcessQuery({ ...value, spawn, env }));

  function refuse(line) {
    output(line);
    return false;
  }

  async function schedule() {
    if (platform !== "win32") return refuse("This command only works on Windows.");
    const done = await storeWindowDone(sessionDir);
    if (!done && await storeWindowAlive({ sessionDir, queryProcess })) {
      return refuse("The update window is still working.");
    }

    const prefix = await selectedStorePath(sessionDir, "selected-prefix-");
    const manifestSelection = await selectedStorePath(sessionDir, "selected-manifest-");
    if (!prefix || !manifestSelection || !(await regularFile(manifestSelection))) {
      return refuse("The store data schedule could not find this install.");
    }

    let manifest;
    try {
      const bytes = await readFile(manifestSelection);
      if (bytes.length === 0 || bytes.length > 1024 * 1024) throw new Error("manifest size");
      manifest = JSON.parse(bytes.toString("utf8"));
    } catch {
      return refuse("The store data schedule could not read the manifest.");
    }
    if (!manifest?.corpora || !Object.hasOwn(manifest.corpora, "custom_api")) {
      return refuse("This install does not have store data set up.");
    }

    const cliCandidate = join(prefix, "node_modules", "brain-installer", "brain.mjs");
    if (!(await regularFile(cliCandidate))) {
      return refuse("The installed Brain command could not be found.");
    }
    const cliPath = await realpath(cliCandidate);
    const manifestPath = await realpath(manifestSelection);
    const powerShell = powerShellPath(env);
    if (!powerShell) return refuse("Windows PowerShell could not be found.");

    let child;
    try {
      const action = buildStorePullAction({ nodePath, cliPath, manifestPath });
      const registration = fillStorePullRegister({ taskName, powerShell, actionEncoded: action.encoded });
      child = invokePowerShell(spawn, env, registration);
    } catch {
      child = null;
    }
    if (!child || child.status !== 0 || child.error || child.signal) {
      return refuse("The store data schedule could not be saved.");
    }
    output(STORE_PULL_SUCCESS);
    return true;
  }

  async function unschedule() {
    if (platform !== "win32") return refuse("This command only works on Windows.");
    const powerShell = powerShellPath(env);
    if (!powerShell) return refuse("Windows PowerShell could not be found.");
    let child;
    try {
      child = invokePowerShell(spawn, env, storePullUnregisterSource(taskName));
    } catch {
      child = null;
    }
    if (!child || child.status !== 0 || child.error || child.signal) {
      return refuse("The store data schedule could not be removed.");
    }
    output("The store data schedule was removed.");
    return true;
  }

  return Object.freeze({ schedule, unschedule, sessionDir });
}

async function main() {
  const [verb] = process.argv.slice(2);
  if (verb !== "schedule-store-pull" && verb !== "unschedule-store-pull") {
    process.stdout.write("Unknown store command.\n");
    process.exitCode = 1;
    return;
  }
  const scheduler = await createStorePullScheduler();
  const ok = verb === "schedule-store-pull" ? await scheduler.schedule() : await scheduler.unschedule();
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stdout.write("STORE: ERROR internal\n");
    process.exitCode = 1;
  });
}
