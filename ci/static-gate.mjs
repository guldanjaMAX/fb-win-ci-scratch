import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function sourceLine(text, line) {
  return (text.split("\n")[line - 1] ?? "").replace(/\r$/u, "");
}

function contentHash(text, line) {
  return createHash("sha256").update(sourceLine(text, line)).digest("hex");
}

function addMatches(hits, text, file, rule, expression) {
  expression.lastIndex = 0;
  for (const match of text.matchAll(expression)) {
    const line = lineOf(text, match.index);
    hits.push({ file, line, rule, contentHash: contentHash(text, line) });
  }
}

export function inspectPowerShell(bytes, file = "input.ps1") {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const hits = [];
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) {
    hits.push({ file, line: 1, rule: "bom", contentHash: contentHash(buffer.toString("utf8"), 1) });
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    hits.push({ file, line: 1, rule: "bom", contentHash: contentHash(buffer.toString("utf8"), 1) });
  }
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] > 0x7f) {
      hits.push({ file, line: 1, rule: "non-ascii", contentHash: contentHash(buffer.toString("utf8"), 1) });
      break;
    }
  }
  const text = buffer.toString("utf8");
  addMatches(hits, text, file, "add-type", /add\s*-?\s*type/giu);
  addMatches(hits, text, file, "invoke-expression", /\b(?:Invoke-Expression|iex)\b/giu);
  addMatches(hits, text, file, "start-process", /\bStart-Process\b/giu);
  addMatches(hits, text, file, "encoded-command", /-EncodedCommand\b/giu);
  addMatches(hits, text, file, "sendkeys", /\bSendKeys\b/giu);
  addMatches(hits, text, file, "read-host", /\bRead-Host\b/giu);
  addMatches(hits, text, file, "ps7-syntax", /(?:&&|\|\||\?\?|\?\.|\s\?\s[^\r\n:]+:|\bclean\s*\{|\bForEach-Object\s+-Parallel\b)/giu);
  addMatches(hits, text, file, "disabled-word", /\bdisabled\b/giu);
  const sealed = String.fromCharCode(97, 108, 105, 103, 110);
  addMatches(hits, text, file, "sealed-word", new RegExp(sealed, "giu"));

  for (const match of text.matchAll(/ConvertFrom-Json/giu)) {
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const lineEndRaw = text.indexOf("\n", match.index);
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
    const line = text.slice(lineStart, lineEnd);
    const allowedPath = /(?:facts\.json|phrases\.json|steps[\\/])/iu.test(line);
    const hasLimit = /(?:1\s*MB|1048576)/iu.test(text.slice(Math.max(0, lineStart - 500), lineEnd + 200));
    if (!allowedPath || !hasLimit) {
      const lineNumber = lineOf(text, match.index);
      hits.push({ file, line: lineNumber, rule: "json-path", contentHash: contentHash(text, lineNumber) });
    }
  }
  for (const match of text.matchAll(/Set-Clipboard[^\r\n]*/giu)) {
    if (!/(?:-Value\s+)?(?:' '|" ")\s*$/u.test(match[0].trim())) {
      const lineNumber = lineOf(text, match.index);
      hits.push({ file, line: lineNumber, rule: "clipboard-value", contentHash: contentHash(text, lineNumber) });
    }
  }
  for (const match of text.matchAll(/[^\r\n]*\$env:CLOUDFLARE_API_TOKEN[^\r\n]*/giu)) {
    if (/(?:Set-Content|WriteAllText|WriteAllBytes|AppendAllText|Out-File|Add-Content)/iu.test(match[0])) {
      const lineNumber = lineOf(text, match.index);
      hits.push({ file, line: lineNumber, rule: "token-env-write", contentHash: contentHash(text, lineNumber) });
    }
  }
  addMatches(hits, text, file, "winrt-enum-name", /-(?:eq|ne)\s*['"](?:Completed|Started|Canceled|Error)['"]/giu);
  return hits;
}

function maskJavaScriptText(source) {
  const chars = [...source];
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      else chars[index] = " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        blockComment = false;
      } else if (char !== "\n") chars[index] = " ";
      continue;
    }
    if (quote) {
      if (char === "\\") {
        chars[index] = " ";
        if (chars[index + 1] !== "\n") chars[index + 1] = " ";
        index += 1;
      } else if (char === quote) {
        chars[index] = " ";
        quote = "";
      } else if (char !== "\n") chars[index] = " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      chars[index] = " ";
      quote = char;
    } else if (char === "/" && next === "/") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      lineComment = true;
    } else if (char === "/" && next === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      blockComment = true;
    }
  }
  return chars.join("");
}

function callSlices(source, name) {
  const slices = [];
  const expression = new RegExp(`(?<![.$\\w])${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\(`, "gu");
  for (const match of source.matchAll(expression)) {
    let depth = 0;
    let quote = "";
    let end = match.index;
    for (let index = source.indexOf("(", match.index); index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === quote && source[index - 1] !== "\\") quote = "";
      } else if (char === '"' || char === "'" || char === "`") {
        quote = char;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) { end = index + 1; break; }
      }
    }
    slices.push({ index: match.index, text: source.slice(match.index, end) });
  }
  return slices;
}

