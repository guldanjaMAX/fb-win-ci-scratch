import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildRefreshAction,
  createRefreshScheduler,
  fillRefreshRegister,
} from "../fb-win.mjs";

const taskName = "Financial Brain daily refresh";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fb-refresh-"));
  const session = join(root, "session folder");
  const prefix = join(root, "installed folder");
  const cli = join(prefix, "node_modules", "brain-installer", "brain.mjs");
  const manifest = join(root, "manifest file.json");
  await mkdir(join(prefix, "node_modules", "brain-installer"), { recursive: true });
  await mkdir(join(session, "run"), { recursive: true });
  await writeFile(cli, "// fixture CLI\n", "ascii");
  await writeFile(manifest, "{}\n", "utf8");
  await writeFile(join(session, "selected-prefix-fixture.txt"), `${prefix}\n`, "utf8");
  await writeFile(join(session, "selected-manifest-fixture.txt"), `${manifest}\n`, "utf8");
  return { root, session, prefix, cli, manifest };
}

function captureSpawn(calls, result = { status: 0, stdout: "", stderr: "" }) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return result;
  };
}

function decodeOuterSource(call) {
  return Buffer.from(call.args.at(-1), "base64").toString("utf16le");
}

test("refresh action is keyless, bounded, and runs only the three refresh sources", () => {
  const action = buildRefreshAction({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Owner Files\\prefix\\node_modules\\brain-installer\\brain.mjs",
    manifestPath: "C:\\Owner Files\\manifest.json",
  });
  assert.equal(action.argumentsLine,
    '"C:\\Owner Files\\prefix\\node_modules\\brain-installer\\brain.mjs" load "C:\\Owner Files\\manifest.json" --only drive,calendar,upload');
  assert.match(action.source, /CreateNoWindow = \$true/u);
  assert.match(action.source, /ProcessWindowStyle\]::Hidden/u);
  assert.match(action.source, /BRAIN_NO_WRANGLER_LOGIN/u);
  const loadGuard = action.source.indexOf("(load|ingest|custom-api)");
  const spawn = action.source.indexOf("System.Diagnostics.Process]::Start");
  assert.ok(loadGuard >= 0 && loadGuard < spawn,
    "the runtime action reaches the load-running decision point before spawning");
  assert.match(action.source, /EnvironmentVariables\.Remove\('CLOUDFLARE_API_TOKEN'\)/u);
  assert.match(action.source, /EnvironmentVariables\.Remove\('CF_API_TOKEN'\)/u);
  assert.match(action.source, /EnvironmentVariables\.Remove\('BRAIN_ADMIN_KEY'\)/u);
  assert.doesNotMatch(action.argumentsLine, /(?:--key(?:\s|=)|CLOUDFLARE_API_TOKEN|CF_API_TOKEN|BRAIN_ADMIN_KEY)/iu);

  const registration = fillRefreshRegister({
    powerShell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    actionEncoded: action.encoded,
  });
  assert.match(registration, /New-ScheduledTaskTrigger -Daily -At '07:30'/u);
  assert.match(registration, /ExecutionTimeLimit \(\[TimeSpan\]::FromMinutes\(45\)\)/u);
  assert.match(registration, /MultipleInstances IgnoreNew/u);
  assert.match(registration, /LogonType Interactive -RunLevel Limited/u);
});

