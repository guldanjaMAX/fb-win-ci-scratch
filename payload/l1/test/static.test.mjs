import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const outDir = resolve(new URL("..", import.meta.url).pathname);
const helperPath = process.env.HELPER_PATH ? resolve(process.env.HELPER_PATH) : join(outDir, "fb-win.mjs");
const stubPath = join(outDir, "ps", "stub.ps1");
const registerPath = join(outDir, "ps", "register.ps1");

async function walk(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(path));
    else paths.push(path);
  }
  return paths;
}

function powerShellViolations(text, { registration = false } = {}) {
  const findings = [];
  const checks = [
    [["Add", "-Type"].join(""), /Add\s*-?\s*Type/iu],
    ["expression execution", /Invoke-Expression|\biex\b/iu],
    ["process launch", /Start-Process/iu],
    ["key simulation", /SendKeys/iu],
    ["input prompt", /Read-Host/iu],
    ["new shell join", /&&|\|\||\?\?|\?\.|\s\?\s|\s-Parallel\b|\bclean\s*\{/u],
    ["blocked state word", new RegExp(["dis", "abled"].join(""), "iu")],
  ];
  if (!registration) checks.push(["encoded action", /-EncodedCommand/iu]);
  for (const [label, pattern] of checks) if (pattern.test(text)) findings.push(label);
  if (/ConvertFrom-Json/iu.test(text) && !/(?:facts|phrases)\.json|steps/iu.test(text)) findings.push("json path");
  if (/Set-Clipboard/iu.test(text) && !/Set-Clipboard\s+['"] ['"]/iu.test(text)) findings.push("clipboard value");
  if (/\$env:CLOUDFLARE_API_TOKEN/iu.test(text)) findings.push("credential environment");
  const sealed = String.fromCharCode(97, 108, 105, 103, 110);
  if (text.toLowerCase().includes(sealed)) findings.push("sealed word");
  return findings;
}

function spawnViolations(text) {
  const findings = [];
  if (/shell\s*:\s*true/u.test(text)) findings.push("shell true");
  const calls = [...text.matchAll(/\bspawn(?:Sync)?\s*\(/gu)].length;
  const hidden = [...text.matchAll(/windowsHide\s*:\s*true/gu)].length;
  const safeShell = [...text.matchAll(/shell\s*:\s*false/gu)].length;
  if (hidden < calls) findings.push("missing hidden flag");
  if (safeShell < calls) findings.push("missing shell false");
  return findings;
}

function publicViolations(text) {
  const findings = [];
  if (/[a-fA-F0-9]{32}/u.test(text)) findings.push("literal long hex");
  for (const match of text.matchAll(/[A-Za-z0-9_-]{35,}/gu)) {
    if (/[A-Z]/u.test(match[0]) && /[a-z]/u.test(match[0]) && /[0-9]/u.test(match[0])) findings.push("literal key shape");
  }
  if (new RegExp(["workers", "dev"].join("\\."), "iu").test(text)) findings.push("worker host");
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(text)) findings.push("email");
  const homeSlash = ["/", "Users", "/", "[^/\\s]+", "/"].join("");
  const homeDrive = ["[A-Za-z]:", "\\\\", "Users", "\\\\", "[^\\\\\\s]+", "\\\\"].join("");
  if (new RegExp(homeSlash, "u").test(text) || new RegExp(homeDrive, "iu").test(text)) findings.push("home path");
  for (const match of text.matchAll(/https:\/\/([^/\s"']+)/gu)) {
    if (!/(?:^|\.)github\.com$|^example\.invalid$|(?:^|\.)financialbrain\.ai$/iu.test(match[1])) findings.push("unapproved secure host");
  }
  const sealed = String.fromCharCode(97, 108, 105, 103, 110);
  if (text.toLowerCase().includes(sealed)) findings.push("sealed word");
  return findings;
}

test("test 11: PowerShell and spawn static gates reject planted defects", async () => {
  const stubBytes = await readFile(stubPath);
  const registerBytes = await readFile(registerPath);
  for (const bytes of [stubBytes, registerBytes]) {
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.some((byte) => byte > 0x7f), false);
  }
  assert.deepEqual(powerShellViolations(stubBytes.toString("ascii")), []);
  assert.deepEqual(powerShellViolations(registerBytes.toString("ascii"), { registration: true }), []);

  const scratch = await mkdtemp(join(tmpdir(), "fb-static-"));
  try {
    const plantedPs = join(scratch, "bad.ps1");
    await writeFile(plantedPs, `${["Add", "-Type"].join("")} -TypeDefinition 'x'\n`, "ascii");
    assert.ok(powerShellViolations(await readFile(plantedPs, "ascii")).length > 0);
    const plantedJs = join(scratch, "bad.mjs");
    const call = ["spawn", "('tool', [], { shell: ", "true", " })"].join("");
    await writeFile(plantedJs, call, "ascii");
    assert.ok(spawnViolations(await readFile(plantedJs, "ascii")).length > 0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const helper = await readFile(helperPath, "utf8");
  assert.deepEqual(spawnViolations(helper), []);
  for (const path of await walk(outDir)) {
    if (extname(path) !== ".mjs") continue;
    assert.deepEqual(spawnViolations(await readFile(path, "utf8")), [], path);
  }
});

test("test 11: synced sources pass public hygiene and imported site patterns", async (t) => {
  const paths = await walk(outDir);
  for (const path of paths) {
    if (![".mjs", ".ps1", ".md"].includes(extname(path))) continue;
    const text = await readFile(path, "utf8");
    assert.deepEqual(publicViolations(text), [], path);
  }

  const namesList = process.env.FB_NAMES_GREP;
  if (!namesList) {
    console.log("skipped-no-list");
  } else {
    for (const path of paths) {
      const text = (await readFile(path, "utf8"))
        .replace(/\b[A-Z]{4}-V3-(?:PREDRAFT|FOLD)\b/g, "");
      const result = spawnSync("grep", ["-n", "-i", "-w", "-E", "-f", namesList], {
        encoding: "utf8", input: text, shell: false, stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000, windowsHide: true,
      });
      assert.equal(result.status, 1, `${path}: ${result.stdout}`);
    }
  }

  const releaseModule = process.env.FB_RELEASE_GATE_MODULE;
  if (!releaseModule) {
    console.log("skipped-no-release-module");
    return;
  }
  const imported = await import(pathToFileURL(releaseModule).href);
  assert.ok(Array.isArray(imported.NONSTABLE_FORBIDDEN_ASSET_PATTERNS));
  for (const path of [helperPath, stubPath, registerPath]) {
    const text = await readFile(path, "utf8");
    for (const [label, pattern] of imported.NONSTABLE_FORBIDDEN_ASSET_PATTERNS) {
      await t.test(`${label}: ${extname(path)}`, () => assert.equal(pattern.test(text), false));
    }
  }
});
