import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const helperPath = process.env.HELPER_PATH
  ? resolve(process.env.HELPER_PATH)
  : fileURLToPath(new URL("./fb-store-s8-stdout-candidate.mjs", import.meta.url));
const { buildStorePullAction, fillStorePullRegister } = await import(pathToFileURL(helperPath).href);

test("generated task keeps path quoting, hidden process, credential guard and task policy", () => {
  const paths = {
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Owner's folder\\brain.mjs",
    manifestPath: "C:\\Owner's folder\\manifest file.json",
  };
  const action = buildStorePullAction(paths);
  assert.equal(action.argumentsLine, '"C:\\Owner\'s folder\\brain.mjs" custom-api "C:\\Owner\'s folder\\manifest file.json"');
  assert.equal(Buffer.from(action.encoded, "base64").toString("utf16le"), action.source);
  assert.ok(action.source.includes("$StartInfo.Arguments = '\"C:\\Owner''s folder\\brain.mjs\" custom-api \"C:\\Owner''s folder\\manifest file.json\"'"));
  assert.match(action.source, /UseShellExecute = \$false/);
  assert.match(action.source, /CreateNoWindow = \$true/);
  assert.match(action.source, /ProcessWindowStyle\]::Hidden/);
  assert.match(action.source, /EnvironmentVariables\['BRAIN_NO_WRANGLER_LOGIN'\] = '1'/);
  assert.match(action.source, /RedirectStandardOutput = \$true/);
  assert.match(action.source, /RedirectStandardError = \$true/);
  const register = fillStorePullRegister({ powerShell: "C:\\Windows\\powershell.exe", actionEncoded: action.encoded });
  assert.match(register, /-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand/);
  assert.match(register, /New-ScheduledTaskTrigger -Daily -At '08:00'/);
  assert.match(register, /-MultipleInstances IgnoreNew/);
  assert.match(register, /-ExecutionTimeLimit \(\[TimeSpan\]::FromMinutes\(30\)\)/);
  assert.match(register, /-LogonType Interactive -RunLevel Limited/);
  for (const invalid of ["C:\\bad\npath", "C:\\bad\rpath", "C:\\bad\0path", 'C:\\bad"path']) {
    assert.throws(() => buildStorePullAction({ ...paths, manifestPath: invalid }), /not safe/);
  }
});

const windowsOnly = process.platform !== "win32";
const allowed = ["SystemRoot", "WINDIR", "ComSpec", "PATH", "Path", "PATHEXT", "PSModulePath", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "OS"];

async function executeFixture({ inheritedHandles = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "s8-pipes-"));
  const cli = join(root, "fixture with spaces.mjs");
  const manifest = join(root, "manifest with spaces.json");
  const descendantPidFile = join(root, "descendant-pid.txt");
  const recordFile = join(root, "record.json");
  await writeFile(manifest, "{}\n");
  await writeFile(cli, `
import { spawn } from 'node:child_process';
import { writeFileSync, writeSync } from 'node:fs';
writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ argv: process.argv.slice(2), stdout_tty: process.stdout.isTTY === true, stderr_tty: process.stderr.isTTY === true }));
const block = Buffer.alloc(65536, 120);
function writeAll(fd) {
  let offset = 0;
  while (offset < block.length) offset += writeSync(fd, block, offset, block.length - offset);
}
for (let i = 0; i < 64; i += 1) { writeAll(1); writeAll(2); }
${inheritedHandles ? `const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));
descendant.unref();` : ""}
process.exit(37);
`);
  const env = Object.fromEntries(allowed.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  Object.assign(env, { HOME: root, USERPROFILE: root, TEMP: root, TMP: root, BRAIN_NO_WRANGLER_LOGIN: "1" });
  const action = buildStorePullAction({ nodePath: process.execPath, cliPath: cli, manifestPath: manifest });
  const ps = win32.join(env.SystemRoot ?? env.WINDIR, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const started = performance.now();
  let result;
  try {
    result = spawnSync(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", action.encoded], {
      env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: false, windowsHide: true,
      timeout: 8000, maxBuffer: 128 * 1024,
    });
    const elapsed = performance.now() - started;
    assert.equal(result.error, undefined, `wrapper error: ${result.error?.code}`);
    assert.equal(result.signal, null);
    assert.equal(result.status, 37, `wrapper lost child exit code: ${result.stderr}`);
    assert.equal(result.stdout, "", "wrapper leaked child stdout or a PowerShell return value");
    assert.equal(result.stderr, "", "wrapper leaked child stderr");
    assert.ok(elapsed < 6000, `wrapper took ${elapsed} ms`);
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    assert.deepEqual(record.argv, ["custom-api", manifest]);
    assert.equal(record.stdout_tty, false);
    assert.equal(record.stderr_tty, false);
    if (inheritedHandles) {
      const descendantPid = Number(await readFile(descendantPidFile, "utf8"));
      assert.ok(descendantPid > 0, "fixture did not record a descendant PID");
      assert.doesNotThrow(() => process.kill(descendantPid, 0), "descendant was not alive at wrapper return");
    }
  } finally {
    const pid = Number(await readFile(descendantPidFile, "utf8").catch(() => ""));
    if (pid > 0) { try { process.kill(pid); } catch { } }
    await rm(root, { recursive: true, force: true });
  }
}

test("Windows generated wrapper drains 4 MiB per stream concurrently and preserves exit 37", { skip: windowsOnly, timeout: 15000 }, () => executeFixture());
test("Windows generated wrapper returns while a fixture descendant holds pipe write handles", { skip: windowsOnly, timeout: 15000 }, () => executeFixture({ inheritedHandles: true }));
