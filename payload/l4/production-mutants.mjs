import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const productionMutants = Object.freeze({
  O1: { file: "finish-window.txt", find: "if ($result.YnPrompt) {", replace: "if ($false) {" },
  O2: { file: "fb-run.mjs", find: "const diskLine = redactLine(clean, exactKey);", replace: "const diskLine = clean;" },
  O3: { file: "finish-window.txt", find: "if ($result.Pending) {", replace: "if ($false) {" },
  O4: { file: "finish-window.txt", find: "if ([int]$attempts -ge 2)", replace: "if ([int]$attempts -ge 4)" },
  O5: { file: "finish-window.txt", find: "if (-not $FB.Tier2On -and -not $FB.W8On)", replace: "if ($false)" },
  O6: { file: "finish-window.txt", find: "$second = Invoke-FbHealthRead", replace: "$second = $reading" },
  O7: { file: "finish-window.txt", find: "if ($calendarResult.Class -ne \"reconnect\")", replace: "if ($false)" },
  O8: { file: "fb-run.mjs", find: "if (plan.step === \"kit-install\") {", replace: "if (false) {" },
  O9: { file: "finish-window.txt", find: "-DecisionId $decisionId", replace: "" },
  O10: { file: "fb-win.mjs", find: "const DECISION_WORDS = new Set([", replace: "const MUTANT_KEY_READ = true;\nconst DECISION_WORDS = new Set([" },
  O11: { file: "finish-window.txt", find: "if (-not $FB.Tier2On -and $FB.W8On)", replace: "if ($false)" },
  O12: { file: "finish-window.txt", find: "@($FB.Facts.key_lengths) -contains $match.Value.Length", replace: "$match.Value -match '[A-Z]' -and $match.Value -match '[a-z]' -and $match.Value -match '[0-9]'" },
});

export function applyProductionMutant(text, id) {
  const mutant = productionMutants[id];
  if (!mutant) throw new Error(`unknown production mutant ${id}`);
  const output = String(text).replace(mutant.find, mutant.replace);
  if (output === text) throw new Error(`production mutant ${id} decision point missing`);
  return output;
}

export function materializeProductionMutant(runnerDir, outputDir, id, runnerNames) {
  const mutant = productionMutants[id];
  if (!mutant) throw new Error(`unknown production mutant ${id}`);
  mkdirSync(outputDir, { recursive: true });
  for (const name of runnerNames) copyFileSync(join(runnerDir, name), join(outputDir, name));
  const target = join(outputDir, mutant.file);
  writeFileSync(target, applyProductionMutant(readFileSync(target, "utf8"), id), "utf8");
  return { id, file: mutant.file, outputDir };
}