export function inspectJavaScript(source, file = "input.mjs") {
  const hits = [];
  const masked = maskJavaScriptText(source);
  const names = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "fork"]);
  for (const match of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*(?:\?\?|\|\|)\s*(spawn|spawnSync|execFile|execFileSync|fork)\b/gu)) {
    names.add(match[1]);
  }
  for (const name of names) {
    for (const call of callSlices(masked, name)) {
      if (!/windowsHide\s*:\s*true/u.test(call.text)) {
        hits.push({ file, line: lineOf(source, call.index), rule: "spawn-options" });
      }
      if (/shell\s*:\s*true/u.test(call.text)) {
        hits.push({ file, line: lineOf(source, call.index), rule: "shell-true" });
      }
    }
  }
  for (const name of ["exec", "execSync"]) {
    for (const call of callSlices(masked, name)) {
      hits.push({ file, line: lineOf(source, call.index), rule: "shell-api" });
    }
  }
  return hits;
}

export function parseStaticExemptions(lines) {
  const exemptions = new Map();
  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(\S+)\s+sha256=([a-f0-9]{64})\s+contract=(\S(?:.*\S)?)$/u);
    if (!match) throw new Error("invalid static exemption");
    const [, file, rule, hash] = match;
    if (!exemptions.has(file)) exemptions.set(file, new Map());
    const rules = exemptions.get(file);
    if (!rules.has(rule)) rules.set(rule, new Set());
    rules.get(rule).add(hash);
  }
  return exemptions;
}

function isExempt(exemptions, file, hit) {
  const rules = exemptions.get(file);
  if (!(rules instanceof Map)) return false;
  const hashes = rules.get(hit.rule);
  return hashes instanceof Set && hashes.has(hit.contentHash);
}

export function inspectReleasePatterns(source, file = "input") {
  const text = Buffer.isBuffer(source) ? source.toString("utf8") : source;
  const hits = [];
  const rules = [
    ["release-global-install", /npm(?:\.cmd)?\s+install\s+--global/giu],
    ["release-brain-cmd", /FinancialBrain[\\/]brain\.cmd/giu],
    ["release-technician", /\btechnician\b[^\r\n]*(?:--run|--json)/giu],
    ["release-tools-handoff", /\btools\b[^\r\n]*--handoff/giu],
    ["release-invite-manifest", /\binvite\b[^\r\n]*brain\.manifest\.json/giu],
  ];
  for (const [rule, expression] of rules) addMatches(hits, text, file, rule, expression);
  return hits;
}

function globExpression(pattern) {
  let result = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      result += ".*";
      index += 1;
    } else if (char === "*") {
      result += "[^/]*";
    } else if (char === "?") {
      result += "[^/]";
    } else {
      result += char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`${result}$`, "u");
}

async function allFiles(root) {
  const found = [];
  async function walk(folder) {
    let entries = [];
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(full);
    }
  }
  await walk(root);
  return found;
}

export async function runRepositoryGate({ root, parseTargets = [], exemptions = new Map() }) {
  const files = await allFiles(root);
  const targetRegex = parseTargets.map(globExpression);
  const psTargets = files.filter((file) => {
    const relative = path.relative(root, file).split(path.sep).join("/");
    return /^ci\/ps\/.*\.ps1$/u.test(relative) || targetRegex.some((expression) => expression.test(relative));
  });
  const jsTargets = files.filter((file) => {
    const relative = path.relative(root, file).split(path.sep).join("/");
    return /^payload\/[^/]+\/(?!test\/).*\.mjs$/u.test(relative);
  });
  const servedTargets = files.filter((file) => {
    const relative = path.relative(root, file).split(path.sep).join("/");
    return /^payload\/[^/]+\/(?!test\/).+/u.test(relative);
  });
  const hits = [];
  for (const file of psTargets) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    hits.push(...inspectPowerShell(await readFile(file), relative).filter((hit) => !isExempt(exemptions, relative, hit)));
  }
  for (const file of jsTargets) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    hits.push(...inspectJavaScript(await readFile(file, "utf8"), relative));
  }
  const releaseTargets = [...new Set([...psTargets, ...servedTargets])];
  for (const file of releaseTargets) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    hits.push(...inspectReleasePatterns(await readFile(file), relative));
  }
  return { hits, files: new Set([...psTargets, ...jsTargets, ...servedTargets]).size };
}

async function cli() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !["--ps", "--js"].includes(args[0])) {
    process.stderr.write("usage: node ci/static-gate.mjs --ps|--js <file>\n");
    process.exitCode = 2;
    return;
  }
  const file = args[1];
  const source = await readFile(file, args[0] === "--ps" ? undefined : "utf8");
  const hits = args[0] === "--ps" ? inspectPowerShell(source, file) : inspectJavaScript(source, file);
  process.stdout.write(`hits=${hits.length} rules=${[...new Set(hits.map((hit) => hit.rule))].sort().join(",") || "none"}\n`);
  process.exitCode = hits.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cli();
}
