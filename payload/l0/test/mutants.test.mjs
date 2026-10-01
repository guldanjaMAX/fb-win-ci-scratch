import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..");

const mutants = [
  {
    id: "M1",
    pattern: "1 marker gate",
    change: (source) => source.replace("if (!VALID_MARKERS.has(marker)) {", "if (false) {"),
  },
  {
    id: "M2",
    pattern: "6 output guard",
    change: (source) => source.replace("if (guardOutputLine(line)) kept.push(line);", "if (true) kept.push(line);"),
  },
  {
    id: "M3",
    pattern: "3 stub pins",
    change: (source) => source.replace(
      '.replace("__HASH_LITERAL__", quotePowerShell(expectedHash));',
      '.replace("__HASH_LITERAL__", quotePowerShell(expectedHash)).replace("if (-not [String]::Equals($Actual, $Expected, [StringComparison]::Ordinal)) {", "if ($false) {");',
    ),
  },
  {
    id: "M4",
    pattern: "9 static gates",
    change: (source) => source.replace("windowsHide: true,", "windowsHide: false,"),
  },
  {
    id: "M5",
    pattern: "5 follow",
    change: (source) => source.replace(
      'if (existsSync(join(probeDir, "window1.done")) &&',
      'if (false && existsSync(join(probeDir, "window1.done")) &&',
    ),
  },
  {
    id: "M6",
    pattern: "7 session folder",
    change: (source) => source.replace("options.sessionDir || MODULE_DIR", "process.cwd()"),
  },
];

test("all six mutants are caught by their named probes", async () => {
  const childEnvironment = { ...process.env, BRAIN_NO_WRANGLER_LOGIN: "1" };
  delete childEnvironment.NODE_TEST_CONTEXT;
  for (const mutant of mutants) {
    const root = mkdtempSync(join(tmpdir(), `probe-${mutant.id}-`));
    const copy = join(root, "out");
    await cp(OUT, copy, { recursive: true });
    const helper = join(copy, "fb-probe.mjs");
    const before = readFileSync(helper, "utf8");
    const after = mutant.change(before);
    assert.notEqual(after, before, `${mutant.id} mutation applied`);
    writeFileSync(helper, after, "utf8");
    const result = spawnSync(process.execPath, [
      "--test",
      join(copy, "test", "helper.test.mjs"),
    ], {
      encoding: "utf8",
      env: childEnvironment,
      maxBuffer: 1024 * 1024,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      windowsHide: true,
    });
    assert.notEqual(result.status, 0, `${mutant.id} escaped its probe`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(mutant.pattern.replaceAll(" ", "\\s+")), `${mutant.id} failed outside its named probe`);
    process.stdout.write(`${mutant.id}=caught:${mutant.pattern}\n`);
    await rm(root, { recursive: true, force: true });
  }
});
