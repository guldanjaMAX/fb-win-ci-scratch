import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const defaultHelperPath = fileURLToPath(new URL("../fb-win.mjs", import.meta.url));
const helperPath = process.env.HELPER_PATH ? resolve(process.env.HELPER_PATH) : defaultHelperPath;
const helperModule = await import(`${pathToFileURL(helperPath).href}?case=${Date.now()}`);
const { createHelper, fillRegister, fillStub, isUnsafeText, REGISTER_TEMPLATE, STUB_TEMPLATE } = helperModule;

const names = [
  "finish-window.txt", "fb-run.mjs", "fb-drive-state.mjs", "fb-manifest-edit.mjs",
  "fb-kit.mjs", "fb-google.mjs", "phrases.json", "facts.json",
];
const opening = "A window called Financial Brain update is opening. It does the update steps for you.";
const nothing = "Nothing more to run here today.";
const mismatch = "Something did not match, so nothing ran. The team will look at it.";
const closed = "The update window closed. Typing the same sentence again picks up where it left off.";
const working = "The update window is working.";
const done = "Done here. You can close this window.";
const timestamp = "2026-10-01T07:00:00Z";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function response(bytes, ok = true) {
  return { ok, async arrayBuffer() { return Uint8Array.from(bytes).buffer; } };
}

async function freshSession(label = "session") {
  const root = await mkdtemp(join(tmpdir(), "fb-l1-"));
  const path = join(root, label);
  await mkdir(path);
  return { root, path };
}

async function fixture({ facts = { schema: 1, tier2: "on", w8: "off", marker: "REHEARSAL.marker" }, label } = {}) {
  const session = await freshSession(label);
  const files = new Map();
  for (const name of names) {
    let text = `fixture-${name}\n`;
    if (name === "facts.json") text = `${JSON.stringify(facts)}\n`;
    if (name === "finish-window.txt") text = "param([Parameter(Mandatory=$true)][string]$SessionDir)\n'fixture'\n";
    files.set(name, Buffer.from(text));
  }
  const pins = Object.fromEntries([...files].map(([name, bytes]) => [name, { sha256: digest(bytes), bytes: bytes.length }]));
  return { ...session, files, pins };
}

async function removeFixture(item) {
  await rm(item.root, { recursive: true, force: true });
}

function fetchFrom(files, calls, overrides = new Map()) {
  return async (url) => {
    const name = basename(new URL(url).pathname);
    calls.push(name);
    if (overrides.has(name)) return response(overrides.get(name));
    const bytes = files.get(name);
    return bytes ? response(bytes) : response(Buffer.alloc(0), false);
  };
}

function lockText(pid = 321, start = "2026-10-01T07:00:00.000Z") {
  return `pid=${pid}\nstart=${start}\n`;
}

