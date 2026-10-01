#!/usr/bin/env node

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function facts(values) {
  for (const [name, value] of Object.entries(values)) {
    process.stdout.write(`fb:${name}=${value}\n`);
  }
}

function parseArgs(argv) {
  const parsed = { ocrOff: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--ocr-off") {
      if (parsed.ocrOff) throw new Error("bad arguments");
      parsed.ocrOff = true;
      continue;
    }
    if (!["--manifest", "--backup-dir", "--desktop", "--cap"].includes(token)) {
      throw new Error("bad arguments");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || Object.hasOwn(parsed, token)) {
      throw new Error("bad arguments");
    }
    parsed[token] = value;
    index += 1;
  }
  if (!parsed["--manifest"] || !parsed["--backup-dir"] || !parsed["--desktop"]) {
    throw new Error("bad arguments");
  }
  if (parsed.ocrOff && parsed["--cap"] !== "10") throw new Error("bad cap");
  if (!parsed.ocrOff && parsed["--cap"] !== undefined) throw new Error("bad arguments");
  return {
    manifest: resolve(parsed["--manifest"]),
    backupDir: resolve(parsed["--backup-dir"]),
    desktop: resolve(parsed["--desktop"]),
    ocrOff: parsed.ocrOff,
  };
}

function regularSingleLink(path) {
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}

function timestampUtc(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z");
}

function localDay(now) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function exclusiveCopy(source, target) {
  copyFileSync(source, target, 1);
}

function desktopCopy(source, desktop, now) {
  mkdirSync(desktop, { recursive: true });
  const stem = `owner-brain-manifest-${localDay(now)}`;
  for (let number = 1; number <= 10_000; number += 1) {
    const suffix = number === 1 ? "" : `-${number}`;
    const target = join(desktop, `${stem}${suffix}.json`);
    try {
      exclusiveCopy(source, target);
      return target;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("desktop copy names exhausted");
}

function decodeJson(bytes) {
  const bom = bytes.subarray(0, 3).equals(UTF8_BOM);
  const text = bytes.subarray(bom ? 3 : 0).toString("utf8");
  return { bom, text, value: JSON.parse(text) };
}

function formatOf(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailing = text.endsWith(eol);
  const match = text.match(/(?:^|\r?\n)(\t| {2}| {4})"/u);
  return { eol, trailing, indent: match?.[1] || "  " };
}

function comparable(value) {
  const copy = structuredClone(value);
  if (copy && typeof copy === "object") {
    if (!copy.safety || typeof copy.safety !== "object" || Array.isArray(copy.safety)) {
      copy.safety = {};
    }
    if (!copy.safety.ocr || typeof copy.safety.ocr !== "object" || Array.isArray(copy.safety.ocr)) {
      copy.safety.ocr = {};
    }
    copy.safety.ocr.enabled = "__allowed__";
    copy.safety.daily_llm_spend_cap_usd = "__allowed__";
  }
  return copy;
}

function sameExceptAllowed(before, after) {
  return JSON.stringify(comparable(before)) === JSON.stringify(comparable(after));
}

function jsonValueSpans(text) {
  const spans = new Map();
  const whitespace = /\s/u;
  const skip = (start) => {
    let index = start;
    while (index < text.length && whitespace.test(text[index])) index += 1;
    return index;
  };
  const stringAt = (start) => {
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index] === "\"") return { value: JSON.parse(text.slice(start, index + 1)), end: index + 1 };
      else index += 1;
    }
    throw new Error("unterminated string");
  };
  const valueAt = (start, path) => {
    const begin = skip(start);
    let end;
    if (text[begin] === "{") {
      let index = skip(begin + 1);
      if (text[index] === "}") end = index + 1;
      else {
        while (index < text.length) {
          const key = stringAt(index);
          index = skip(key.end);
          if (text[index] !== ":") throw new Error("missing colon");
          const child = valueAt(index + 1, [...path, key.value]);
          index = skip(child.end);
          if (text[index] === "}") { end = index + 1; break; }
          if (text[index] !== ",") throw new Error("missing comma");
          index = skip(index + 1);
        }
      }
    } else if (text[begin] === "[") {
      let index = skip(begin + 1);
      let item = 0;
      if (text[index] === "]") end = index + 1;
      else {
        while (index < text.length) {
          const child = valueAt(index, [...path, String(item)]);
          item += 1;
          index = skip(child.end);
          if (text[index] === "]") { end = index + 1; break; }
          if (text[index] !== ",") throw new Error("missing array comma");
          index = skip(index + 1);
        }
      }
    } else if (text[begin] === "\"") {
      end = stringAt(begin).end;
    } else {
      end = begin;
      while (end < text.length && !/[\s,}\]]/u.test(text[end])) end += 1;
      JSON.parse(text.slice(begin, end));
    }
    if (!Number.isInteger(end)) throw new Error("unterminated value");
    if (path.length) spans.set(path.join("\u0000"), { start: begin, end });
    return { start: begin, end };
  };
  valueAt(0, []);
  return spans;
}

