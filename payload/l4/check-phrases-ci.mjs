import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkLegacy } from "./check-phrases.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseSource(source) {
  const match = /^(.*):(\d+)$/.exec(source || "");
  if (!match) throw new Error(`bad source ${source || "(missing)"}`);
  return { file: match[1], line: Number(match[2]) };
}

function checkPart(kitTree, id, part) {
  if (part.source === "provider-text") return typeof part.why === "string" && part.why.length > 0;
  const { file, line } = parseSource(part.source);
  const rows = readFileSync(resolve(kitTree, file), "utf8").split(/\r?\n/);
  return line > 0 && line <= rows.length && rows[line - 1].includes(part.match);
}

export function checkMerged(kitTree, tablePath, { print = true } = {}) {
  const table = JSON.parse(readFileSync(tablePath, "utf8"));
  if (table.schema !== 1 || !Array.isArray(table.entries)) return { pass: false, count: 0, results: [] };
  const results = table.entries.map((entry) => {
    const parts = entry.all_of || [entry];
    let pass = false;
    try {
      pass = parts.length > 0 && parts.every((part) => typeof part.match === "string" && checkPart(kitTree, entry.id, part));
    } catch {
      pass = false;
    }
    if (print) console.log(`${pass ? "PASS" : "FAIL"} merged:${entry.id}`);
    return { id: entry.id, pass };
  });
  return { pass: results.length > 0 && results.every((item) => item.pass), count: results.length, results };
}

function mutateMerged(path) {
  const table = JSON.parse(readFileSync(path, "utf8"));
  const first = table.entries[0];
  if (first.all_of) first.all_of[0].match += "x";
  else first.match += "x";
  const dir = mkdtempSync(join(tmpdir(), "phrase-control-"));
  const out = join(dir, "mutated.json");
  writeFileSync(out, `${JSON.stringify(table, null, 2)}\n`);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const kitTree = process.argv[2];
  const merged = process.argv[3];
  if (!kitTree) {
    console.error("usage: node check-phrases-ci.mjs <kit-tree> [merged-table]");
    process.exit(2);
  }

  const real = checkLegacy(kitTree, join(here, "phrases.json"));
  const canary = checkLegacy(kitTree, join(here, "phrases-canary.json"));
  const canaryNamed = canary.results.length === 1 && canary.results[0].id === "canary-verified-spelling" && !canary.results[0].pass;
  console.log(`${canaryNamed ? "PASS" : "FAIL"} canary rejected by id`);

  let mergedOk = true;
  if (merged) {
    const checked = checkMerged(kitTree, merged);
    const mutated = checkMerged(kitTree, mutateMerged(merged), { print: false });
    mergedOk = checked.pass && !mutated.pass;
    console.log(`${mergedOk ? "PASS" : "FAIL"} merged table and mutation control`);
  }

  process.exitCode = real.pass && canaryNamed && mergedOk ? 0 : 1;
}
