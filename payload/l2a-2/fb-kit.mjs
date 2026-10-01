#!/usr/bin/env node

import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

class DownloadFailure extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

function printFacts(result) {
  for (const name of ["fetched", "reused", "bytes_ok", "sha_ok", "reason"]) {
    process.stdout.write(`fb:${name}=${result[name]}\n`);
  }
}

function parseArgs(argv) {
  if (argv[0] !== "fetch") throw new Error("bad arguments");
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--url", "--sha256", "--bytes", "--out", "--allow-loopback-base"].includes(flag) ||
        !value || Object.hasOwn(values, flag)) {
      throw new Error("bad arguments");
    }
    values[flag] = value;
  }
  if (!values["--url"] || !values["--sha256"] || !values["--bytes"] || !values["--out"]) {
    throw new Error("bad arguments");
  }
  const sha256 = values["--sha256"];
  const bytes = Number(values["--bytes"]);
  if (!/^[a-f0-9]{64}$/u.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error("bad arguments");
  }
  return {
    url: values["--url"],
    sha256,
    bytes,
    out: resolve(values["--out"]),
    loopbackBase: values["--allow-loopback-base"] || null,
  };
}

function validateUrl(options) {
  const match = options.url.match(
    /^https:\/\/financialbrain\.ai\/kit\/brain-installer-([0-9]+\.[0-9]+\.[0-9]+)-([a-f0-9]{16})\.tgz$/u,
  );
  if (!match || match[2] !== options.sha256.slice(0, 16)) return false;
  if (options.loopbackBase !== null) {
    const allowed = /^http:\/\/127\.0\.0\.1:\d+\/$/u.test(options.loopbackBase);
    const seamOn = process.env.FB_KIT_TEST === ["1"].join("");
    if (!allowed || !seamOn) return false;
  }
  return true;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function removePart(path) {
  try { if (existsSync(path)) unlinkSync(path); } catch {}
}

async function fetchAttempt(url, part, maximumBytes, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    throw new DownloadFailure(String(error?.message || "download failed"), true);
  }
  if (!response?.ok || !response.body) {
    throw new DownloadFailure("download response failed", false);
  }
  const descriptor = openSync(part, "w", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        try { await response.body.cancel(); } catch {}
        throw new DownloadFailure("download exceeded expected bytes", false);
      }
      hash.update(chunk);
      writeSync(descriptor, chunk);
    }
  } finally {
    closeSync(descriptor);
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function fetchKit(options, seams = {}) {
  const result = { fetched: "no", reused: "no", bytes_ok: "no", sha_ok: "no", reason: "download" };
  if (!validateUrl(options)) {
    result.reason = "url";
    return { code: 2, result };
  }
  mkdirSync(options.out, { recursive: true });
  const name = basename(new URL(options.url).pathname);
  const finalPath = join(options.out, "tgz");
  const partPath = `${finalPath}.part`;
  if (existsSync(finalPath) && statSync(finalPath).isFile()) {
    const existing = await hashFile(finalPath);
    if (existing.bytes === options.bytes && existing.sha256 === options.sha256) {
      return {
        code: 0,
        result: { fetched: "no", reused: "yes", bytes_ok: "yes", sha_ok: "yes", reason: "ok" },
      };
    }
  }

  removePart(partPath);
  const requestUrl = options.loopbackBase
    ? new URL(name, options.loopbackBase).href
    : options.url;
  const fetchImpl = seams.fetchImpl ?? fetch;
  let receipt = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      receipt = await fetchAttempt(requestUrl, partPath, options.bytes, fetchImpl);
      break;
    } catch (error) {
      removePart(partPath);
      if (!(error instanceof DownloadFailure) || !error.retryable || attempt === 2) {
        result.reason = error?.message === "download exceeded expected bytes" ? "bytes" : "download";
        return { code: 2, result };
      }
    }
  }
  result.bytes_ok = receipt.bytes === options.bytes ? "yes" : "no";
  result.sha_ok = receipt.sha256 === options.sha256 ? "yes" : "no";
  if (result.bytes_ok !== "yes") {
    removePart(partPath);
    result.reason = "bytes";
    return { code: 2, result };
  }
  if (result.sha_ok !== "yes") {
    removePart(partPath);
    result.reason = "sha";
    return { code: 2, result };
  }
  renameSync(partPath, finalPath);
  result.fetched = "yes";
  result.reason = "ok";
  return { code: 0, result };
}

export async function runCli(argv) {
  let receipt;
  try {
    receipt = await fetchKit(parseArgs(argv));
  } catch {
    receipt = {
      code: 2,
      result: { fetched: "no", reused: "no", bytes_ok: "no", sha_ok: "no", reason: "url" },
    };
  }
  printFacts(receipt.result);
  return receipt.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
