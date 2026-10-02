// Synthetic, finite Windows pipe diagnostic. Never registers a scheduled task.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIMIT_MS = 8000;
const OUTPUT_LIMIT = 128 * 1024;
const ARTIFACT_LIMIT = 2 * 1024 * 1024;
const COMMAND_LIMIT = 30000; // Below the 32767-character CreateProcess limit, including flags/path.
const cases = [
  { name: "quiet-control", pressure: false, inherited: false },
  { name: "output-pressure-only", pressure: true, inherited: false },
  { name: "inherited-handles-only", pressure: false, inherited: true },
];
const args = process.argv.slice(2);
if (args.length !== 3 || !["--prepare", "--run"].includes(args[0]) || args[1] !== "--out") {
  throw new Error("Use --prepare|--run --out EMPTY_ARTIFACT_DIRECTORY with HELPER_PATH set");
}
if (!process.env.HELPER_PATH) throw new Error("HELPER_PATH must identify the existing reviewed scratch helper");
const prepareOnly = args[0] === "--prepare";
if (!prepareOnly && process.platform !== "win32") throw new Error("Execution requires Windows; use --prepare for local review");
const root = resolve(args[2]);
await mkdir(root, { recursive: true });
if ((await readdir(root)).length) throw new Error("Artifact directory must be empty; prior results are preserved");
const helperPath = resolve(process.env.HELPER_PATH);
const helperBytes = await readFile(helperPath);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const helperSha = hash(helperBytes);
const diagnosticSha = hash(await readFile(fileURLToPath(import.meta.url)));
const { buildStorePullAction } = await import(pathToFileURL(helperPath).href);
const quotePS = (value) => String(value).replaceAll("'", "''");
const anchorReview = [];
function encodeCommand(source, executable) {
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  const characters = executable.length + 2 + " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ".length + encoded.length;
  if (characters >= COMMAND_LIMIT) throw new Error("Encoded diagnostic command exceeds its reviewed length cap; do not execute");
  return { encoded, characters };
}

function instrument(source, phasePath) {
  // Every anchor must be present exactly once. Original statements stay intact.
  const anchors = [
    ["$Process = [System.Diagnostics.Process]::Start($StartInfo)", "before-process-start", "after-process-start"],
    ["  $StdoutDrain = $Process.StandardOutput.BaseStream.CopyToAsync([System.IO.Stream]::Null)", "before-stdout-copy", "after-stdout-copy"],
    ["  $StderrDrain = $Process.StandardError.BaseStream.CopyToAsync([System.IO.Stream]::Null)", "before-stderr-copy", "after-stderr-copy"],
    ["  while (-not $Process.WaitForExit(250)) {", "before-wait-loop", null],
    ["  $ExitCode = $Process.ExitCode", "after-child-exit", "child-exit-code-read"],
    ["    [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($StdoutDrain, $StderrDrain), 1000)", "before-post-exit-wait-all", "after-post-exit-wait-all"],
    ["  try { $Process.StandardOutput.Close() } catch { }", "before-stdout-close", "after-stdout-close-attempt"],
    ["  try { $Process.StandardError.Close() } catch { }", "before-stderr-close", "after-stderr-close-attempt"],
    ["  try { $Process.Dispose() } catch { }", "before-process-dispose", "after-process-dispose-attempt"],
    ["exit $ExitCode", "before-wrapper-exit", null],
  ];
  for (const [anchor, before, after] of anchors) {
    if (source.split(anchor).length !== 2) throw new Error(`Instrumentation anchor absent or ambiguous: ${before}`);
    anchorReview.push({ anchor, before, after });
    const childPid = before === "before-process-start" ? "\nif ($null -ne $Process) { $DiagChildPid = $Process.Id }" : "";
    source = source.replace(anchor, `Write-DiagnosticPhase '${before}'\n${anchor}${childPid}${after ? `\nWrite-DiagnosticPhase '${after}'` : ""}`);
  }
  const prefix = `$DiagPath = '${quotePS(phasePath)}'
$DiagClock = [System.Diagnostics.Stopwatch]::StartNew()
$DiagCount = 0
$DiagChildPid = 0
function Write-DiagnosticPhase([string]$Phase) {
  try {
    if ($script:DiagCount -ge 512) { return }
    $script:DiagCount += 1
    $OutState = if ($null -eq $StdoutDrain) { 'not-created' } else { [string]$StdoutDrain.Status }
    $ErrState = if ($null -eq $StderrDrain) { 'not-created' } else { [string]$StderrDrain.Status }
    $Code = if ($null -eq $ExitCode) { 'unset' } else { [string]$ExitCode }
    $Line = '{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8}|{9}' -f [DateTime]::UtcNow.ToString('o'), [long]$DiagClock.Elapsed.TotalMilliseconds, $PID, $DiagChildPid, $Phase, $OutState, $ErrState, $Code, $PSVersionTable.PSVersion.ToString(), $PSVersionTable.PSEdition
    [System.IO.File]::AppendAllText($DiagPath, $Line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
  } catch { }
}
Write-DiagnosticPhase 'wrapper-entry'
`;
  return prefix + source;
}

