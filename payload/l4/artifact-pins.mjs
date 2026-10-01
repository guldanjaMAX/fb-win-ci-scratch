import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pinTable = JSON.parse(readFileSync(resolve(here, "runner-pins.json"), "utf8"));

export function expectedRunnerNames() {
  return pinTable.files.map((entry) => entry.name);
}

export function runnerPinTable() {
  return JSON.parse(JSON.stringify(pinTable));
}

export function verifyRunnerArtifacts(runnerDir, { allowMissing = false } = {}) {
  const missing = [];
  const mismatches = [];
  const checked = [];
  for (const entry of pinTable.files) {
    const path = resolve(runnerDir, entry.name);
    if (!existsSync(path)) {
      missing.push(entry.name);
      continue;
    }
    const bytes = readFileSync(path);
    const actual = createHash("sha256").update(bytes).digest("hex");
    const size = statSync(path).size;
    if (actual !== entry.sha256 || size !== entry.bytes) {
      mismatches.push({ name: entry.name, expectedSha256: entry.sha256, actualSha256: actual, expectedBytes: entry.bytes, actualBytes: size });
    } else {
      checked.push({ name: entry.name, sha256: actual, bytes: size });
    }
  }
  const pass = mismatches.length === 0 && (allowMissing || missing.length === 0);
  return { pass, missing, mismatches, checked };
}