function renderEditedText(text, after, format) {
  const spans = jsonValueSpans(text);
  const replacements = [
    ["safety\u0000ocr\u0000enabled", "false"],
    ["safety\u0000daily_llm_spend_cap_usd", "10"],
  ].map(([path, value]) => ({ ...spans.get(path), value }))
    .filter((entry) => Number.isInteger(entry.start))
    .sort((left, right) => right.start - left.start);
  if (replacements.length === 2) {
    let edited = text;
    for (const replacement of replacements) {
      edited = edited.slice(0, replacement.start) + replacement.value + edited.slice(replacement.end);
    }
    return edited;
  }
  let serialized = JSON.stringify(after, null, format.indent).replace(/\n/g, format.eol);
  if (format.trailing) serialized += format.eol;
  return serialized;
}

function atomicWrite(path, bytes, nonce) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${nonce}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    throw error;
  }
}

function printable(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "unknown";
}

export function editManifest(options, seams = {}) {
  const now = seams.now ?? new Date();
  const output = {
    backup: "no",
    desktop_copy: "no",
    ocr_before: "unknown",
    ocr_after: "unknown",
    cap_before: "unknown",
    cap_after: "unknown",
    changed: "no",
    result: "edit_failed",
  };
  let originalBytes;
  let backupPath;
  try {
    if (!regularSingleLink(options.manifest)) throw new Error("unsafe manifest");
    originalBytes = readFileSync(options.manifest);
    mkdirSync(options.backupDir, { recursive: true });
    backupPath = join(options.backupDir, `manifest-${timestampUtc(now)}.json`);
    exclusiveCopy(options.manifest, backupPath);
    output.backup = "yes";
    try {
      desktopCopy(options.manifest, options.desktop, now);
      output.desktop_copy = "yes";
    } catch {
      output.desktop_copy = "no";
    }

    const decoded = decodeJson(originalBytes);
    const before = decoded.value;
    output.ocr_before = printable(before?.safety?.ocr?.enabled);
    output.cap_before = printable(before?.safety?.daily_llm_spend_cap_usd);
    if (!options.ocrOff) {
      output.ocr_after = output.ocr_before;
      output.cap_after = output.cap_before;
      output.result = output.desktop_copy === "yes" ? "pass" : "edit_failed";
      return { code: output.result === "pass" ? 0 : 2, output };
    }

    const after = structuredClone(before);
    if (!after.safety || typeof after.safety !== "object" || Array.isArray(after.safety)) after.safety = {};
    if (!after.safety.ocr || typeof after.safety.ocr !== "object" || Array.isArray(after.safety.ocr)) {
      after.safety.ocr = {};
    }
    after.safety.ocr.enabled = false;
    after.safety.daily_llm_spend_cap_usd = 10;
    output.ocr_after = "false";
    output.cap_after = "10";
    output.changed = JSON.stringify(before) === JSON.stringify(after) ? "no" : "yes";
    if (output.changed === "no") {
      output.result = output.desktop_copy === "yes" ? "pass" : "edit_failed";
      return { code: output.result === "pass" ? 0 : 2, output };
    }

    const format = formatOf(decoded.text);
    const serialized = renderEditedText(decoded.text, after, format);
    const editedBytes = Buffer.concat([
      decoded.bom ? UTF8_BOM : Buffer.alloc(0),
      Buffer.from(serialized, "utf8"),
    ]);
    atomicWrite(options.manifest, editedBytes, "edit");
    if (typeof seams.afterRename === "function") seams.afterRename(options.manifest);

    let verified;
    try {
      verified = decodeJson(readFileSync(options.manifest)).value;
    } catch {
      verified = null;
    }
    if (!verified || !sameExceptAllowed(before, verified) ||
        verified?.safety?.ocr?.enabled !== false ||
        verified?.safety?.daily_llm_spend_cap_usd !== 10) {
      atomicWrite(options.manifest, originalBytes, "restore");
      output.result = "verify_failed";
      return { code: 3, output };
    }
    output.result = output.desktop_copy === "yes" ? "pass" : "edit_failed";
    return { code: output.result === "pass" ? 0 : 2, output };
  } catch {
    output.result = "edit_failed";
    return { code: 2, output };
  }
}

export function runCli(argv) {
  let result;
  try {
    result = editManifest(parseArgs(argv));
  } catch {
    result = {
      code: 2,
      output: {
        backup: "no",
        desktop_copy: "no",
        ocr_before: "unknown",
        ocr_after: "unknown",
        cap_before: "unknown",
        cap_after: "unknown",
        changed: "no",
        result: "edit_failed",
      },
    };
  }
  facts(result.output);
  return result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
