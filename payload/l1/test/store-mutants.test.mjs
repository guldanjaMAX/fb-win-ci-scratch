import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourcePath = fileURLToPath(new URL("../fb-store.mjs", import.meta.url));

async function fixture(root, customApi = true) {
  const session = join(root, "session");
  const prefix = join(root, "prefix");
  const cli = join(prefix, "node_modules", "brain-installer", "brain.mjs");
  const manifest = join(root, "manifest.json");
  await mkdir(dirname(cli), { recursive: true });
  await mkdir(join(session, "run"), { recursive: true });
  await writeFile(cli, "// fixture CLI\n", "ascii");
  const corpora = customApi ? { custom_api: { cadence: 86400 } } : {};
  await writeFile(manifest, `${JSON.stringify({ corpora })}\n`, "utf8");
  await writeFile(join(session, "selected-prefix-fixture.txt"), `${prefix}\n`, "utf8");
  await writeFile(join(session, "selected-manifest-fixture.txt"), `${manifest}\n`, "utf8");
  return { session };
}

async function importMutant(root, id, before, after) {
  const source = await readFile(sourcePath, "utf8");
  assert.equal(source.split(before).length, 2, `${id} has exactly one mutation anchor`);
  const path = join(root, `${id}.mjs`);
  await writeFile(path, source.replace(before, after), "utf8");
  return import(`${pathToFileURL(path).href}?mutant=${id}`);
}

function capture(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "", stderr: "" };
  };
}

test("store guard mutants are killed by distinct outcomes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fb-store-mutants-"));
  try {
    await t.test("live-window guard mutant reaches a scheduler write", async () => {
      const module = await importMutant(root, "live-window",
        "if (!done && await storeWindowAlive({ sessionDir, queryProcess })) {",
        "if (false && !done && await storeWindowAlive({ sessionDir, queryProcess })) {");
      const item = await fixture(join(root, "live-fixture"));
      const calls = [];
      const output = [];
      const lockStart = "2026-10-01T14:00:00.000Z";
      await writeFile(join(item.session, "run", "window.lock"), `pid=321\nstart=${lockStart}\n`, "ascii");
      await writeFile(join(item.session, "run", "status.txt"), "2026-10-01T14:00:00Z RUN START start\n", "ascii");
      const scheduler = await module.createStorePullScheduler({
        sessionDir: item.session,
        platform: "win32",
        env: { SystemRoot: "Q:\\Windows" },
        queryProcess: () => lockStart,
        spawn: capture(calls),
        output: (line) => output.push(line),
      });
      assert.equal(await scheduler.schedule(), true, "the mutant exposes the missing refusal");
      assert.deepEqual(output, ["Store data will now load every day at 8:00 AM."]);
      assert.equal(calls.length, 1, "the unsafe mutant reaches a scheduler write");
    });

    await t.test("missing-custom_api guard mutant reaches a scheduler write", async () => {
      const module = await importMutant(root, "custom-api",
        "if (!manifest?.corpora || !Object.hasOwn(manifest.corpora, \"custom_api\")) {",
        "if (false && (!manifest?.corpora || !Object.hasOwn(manifest.corpora, \"custom_api\"))) {");
      const item = await fixture(join(root, "custom-fixture"), false);
      const calls = [];
      const output = [];
      const scheduler = await module.createStorePullScheduler({
        sessionDir: item.session,
        platform: "win32",
        env: { SystemRoot: "Q:\\Windows" },
        spawn: capture(calls),
        output: (line) => output.push(line),
      });
      assert.equal(await scheduler.schedule(), true, "the mutant exposes the missing custom_api refusal");
      assert.deepEqual(output, ["Store data will now load every day at 8:00 AM."]);
      assert.equal(calls.length, 1, "the unsafe mutant reaches a scheduler write");
    });

    await t.test("action-key guard mutant accepts credential material", async () => {
      const module = await importMutant(root, "action-key",
        "if (CREDENTIAL_ACTION.test(argumentsLine) || CREDENTIAL_ACTION.test(source)) {",
        "if (false && (CREDENTIAL_ACTION.test(argumentsLine) || CREDENTIAL_ACTION.test(source))) {");
      const action = module.buildStorePullAction({
        nodePath: "C:\\node.exe",
        cliPath: "C:\\fixture --key value\\brain.mjs",
        manifestPath: "C:\\manifest.json",
      });
      assert.match(action.source, /--key value/u, "the mutant exposes credential material in the action");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
