import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key || !key.startsWith("--") || value === undefined) throw new Error("bad arguments");
    result[key.slice(2)] = value;
  }
  if (!result.manifest || !["yes", "no"].includes(result["load-running"])) throw new Error("bad arguments");
  return result;
}

function countMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
}

function fact(name, value) {
  process.stdout.write(`fb:${name}=${value}\n`);
}

function domainPresent(manifestPath) {
  try {
    const domain = JSON.parse(readFileSync(manifestPath, "utf8"))?.brain?.domain;
    return typeof domain === "string" && domain.trim() !== "";
  } catch {
    return false;
  }
}

function emit(domain, stateKind, bytes, data, manifestMtime, loadRunning, unreadable = false) {
  const sweepTime = Date.parse(data?.drive_last_full_sweep_at ?? "");
  const sweep = Number.isFinite(sweepTime);
  const sweepAfterManifest = sweep && sweepTime > manifestMtime;
  const review = data?.drive_removal_review?.issue_code === "SAFETY_REVIEW_REQUIRED";
  const rawAbsences = data?.drive_removal_review?.counts?.unresolved_absences;
  const reviewAbsences = Number.isFinite(rawAbsences) && rawAbsences >= 0 ? Math.floor(rawAbsences) : 0;
  const terminal = !unreadable && stateKind === "present" && !loadRunning && sweepAfterManifest;
  let reason = "terminal";
  if (unreadable) reason = "unreadable";
  else if (stateKind === "absent") reason = "absent";
  else if (loadRunning) reason = "load-running";
  else if (!sweep) reason = "no-sweep";
  else if (!sweepAfterManifest) reason = "manifest-newer";

  fact("domain", domain ? "yes" : "no");
  fact("drive_state", stateKind);
  fact("mb", Math.round(bytes / (1024 * 1024)));
  fact("done", countMap(data?.done));
  fact("skipped", countMap(data?.skipped));
  fact("removed", countMap(data?.removed));
  fact("sweep", sweep ? "yes" : "no");
  fact("sweep_after_manifest", sweepAfterManifest ? "yes" : "no");
  fact("review", review ? "yes" : "no");
  fact("review_absences", reviewAbsences);
  fact("terminal", terminal ? "yes" : "no");
  fact("reason", reason);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch {
  process.exitCode = 2;
}

if (args) {
  const domain = domainPresent(args.manifest);
  let manifestMtime = Number.POSITIVE_INFINITY;
  try {
    manifestMtime = statSync(args.manifest).mtimeMs;
  } catch {}
  const statePath = join(dirname(args.manifest), ".brain-ingest-drive.json");
  if (!existsSync(statePath)) {
    emit(domain, "absent", 0, {}, manifestMtime, args["load-running"] === "yes");
  } else {
    let bytes = 0;
    try {
      bytes = statSync(statePath).size;
      const data = JSON.parse(readFileSync(statePath, "utf8"));
      emit(domain, "present", bytes, data, manifestMtime, args["load-running"] === "yes");
    } catch {
      emit(domain, "unreadable", bytes, {}, manifestMtime, args["load-running"] === "yes", true);
      process.exitCode = 2;
    }
  }
}

