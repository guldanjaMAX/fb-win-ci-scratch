import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourcePath = join(outDir, "fb-win.mjs");
const helperTest = join(outDir, "test", "helper.test.mjs");
const staticTest = join(outDir, "test", "static.test.mjs");
const storePullTest = join(outDir, "test", "store-pull.test.mjs");
const source = await readFile(sourcePath, "utf8");
const scratch = await mkdtemp(join(tmpdir(), "fb-mutants-"));
const mutantTmp = join(scratch, "tmp");
await mkdir(mutantTmp);

const arms = [
  ["M1", "test 7", "if (!choices.includes(word)) {", "if (false && !choices.includes(word)) {"],
  ["M2", "test 5", "if (BOUNDARY_CODES.has(event.code)) {", "if (event.code === \"INFO\" || BOUNDARY_CODES.has(event.code)) {"],
  ["M3", "test 6", "  async function status() {\n", "  async function status() {\n    await sleep(2000);\n"],
  ["M4", "test 8", "export function isUnsafeText(text, acceptedLengths = [40]) {\n", "export function isUnsafeText(text, acceptedLengths = [40]) {\n  return false;\n"],
  ["M5", "test 1", "const enabled = facts.tier2 === \"on\" || facts.w8 === \"on\" || markerOn;", "const enabled = true;"],
  ["M6", "test 3", "if (await fullAlive()) return finishStart(\"already-open\", PAGE_SENTENCES.open);", "if (false && await fullAlive()) return finishStart(\"already-open\", PAGE_SENTENCES.open);"],
  ["M7", "test 2", "const matches = bytes.length === pin.bytes && sha256(bytes) === pin.sha256;", "const matches = true;"],
  ["M8", "test 11", "windowsHide: true,", "windowsHide: false,"],
  ["M9", "test 9", "const sessionDir = await realpath(options.sessionDir ?? moduleDir);", "const sessionDir = await realpath(process.cwd());"],
  ["M10", "test 12", "    output(shown);\n", "    output(shown);\n    output(\"NEXT: follow\");\n"],
  ["M11", "test 1", "if (Object.hasOwn(facts, \"marker\") && facts.marker !== MARKER_NAME) {", "if (false && Object.hasOwn(facts, \"marker\") && facts.marker !== MARKER_NAME) {"],
  ["M12", "test 1", "const markerOn = await markerTurnsOn(join(sessionDir, MARKER_NAME));", "const markerOn = Boolean(await readMaybe(join(sessionDir, MARKER_NAME)));"],
  ["M13", "test 1", "const enabled = facts.tier2 === \"on\" || facts.w8 === \"on\" || markerOn;", "const enabled = facts.tier2 === \"on\" || markerOn;"],
  ["M14", "test 13", "if (!done && await storeWindowAlive({ sessionDir, queryProcess })) {", "if (false && !done && await storeWindowAlive({ sessionDir, queryProcess })) {"],
];

try {
  for (const [id, expectedTest, before, after] of arms) {
    const occurrences = source.split(before).length - 1;
    assert.equal(occurrences, 1, `${id} mutation anchor count`);
    const mutant = source.replace(before, after);
    const path = join(scratch, `${id}.mjs`);
    await writeFile(path, mutant, "utf8");
    const result = spawnSync(process.execPath, ["--test", helperTest, staticTest, storePullTest], {
      encoding: "utf8",
      cwd: scratch,
      env: {
        ...process.env,
        BRAIN_NO_WRANGLER_LOGIN: "1",
        HELPER_PATH: path,
        TMPDIR: mutantTmp,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true,
    });
    const transcript = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.notEqual(result.status, 0, `${id} survived\n${transcript}`);
    const escaped = expectedTest.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(transcript, new RegExp(`(?:not ok|✖).*${escaped}`, "iu"), `${id} missed ${expectedTest}\n${transcript}`);
    process.stdout.write(`${id} caught by ${expectedTest}\n`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
