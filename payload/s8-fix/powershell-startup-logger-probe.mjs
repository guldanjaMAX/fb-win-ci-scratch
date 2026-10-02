// One helper-free PowerShell startup/logger probe. Never creates tasks or child fixtures.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length !== 3 || !['--prepare', '--run'].includes(args[0]) || args[1] !== '--out') throw new Error('Use --prepare|--run --out EMPTY_DIRECTORY');
const prepare = args[0] === '--prepare';
if (!prepare && process.platform !== 'win32') throw new Error('Execution requires Windows');
const root = resolve(args[2]);
await mkdir(root, { recursive: true });
if ((await readdir(root)).length) throw new Error('Output must be empty; previous evidence is preserved');
const quote = value => value.replaceAll("'", "''");
const hash = value => createHash('sha256').update(value).digest('hex');
const nonce = randomUUID();
const psRoot = prepare ? 'D:\\a\\fb-win-ci-scratch\\fb-win-ci-scratch\\ci-out\\s8-startup-logger' : root;
const systemRoot = prepare ? 'C:\\Windows' : process.env.SystemRoot ?? process.env.WINDIR;
if (!systemRoot) throw new Error('Windows SystemRoot unavailable');
const ps = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const source = `# Synthetic probe identity: ${nonce}
[Console]::Out.WriteLine('STARTUP_ENTER')
[Console]::Out.Flush()
[Console]::Out.WriteLine(('RUNTIME|{0}|{1}|{2}' -f $PID, $PSVersionTable.PSVersion.ToString(), $PSVersionTable.PSEdition))
[Console]::Out.Flush()
[Console]::Out.WriteLine('DIRECT_WRITE_BEGIN')
[Console]::Out.Flush()
try {
  [System.IO.File]::WriteAllText('${quote(win32.join(psRoot, 'direct-write.txt'))}', 'direct-write-ok' + [Environment]::NewLine, [System.Text.Encoding]::UTF8)
  [Console]::Out.WriteLine('DIRECT_WRITE_OK')
  [Console]::Out.Flush()
} catch {
  [Console]::Error.WriteLine('DIRECT_WRITE_ERROR|' + $_.Exception.GetType().FullName)
  [Console]::Error.Flush()
  exit 41
}
[Console]::Out.WriteLine('LOGGER_BEGIN')
[Console]::Out.Flush()
$DiagPath = '${quote(win32.join(psRoot, 'wrapper-phases.tsv'))}'
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
  } catch {
    [Console]::Error.WriteLine('LOGGER_ERROR|' + $_.Exception.GetType().FullName)
    [Console]::Error.Flush()
  }
}
Write-DiagnosticPhase 'wrapper-entry'
[Console]::Out.WriteLine('LOGGER_RETURN')
[Console]::Out.Flush()
try {
  $Rows = [System.IO.File]::ReadAllLines($DiagPath)
  if ($Rows.Length -ne 1) { throw 'invalid marker count' }
  $Fields = $Rows[0].Split('|')
  if ($Fields.Length -ne 10 -or $Fields[2] -ne [string]$PID -or $Fields[4] -ne 'wrapper-entry' -or $Fields[8] -notmatch '^5\\.' -or $Fields[9] -ne 'Desktop') { throw 'invalid marker row' }
  [Console]::Out.WriteLine('LOGGER_ROW_OK')
  [Console]::Out.Flush()
} catch {
  [Console]::Error.WriteLine('LOGGER_ROW_ERROR|' + $_.Exception.GetType().FullName)
  [Console]::Error.Flush()
  exit 42
}
exit 37
`;
const encoded = Buffer.from(source, 'utf16le').toString('base64');
const argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded];
const commandCharacters = ps.length + 2 + ' -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '.length + encoded.length;
if (commandCharacters >= 30000) throw new Error('Command exceeds reviewed 30000-character cap');
const allowed = ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'Path', 'PATHEXT', 'PSModulePath', 'OS'];
const invocation = { executable: ps, argv, sourceSHA256: hash(source), encodedCommandSHA256: hash(encoded), diagnosticSHA256: hash(await readFile(fileURLToPath(import.meta.url))), commandCharacters, nonce, environmentKeysAllowed: allowed, syntheticEnvironmentKeys: ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'], wrapperTimeoutMs: 8000, outputMaxBufferBytes: 131072, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maximumProbeInvocations: 1, helperOrFixtureImports: false };
await writeFile(join(root, 'probe.ps1'), source);
await writeFile(join(root, 'invocation.json'), JSON.stringify(invocation, null, 2) + '\n');
const receipt = { startedAtUTC: new Date().toISOString(), mode: prepare ? 'PREPARE_ONLY' : 'WINDOWS_RUN', runtime: { node: process.version, platform: process.platform, arch: process.arch }, diagnosticSHA256: invocation.diagnosticSHA256, sourceSHA256: invocation.sourceSHA256, invocationCount: 0, status: prepare ? 'PREPARED_ONLY' : 'STARTING', helperExecuted: false, fixtureExecuted: false, descendantsCreated: false };
await writeFile(join(root, 'probe-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
let pass = prepare;
if (!prepare) {
  const env = Object.fromEntries(allowed.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  Object.assign(env, { USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, BRAIN_NO_WRANGLER_LOGIN: '1' });
  const started = performance.now();
  receipt.invocationCount = 1;
  let result;
  try {
    result = spawnSync(ps, argv, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, timeout: 8000, maxBuffer: 131072 });
  } catch (error) { result = { error }; }
  receipt.elapsedMs = Math.round(performance.now() - started);
  receipt.pid = Number.isInteger(result.pid) && result.pid > 0 ? result.pid : null;
  receipt.exitStatus = result.status ?? null;
  receipt.signal = result.signal ?? null;
  receipt.errorCode = result.error?.code ?? null;
  receipt.errorType = result.error?.name ?? null;
  receipt.status = 'INVOCATION_RETURNED_NEEDS_VALIDATION_AND_TERMINATION_CHECK';
  await writeFile(join(root, 'probe-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  const stdout = result.stdout ?? Buffer.alloc(0), stderr = result.stderr ?? Buffer.alloc(0);
  await writeFile(join(root, 'stdout.bin'), stdout);
  await writeFile(join(root, 'stderr.bin'), stderr);
  receipt.stdoutBytes = stdout.length;
  receipt.stderrBytes = stderr.length;
  const lines = stdout.toString('utf8').trim().split(/\r?\n/u).filter(Boolean);
  receipt.markers = lines.filter(line => !line.startsWith('RUNTIME|'));
  const runtime = lines.find(line => line.startsWith('RUNTIME|'))?.split('|');
  receipt.powerShell = runtime ? { pid: Number(runtime[1]), version: runtime[2], edition: runtime[3] } : null;
  const phases = await readFile(join(root, 'wrapper-phases.tsv'), 'utf8').catch(() => null);
  const direct = await readFile(join(root, 'direct-write.txt'), 'utf8').catch(() => null);
  receipt.phaseFilePresent = phases !== null;
  receipt.phaseRows = phases?.trim().split(/\r?\n/u).filter(Boolean) ?? [];
  receipt.directWriteVerified = direct?.replace(/^\uFEFF/u, '').trim() === 'direct-write-ok';
  const fields = receipt.phaseRows[0]?.split('|') ?? [];
  receipt.phaseRowVerified = receipt.phaseRows.length === 1 && fields.length === 10 && Number(fields[2]) === receipt.pid && fields[4] === 'wrapper-entry' && /^5\./u.test(fields[8]) && fields[9] === 'Desktop';
  const expected = ['STARTUP_ENTER', 'DIRECT_WRITE_BEGIN', 'DIRECT_WRITE_OK', 'LOGGER_BEGIN', 'LOGGER_RETURN', 'LOGGER_ROW_OK'];
  pass = !result.error && !result.signal && result.status === 37 && stderr.length === 0 && JSON.stringify(receipt.markers) === JSON.stringify(expected) && receipt.powerShell?.pid === receipt.pid && /^5\./u.test(receipt.powerShell?.version ?? '') && receipt.powerShell.edition === 'Desktop' && receipt.directWriteVerified && receipt.phaseRowVerified;
  receipt.status = pass ? 'PASS_UNIT_BASELINE_ONLY' : 'FAIL_STOP';
  receipt.terminationEvidence = 'Outer workflow must verify this recorded owned PowerShell PID; no second subprocess is launched here.';
}
receipt.completedAtUTC = new Date().toISOString();
await writeFile(join(root, 'probe-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const inventory = [];
for (const name of (await readdir(root)).sort()) {
  const path = join(root, name), info = await stat(path);
  if (!info.isFile()) throw new Error('Unexpected artifact entry');
  inventory.push({ name, bytes: info.size, sha256: hash(await readFile(path)) });
}
if (inventory.reduce((total, row) => total + row.bytes, 0) > 2097152) throw new Error('Probe artifacts exceed 2MiB internal cap');
await writeFile(join(root, 'artifact-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
console.log(JSON.stringify({ status: receipt.status, invocationCount: receipt.invocationCount, pid: receipt.pid ?? null, elapsedMs: receipt.elapsedMs ?? null, markers: receipt.markers ?? [] }));
process.exitCode = pass ? 0 : 1;