async function harness(item, options = {}) {
  const output = [];
  const fetchCalls = [];
  const spawnCalls = [];
  const lockStart = options.lockStart ?? "2026-10-01T07:00:00.000Z";
  let clock = Date.parse(lockStart);
  const spawn = options.spawn ?? ((command, args, spawnOptions) => {
    spawnCalls.push({ command, args, options: spawnOptions });
    const source = Buffer.from(args.at(-1), "base64").toString("utf16le");
    if (source.includes("Register-ScheduledTask")) {
      writeFileSync(join(item.path, "run", "window.lock"), lockText(321, lockStart), "ascii");
      return { status: 0, stdout: "REGISTERED\nSTARTED\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  const helper = await createHelper({
    sessionDir: item.path,
    platform: options.platform ?? "win32",
    nodeMajor: options.nodeMajor ?? 24,
    baseUrl: options.baseUrl ?? "https://example.invalid/client-page-built",
    pins: options.pins ?? item.pins,
    fetch: options.fetch ?? fetchFrom(item.files, fetchCalls, options.overrides),
    spawn,
    output: (line) => output.push(line),
    env: { SystemRoot: `Q:${"\\"}Root` },
    sleep: options.sleep ?? (async (ms) => { clock += ms; }),
    now: options.now ?? (() => clock),
    kill: options.kill ?? (() => {}),
    queryProcess: options.queryProcess ?? (({ start }) => start),
    taskName: options.taskName ?? "Fixture update",
    logonType: options.logonType,
  });
  return { helper, output, fetchCalls, spawnCalls };
}

async function helperLog(item) {
  return (await readFile(join(item.path, "run", "helper.txt"), "ascii")).trim().split("\n");
}

function assertOnePageLine(output) {
  assert.equal(output.length, 1);
  assert.doesNotMatch(output[0], /^(?:NEXT:|EVENT |SAY:|HIDDEN:)/u);
}

test("test 1: Tier 2 gate checks facts, marker content, W8, and marker name", async (t) => {
  const offMarkers = [null, "", "probe-sentence", "probe-window", "w8", "tier2x"];
  for (const marker of offMarkers) {
    await t.test(`off marker ${marker ?? "missing"}`, async () => {
      const item = await fixture({ facts: { schema: 1, tier2: "off", w8: "off" } });
      try {
        if (marker !== null) await writeFile(join(item.path, "REHEARSAL.marker"), marker, "ascii");
        let gateCalls = 0;
        const fetchCalls = [];
        const { helper, output, spawnCalls } = await harness(item, {
          fetch: async (url) => {
            gateCalls += 1;
            return fetchFrom(item.files, fetchCalls)(url);
          },
        });
        await helper.start();
        assert.deepEqual(output, [nothing]);
        assert.deepEqual(fetchCalls, ["facts.json"]);
        assert.equal(gateCalls, 1);
        assert.equal(spawnCalls.length, 0);
        assert.ok((await helperLog(item)).includes("start=tier2-off"));
      } finally { await removeFixture(item); }
    });
  }

  const onCases = [
    { facts: { schema: 1, tier2: "off", w8: "off" }, marker: "tier2" },
    { facts: { schema: 1, tier2: "off", w8: "off" }, marker: "tier2\r\nw8\r\n" },
    { facts: { schema: 1, tier2: "on", w8: "off" } },
    { facts: { schema: 1, tier2: "off", w8: "on" } },
    { facts: { schema: 1, tier2: "on", w8: "off", marker: "REHEARSAL.marker" } },
    { facts: { schema: 1, tier2: "on", w8: "off" } },
  ];
  for (const [index, arm] of onCases.entries()) {
    await t.test(`on arm ${index + 1}`, async () => {
      const item = await fixture({ facts: arm.facts });
      try {
        if (arm.marker) await writeFile(join(item.path, "REHEARSAL.marker"), arm.marker, "ascii");
        const run = await harness(item);
        await run.helper.start();
        assert.deepEqual(run.output, [opening]);
        assert.equal(run.fetchCalls.length, 8);
        assert.ok(run.spawnCalls.length >= 1);
        assert.ok((await helperLog(item)).includes("start=opened"));
      } finally { await removeFixture(item); }
    });
  }

  const bad = await fixture({ facts: { schema: 1, tier2: "on", w8: "off", marker: "fb-rehearsal.marker" } });
  try {
    const run = await harness(bad);
    await run.helper.start();
    assert.deepEqual(run.output, [mismatch]);
    assert.deepEqual(run.fetchCalls, ["facts.json"]);
    assert.equal(run.spawnCalls.length, 0);
    assert.ok((await helperLog(bad)).includes("start=stop-marker-mismatch"));
  } finally { await removeFixture(bad); }
});

test("test 2: every file is checked by byte count and full fingerprint", async (t) => {
  for (const target of ["finish-window.txt", "facts.json"]) {
    await t.test(`wrong byte ${target}`, async () => {
      const item = await fixture();
      const wrong = Buffer.from(item.files.get(target));
      wrong[wrong.length - 1] ^= 1;
      try {
        const matchingName = target === "facts.json" ? null : "fb-run.mjs";
        if (matchingName) {
          await writeFile(join(item.path, matchingName), item.files.get(matchingName));
          await utimes(join(item.path, matchingName), 1, 1);
        }
        const run = await harness(item, { overrides: new Map([[target, wrong]]) });
        await run.helper.start();
        assert.deepEqual(run.output, [mismatch]);
        const key = target === "facts.json" ? "facts" : "window";
        assert.ok((await helperLog(item)).includes(`start=stop-fingerprint-${key}`));
        assert.equal(run.spawnCalls.length, 0);
        assert.equal((await readdir(item.path)).some((name) => name.includes(".download-")), false);
        if (matchingName) {
          assert.deepEqual(await readFile(join(item.path, matchingName)), item.files.get(matchingName));
          assert.equal(Math.trunc((await stat(join(item.path, matchingName))).mtimeMs), 1000);
        }
      } finally { await removeFixture(item); }
    });
  }
  await t.test("right fingerprint with wrong byte count", async () => {
    const item = await fixture();
    try {
      const pins = structuredClone(item.pins);
      pins["facts.json"].bytes += 1;
      const run = await harness(item, { pins });
      await run.helper.start();
      assert.deepEqual(run.output, [mismatch]);
      assert.ok((await helperLog(item)).includes("start=stop-fingerprint-facts"));
      assert.equal(run.spawnCalls.length, 0);
    } finally { await removeFixture(item); }
  });
});

test("test 3: a live window blocks a second start and a stale lock does not", async (t) => {
  await t.test("live", async () => {
    const item = await fixture();
    try {
      await mkdir(join(item.path, "run"));
      await writeFile(join(item.path, "run", "window.lock"), lockText(), "ascii");
      const run = await harness(item);
      await run.helper.start();
      assert.deepEqual(run.output, ["The update window is already open."]);
      assert.equal(run.fetchCalls.length, 0);
      assert.equal(run.spawnCalls.length, 0);
      assert.ok((await helperLog(item)).includes("start=already-open"));
    } finally { await removeFixture(item); }
  });
  await t.test("stale", async () => {
    const item = await fixture();
    try {
      await mkdir(join(item.path, "run"));
      await writeFile(join(item.path, "run", "window.lock"), lockText(), "ascii");
      let queries = 0;
      const run = await harness(item, {
        queryProcess: ({ start }) => {
          queries += 1;
          return queries === 1 ? new Date(Date.parse(start) + 5000).toISOString() : start;
        },
      });
      await run.helper.start();
      assert.deepEqual(run.output, [opening]);
      assert.equal(run.fetchCalls.length, 8);
    } finally { await removeFixture(item); }
  });
});

test("test 4: stub and registration templates carry the required Windows behavior", async () => {
  const stubFile = await readFile(new URL("../ps/stub.ps1", import.meta.url), "ascii");
  const registerFile = await readFile(new URL("../ps/register.ps1", import.meta.url), "ascii");
  assert.equal(stubFile, STUB_TEMPLATE);
  assert.equal(registerFile, REGISTER_TEMPLATE);
  const path = `Q:${"\\"}Owner's Folder`;
  const stub = fillStub({ sessionDir: path, runDir: `${path}${"\\"}run`, sha256: "a".repeat(64) });
  assert.match(stub, /ComputeHash/u);
  assert.match(stub, /Bytes\[0\].*239/u);
  assert.match(stub, /-SessionDir 'Q:\\Owner''s Folder'/u);
  assert.match(stub, /RUN STOP preflight window-fingerprint/u);
  assert.doesNotMatch(stub, /FB_WINDOW_TEST/u);
  const encodedStub = Buffer.from(stub, "utf16le").toString("base64");
  assert.ok(encodedStub.length < 8000);
  assert.equal(Buffer.from(encodedStub, "base64").toString("utf16le"), stub);
  const registration = fillRegister({ taskName: "Fixture update", stubEncoded: "QQ==" });
  assert.doesNotMatch(registration, /-WindowStyle Hidden|-NonInteractive/u);
  assert.match(registration, /MultipleInstances IgnoreNew/u);
  assert.match(registration, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/u);
  assert.match(registration, /EndBoundary/u);
  assert.match(registration, /DeleteExpiredTaskAfter/u);
  assert.match(REGISTER_TEMPLATE, /-LogonType '@@LOGON@@'/u);
  assert.match(registration, /LogonType 'Interactive'/u);
});

test("test 5: follow returns only at part boundaries, close, or cap", async (t) => {
  const item = await fixture();
  try {
    let firstBoundaryWritten = false;
    const run = await harness(item, {
      sleep: async () => {
        if (!firstBoundaryWritten) {
          firstBoundaryWritten = true;
          await appendFile(join(item.path, "run", "status.txt"), `${timestamp} W1 PASS readout\r\n`, "utf8");
        }
      },
    });
    await writeFile(join(item.path, "run", "window.lock"), lockText(), "ascii");
    await writeFile(join(item.path, "run", "now.txt"), `${done}\n`, "ascii");
    await writeFile(join(item.path, "run", "status.txt"), `\uFEFF${timestamp} RUN START start\r\n${timestamp} W1 INFO readout\r\n`, "utf8");
    const first = await run.helper.follow(5);
    assert.deepEqual(first.slice(0, 3), ["EVENT RUN START start", "EVENT W1 INFO readout", "EVENT W1 PASS readout"]);
    assert.equal(first.at(-1), "NEXT: follow");
    await appendFile(join(item.path, "run", "status.txt"), `${timestamp} W7 INFO stage n=3\r\n${timestamp} W4 WAITING lead queue n=1200 id=a1b2c3 words=wait,finish-later\r\n`, "utf8");
    const second = await run.helper.follow(5);
    assert.ok(second.includes("EVENT W7 INFO stage n=3"));
    assert.ok(second.includes("EVENT W4 WAITING lead queue n=1200"));
    assert.ok(second.includes("CHOICES: wait / finish-later"));
    assert.equal(second.at(-1), "NEXT: decide");
    await appendFile(join(item.path, "run", "status.txt"), `${timestamp} W3 WAITING owner copy-key\r\n`, "utf8");
    const third = await run.helper.follow(5);
    assert.ok(third.includes("EVENT W3 WAITING owner copy-key"));
    assert.equal(third.at(-1), "NEXT: follow");
    await appendFile(join(item.path, "run", "status.txt"), `${timestamp} W11 DONE done\r\n`, "utf8");
    const fourth = await run.helper.follow(5);
    assert.ok(fourth.includes("EVENT W11 DONE done"));
    assert.equal(fourth.at(-1), "NEXT: none");
  } finally { await removeFixture(item); }

  await t.test("missing words uses fallback", async () => {
    const arm = await fixture();
    try {
      const run = await harness(arm);
      await writeFile(join(arm.path, "run", "status.txt"), `${timestamp} W4 WAITING lead queue id=a1b2c3\n`, "ascii");
      assert.ok((await run.helper.follow(5)).includes("CHOICES: wait / finish-later"));
    } finally { await removeFixture(arm); }
  });
  await t.test("cap", async () => {
    const arm = await fixture();
    let clock = 0;
    try {
      const run = await harness(arm, { now: () => clock, sleep: async (ms) => { clock += ms; } });
      await writeFile(join(arm.path, "run", "window.lock"), lockText(), "ascii");
      assert.deepEqual(await run.helper.follow(5), ["FOLLOW: CAP", "NEXT: follow"]);
    } finally { await removeFixture(arm); }
  });
  await t.test("closed", async () => {
    const arm = await fixture();
    try {
      const run = await harness(arm, { kill: () => { throw new Error("gone"); } });
      await writeFile(join(arm.path, "run", "window.lock"), lockText(), "ascii");
      assert.deepEqual(await run.helper.follow(5), ["WINDOW: CLOSED", closed, "NEXT: none"]);
    } finally { await removeFixture(arm); }
  });
  await t.test("UTF-16LE with BOM", async () => {
    const arm = await fixture();
    try {
      const run = await harness(arm);
      const text = `${timestamp} W1 PASS readout\r\n`;
      const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
      await writeFile(join(arm.path, "run", "status.txt"), bytes);
      const lines = await run.helper.follow(5);
      assert.ok(lines.includes("EVENT W1 PASS readout"));
    } finally { await removeFixture(arm); }
  });
});

async function statusArm(statusText, nowText, options = {}) {
  const item = await fixture();
  const run = await harness(item, { sleep: async () => { throw new Error("status slept"); }, ...options });
  if (statusText !== null) await writeFile(join(item.path, "run", "status.txt"), statusText, "ascii");
  if (nowText !== null) await writeFile(join(item.path, "run", "now.txt"), `${nowText}\n`, "ascii");
  if (statusText !== null) await writeFile(join(item.path, "run", "window.lock"), lockText(), "ascii");
  await writeFile(join(item.path, "run", "follow.cursor"), "9\n", "ascii");
  await run.helper.status();
  assert.equal(await readFile(join(item.path, "run", "follow.cursor"), "ascii"), "9\n");
  assertOnePageLine(run.output);
  return { item, run };
}

test("test 6: status is non-blocking, one-line, and boundary based", async () => {
  const cases = [
    [`${timestamp} W4 WAITING lead queue id=a1b2c3 words=wait,finish-later\n`, working, "WAITING lead W4 queue [wait / finish-later]", "status=W4.WAITING.queue"],
    [`${timestamp} W3 WAITING owner copy-key\n`, "Please copy the requested value.", "WAITING owner: Please copy the requested value.", "status=W3.WAITING.copy-key"],
    [`${timestamp} W1 STOP preflight av-third-party\n`, working, "STOP W1 preflight av-third-party", "status=W1.STOP.preflight-av-third-party"],
    [`${timestamp} W11 DONE done\n`, done, done, "status=W11.DONE.done"],
  ];
  for (const [statusText, nowText, expected, token] of cases) {
    const { item, run } = await statusArm(statusText, nowText);
    try {
      assert.deepEqual(run.output, [expected]);
      assert.ok((await helperLog(item)).includes(token));
    } finally { await removeFixture(item); }
  }
  const item = await fixture();
  try {
    const run = await harness(item, { kill: () => { throw new Error("gone"); }, sleep: async () => { throw new Error("status slept"); } });
    await writeFile(join(item.path, "run", "window.lock"), lockText(), "ascii");
    await writeFile(join(item.path, "run", "status.txt"), `${timestamp} W1 PASS readout\n`, "ascii");
    await run.helper.status();
    assert.deepEqual(run.output, [closed]);
  } finally { await removeFixture(item); }
  const absent = await statusArm(null, null);
  try {
    assert.deepEqual(absent.run.output, [nothing]);
    assert.ok((await helperLog(absent.item)).includes("status=RUN.INFO.none"));
  } finally { await removeFixture(absent.item); }
});

test("test 7: decide enforces the open wait, choices, id, and atomic write", async () => {
  const item = await fixture();
  try {
    const run = await harness(item);
    await run.helper.decide("bogus");
    assert.deepEqual(run.output.splice(0), ["DECIDE: UNKNOWN WORD"]);
    await run.helper.decide("wait");
    assert.deepEqual(run.output.splice(0), ["DECIDE: NOT NOW"]);
    await writeFile(join(item.path, "run", "status.txt"), `${timestamp} W4 WAITING lead queue id=a1b2c3 words=wait,finish-later\n`, "ascii");
    await run.helper.decide("continue");
    assert.deepEqual(run.output.splice(0), ["DECIDE: NOT NOW"]);
    await run.helper.decide("wait");
    assert.deepEqual(run.output.splice(0), ["DECIDED: wait"]);
    assert.equal(await readFile(join(item.path, "run", "decision.txt"), "ascii"), "wait id=a1b2c3\n");
    assert.equal((await readdir(join(item.path, "run"))).some((name) => name.includes("decision.txt.tmp")), false);
    await run.helper.decide("wait");
    assert.deepEqual(run.output.splice(0), ["DECIDE: ALREADY SENT"]);
    await writeFile(join(item.path, "run", "status.txt"), `${timestamp} W4 WAITING lead queue id=d4e5f6 words=finish-later\n`, "ascii");
    await run.helper.decide("wait");
    assert.deepEqual(run.output.splice(0), ["DECIDE: NOT NOW"]);
    await rm(join(item.path, "run", "status.txt"));
    await run.helper.decide("key-visible");
    assert.deepEqual(run.output.splice(0), ["DECIDED: key-visible"]);
    assert.equal(await readFile(join(item.path, "run", "decision.txt"), "ascii"), "key-visible\n");
    for (const line of await helperLog(item)) assert.match(line, /^[a-z0-9_.]{1,40}=[A-Za-z0-9_.:()-]{0,64}$/u);
  } finally { await removeFixture(item); }
});

function dangerCanaries() {
  return [
    "Aa1_".repeat(10), "ab".repeat(16), "cd".repeat(32),
    ["123e4567", "e89b", "42d3", "a456", "426614174000"].join("-"),
    ["x", "workers", "dev"].join("."), `${"owner"}${"@"}${"example"}.${"com"}`,
    `C:${"\\"}${"Users"}${"\\"}${"name"}${"\\"}`,
  ];
}

test("test 8: output guard hides dangerous text and keeps every approved sentence", async () => {
  for (const canary of dangerCanaries()) {
    const item = await fixture();
    try {
      const run = await harness(item);
      await writeFile(join(item.path, "run", "window.lock"), lockText(), "ascii");
      await writeFile(join(item.path, "run", "now.txt"), `${canary}\n`, "utf8");
      await writeFile(join(item.path, "run", "status.txt"), `${timestamp} W1 PASS readout\n`, "ascii");
      await run.helper.status();
      assert.deepEqual(run.output.splice(0), [working]);
      assert.ok((await helperLog(item)).includes("hidden=1"));
      await rm(join(item.path, "run", "follow.cursor"), { force: true });
      await writeFile(join(item.path, "run", "status.txt"), `${timestamp} W1 INFO ${canary}\n${timestamp} W1 PASS readout\n`, "utf8");
      const lines = await run.helper.follow(5);
      assert.equal(lines.some((line) => line.includes(canary)), false);
      assert.ok(lines.some((line) => /^HIDDEN: [1-9]/u.test(line)));
    } finally { await removeFixture(item); }
  }
  const sentences = [
    "Your Brain: ready.", "Your Brain: still putting away recent documents.", "Documents: finished loading.",
    "Documents: still loading.", "Update: can start.", "Update: not today. Your Brain keeps working as it is.",
    "This computer needs a quick check first. Nothing was changed.",
    "Please pause your screen share for a minute; your password manager will be on screen.",
    "Open your password manager, find Financial Brain updates, and click Copy. I'll say Got it.",
    "Still waiting for the key. Click Copy on Financial Brain updates in your password manager.",
    "That copy held more than one key-like value. Copy only the key, please.", "Got it.", "Checking the key.",
    "That key didn't work. Please copy it once more.", "Checked.", "Saved on this computer.", "You can share again.",
    "Let's do this part later. You can share again.", "Using the key saved on this computer.",
    "The key saved on this computer no longer works.",
    "Your Brain is still putting away about 1200 recent items. That takes about 20 minutes.",
    "We'll do the update another time. Your Brain keeps working as it is.", "Getting the update ready.",
    "Updating your Brain. This usually takes 10 to 25 minutes, sometimes longer. Nothing for you to do.",
    "Update step 6 of 13. Nothing for you to do.",
    "Update step 6 of 13: a safety pause that can last up to 20 minutes. Nothing for you to do.",
    "Updated. Your Brain is on 0.4.9.", "Checking your calendar connection.", "Your calendar connection works.",
    "Google is busy loading your documents, so the calendar check waits for another day.",
    "Google will warn that this app isn't verified. That's because it's your own private app, made just for your Brain. Click Advanced, then Continue.",
    "If Google shows boxes, tick every one, then click Continue.",
    "Google is opening in your browser. Pick your Google account.",
    "Google gave your Brain access to Drive, Gmail and Calendar.",
    "Google did not give access to Drive, Gmail and Calendar. Drive, Gmail and Calendar won't load until it's allowed. We'll sort that out with you.",
    "That was a different Google account from before.", "The Google sign-in didn't finish. That's fine; we'll do it another time.",
    "One moment: someone on our side needs to look at this. Your Brain is safe.", done, nothing, opening,
    "The update window is already open.", "The update window did not open. Nothing was changed.", mismatch, closed, working,
  ];
  for (const sentence of sentences) {
    assert.equal(isUnsafeText(sentence), false, sentence);
    assert.equal(isUnsafeText(`WAITING owner: ${sentence}`), false, sentence);
    assert.ok(sentence.length <= 160, sentence);
  }

  const ownerSentence = sentences.find((sentence) => sentence.startsWith("Google will warn"));
  const ownerItem = await fixture();
  try {
    const run = await harness(ownerItem);
    await writeFile(join(ownerItem.path, "run", "window.lock"), lockText(), "ascii");
    await writeFile(join(ownerItem.path, "run", "now.txt"), `${ownerSentence}\n`, "ascii");
    await writeFile(join(ownerItem.path, "run", "status.txt"), `${timestamp} W8 WAITING owner google-consent\n`, "ascii");
    await run.helper.status();
    assert.deepEqual(run.output, [`WAITING owner: ${ownerSentence}`]);
  } finally { await removeFixture(ownerItem); }

  const cutItem = await fixture();
  try {
    const run = await harness(cutItem);
    await writeFile(join(cutItem.path, "run", "window.lock"), lockText(), "ascii");
    await writeFile(join(cutItem.path, "run", "now.txt"), `${"q".repeat(170)}\n`, "ascii");
    await writeFile(join(cutItem.path, "run", "status.txt"), `${timestamp} W1 PASS readout\n`, "ascii");
    await run.helper.status();
    assert.deepEqual(run.output, ["q".repeat(160)]);
    assert.ok((await helperLog(cutItem)).includes("now_cut=yes"));
  } finally { await removeFixture(cutItem); }
});

test("test 9: session folder comes from the helper location seam, not the working directory", async () => {
  const item = await fixture({ label: "folder with space and owner's quote" });
  const before = process.cwd();
  const elsewhere = await freshSession("elsewhere");
  try {
    process.chdir(elsewhere.path);
    const run = await harness(item);
    await run.helper.start();
    assert.deepEqual(run.output, [opening]);
    assert.equal(run.helper.sessionDir, await realpath(item.path));
    assert.ok(await stat(join(item.path, "run", "helper.txt")));
    await assert.rejects(stat(join(elsewhere.path, "run", "helper.txt")));

    const localCopy = join(item.path, "helper copy.mjs");
    await writeFile(localCopy, await readFile(helperPath), "utf8");
    const command = spawnSync(process.execPath, [localCopy, "status"], {
      cwd: elsewhere.path,
      encoding: "utf8",
      env: { HOME: item.path, TMPDIR: tmpdir(), BRAIN_NO_WRANGLER_LOGIN: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(command.status, 0, command.stderr);
    assert.equal(command.stdout, `${nothing}\n`);
    assert.ok(await stat(join(item.path, "run", "helper.txt")));
    await assert.rejects(stat(join(elsewhere.path, "run", "helper.txt")));
    const localModule = await import(`${pathToFileURL(localCopy).href}?local=${Date.now()}`);
    const localOutput = [];
    const localHelper = await localModule.createHelper({
      platform: "win32", nodeMajor: 24, output: (line) => localOutput.push(line),
    });
    await localHelper.start();
    assert.deepEqual(localOutput, [mismatch]);
    assert.ok(await stat(join(item.path, "run", "helper.txt")));
    await assert.rejects(stat(join(elsewhere.path, "run", "helper.txt")));
  } finally {
    process.chdir(before);
    await removeFixture(item);
    await removeFixture(elsewhere);
  }
});

test("test 10: substitution changes only the two marked lines and placeholder start is closed", async () => {
  const source = await readFile(defaultHelperPath, "utf8");
  const lines = source.split("\n");
  const baseIndex = lines.findIndex((line) => line.endsWith("// @base-url"));
  const pinsIndex = lines.findIndex((line) => line.endsWith("// @pins"));
  assert.notEqual(baseIndex, -1);
  assert.notEqual(pinsIndex, -1);
  assert.equal(lines.filter((line) => line.endsWith("// @base-url")).length, 1);
  assert.equal(lines.filter((line) => line.endsWith("// @pins")).length, 1);
  const changed = [...lines];
  changed[baseIndex] = "const BASE_URL = \"https://example.invalid/built\"; // @base-url";
  changed[pinsIndex] = `const PINS = ${JSON.stringify({ "facts.json": { sha256: "a".repeat(64), bytes: 3 } })}; // @pins`;
  const temp = join(tmpdir(), `fb-sub-${process.pid}-${Date.now()}.mjs`);
  await writeFile(temp, changed.join("\n"), "utf8");
  try {
    const check = spawnSync(process.execPath, ["--check", temp], {
      encoding: "utf8", env: { ...process.env, BRAIN_NO_WRANGLER_LOGIN: "1" }, shell: false,
      stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, windowsHide: true,
    });
    assert.equal(check.status, 0, check.stderr);
    assert.deepEqual(lines.flatMap((line, index) => line === changed[index] ? [] : [index]), [baseIndex, pinsIndex]);
  } finally { await rm(temp, { force: true }); }
  const item = await fixture();
  try {
    let fetches = 0;
    const output = [];
    const helper = await createHelper({
      sessionDir: item.path, platform: "win32", nodeMajor: 24,
      fetch: async () => { fetches += 1; throw new Error("unexpected"); }, output: (line) => output.push(line),
    });
    await helper.start();
    assert.deepEqual(output, [mismatch]);
    assert.equal(fetches, 0);
    assert.ok((await helperLog(item)).includes("start=stop-not-built"));
  } finally { await removeFixture(item); }
});

test("test 12: every page verb remains exactly one safe page-form line", async () => {
  const item = await fixture();
  try {
    const run = await harness(item);
    await writeFile(join(item.path, "run", "window.lock"), lockText(), "ascii");
    await writeFile(join(item.path, "run", "status.txt"), `${timestamp} W4 WAITING lead queue id=a1b2c3 words=wait,finish-later\n`, "ascii");
    for (const action of [() => run.helper.status(), () => run.helper.decide("wait")]) {
      run.output.length = 0;
      await action();
      assertOnePageLine(run.output);
    }
    const canary = "Aa1_".repeat(10);
    await writeFile(join(item.path, "run", "now.txt"), `${canary}\n`, "ascii");
    await writeFile(join(item.path, "run", "status.txt"), `${timestamp} W3 WAITING owner copy-key\n`, "ascii");
    run.output.length = 0;
    await run.helper.status();
    assert.deepEqual(run.output, [`WAITING owner: ${working}`]);
    assertOnePageLine(run.output);
    assert.ok((await helperLog(item)).includes("hidden=1"));
    for (const line of await helperLog(item)) assert.match(line, /^[a-z0-9_.]{1,40}=[A-Za-z0-9_.:()-]{0,64}$/u);
  } finally { await removeFixture(item); }
});
