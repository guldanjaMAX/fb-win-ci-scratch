import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = import.meta.dirname;
const source = readFileSync(join(root, "windows-session.mjs"), "utf8");
const arms = readFileSync(join(root, "reference", "arms.mjs"), "utf8");

test("real-window fixtures encode every triaged decision point non-vacuously", () => {
  assert.match(arms, /id: "A11b"[\s\S]*statuses: \[[^\]]*"W1 START readout"/u);
  // W5 runs before the update and again after it (A0 parity), so a review arm that reaches W11 makes two edits.
  assert.match(arms, /id: "A12-review"[\s\S]*"manifest-edit": 2/u);
  assert.match(arms, /id: "A13"[\s\S]*"cli-version": 3/u);
  assert.match(source, /PUBLISHED_KIT = \{ bytes: 6668013, sha256: "0555ad1972d7f8d6/u, "A16 downloads real published bytes so the full hash compare is reached");
  assert.match(source, /PUBLISHED_KIT\.sha256\.slice\(0, 16\) \+ "f"\.repeat\(48\)/u);
  assert.match(source, /id === "PR008"[^\n]*drive\(\), ready\(\), ready\(\), version\(\)/u, "PR008 health has stub output, so the bad machine file is the only fault");
  assert.match(source, /updatePendingMigration[\s\S]*applying 0049_fixture/u);
  assert.match(source, /updatePrompt[\s\S]*readStdin: true/u);
  assert.match(source, /id === "A7"[\s\S]*Your internet connection dropped[\s\S]*leakParts/u);
  assert.match(source, /id === "A1"[\s\S]*health: pending\(\)[\s\S]*"W4 queue": "finish-later"|id === "A1"[\s\S]*"W4 queue": "finish-later"[\s\S]*health: pending\(\)/u);
  assert.match(source, /id === "A12-review"[\s\S]*successTail/u);
  assert.match(source, /id === "A16"[\s\S]*kitShaMismatch: true/u);
  assert.match(source, /id === "A17"[\s\S]*emptyClipboard: true/u);
  assert.match(source, /id === "PR002"[\s\S]*delay_ms: [3-9]\d{3}/u);
  assert.match(source, /step=update[\s\S]*out\.log/u, "dead rejoin has reached-step evidence without a stub-output VOID");
  assert.match(source, /stdinTty:[\s\S]*stdinEof:[\s\S]*stdinBytes:/u);
  assert.match(source, /loadBeforeInstall[\s\S]*stepMetaCalls\(session\)[\s\S]*"kit-fetch"/u);
});

test("interactive host arms remain explicitly bounded", () => {
  assert.match(source, /\["A6", "A6-hidden", "A15-dead", "A15-preview", "A15-scope", "A15-partial", "A15-full"\]/u);
  assert.match(source, /interactive consent screen/u);
  assert.match(source, /interactive update prompt/u);
});
