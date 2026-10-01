import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultHelperPath = fileURLToPath(new URL("../fb-store.mjs", import.meta.url));
const helperPath = process.env.HELPER_PATH ? resolve(process.env.HELPER_PATH) : defaultHelperPath;
const {
  buildStorePullAction,
  createStorePullScheduler,
  fillStorePullRegister,
  quoteWindowsArgument,
} = await import(`${pathToFileURL(helperPath).href}?store=${Date.now()}`);

const taskName = "Financial Brain store data 8AM";
const success = "Store data will now load every day at 8:00 AM.";
const lockStart = "2026-10-01T14:00:00.000Z";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fb-store-pull-"));
  const session = join(root, "session folder");
  const prefix = join(root, "installed folder");
  const cli = join(prefix, "node_modules", "brain-installer", "brain.mjs");
  const manifest = join(root, "manifest file.json");
  await mkdir(join(prefix, "node_modules", "brain-installer"), { recursive: true });
  await mkdir(join(session, "run"), { recursive: true });
  await writeFile(cli, "// fixture CLI\n", "ascii");
  await writeFile(manifest, `${JSON.stringify({ corpora: { custom_api: { cadence: 86400 } } })}\n`, "utf8");
  await writeFile(join(session, "selected-prefix-fixture.txt"), `${prefix}\n`, "utf8");
  await writeFile(join(session, "selected-manifest-fixture.txt"), `${manifest}\n`, "utf8");
  return { root, session, prefix, cli, manifest };
}

async function snapshot(path) {
  const entries = [];
  for (const name of (await readdir(path)).sort()) {
    const bytes = await readFile(join(path, name)).catch(() => null);
    entries.push([name, bytes?.toString("base64") ?? null]);
  }
  return entries;
}

function captureSpawn(calls, result = { status: 0, stdout: "", stderr: "" }) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return result;
  };
}

