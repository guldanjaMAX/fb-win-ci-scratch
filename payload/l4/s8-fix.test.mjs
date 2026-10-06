import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("store harness cleanup forces success after absence readback", () => {
  const source = readFileSync(join(here, "windows-store-pull.mjs"), "utf8");
  assert.match(source, /task remained registered[\s\S]*\nexit 0\n/u);
  assert.match(source, /command_argv[\s\S]*status[\s\S]*stdout_first_5[\s\S]*stderr_first_5/u);

  const mutant = source.replace("\nexit 0\n", "\n");
  assert.doesNotMatch(mutant, /task remained registered[\s\S]*\nexit 0\n/u);
});

test("hidden-window proof uses the live process handle, not stdout TTY attachment", () => {
  const source = readFileSync(join(here, "windows-store-pull.mjs"), "utf8");
  assert.match(source, /processWindowHandle\(records\[0\]\.pid\)/u,
    "green control reaches the live child handle check");
  assert.match(source, /assert\.equal\(processWindowHandle\(records\[0\]\.pid\), "0"/u);
  assert.doesNotMatch(source, /assert\.equal\(records\[0\]\.stdout_tty, false/u,
    "stdout TTY attachment is diagnostic and does not imply a visible window");

  const mutant = source.replace(
    'assert.equal(processWindowHandle(records[0].pid), "0", "stub-had-visible-window");',
    'void processWindowHandle(records[0].pid);',
  );
  assert.doesNotMatch(mutant, /assert\.equal\(processWindowHandle\(records\[0\]\.pid\), "0"/u,
    "removing the live visibility assertion is a caught mutation");
});

test("WCI failure details preserve bounded cleanup diagnostics", () => {
  const source = readFileSync(join(here, "..", "..", "wci", "out", "repo", "ci", "wci-run.mjs"), "utf8");
  for (const token of [
    "store-pull-results.json",
    "cleanup-${index + 1}",
    "command-argv",
    "stdout-first-5",
    "stderr-first-5",
  ]) assert.ok(source.includes(token), token);

  const mutant = source.replace('const cleanup = Array.isArray(structured.get(arm)?.cleanup) ? structured.get(arm).cleanup : [];', 'const cleanup = [];');
  assert.doesNotMatch(mutant, /structured\.get\(arm\)\?\.cleanup/u,
    "discarding structured cleanup evidence is a caught mutation");
});

test("R-REG config proves the intended registry state and avoids a vacuous fixture", () => {
  const source = readFileSync(join(here, "windows-session.mjs"), "utf8");
  assert.match(source, /assertRegistryArmState\(snapshot, mode\)/u);
  assert.match(source, /const target = spec\.statuses\.at\(-1\)/u);
  const arms = readFileSync(join(here, "reference", "arms.mjs"), "utf8");
  assert.match(arms, /R-REG[\s\S]*W1 INFO history-on[\s\S]*W3 SKIP history-unproven[\s\S]*W11 DONE done/u);
});
