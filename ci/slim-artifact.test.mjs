import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSlimArtifact } from "./slim-artifact.mjs";

test("artifact keeps bounded review evidence and excludes executables and kits", async () => {
  const root = mkdtempSync(join(tmpdir(), "wci-slim-"));
  const source = join(root, "source");
  const output = join(root, "output");
  const arm = join(source, "l4-results", "A0", "real-session", "session", "run");
  const step = join(arm, "steps", "update-fixture");
  mkdirSync(step, { recursive: true });
  writeFileSync(join(source, "summary.log"), "summary\n");
  writeFileSync(join(source, "l4-results", "A0", "result.json"), "{}\n");
  writeFileSync(join(arm, "status.txt"), "status\n");
  writeFileSync(join(arm, "decision.txt"), "decision\n");
  writeFileSync(join(arm, "w7-detail.txt"), "detail\n");
  writeFileSync(join(arm, "real-npm.json"), "{}\n");
  writeFileSync(join(arm, "window-close.json"), "{}\n");
  writeFileSync(join(arm, "task-end.json"), "{}\n");
  for (const name of ["exit.txt", "meta.txt", "events.txt"]) writeFileSync(join(step, name), `${name}\n`);
  writeFileSync(join(step, "out.log"), "x".repeat(70 * 1024));
  writeFileSync(join(step, "node.exe"), "never-copy\n");
  writeFileSync(join(arm, "kit.tgz"), "never-copy\n");

  const receipt = await buildSlimArtifact({ source, output });
  assert.ok(receipt.copied > 0, "copy decision point reached");
  assert.equal(readFileSync(join(output, "summary.log"), "utf8"), "summary\n", "small top-level control copied");
  assert.equal(statSync(join(output, "l4-results", "A0", "real-session", "session", "run", "steps", "update-fixture", "out.log")).size, 64 * 1024);
  assert.equal(existsSync(join(output, "l4-results", "A0", "real-session", "session", "run", "steps", "update-fixture", "node.exe")), false);
  assert.equal(existsSync(join(output, "l4-results", "A0", "real-session", "session", "run", "kit.tgz")), false);
  for (const name of ["real-npm.json", "window-close.json", "task-end.json"]) {
    assert.equal(existsSync(join(output, "l4-results", "A0", "real-session", "session", "run", name)), true);
  }
});

test("workflow grants the real-window lane enough time and uploads only the slim tree", () => {
  const workflow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "windows-ps51.yml"), "utf8");
  assert.match(workflow, /timeout-minutes: 120/u);
  assert.match(workflow, /node ci\/slim-artifact\.mjs --source ci-out --out ci-artifact/u);
  assert.match(workflow, /path: ci-artifact/u);
  assert.doesNotMatch(workflow, /path: ci-out(?:\s|$)/u);
});