function decodeOuterSource(call) {
  assert.deepEqual(call.args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  return Buffer.from(call.args.at(-1), "base64").toString("utf16le");
}

function decodeActionSource(registration) {
  const match = /-EncodedCommand ([A-Za-z0-9+/=]+)'/u.exec(registration);
  assert.ok(match, "registration carries one encoded hidden action");
  return Buffer.from(match[1], "base64").toString("utf16le");
}

test("store schedule has a green control and guards live windows and missing custom_api", async (t) => {
  await t.test("DONE green control registers the hidden daily task", async () => {
    const item = await fixture();
    const calls = [];
    const output = [];
    let livenessQueries = 0;
    try {
      await writeFile(join(item.session, "run", "window.lock"), `pid=321\nstart=${lockStart}\n`, "ascii");
      await writeFile(join(item.session, "run", "status.txt"), "2026-10-01T14:00:00Z W11 DONE done\n", "ascii");
      const scheduler = await createStorePullScheduler({
        sessionDir: item.session,
        platform: "win32",
        nodePath: join(item.root, "node folder", "node.exe"),
        env: { SystemRoot: "Q:\\Windows", USERDOMAIN: "FIXTURE", USERNAME: "owner" },
        queryProcess: () => { livenessQueries += 1; return lockStart; },
        spawn: captureSpawn(calls),
        output: (line) => output.push(line),
      });
      assert.equal(await scheduler.schedule(), true);
      assert.deepEqual(output, [success]);
      assert.equal(livenessQueries, 0, "the DONE decision point bypasses liveness");
      assert.equal(calls.length, 1, "the green control reaches one scheduler write");

      const registration = decodeOuterSource(calls[0]);
      assert.match(registration, /New-ScheduledTaskTrigger -Daily -At '08:00'/u);
      assert.match(registration, /MultipleInstances IgnoreNew/u);
      assert.match(registration, /StartWhenAvailable/u);
      assert.match(registration, /AllowStartIfOnBatteries/u);
      assert.match(registration, /DontStopIfGoingOnBatteries/u);
      assert.match(registration, /ExecutionTimeLimit \(\[TimeSpan\]::FromMinutes\(30\)\)/u);
      assert.match(registration, /LogonType Interactive -RunLevel Limited/u);
      assert.match(registration, /Register-ScheduledTask[\s\S]*-Force/u);
      assert.match(registration, new RegExp(taskName, "u"));
      assert.doesNotMatch(registration, /Start-ScheduledTask/u);

      const action = decodeActionSource(registration);
      assert.match(action, /System\.Diagnostics\.ProcessStartInfo/u);
      assert.match(action, /CreateNoWindow = \$true/u);
      assert.match(action, /ProcessWindowStyle\]::Hidden/u);
      assert.match(action, / custom-api /u);
      assert.doesNotMatch(action, /(?:--key(?:\s|=)|TOKEN|SECRET|PASSWORD)/iu);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  await t.test("live-window guard reaches its refusal without a scheduler write", async () => {
    const item = await fixture();
    const calls = [];
    const output = [];
    let livenessQueries = 0;
    try {
      await writeFile(join(item.session, "run", "window.lock"), `pid=321\nstart=${lockStart}\n`, "ascii");
      await writeFile(join(item.session, "run", "status.txt"), [
        "2026-10-01T13:59:00Z W11 DONE done",
        "2026-10-01T14:00:00Z RUN START start",
        "",
      ].join("\n"), "ascii");
      const beforeSession = await snapshot(item.session);
      const beforeRun = await snapshot(join(item.session, "run"));
      const scheduler = await createStorePullScheduler({
        sessionDir: item.session,
        platform: "win32",
        env: { SystemRoot: "Q:\\Windows" },
        queryProcess: () => { livenessQueries += 1; return lockStart; },
        spawn: captureSpawn(calls),
        output: (line) => output.push(line),
      });
      assert.equal(await scheduler.schedule(), false);
      assert.deepEqual(output, ["The update window is still working."]);
      assert.equal(livenessQueries, 1, "the live-window decision point was reached");
      assert.equal(calls.length, 0, "the refusal occurs before task registration");
      assert.deepEqual(await snapshot(item.session), beforeSession);
      assert.deepEqual(await snapshot(join(item.session, "run")), beforeRun);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  await t.test("missing-custom_api guard reaches its refusal without a scheduler write", async () => {
    const item = await fixture();
    const calls = [];
    const output = [];
    try {
      await writeFile(item.manifest, `${JSON.stringify({ corpora: {} })}\n`, "utf8");
      const before = await snapshot(item.session);
      const scheduler = await createStorePullScheduler({
        sessionDir: item.session,
        platform: "win32",
        env: { SystemRoot: "Q:\\Windows" },
        spawn: captureSpawn(calls),
        output: (line) => output.push(line),
      });
      assert.equal(await scheduler.schedule(), false);
      assert.deepEqual(output, ["This install does not have store data set up."]);
      assert.equal(calls.length, 0, "the custom_api decision point was reached before registration");
      assert.deepEqual(await snapshot(item.session), before);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  await t.test("an absent or stale window is accepted", async () => {
    for (const kind of ["absent", "stale"]) {
      const item = await fixture();
      const calls = [];
      const output = [];
      let livenessQueries = 0;
      try {
        if (kind === "stale") {
          await writeFile(join(item.session, "run", "window.lock"), `pid=321\nstart=${lockStart}\n`, "ascii");
        }
        const scheduler = await createStorePullScheduler({
          sessionDir: item.session,
          platform: "win32",
          env: { SystemRoot: "Q:\\Windows" },
          queryProcess: () => { livenessQueries += 1; return null; },
          spawn: captureSpawn(calls),
          output: (line) => output.push(line),
        });
        assert.equal(await scheduler.schedule(), true, kind);
        assert.deepEqual(output, [success], kind);
        assert.equal(calls.length, 1, `${kind} reaches registration`);
        assert.equal(livenessQueries, kind === "stale" ? 1 : 0, `${kind} uses the expected identity check`);
      } finally {
        await rm(item.root, { recursive: true, force: true });
      }
    }
  });
});

test("store action quotes argv and rejects credential material", () => {
  assert.equal(quoteWindowsArgument("plain"), "plain");
  assert.equal(quoteWindowsArgument(""), '\"\"');
  assert.equal(quoteWindowsArgument("C:\\Program Files\\node.exe"), '\"C:\\Program Files\\node.exe\"');
  assert.equal(quoteWindowsArgument("C:\\folder with space\\"), '\"C:\\folder with space\\\\\"');
  const action = buildStorePullAction({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Owner's Files\\prefix\\node_modules\\brain-installer\\brain.mjs",
    manifestPath: "C:\\Owner's Files\\manifest.json",
  });
  assert.equal(action.argumentsLine,
    '\"C:\\Owner\'s Files\\prefix\\node_modules\\brain-installer\\brain.mjs\" custom-api \"C:\\Owner\'s Files\\manifest.json\"');
  assert.match(action.source, /FileName = 'C:\\Program Files\\nodejs\\node\.exe'/u);
  assert.match(action.source, /Arguments = '"C:\\Owner''s Files/u);
  assert.doesNotMatch(action.source, /(?:--key(?:\s|=)|TOKEN|SECRET|PASSWORD)/iu);
  assert.throws(() => buildStorePullAction({
    nodePath: "C:\\node.exe",
    cliPath: "C:\\fixture --key value\\brain.mjs",
    manifestPath: "C:\\manifest.json",
  }), /credential material/u, "the action-key decision point rejects the unsafe path");
  const registration = fillStorePullRegister({
    powerShell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    actionEncoded: action.encoded,
  });
  assert.match(registration, /-WindowStyle Hidden -EncodedCommand/u);
  assert.equal(decodeActionSource(registration), action.source);
});

test("unschedule waits for stop and proves absence by readback", async () => {
  const item = await fixture();
  const calls = [];
  const output = [];
  try {
    const scheduler = await createStorePullScheduler({
      sessionDir: item.session,
      platform: "win32",
      env: { SystemRoot: "Q:\\Windows" },
      spawn: captureSpawn(calls),
      output: (line) => output.push(line),
    });
    assert.equal(await scheduler.unschedule(), true);
    assert.deepEqual(output, ["The store data schedule was removed."]);
    assert.equal(calls.length, 1);
    const source = decodeOuterSource(calls[0]);
    assert.match(source, /Stop-ScheduledTask/u);
    assert.match(source, /\$StopDeadline/u, "removal waits for a running task to settle");
    assert.match(source, /Unregister-ScheduledTask/u);
    assert.match(source, /\$RemoveDeadline/u, "removal polls scheduler readback");
    assert.match(source, /task remained registered/u, "removal proves absence by readback");
    assert.match(source, new RegExp(taskName, "u"));
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});
