import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..");
const HELPER = join(OUT, "fb-probe.mjs");

async function loadHelper(path = HELPER) {
  return import(`${pathToFileURL(path).href}?v=${Date.now()}-${Math.random()}`);
}

function scratch(label) {
  return mkdtempSync(join(tmpdir(), `${label} space's-`));
}

function baseOptions(sessionDir, overrides = {}) {
  const calls = [];
  const writes = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    if (command.toLowerCase().endsWith("powercfg.exe")) {
      if (args[0] === "-query") {
        const seconds = args.at(-1) === "STANDBYIDLE" ? 1200 : 3600;
        return { status: 0, stdout: `Current AC Power Setting Index: 0x${seconds.toString(16).padStart(8, "0")}\n`, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    const decoded = args.at(-2) === "-EncodedCommand"
      ? Buffer.from(args.at(-1), "base64").toString("utf16le")
      : "";
    if (decoded.includes("Get-CimInstance Win32_Process") && decoded.includes("ancestor_windowsapps")) {
      return { status: 0, stdout: "ps_version=5.1.22621\nparent=powershell\nancestor_windowsapps=no\n", stderr: "" };
    }
    if (decoded.includes("Register-ScheduledTask")) {
      return { status: 0, stdout: "register=ok\nstart=ok\n", stderr: "" };
    }
    if (decoded.includes("Unregister-ScheduledTask")) {
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "alive=yes\n", stderr: "" };
  };
  return {
    sessionDir,
    platform: "win32",
    nodeMajor: 24,
    env: {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      LOCALAPPDATA: join(sessionDir, "local"),
      APPDATA: join(sessionDir, "roaming"),
    },
    spawn,
    calls,
    writes,
    onWrite(path, data) { writes.push({ path, data }); },
    sleep: async () => {},
    waitForLock: async () => true,
    now: () => new Date("2026-10-01T07:00:00.000Z"),
    isPidAlive: async () => true,
    randomBytes: (count) => Buffer.alloc(count, 7),
    ...overrides,
  };
}

test("1 marker gate reaches its decision and blocks all side effects", async () => {
  const { runProbe } = await loadHelper();
  for (const value of [null, "", "tier2"]) {
    const dir = scratch("marker");
    if (value !== null) writeFileSync(join(dir, "REHEARSAL.marker"), value);
    let reached = 0;
    const options = baseOptions(dir, { onGate: () => { reached += 1; } });
    const result = await runProbe(["start"], options);
    assert.equal(reached, 1);
    assert.deepEqual(result.lines, ["SAY: Nothing to run yet. See you Friday.", "NEXT: none"]);
    assert.equal(options.calls.length, 0);
    assert.equal(options.writes.length, 0);
    await rm(dir, { recursive: true, force: true });
  }
  for (const value of ["probe-sentence", "probe-window"]) {
    const dir = scratch("marker-valid");
    writeFileSync(join(dir, "REHEARSAL.marker"), `${value}\nignored`);
    let reached = 0;
    const options = baseOptions(dir, { onGate: () => { reached += 1; } });
    const result = await runProbe(["start"], options);
    assert.equal(reached, 1);
    assert.equal(result.lines[0], "READY");
    await rm(dir, { recursive: true, force: true });
  }
});

test("2 sentence mode orders output and covers powercfg outcomes", async () => {
  const { runProbe } = await loadHelper();
  const cases = [
    ["ok", {}],
    ["denied", { spawn: (command, args, options) => {
      const base = baseOptions(scratch("unused")).spawn(command, args, options);
      if (command.toLowerCase().endsWith("powercfg.exe") && args[0] === "-change") return { status: 5, stdout: "", stderr: "" };
      return base;
    } }],
    ["skipped", { spawn: (command, args, options) => {
      const base = baseOptions(scratch("unused")).spawn(command, args, options);
      if (command.toLowerCase().endsWith("powercfg.exe") && args[0] === "-query") return { status: 0, stdout: "Current AC Power Setting Index: 0x0000003d\n", stderr: "" };
      return base;
    } }],
  ];
  for (const [expected, override] of cases) {
    const dir = scratch(`sentence-${expected}`);
    writeFileSync(join(dir, "REHEARSAL.marker"), "probe-sentence\n");
    const result = await runProbe(["start"], baseOptions(dir, override));
    assert.deepEqual(result.lines, [
      "READY",
      "POWERSHELL: 5.1.22621",
      "MSIX: no",
      "SHELL: powershell",
      `POWERCFG WRITE: ${expected}`,
      "SAY: The probe check is done. Nothing else to run.",
      "NEXT: none",
    ]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("3 stub pins bytes, rejects mismatch, strips BOM, and registration is visible", async () => {
  const { buildStub, embeddedScripts } = await loadHelper();
  const session = "C:\\Probe folder's test";
  const built = buildStub({ sessionDir: session, phase: "1", expectedHash: "a".repeat(64) });
  assert.ok(built.encoded.length < 8000);
  assert.match(built.text, /ComputeHash/);
  assert.match(built.text, /String\]::Equals/);
  assert.match(built.text, /stop=fingerprint/);
  assert.match(built.text, /0xEF/);
  assert.match(built.text, /C:\\Probe folder''s test/);
  const register = embeddedScripts["register.ps1"];
  assert.doesNotMatch(register, /WindowStyle\s+Hidden/i);
  assert.match(register, /MultipleInstances\s+IgnoreNew/i);
  assert.match(register, /ExecutionTimeLimit\s+\(\[TimeSpan\]::Zero\)/i);
  assert.match(register, /EndBoundary/);
});

test("4 live lock never opens a second first window", async () => {
  const { runProbe } = await loadHelper();
  const dir = scratch("one-window");
  await mkdir(join(dir, "probe"), { recursive: true });
  writeFileSync(join(dir, "REHEARSAL.marker"), "probe-window\n");
  writeFileSync(join(dir, "probe", "window.lock"), "pid=41\nstart=2026-10-01T07:00:00.000Z\n");
  const options = baseOptions(dir);
  const result = await runProbe(["start"], options);
  assert.ok(result.lines.includes("WINDOW 1: ALREADY OPEN"));
  assert.ok(result.lines.includes("NEXT: follow"));
  assert.equal(options.calls.some((call) => Buffer.from(call.args.at(-1) || "", "base64").toString("utf16le").includes("Register-ScheduledTask")), false);
  await rm(dir, { recursive: true, force: true });
});

test("5 follow handles both done files, death, and cap", async () => {
  const { runProbe } = await loadHelper();
  const one = scratch("follow-one");
  await mkdir(join(one, "probe"), { recursive: true });
  writeFileSync(join(one, "REHEARSAL.marker"), "probe-window\n");
  writeFileSync(join(one, "probe", "window1.done"), "done=yes\n");
  writeFileSync(join(one, "probe", "phase1.txt"), "clip_watch=got-it\ndpapi_save=yes\n");
  const oneOptions = baseOptions(one);
  const oneResult = await runProbe(["follow", "5"], oneOptions);
  assert.ok(oneResult.lines.includes("RESULT clip_watch=got-it"));
  assert.ok(oneResult.lines.includes("WINDOW 2: OPENED (task)"));
  assert.ok(oneOptions.calls.some((call) => Buffer.from(call.args.at(-1) || "", "base64").toString("utf16le").includes("Register-ScheduledTask")));

  const two = scratch("follow-two");
  await mkdir(join(two, "probe"), { recursive: true });
  writeFileSync(join(two, "REHEARSAL.marker"), "probe-window\n");
  writeFileSync(join(two, "probe", "window2.done"), "done=yes\n");
  writeFileSync(join(two, "probe", "phase2.txt"), "dpapi_readback=match\ndpapi_tamper_control=ok\ncleanup=yes\n");
  const twoOptions = baseOptions(two);
  const twoResult = await runProbe(["follow", "5"], twoOptions);
  assert.ok(twoResult.lines.includes("PROBE: DONE"));
  assert.ok(twoOptions.calls.some((call) => Buffer.from(call.args.at(-1) || "", "base64").toString("utf16le").includes("Unregister-ScheduledTask")));

  const dead = scratch("follow-dead");
  await mkdir(join(dead, "probe"), { recursive: true });
  writeFileSync(join(dead, "REHEARSAL.marker"), "probe-window\n");
  writeFileSync(join(dead, "probe", "window.lock"), "pid=42\nstart=2026-10-01T07:00:00.000Z\nphase=1\n");
  const deadResult = await runProbe(["follow", "5"], baseOptions(dead, { isPidAlive: async () => false }));
  assert.ok(deadResult.lines.includes("WINDOW 1: CLOSED EARLY"));

  const wait = scratch("follow-cap");
  await mkdir(join(wait, "probe"), { recursive: true });
  writeFileSync(join(wait, "REHEARSAL.marker"), "probe-window\n");
  const waitResult = await runProbe(["follow", "5"], baseOptions(wait, { isPidAlive: async () => true }));
  assert.deepEqual(waitResult.lines.slice(-2), ["FOLLOW: STILL WAITING", "NEXT: follow"]);
  for (const dir of [one, two, dead, wait]) await rm(dir, { recursive: true, force: true });
});

test("6 output guard hides every planted category and preserves vocabulary", async () => {
  const { guardLines } = await loadHelper();
  const mixed = "Abcdefghijklmnopqrstuvwxyz" + "1234567890_ABCD";
  const longHex = "ab".repeat(16);
  const longerHex = "cd".repeat(32);
  const uuid = ["12345678", "1234", "4abc", "8def", "123456789abc"].join("-");
  const host = ["x", "workers", "dev"].join(".");
  const mail = ["owner", "example.invalid"].join("@");
  const winPath = ["C:", "Users", "owner", "file"].join("\\");
  const unsafe = [mixed, longHex, longerHex, uuid, host, mail, winPath].map((value) => `RESULT cleanup=${value}`);
  const safe = [
    "READY", "POWERSHELL: 5.1.1", "MSIX: no", "SHELL: powershell",
    "POWERCFG WRITE: ok", "WINDOW 1: OPENED (task)", "FOLLOW: STILL WAITING",
    "RESULT cleanup=yes", "PROBE: DONE", "SAY: The probe is finished. Thank you.", "NEXT: none",
  ];
  const guarded = guardLines([...unsafe, ...safe]);
  assert.deepEqual(guarded.slice(0, -1), safe);
  assert.equal(guarded.at(-1), `HIDDEN: ${unsafe.length}`);
});

test("7 session folder comes from the helper location, not cwd", async () => {
  const dir = scratch("session-own");
  const other = scratch("session-cwd");
  const copied = join(dir, "fb-probe.mjs");
  try {
    await cp(HELPER, copied);
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
    if (process.platform === "win32") {
      assert.match(stdout, /^READY$/m);
      assert.equal(existsSync(join(dir, "probe-results.txt")), true);
      assert.equal(existsSync(join(other, "probe-results.txt")), false);
    } else {
      assert.match(stdout, /^SAY: This probe only runs on Windows\./m);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("8 embedded PowerShell sources are byte-identical", async () => {
  const { embeddedScripts } = await loadHelper();
  for (const [name, text] of Object.entries(embeddedScripts)) {
    assert.deepEqual(Buffer.from(text, "utf8"), readFileSync(join(OUT, "ps", name)));
  }
});

test("9 static gates reject unsafe spawn and forbidden PowerShell", async () => {
  const { scanJavaScriptSpawnSafety, staticCheckPowerShell } = await loadHelper();
  const helperText = readFileSync(HELPER, "utf8");
  assert.deepEqual(scanJavaScriptSpawnSafety(helperText), []);
  const fixtureDir = scratch("static-fixtures");
  const spawnFixturePath = join(fixtureDir, "unsafe-spawn.txt");
  writeFileSync(spawnFixturePath, ["spawn", "Sync(command, args, { ", "shell: false });"].join(""));
  assert.ok(scanJavaScriptSpawnSafety(readFileSync(spawnFixturePath, "utf8")).length > 0);
  let namesText = "";
  if (process.env.FB_NAMES_GREP) namesText = readFileSync(process.env.FB_NAMES_GREP, "utf8");
  else process.stdout.write("names-rule=skipped-no-list\n");
  for (const name of Object.keys((await loadHelper()).embeddedScripts)) {
    const allowEncoded = name === "register.ps1";
    assert.deepEqual(staticCheckPowerShell(readFileSync(join(OUT, "ps", name), "utf8"), { allowEncoded, namesText }), []);
  }
  const psFixturePath = join(fixtureDir, "unsafe-powershell.txt");
  writeFileSync(psFixturePath, `${["A", "dd", "-Type"].join("")} x`);
  assert.ok(staticCheckPowerShell(readFileSync(psFixturePath, "utf8")).length > 0);
  await rm(fixtureDir, { recursive: true, force: true });
});
