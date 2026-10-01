import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..");
const PS_DIR = join(OUT, "ps");
const IS_WINDOWS = process.platform === "win32";
const SKIP = !IS_WINDOWS;

if (!IS_WINDOWS && process.env.WCI === "1") {
  test("WCI must execute Windows-only coverage", () => assert.fail("WCI set on a non-Windows host"));
}

function powershellPath() {
  const root = process.env.SystemRoot || process.env.WINDIR;
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runPs(source, options = {}) {
  return spawnSync(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    windowsHide: true,
    ...options,
  });
}

function spawnDiagnostic(result) {
  const error = result.error
    ? `${result.error.code || result.error.name || "spawn"}: ${result.error.message}`
    : "none";
  return `status=${result.status} signal=${result.signal || "none"} error=${error} stderr=${result.stderr || ""}`;
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function scratch(label) {
  return mkdtempSync(join(tmpdir(), `${label} space's-`));
}

test("PowerShell spawn diagnostics include launch errors", { skip: SKIP }, () => {
  const error = Object.assign(new Error("launch failed"), { code: "E2BIG" });
  assert.match(spawnDiagnostic({ status: null, signal: null, error, stderr: undefined }), /error=E2BIG: launch failed/u);
});

test("Windows PowerShell 5.1 parses every payload", { skip: SKIP }, () => {
  for (const name of readdirSync(PS_DIR).filter((entry) => entry.endsWith(".ps1"))) {
    const path = join(PS_DIR, name);
    const parser = `$Utf8=New-Object Text.UTF8Encoding($false,$true); $Source=[IO.File]::ReadAllText(${psQuote(path)},$Utf8); $Tokens=$null; $Errors=$null; [Management.Automation.Language.Parser]::ParseInput($Source,${psQuote(path)},[ref]$Tokens,[ref]$Errors) | Out-Null; if ($Errors.Count -ne 0) { exit 2 }`;
    const result = runPs(parser);
    assert.equal(result.status, 0, `${name}: ${spawnDiagnostic(result)}`);
  }
});

test("session folder follows the helper path when cwd differs on Windows", { skip: SKIP }, async () => {
  const dir = scratch("session-helper");
  const other = scratch("session-other");
  const copied = join(dir, "fb-probe.mjs");
  try {
    await cp(join(OUT, "fb-probe.mjs"), copied);
    writeFileSync(join(dir, "REHEARSAL.marker"), "probe-sentence\n");
    const stdout = execFileSync(process.execPath, [copied, "start"], {
      cwd: other,
      encoding: "utf8",
      env: { ...process.env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    assert.match(stdout, /^READY$/m);
    assert.equal(existsSync(join(dir, "probe-results.txt")), true);
    assert.equal(existsSync(join(other, "probe-results.txt")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("stub runs correct pin and reaches wrong-pin refusal", { skip: SKIP }, async () => {
  const { buildStub } = await import("../fb-probe.mjs");
  const dir = scratch("stub");
  const probe = join(dir, "probe");
  await mkdir(probe, { recursive: true });
  const fixture = "param([string]$SessionDir,[string]$Phase)\n[IO.File]::WriteAllText((Join-Path $SessionDir 'fixture-ran.txt'), ('phase=' + $Phase), [Text.Encoding]::ASCII)\n";
  writeFileSync(join(probe, "window.ps1"), fixture, "utf8");
  const pin = createHash("sha256").update(fixture).digest("hex");
  const good = buildStub({ sessionDir: dir, phase: "1", expectedHash: pin });
  assert.equal(runPs(good.text).status, 0);
  assert.equal(readFileSync(join(dir, "fixture-ran.txt"), "utf8"), "phase=1");

  await rm(join(dir, "fixture-ran.txt"), { force: true });
  const wrong = buildStub({ sessionDir: dir, phase: "1", expectedHash: "0".repeat(64) });
  assert.equal(runPs(wrong.text).status, 0);
  assert.equal(existsSync(join(dir, "fixture-ran.txt")), false);
  assert.match(readFileSync(join(dir, "probe-results.txt"), "utf8"), /stop=fingerprint/);
  await rm(dir, { recursive: true, force: true });
});

test("DPAPI reads in a second process and rejects a tampered copy", { skip: SKIP }, async () => {
  const dir = scratch("dpapi");
  const cipher = join(dir, "value.dpapi");
  const recovered = join(dir, "recovered.txt");
  const reached = join(dir, "tamper-reached.txt");
  const parts = ["AbCdEfGhIjKlMnOpQrSt", "UvWxYz0123456789_-ab"];
  const plain = parts.join("");
  const save = `$Ascii=New-Object Text.ASCIIEncoding; $Plain=${psQuote(plain)}; $Secure=ConvertTo-SecureString -String $Plain -AsPlainText -Force; $Cipher=ConvertFrom-SecureString -SecureString $Secure; [IO.File]::WriteAllText(${psQuote(cipher)},$Cipher,$Ascii)`;
  const saved = runPs(save);
  assert.equal(saved.status, 0, spawnDiagnostic(saved));
  const read = `$Ascii=New-Object Text.ASCIIEncoding; $Cipher=[IO.File]::ReadAllText(${psQuote(cipher)},$Ascii); $Secure=ConvertTo-SecureString -String $Cipher; $Ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure); try { $Plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($Ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Ptr) }; [IO.File]::WriteAllText(${psQuote(recovered)},$Plain,$Ascii)`;
  const readBack = runPs(read);
  assert.equal(readBack.status, 0, spawnDiagnostic(readBack));
  assert.deepEqual(readFileSync(recovered), Buffer.from(plain, "ascii"));

  const text = readFileSync(cipher, "utf8").trim();
  // Change the blob's first hex digit to a different value (same place the CI's own DPAPI tamper control changes).
  // A middle digit can land on a case-only change (hex is case-insensitive) or outside what DPAPI checks.
  const changed = (/^[aA]/.test(text) ? "B" : "A") + text.slice(1);
  const tampered = join(dir, "tampered.dpapi");
  writeFileSync(tampered, changed, "ascii");
  const check = `$Ascii=New-Object Text.ASCIIEncoding; [IO.File]::WriteAllText(${psQuote(reached)},'yes',$Ascii); try { $Cipher=[IO.File]::ReadAllText(${psQuote(tampered)},$Ascii); $null=ConvertTo-SecureString -String $Cipher; exit 3 } catch { exit 0 }`;
  const rejected = runPs(check);
  assert.equal(existsSync(reached), true);
  assert.equal(rejected.status, 0, spawnDiagnostic(rejected));
  await rm(dir, { recursive: true, force: true });
});

test("scheduled task starts the pinned stub and always unregisters", { skip: SKIP, timeout: 90_000 }, async () => {
  const { runProbe } = await import("../fb-probe.mjs");
  const dir = scratch("task");
  writeFileSync(join(dir, "REHEARSAL.marker"), "probe-window\n");
  const taskName = `WCI probe ${randomBytes(8).toString("hex")}`;
  const fixture = "param([string]$SessionDir,[string]$Phase)\n[IO.File]::WriteAllText((Join-Path $SessionDir 'task-ran.txt'), ('phase=' + $Phase), [Text.Encoding]::ASCII)\n";
  const unregister = `Unregister-ScheduledTask -TaskName ${psQuote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue`;
  let outcome;
  try {
    outcome = await runProbe(["start"], { sessionDir: dir, taskName, logonType: "Interactive", windowSource: fixture });
    if (outcome.lines.includes("WINDOW 1: NOT OPENED no-heartbeat")) {
      process.stdout.write("interactive=unavailable\n");
      outcome = await runProbe(["start"], { sessionDir: dir, taskName, logonType: "S4U", windowSource: fixture });
    }
    assert.ok(outcome.lines.includes("WINDOW 1: OPENED (task)"), outcome.lines.join("\n"));
    assert.equal(readFileSync(join(dir, "task-ran.txt"), "utf8"), "phase=1");
    assert.match(readFileSync(join(dir, "probe", "window.lock"), "utf8"), /^pid=[0-9]+\nstart=.+\nphase=1\n$/);
  } finally {
    runPs(unregister);
    await rm(dir, { recursive: true, force: true });
  }
});
