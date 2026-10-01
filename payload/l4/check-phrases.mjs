import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function spanFor(entry) {
  if (Number.isInteger(entry.line)) return [entry.line, entry.line];
  if (Array.isArray(entry.lines) && entry.lines.length === 2 && entry.lines.every(Number.isInteger)) return entry.lines;
  throw new Error(`${entry.id}: bad line citation`);
}

function inOrder(text, fragments) {
  let cursor = 0;
  for (const fragment of fragments) {
    const found = text.indexOf(fragment, cursor);
    if (found < 0) return false;
    cursor = found + fragment.length;
  }
  return true;
}

export function checkLegacy(kitTree, tablePath, { print = true } = {}) {
  const table = loadJson(tablePath);
  const entries = Array.isArray(table.entries) ? table.entries : [];
  const results = [];
  for (const entry of entries) {
    let pass = false;
    let detail = "";
    try {
      const [start, end] = spanFor(entry);
      const lines = readFileSync(resolve(kitTree, entry.file), "utf8").split(/\r?\n/);
      if (start < 1 || end < start || end > lines.length) throw new Error("citation outside file");
      const cited = lines.slice(start - 1, end).join("\n");
      if (!Array.isArray(entry.fragments) || !entry.fragments.length) throw new Error("no fragments");
      pass = inOrder(cited, entry.fragments);
      detail = pass ? `${entry.file}:${start}${end === start ? "" : `-${end}`}` : "fragment absent or out of order";
    } catch (error) {
      detail = error.message;
    }
    results.push({ id: entry.id, pass, detail });
    if (print) console.log(`${pass ? "PASS" : "FAIL"} ${entry.id} ${detail}`);
  }
  const minimum = Number.isInteger(table.minimum) ? table.minimum : entries.length;
  const countPass = entries.length >= minimum;
  if (print) console.log(`${results.filter((r) => r.pass).length}/${entries.length} phrases matched; minimum=${minimum}`);
  return { pass: countPass && results.length > 0 && results.every((r) => r.pass), results, minimum, countPass };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , kitTree, tablePath] = process.argv;
  if (!kitTree || !tablePath) {
    console.error("usage: node check-phrases.mjs <kit-tree> <table>");
    process.exit(2);
  }
  const result = checkLegacy(kitTree, tablePath);
  process.exitCode = result.pass ? 0 : 1;
}
