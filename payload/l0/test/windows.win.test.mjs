import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
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

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function scratch(label) {
  return mkdtempSync(join(tmpdir(), `${label} space's-`));
}

test("Windows PowerShell 5.1 parses every payload", { skip: SKIP }, () => {
  for (const name of readdirSync(PS_DIR).filter((entry) => entry.endsWith(".ps1"))) {
    const source = readFileSync(join(PS_DIR, name), "utf8");
    const parser = `$Source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString("base64")}')); $Tokens=$null; $Errors=$null; [Management.Automation.Language.Parser]::ParseInput($Source,[ref]$Tokens,[ref]$Errors) | Out-Null; if ($Errors.Count -ne 0) { exit 2 }`;
    const result = runPs(parser);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
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
  const expected = join(dir, "expected.txt");
  const result = join(dir, "result.txt");
  const parts = ["AbCdEfGhIjKlMnOpQrSt", "UvWxYz0123456789_-ab"];
  const plain = parts.join("");
  const save = `$Plain=${psQuote(plain)}; $Secure=ConvertTo-SecureString $Plain -AsPlainText -Force; ConvertFrom-SecureString $Secure | Set-Content -LiteralPath ${psQuote(cipher)} -Encoding ASCII; $Hash=[Security.Cryptography.SHA256]::Create(); try { $Prefix=([BitConverter]::ToString($Hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Plain)))).Replace('-','').Substring(0,8).ToLowerInvariant() } finally { $Hash.Dispose() }; [IO.File]::WriteAllText(${psQuote(expected)},$Prefix,[Text.Encoding]::ASCII)`;
  assert.equal(runPs(save).status, 0);
  const read = `$Expected=[IO.File]::ReadAllText(${psQuote(expected)}); $Secure=Get-Content -LiteralPath ${psQuote(cipher)} -Raw | ConvertTo-SecureString; $Ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure); try { $Plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($Ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Ptr) }; $Hash=[Security.Cryptography.SHA256]::Create(); try { $Prefix=([BitConverter]::ToString($Hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Plain)))).Replace('-','').Substring(0,8).ToLowerInvariant() } finally { $Hash.Dispose() }; [IO.File]::WriteAllText(${psQuote(result)},$(if($Prefix -eq $Expected){'match'}else{'mismatch'}),[Text.Encoding]::ASCII)`;
  assert.equal(runPs(read).status, 0);
  assert.equal(readFileSync(result, "utf8"), "match");

  const text = readFileSync(cipher, "utf8").trim();
  const at = Math.floor(text.length / 2);
  const changed = text.slice(0, at) + (text[at] === "A" ? "B" : "A") + text.slice(at + 1);
  const tampered = join(dir, "tampered.dpapi");
  writeFileSync(tampered, changed, "ascii");
  const check = `try { $null=Get-Content -LiteralPath ${psQuote(tampered)} -Raw | ConvertTo-SecureString; exit 3 } catch { exit 0 }`;
  assert.equal(runPs(check).status, 0);
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
