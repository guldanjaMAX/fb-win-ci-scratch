import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function freshKey() {
  while (true) {
    const value = randomBytes(48).toString("base64url").slice(0, 40);
    if (/[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value)) return value;
  }
}

export function splitCanaries() {
  return {
    account: ["0123456789abcdef", "fedcba9876543210"].join(""),
    email: ["owner", "example.invalid"].join("@"),
    host: ["harness-throwaway", "workers", "dev"].join("."),
    bookmark: ["0123456789abcdef", "0123456789abcdef", "0123456789abcdef", "0123456789abcdef"].join("")
  };
}

export function makeSession(root, { tier2 = true, w8 = false, marker = null } = {}) {
  const session = join(root, "session space's");
  const run = join(session, "run");
  const prefix = join(root, "fake prefix");
  const manifestDir = join(root, "manifest folder");
  const home = join(root, "home");
  const local = join(root, "local data");
  for (const path of [session, run, prefix, manifestDir, home, local]) mkdirSync(path, { recursive: true });
  const manifest = join(manifestDir, "brain.manifest.json");
  const canaries = splitCanaries();
  writeFileSync(manifest, `${JSON.stringify({ client: { slug: "harness-throwaway" }, cloudflare: { account_id: canaries.account }, brain: { worker_name: "harness-throwaway", domain: canaries.host }, safety: { ocr: { enabled: false }, daily_llm_spend_cap_usd: 10 } }, null, 2)}\n`);
  writeFileSync(join(session, "selected-prefix-fixture.txt"), `${prefix}\n`);
  writeFileSync(join(session, "selected-manifest-fixture.txt"), `${manifest}\n`);
  writeFileSync(join(session, "fb-test-seam.marker"), "on\n");
  writeFileSync(join(session, "test-clipboard.txt"), "fixture\n");
  writeFileSync(join(session, "test-history.json"), "{\"enabled\":false}\n");
  writeFileSync(join(session, "test-processes.json"), "[]\n");
  writeFileSync(join(session, "test-machine.json"), "{\"memory_mb\":8192}\n");
  if (marker !== null) writeFileSync(join(session, "REHEARSAL.marker"), marker);
  const facts = {
    schema: 1,
    tier2: tier2 ? "on" : "off",
    w8: w8 ? "on" : "off",
    kit_url: "http://127.0.0.1:1/kit.tgz",
    kit_sha256: "pending",
    kit_bytes: 0,
    kit_version: "0.4.9",
    runtime_payload_sha256: "pending",
    min_free_mb: 512,
    history_delete_proven: false,
    cloud_clipboard_allowed: false,
    key_lengths: [40],
    drain_per_minute: 60,
    marker: "REHEARSAL.marker"
  };
  writeFileSync(join(session, "facts.json"), `${JSON.stringify(facts, null, 2)}\n`);
  return { session, run, prefix, manifest, manifestDir, home, local, canaries };
}

export function installStub(prefix, scenario) {
  const packageDir = join(prefix, "node_modules", "brain-installer");
  const npmDir = join(dirname(process.execPath), "node_modules", "npm", "bin");
  mkdirSync(packageDir, { recursive: true });
  cpSync(join(here, "stub", "brain.mjs"), join(packageDir, "brain.mjs"));
  cpSync(join(here, "stub", "package.json"), join(packageDir, "package.json"));
  cpSync(join(here, "stub", "brain.cmd"), join(prefix, "brain.cmd"));
  cpSync(join(here, "phrases.json"), join(prefix, "phrases.json"));
  writeFileSync(join(prefix, "scenario.json"), `${JSON.stringify(scenario, null, 2)}\n`);
  return { packageDir, npmDir };
}

export function makeFakeNode(root) {
  const nodeDir = join(root, "fake node dir");
  const executable = join(nodeDir, process.platform === "win32" ? "node.exe" : "node-copy");
  const npmDir = join(nodeDir, "node_modules", "npm", "bin");
  mkdirSync(npmDir, { recursive: true });
  copyFileSync(process.execPath, executable);
  chmodSync(executable, 0o755);
  copyFileSync(join(here, "stub", "npm-cli.js"), join(npmDir, "npm-cli.js"));
  return { nodeDir, executable, npmCli: join(npmDir, "npm-cli.js") };
}

export function makeRealNode(root) {
  const nodeDir = join(root, "real node runtime");
  const executable = join(nodeDir, process.platform === "win32" ? "node.exe" : "node-copy");
  const npmSource = join(dirname(process.execPath), "node_modules", "npm");
  const npmRoot = join(nodeDir, "node_modules", "npm");
  mkdirSync(nodeDir, { recursive: true });
  copyFileSync(process.execPath, executable);
  chmodSync(executable, 0o755);
  cpSync(npmSource, npmRoot, { recursive: true });
  return { nodeDir, executable, npmCli: join(npmRoot, "bin", "npm-cli.js") };
}

export function makeKit(run) {
  const kitDir = join(run, "kit");
  mkdirSync(kitDir, { recursive: true });
  const bytes = Buffer.from("fixture kit bytes\n", "utf8");
  const path = join(kitDir, "kit.tgz");
  writeFileSync(path, bytes);
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function makeLargeDriveState(manifestDir, targetBytes = 50 * 1024 * 1024) {
  const path = join(manifestDir, ".brain-ingest-drive.json");
  const prefix = "{\"done\":{\"a\":{}},\"skipped\":{\"b\":{}},\"removed\":{\"c\":{}},\"pad\":\"";
  const suffix = "\"}\n";
  const padSize = Math.max(0, targetBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix));
  const text = `${prefix}${"x".repeat(padSize)}${suffix}`;
  writeFileSync(path, text);
  return { path, bytes: Buffer.byteLength(text) };
}

export function scenarioFor(linesByCommand, key) {
  return {
    version: "0.4.9",
    right_key_sha256: createHash("sha256").update(key).digest("hex"),
    commands: linesByCommand
  };
}

export function scenarioForSupervisorArgv(sequence, key, processesPath = null) {
  const commandByLabel = new Map([
    ["health", "health"],
    ["health-key", "health"],
    ["verify", "verify"],
    ["update-preview", "update"],
    ["update", "update"],
    ["deploy", "deploy"],
    ["google-calendar-check", "ingest"],
    ["google-connect", "connect"]
  ]);
  const commands = {};
  for (const action of sequence) {
    const command = commandByLabel.get(action.label);
    if (!command) continue;
    commands[command] ||= [];
    commands[command].push({ ...action, expect_output: true });
  }
  return {
    version: "0.4.9",
    right_key_sha256: createHash("sha256").update(key).digest("hex"),
    processes_path: processesPath,
    expected_output_commands: Object.keys(commands),
    commands
  };
}

export function scenarioForSessionHelpers(sequence) {
  const commands = {};
  for (const action of sequence) {
    if (!action.label?.startsWith("google-") || ["google-calendar-check", "google-connect"].includes(action.label)) continue;
    commands[action.label] ||= [];
    commands[action.label].push({ ...action, expect_output: true });
  }
  return { expected_output_commands: Object.keys(commands), commands };
}
