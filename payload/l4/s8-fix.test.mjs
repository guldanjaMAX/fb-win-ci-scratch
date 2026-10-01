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

test("R-REG config proves the intended registry state and avoids a vacuous fixture", () => {
  const source = readFileSync(join(here, "windows-session.mjs"), "utf8");
  assert.match(source, /assertRegistryArmState\(snapshot, mode\)/u);
  assert.match(source, /const target = spec\.statuses\.at\(-1\)/u);
  const arms = readFileSync(join(here, "reference", "arms.mjs"), "utf8");
  assert.match(arms, /R-REG[\s\S]*W1 INFO history-on[\s\S]*W3 SKIP history-unproven[\s\S]*W11 DONE done/u);
});