test("schedule has a green control and a non-vacuous load-running refusal", async (t) => {
  await t.test("green control registers one refresh task", async () => {
    const item = await fixture();
    const calls = [];
    const output = [];
    let loadChecks = 0;
    try {
      const scheduler = await createRefreshScheduler({
        sessionDir: item.session,
        platform: "win32",
        nodePath: join(item.root, "node folder", "node.exe"),
        env: { SystemRoot: "Q:\\Windows", USERDOMAIN: "FIXTURE", USERNAME: "owner" },
        loadRunning: () => { loadChecks += 1; return false; },
        spawn: captureSpawn(calls),
        output: (line) => output.push(line),
      });
      assert.equal(await scheduler.schedule(), true);
      assert.equal(loadChecks, 1, "the green control reached the load-running decision point");
      assert.equal(calls.length, 1, "the green control reached registration");
      assert.deepEqual(output, ["Daily refresh is scheduled for 7:30 AM."]);
      const source = decodeOuterSource(calls[0]);
      assert.match(source, new RegExp(taskName, "u"));
      assert.match(source, /Register-ScheduledTask[\s\S]*-Force/u);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  await t.test("live load refuses before a scheduler write", async () => {
    const item = await fixture();
    const calls = [];
    const output = [];
    let loadChecks = 0;
    try {
      const scheduler = await createRefreshScheduler({
        sessionDir: item.session,
        platform: "win32",
        env: { SystemRoot: "Q:\\Windows" },
        loadRunning: () => { loadChecks += 1; return true; },
        spawn: captureSpawn(calls),
        output: (line) => output.push(line),
      });
      assert.equal(await scheduler.schedule(), false);
      assert.equal(loadChecks, 1, "the refusal reached the load-running decision point");
      assert.equal(calls.length, 0, "the refusal made no scheduler write");
      assert.deepEqual(output, ["A load is already running, so daily refresh was not changed."]);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });
});

test("unschedule forces a successful absent-task exit and the mutant is rejected", async () => {
  const item = await fixture();
  const calls = [];
  try {
    const scheduler = await createRefreshScheduler({
      sessionDir: item.session,
      platform: "win32",
      env: { SystemRoot: "Q:\\Windows" },
      spawn: captureSpawn(calls),
      output: () => {},
    });
    assert.equal(await scheduler.unschedule(), true);
    assert.equal(calls.length, 1, "the green control reached PowerShell");
    const source = decodeOuterSource(calls[0]);
    assert.match(source, /task remained registered[\s\S]*\nexit 0\n/u);
    const mutant = source.replace("\nexit 0\n", "\n");
    assert.doesNotMatch(mutant, /task remained registered[\s\S]*\nexit 0\n/u,
      "the missing-exit mutant is distinguishable");
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("status reports registered and absent controls without changing the task", async () => {
  const item = await fixture();
  try {
    for (const [state, expected] of [
      ["Ready", "Daily refresh is scheduled for 7:30 AM (Ready)."],
      [null, "Daily refresh is not scheduled."],
    ]) {
      const output = [];
      let reads = 0;
      const scheduler = await createRefreshScheduler({
        sessionDir: item.session,
        platform: "win32",
        env: { SystemRoot: "Q:\\Windows" },
        taskStatus: () => { reads += 1; return state; },
        spawn: () => { throw new Error("status must not write"); },
        output: (line) => output.push(line),
      });
      assert.equal(await scheduler.status(), true);
      assert.equal(reads, 1, "status reached one readback decision");
      assert.deepEqual(output, [expected]);
    }
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("CLI update coordination pauses before start and restores only after DONE", async () => {
  const source = await readFile(new URL("../fb-win.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("async function main()"));
  const pause = main.indexOf("scheduler.unschedule({ announce: false })");
  const start = main.indexOf("await helper.start()");
  const done = main.indexOf("await helper.isDone()");
  const restore = main.indexOf("scheduler.schedule({ announce: false })");
  assert.ok(pause >= 0 && pause < start, "unschedule decision precedes update start");
  assert.ok(done > start && restore > done, "refresh restoration follows the DONE decision");
  assert.doesNotMatch(main, /brain_(?:health|think|search)/u,
    "missing Brain tools in a fresh Code session cannot gate the local update flow");

  const mutant = main.replaceAll("await helper.isDone()", "true");
  assert.doesNotMatch(mutant, /await helper\.isDone\(\)/u,
    "removing the DONE gate is a caught mutation");
});