function fixtureSource(spec, files, nonce) {
  return `import { spawn } from 'node:child_process';
import { appendFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
const state = { nonce: ${JSON.stringify(nonce)}, pid: process.pid, startedAt: new Date().toISOString(), phase: 'entry', stdoutProduced: 0, stderrProduced: 0, stdoutAttempted: 0, stderrAttempted: 0, descendantPid: null, argv: process.argv.slice(2), stdoutTty: process.stdout.isTTY === true, stderrTty: process.stderr.isTTY === true };
function progress(phase, history = false) {
  state.phase = phase;
  state.observedAt = new Date().toISOString();
  writeFileSync(${JSON.stringify(files.progress + ".tmp")}, JSON.stringify(state) + '\\n');
  renameSync(${JSON.stringify(files.progress + ".tmp")}, ${JSON.stringify(files.progress)});
  if (history) appendFileSync(${JSON.stringify(files.history)}, JSON.stringify(state) + '\\n');
}
progress('entry', true);
${spec.pressure ? `const block = Buffer.alloc(65536, 120);
function writeBlock(fd, key) {
  let offset = 0;
  state[key + 'Attempted'] += block.length;
  progress('before-' + key + '-block');
  while (offset < block.length) {
    const written = writeSync(fd, block, offset, block.length - offset);
    if (written <= 0) throw new Error('synthetic write made no progress');
    offset += written;
    state[key + 'Produced'] += written;
    progress('after-' + key + '-write');
  }
  progress('after-' + key + '-block', true);
}
for (let i = 0; i < 64; i += 1) { writeBlock(1, 'stdout'); writeBlock(2, 'stderr'); }` : ""}
${spec.inherited ? `const descendant = spawn(process.execPath, [${JSON.stringify(files.descendant)}, ${JSON.stringify(nonce)}], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
state.descendantPid = descendant.pid;
progress('descendant-spawned', true);
descendant.unref();` : ""}
progress('before-exit-37', true);
process.exit(37);
`;
}

function cleanupScript(identities, cleanupPath) {
  return `$ErrorActionPreference = 'Stop'
$Results = @()
${identities.map((identity) => `$TargetPid = ${identity.pid}
$Role = '${identity.role}'
$ExpectedExe = '${quotePS(identity.executable)}'
$ExpectedToken = '${quotePS(identity.commandToken)}'
$ExpectedNonceArgument = '${quotePS(identity.commandNonce ?? "")}'
$NoncePattern = '(?:^|\\s|")' + [regex]::Escape($ExpectedNonceArgument) + '(?:$|\\s|")'
$Entry = @{ role = $Role; pid = $TargetPid; presentBefore = $false; identityMatched = $false; result = 'UNKNOWN' }
try {
  $Found = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetPid"
  if ($null -eq $Found) { $Entry.result = 'NOT_PRESENT' }
  else {
    $Entry.presentBefore = $true
    $Entry.identityMatched = (($Found.ExecutablePath -ieq $ExpectedExe) -and ([string]$Found.CommandLine).IndexOf($ExpectedToken, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and (($ExpectedNonceArgument -eq '') -or ([string]$Found.CommandLine -match $NoncePattern)))
    if (-not $Entry.identityMatched) { $Entry.result = 'IDENTITY_MISMATCH_NOT_STOPPED' }
    else {
      Stop-Process -Id $TargetPid -Force -ErrorAction Stop
      $After = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetPid"
      if ($null -eq $After) { $Entry.result = 'TERMINATED_CONFIRMED' }
      elseif (([string]$After.CommandLine).IndexOf($ExpectedToken, [StringComparison]::OrdinalIgnoreCase) -lt 0) { $Entry.result = 'ORIGINAL_GONE_PID_REUSED' }
      else { $Entry.result = 'STILL_PRESENT_AFTER_STOP' }
    }
  }
} catch { $Entry.result = 'CHECK_OR_STOP_ERROR'; $Entry.errorType = $_.Exception.GetType().FullName }
$Results += $Entry
`).join("\n")}
[System.IO.File]::WriteAllText('${quotePS(cleanupPath)}', (ConvertTo-Json -InputObject @($Results) -Depth 3), (New-Object System.Text.UTF8Encoding -ArgumentList $false))
`;
}

const plans = [];
for (const spec of cases) {
  const dir = join(root, spec.name);
  await mkdir(dir);
  const files = {
    cli: join(dir, "fixture with spaces.mjs"), manifest: join(dir, "manifest with spaces.json"),
    descendant: join(dir, "quiet descendant.mjs"), descendantRecord: join(dir, "descendant-record.json"),
    progress: join(dir, "fixture-progress.json"), history: join(dir, "fixture-progress.jsonl"),
    phases: join(dir, "wrapper-phases.tsv"), wrapper: join(dir, "instrumented-wrapper.ps1"),
  };
  const nonce = randomUUID();
  await writeFile(files.manifest, "{}\n");
  await writeFile(files.cli, fixtureSource(spec, files, nonce));
  await writeFile(files.descendant, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(files.descendantRecord)}, JSON.stringify({ nonce: process.argv[2], pid: process.pid, startedAt: new Date().toISOString(), phase: 'holding-inherited-handles', stdoutProduced: 0, stderrProduced: 0 }) + '\\n');\nsetTimeout(() => process.exit(0), 15000);\n`);
  const action = buildStorePullAction({ nodePath: process.execPath, cliPath: files.cli, manifestPath: files.manifest });
  const source = instrument(action.source, files.phases);
  await writeFile(join(dir, "original-wrapper.ps1"), action.source);
  await writeFile(files.wrapper, source);
  const reviewPs = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const encoded = encodeCommand(source, reviewPs);
  // This file is for parser/size review only and is never invoked. Synthetic PIDs are deliberate.
  const reviewCleanup = cleanupScript([
    { role: "wrapper", pid: 12345, executable: reviewPs, commandToken: encoded.encoded.slice(0, 1024) },
    { role: "fixture", pid: 12346, executable: process.execPath, commandToken: files.cli },
    { role: "descendant", pid: 12347, executable: process.execPath, commandToken: files.descendant, commandNonce: nonce },
  ], join(dir, "cleanup-results.json"));
  await writeFile(join(dir, "cleanup-review-only.ps1"), reviewCleanup);
  const cleanupLength = encodeCommand(reviewCleanup, reviewPs).characters;
  const plan = { ...spec, files, nonce, originalSourceSha256: hash(action.source), instrumentedSourceSha256: hash(source), encoded: encoded.encoded, wrapperCommandCharacters: encoded.characters, cleanupReviewCommandCharacters: cleanupLength };
  plans.push(plan);
  await writeFile(join(dir, "fixture-plan.json"), JSON.stringify({ ...spec, nonce, expectedChildExit: 37, expectedProducedPerStream: spec.pressure ? 4194304 : 0, wrapperTimeoutMs: LIMIT_MS, inheritedHoldMs: spec.inherited ? 15000 : 0, originalSourceSha256: plan.originalSourceSha256, instrumentedSourceSha256: plan.instrumentedSourceSha256, wrapperCommandCharacters: plan.wrapperCommandCharacters, cleanupReviewCommandCharacters: cleanupLength }, null, 2) + "\n");
}
await writeFile(join(root, "instrumentation-anchors.json"), JSON.stringify(anchorReview.slice(0, 10), null, 2) + "\n");

const receipt = {
  schema: 1, mode: prepareOnly ? "PREPARE_ONLY" : "WINDOWS_RUN", startedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch }, harnessPid: process.pid,
  helperSha256: helperSha, diagnosticSourceSha256: diagnosticSha, limits: { wrapperTimeoutMs: LIMIT_MS, wrapperOutputMaxBufferBytes: OUTPUT_LIMIT, artifactBytes: ARTIFACT_LIMIT, phaseLinesPerCase: 512, encodedCommandCharacters: COMMAND_LIMIT },
  algorithmChanged: false, scheduledTasksUsed: false, cases: [],
};
const saveReceipt = () => writeFile(join(root, "diagnostic-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
async function readJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
await saveReceipt();

if (!prepareOnly) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error("Windows SystemRoot unavailable");
  const ps = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const allowed = ["SystemRoot", "WINDIR", "ComSpec", "PATH", "Path", "PATHEXT", "PSModulePath", "OS"];
  const env = Object.fromEntries(allowed.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  Object.assign(env, { USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, BRAIN_NO_WRANGLER_LOGIN: "1" });
  let stopped = false;
  for (const plan of plans) {
    if (stopped) { receipt.cases.push({ name: plan.name, status: "NOT_RUN", reason: "earlier decisive failure" }); continue; }
    const wrapperCommand = encodeCommand(await readFile(plan.files.wrapper, "utf8"), ps);
    const failures = [];
    let result = null;
    let elapsedMs = null;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let progress = null;
    let descendant = null;
    let markers = [];
    let cleanup = null;
    let cleanupEntries = null;
    let cleanupCommandCharacters = null;
    let identityResolution = [];
    const recordError = (operation, error) => failures.push(`${operation}: ${error.code ?? error.name ?? "unknown error"}`);
    async function retain(path, bytes) {
      try { await writeFile(path, bytes); } catch (error) { recordError("artifact retention failed", error); }
    }
    try {
      const started = performance.now();
      result = spawnSync(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", wrapperCommand.encoded], {
        env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true, timeout: LIMIT_MS, maxBuffer: OUTPUT_LIMIT,
      });
      elapsedMs = Math.round(performance.now() - started);
      stdout = result.stdout ?? stdout;
      stderr = result.stderr ?? stderr;
      await retain(join(root, plan.name, "wrapper-stdout.bin"), stdout);
      await retain(join(root, plan.name, "wrapper-stderr.bin"), stderr);
    } catch (error) {
      recordError("wrapper launch or processing failed", error);
    } finally {
      // Always reread owned records here, including when retaining raw output failed.
      progress = await readJson(plan.files.progress);
      descendant = await readJson(plan.files.descendantRecord);
      const phases = await readFile(plan.files.phases, "utf8").catch(() => "");
      markers = phases.trim().split(/\r?\n/u).filter(Boolean).map((line) => line.split("|"));
      if (result?.error) failures.push(`wrapper error ${result.error.code ?? result.error.name}`);
      if (result?.signal) failures.push(`wrapper signal ${result.signal}`);
      if (result?.status !== 37) failures.push(`wrapper exit ${result?.status ?? "unrecorded"}, expected 37`);
      if (elapsedMs === null || elapsedMs >= 6000) failures.push(`wrapper elapsed ${elapsedMs}ms, expected below 6000ms`);
      if (stdout.length || stderr.length) failures.push("wrapper produced output");
      if (!progress || progress.nonce !== plan.nonce || progress.phase !== "before-exit-37") failures.push("fixture did not reach recorded exit boundary");
      const expectedBytes = plan.pressure ? 4194304 : 0;
      if (progress && (progress.stdoutProduced !== expectedBytes || progress.stderrProduced !== expectedBytes)) failures.push("produced-byte totals differ from this case's expected totals");
      if (!markers.some((marker) => marker[4] === "before-wrapper-exit")) failures.push("wrapper exit phase not observed");
      for (const required of ["wrapper-entry", "after-process-start", "after-stdout-copy", "after-stderr-copy", "before-wait-loop", "after-child-exit", "after-post-exit-wait-all", "after-stdout-close-attempt", "after-stderr-close-attempt", "after-process-dispose-attempt"]) {
        if (!markers.some((marker) => marker[4] === required)) failures.push(`required phase missing: ${required}`);
      }
      if (progress && (progress.stdoutTty || progress.stderrTty)) failures.push("fixture unexpectedly had a terminal");
      if (progress && JSON.stringify(progress.argv) !== JSON.stringify(["custom-api", plan.files.manifest])) failures.push("fixture arguments differ");

      const validPid = (pid) => Number.isInteger(pid) && pid > 0 && pid <= 2147483647 && pid !== process.pid;
      // These rows came from this case's exact retained file. Require complete rows,
      // valid elapsed/runtime fields, and agreement with the spawn receipt when present.
      const ownMarkers = markers.filter((marker) => marker.length === 10 && Number.isFinite(Date.parse(marker[0])) && Number.isFinite(Number(marker[1])) && Number(marker[1]) >= 0 && validPid(result?.pid) && Number(marker[2]) === result.pid && /^5\./u.test(marker[8]) && marker[9] === "Desktop");
      const progressOwned = progress?.nonce === plan.nonce;
      const descendantOwned = descendant?.nonce === plan.nonce;
      const sources = [
        { role: "wrapper", executable: ps, commandToken: wrapperCommand.encoded.slice(0, 1024), candidates: [result?.pid, ...ownMarkers.map((marker) => Number(marker[2]))] },
        { role: "fixture", executable: process.execPath, commandToken: plan.files.cli, candidates: [progressOwned ? progress.pid : null, ...ownMarkers.map((marker) => Number(marker[3]))] },
        ...(plan.inherited ? [{ role: "descendant", executable: process.execPath, commandToken: plan.files.descendant, commandNonce: plan.nonce, candidates: [progressOwned ? progress.descendantPid : null, descendantOwned ? descendant.pid : null] }] : []),
      ];
      const identities = [];
      identityResolution = sources.map(({ role, executable, commandToken, commandNonce, candidates }) => {
        const pids = [...new Set(candidates.filter(validPid))];
        const status = pids.length === 1 ? "RECORDED_PID" : pids.length ? "CONFLICTING_RECORDED_PIDS_UNVERIFIED" : "MISSING_RECORDED_PID_UNVERIFIED";
        if (pids.length !== 1) failures.push(`${role} cleanup identity unresolved: ${status}`);
        // Even conflicting own recorded candidates are only stopped after the exact
        // executable + unique generated command identity check in cleanupScript.
        for (const pid of pids) identities.push({ role, pid, executable, commandToken, commandNonce });
        return { role, status, pids };
      });
      const cleanupPath = join(root, plan.name, "cleanup-results.json");
      try {
        if (!identities.length) throw new Error("no recorded owned PID available for cleanup");
        const cleanupSource = cleanupScript(identities, cleanupPath);
        const cleanupCommand = encodeCommand(cleanupSource, ps);
        cleanupCommandCharacters = cleanupCommand.characters;
        await retain(join(root, plan.name, "cleanup.ps1"), cleanupSource);
        // Retention failure cannot bypass cleanup. The reviewed encoded copy is used.
        cleanup = spawnSync(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", cleanupCommand.encoded], {
          env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true, timeout: LIMIT_MS, maxBuffer: OUTPUT_LIMIT,
        });
        await retain(join(root, plan.name, "cleanup-stdout.bin"), cleanup.stdout ?? Buffer.alloc(0));
        await retain(join(root, plan.name, "cleanup-stderr.bin"), cleanup.stderr ?? Buffer.alloc(0));
        cleanupEntries = await readJson(cleanupPath);
      } catch (error) {
        recordError("owned PID cleanup failed or unverified", error);
      }
      if (plan.inherited) {
        const holder = Array.isArray(cleanupEntries) ? cleanupEntries.find((entry) => entry.role === "descendant") : null;
        if (!descendantOwned || !holder?.presentBefore || !holder?.identityMatched || descendant.pid !== holder.pid) failures.push("inherited holder not confirmed alive with this fixture identity at cleanup check");
      }
      if (!cleanup || cleanup.error || cleanup.status !== 0 || !Array.isArray(cleanupEntries) || cleanupEntries.length !== identities.length || cleanupEntries.some((entry) => !["NOT_PRESENT", "TERMINATED_CONFIRMED", "ORIGINAL_GONE_PID_REUSED"].includes(entry.result))) failures.push("fixture cleanup incomplete or unverified");
      receipt.cases.push({
        name: plan.name, status: failures.length ? "FAIL_STOP" : "PASS", failures, elapsedMs, wrapperCommandCharacters: wrapperCommand.characters, cleanupCommandCharacters,
        wrapper: { pid: result?.pid ?? null, status: result?.status ?? null, signal: result?.signal ?? null, error: result?.error ? { code: result.error.code, name: result.error.name } : null, stdoutBytes: stdout.length, stderrBytes: stderr.length, powerShellVersion: markers[0]?.[8] ?? null, powerShellEdition: markers[0]?.[9] ?? null },
        lastPhase: markers.at(-1) ?? null, phaseCount: markers.length, fixtureProgress: progress, descendantRecord: descendant,
        cleanup: { status: cleanup?.status ?? null, signal: cleanup?.signal ?? null, errorCode: cleanup?.error?.code ?? null, identityResolution, entries: cleanupEntries },
      });
      stopped = failures.length > 0;
      try { await saveReceipt(); } catch (error) { recordError("receipt retention failed", error); receipt.cases.at(-1).status = "FAIL_STOP"; stopped = true; }
    }

  }
}

receipt.helperUnchanged = hash(await readFile(helperPath)) === helperSha;
if (!receipt.helperUnchanged) throw new Error("Existing helper changed during diagnostic; stop");
receipt.completedAt = new Date().toISOString();
receipt.status = prepareOnly ? "PREPARED_NOT_EXECUTED" : receipt.cases.some((entry) => entry.status === "FAIL_STOP") ? "FAIL_STOP" : "PASS";
await saveReceipt();
async function inventory(dir, prefix = "") {
  const entries = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const relative = join(prefix, item.name);
    if (item.isDirectory()) entries.push(...await inventory(join(dir, item.name), relative));
    else if (item.isFile()) { const bytes = await readFile(join(dir, item.name)); entries.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) }); }
    else throw new Error("Unexpected non-file artifact; stop diagnostic");
  }
  return entries;
}
const files = await inventory(root);
const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
await writeFile(join(root, "artifact-inventory.json"), JSON.stringify({ files, totalBytes, limitBytes: ARTIFACT_LIMIT, withinLimit: totalBytes < ARTIFACT_LIMIT }, null, 2) + "\n");
if (totalBytes >= ARTIFACT_LIMIT) throw new Error("Diagnostic artifact cap exceeded; stop diagnostic");
console.log(JSON.stringify({ status: receipt.status, cases: receipt.cases.map(({ name, status, failures, lastPhase }) => ({ name, status, failures, lastPhase })), artifactBytes: totalBytes, helperUnchanged: receipt.helperUnchanged }));
if (receipt.status === "FAIL_STOP") process.exitCode = 1;
