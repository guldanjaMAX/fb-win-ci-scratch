import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const STEP_FILES = new Set(["exit.txt", "meta.txt", "events.txt", "out.log"]);
const REAL_ARM_FILES = new Set(["real-npm.json", "window-close.json", "task-end.json"]);
const MAX_STEP_BYTES = 64 * 1024;

function selected(relativePath) {
  const parts = relativePath.split(sep);
  const name = parts.at(-1);
  if (parts.length === 1) return true;
  if (name === "result.json" || name === "status.txt") return true;
  if (REAL_ARM_FILES.has(name)) return true;
  if (/decision.*\.txt$/iu.test(name) || /detail.*\.txt$/iu.test(name)) return true;
  return parts.includes("steps") && STEP_FILES.has(name);
}

async function filesUnder(root, folder = root) {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(root, path));
    else if (entry.isFile()) found.push({ path, relativePath: relative(root, path) });
  }
  return found;
}

export async function buildSlimArtifact({ source, output }) {
  const sourceRoot = resolve(source);
  const outputRoot = resolve(output);
  if (sourceRoot === outputRoot || outputRoot.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error("output must be outside source");
  }
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  let copied = 0;
  let truncated = 0;
  for (const item of await filesUnder(sourceRoot)) {
    if (!selected(item.relativePath)) continue;
    const destination = resolve(outputRoot, item.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    const parts = item.relativePath.split(sep);
    if (parts.includes("steps") && STEP_FILES.has(parts.at(-1))) {
      const data = await readFile(item.path);
      await writeFile(destination, data.subarray(0, MAX_STEP_BYTES));
      if (data.length > MAX_STEP_BYTES) truncated += 1;
    } else {
      await copyFile(item.path, destination);
    }
    copied += 1;
  }
  return { copied, truncated, max_step_bytes: MAX_STEP_BYTES };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--source", "--out"].includes(flag)) throw new Error("usage: slim-artifact --source <dir> --out <dir>");
    values[flag.slice(2)] = value;
  }
  if (!values.source || !values.out) throw new Error("usage: slim-artifact --source <dir> --out <dir>");
  return values;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const receipt = await buildSlimArtifact({ source: args.source, output: args.out });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
