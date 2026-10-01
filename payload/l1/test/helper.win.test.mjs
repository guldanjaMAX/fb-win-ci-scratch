import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { createHelper, fillStub } from "../fb-win.mjs";

const isWindows = process.platform === "win32";
const files = [
  "finish-window.txt", "fb-run.mjs", "fb-drive-state.mjs", "fb-manifest-edit.mjs",
  "fb-kit.mjs", "fb-google.mjs", "phrases.json", "facts.json",
];

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function systemPowerShell() {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  if (!root) throw new Error("Windows root missing");
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runPowerShell(source) {
  return spawnSync(systemPowerShell(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(source, "utf16le").toString("base64"),
  ], {
    encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, windowsHide: true,
  });
}

function quoted(value) {
  return String(value).replaceAll("'", "''");
}

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), "fb window "));
  const session = join(root, "session with space");
  await mkdir(session);
  const values = new Map();
  const window = String.raw`param([Parameter(Mandatory=$true)][string]$SessionDir)
$R = Join-Path $SessionDir 'run'
$Lf = [char]10
function Put([string]$Line) { [IO.File]::AppendAllText((Join-Path $R 'status.txt'), $Line + $Lf, [Text.Encoding]::ASCII) }
Put ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + ' RUN START start')
[IO.File]::WriteAllText((Join-Path $R 'now.txt'), 'One moment: someone on our side needs to look at this. Your Brain is safe.' + $Lf, [Text.Encoding]::ASCII)
Put ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + ' W4 WAITING lead queue id=a1b2c3 words=wait,finish-later')
$Limit = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $Limit -and -not (Test-Path -LiteralPath (Join-Path $R 'decision.txt'))) { Start-Sleep -Milliseconds 250 }
[IO.File]::WriteAllText((Join-Path $R 'now.txt'), 'Done here. You can close this window.' + $Lf, [Text.Encoding]::ASCII)
Put ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + ' W11 DONE done')
`;
  for (const name of files) {
    let bytes = Buffer.from(`fixture-${name}\n`);
    if (name === "finish-window.txt") bytes = Buffer.from(window);
    if (name === "facts.json") bytes = Buffer.from(`${JSON.stringify({ schema: 1, tier2: "on", w8: "off", marker: "REHEARSAL.marker" })}\n`);
    values.set(name, bytes);
  }
  const pins = Object.fromEntries([...values].map(([name, bytes]) => [name, { sha256: sha(bytes), bytes: bytes.length }]));
  return { root, session, values, pins };
}

async function unregister(taskName) {
  const source = `$ErrorActionPreference = 'SilentlyContinue'\nUnregister-ScheduledTask -TaskName '${quoted(taskName)}' -Confirm:$false\n`;
  runPowerShell(source);
}

if (!isWindows) {
  test("Windows-only scheduler and parser proof", { skip: process.env.WCI !== "1" }, () => {
    assert.equal(process.platform, "win32", "WCI requested a Windows test on another host");
  });
} else {
  test("Windows-only scheduler, visible action, stub refusal, and parser proof", { timeout: 180_000 }, async () => {
    const item = await buildFixture();
    const taskName = `WCI update ${randomBytes(4).toString("hex")}`;
    const fetchLocal = async (url) => {
      const name = basename(new URL(url).pathname);
      const bytes = item.values.get(name);
      return { ok: Boolean(bytes), async arrayBuffer() { return Uint8Array.from(bytes ?? []).buffer; } };
    };
    try {
      let chosen = "Interactive";
      let output = [];
      let helper = await createHelper({
        sessionDir: item.session, baseUrl: "https://example.invalid/wci", pins: item.pins,
        fetch: fetchLocal, taskName, logonType: chosen, output: (line) => output.push(line),
      });
      await helper.start();
      if (!output.includes("A window called Financial Brain update is opening. It does the update steps for you.")) {
        console.log("interactive=unavailable");
        chosen = "S4U";
        output = [];
        helper = await createHelper({
          sessionDir: item.session, baseUrl: "https://example.invalid/wci", pins: item.pins,
          fetch: fetchLocal, taskName, logonType: chosen, output: (line) => output.push(line),
        });
        await helper.start();
      }
      assert.deepEqual(output, ["A window called Financial Brain update is opening. It does the update steps for you."]);
      const first = await helper.follow(20);
      assert.ok(first.includes("EVENT W4 WAITING lead queue"));
      assert.ok(first.includes("CHOICES: wait / finish-later"));
      output.length = 0;
      await helper.status();
      assert.deepEqual(output, ["WAITING lead W4 queue [wait / finish-later]"]);
      output.length = 0;
      await helper.decide("wait");
      assert.deepEqual(output, ["DECIDED: wait"]);
      const second = await helper.follow(20);
      assert.ok(second.includes("EVENT W11 DONE done"));
      assert.equal(second.at(-1), "NEXT: none");

      const badRoot = join(item.root, "wrong pin");
      await mkdir(join(badRoot, "run"), { recursive: true });
      const markerPath = join(badRoot, "fixture-ran.txt");
      const wrongWindow = `param([Parameter(Mandatory=$true)][string]$SessionDir)\n[IO.File]::WriteAllText((Join-Path $SessionDir 'fixture-ran.txt'), 'ran')\n`;
      await writeFile(join(badRoot, "finish-window.txt"), wrongWindow, "ascii");
      const stub = fillStub({ sessionDir: badRoot, runDir: join(badRoot, "run"), sha256: "0".repeat(64) });
      const refusal = runPowerShell(stub);
      assert.equal(refusal.status, 0, refusal.stderr);
      assert.match(await readFile(join(badRoot, "run", "status.txt"), "ascii"), /RUN STOP preflight window-fingerprint/u);
      await assert.rejects(readFile(markerPath));

      for (const sourceUrl of [new URL("../ps/stub.ps1", import.meta.url), new URL("../ps/register.ps1", import.meta.url)]) {
        const sourcePath = fileURLToPath(sourceUrl);
        const parseSource = `$tokens = $null\n$errors = $null\n[System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText('${quoted(sourcePath)}'), [ref]$tokens, [ref]$errors) | Out-Null\nif ($errors.Count -ne 0) { exit 1 }\n`;
        const parsed = runPowerShell(parseSource);
        assert.equal(parsed.status, 0, parsed.stderr);
      }
    } finally {
      await unregister(taskName);
      await rm(item.root, { recursive: true, force: true });
    }
  });
}
