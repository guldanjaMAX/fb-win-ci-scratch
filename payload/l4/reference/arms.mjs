const stageLines = Array.from({ length: 13 }, (_, index) => `W7 INFO stage n=${index + 1}`);

const commonDone = ["W7 PASS verified", "W11 INFO key-removed", "W11 DONE done"];

export const armSpecs = [
  { id: "A0", negative: false, point: "update call completed", statuses: ["RUN START start", "W3 WAITING owner copy-key", "W3 INFO key-saved", "W4 INFO queue-zero", ...stageLines, ...commonDone], calls: { update: 1, verify: 1, health: 2, "npm-cli.js": 1 } },
  { id: "A0b", negative: false, point: "clipboard-history-off branch", statuses: ["RUN START start", "W1 INFO history-off", "W3 WAITING owner copy-key", "W3 INFO key-saved", "W4 INFO queue-zero", ...stageLines, ...commonDone], calls: { update: 1 } },
  { id: "A1", negative: true, point: "single backlog reading", statuses: ["W4 INFO pending n=121", "W4 INFO projection n=3", "W4 WAITING lead queue id=<id> words=wait,finish-later", "W4 SKIP finish-later"], calls: { health: 1, update: 0 } },
  { id: "A1-wait", negative: true, point: "lead wait decision consumed", statuses: ["W4 INFO pending n=121", "W4 INFO projection n=3", "W4 WAITING lead queue id=<id> words=wait,finish-later", "W4 INFO wait-elapsed", "W4 SKIP finish-later"], calls: { health: 2, update: 0 } },
  { id: "A1b", negative: true, point: "update queue refusal classified", statuses: ["W7 SKIP queue-not-empty"], calls: { update: 1 } },
  { id: "A2", negative: true, point: "first cpu-reset failure classified", statuses: ["W7 INFO retry-cpu-reset", "W7 PASS verified", "W11 DONE done"], calls: { update: 2 } },
  { id: "A2-two", negative: true, point: "second cpu-reset failure classified", statuses: ["W7 INFO retry-cpu-reset", "W7 STOP update second-failure"], calls: { update: 2 } },
  { id: "A3", negative: true, point: "first last-stage failure classified", statuses: ["W7 INFO retry-last-stage-503", "W7 PASS verified", "W11 DONE done"], calls: { update: 2 } },
  { id: "A3-two", negative: true, point: "second last-stage failure classified", statuses: ["W7 INFO retry-last-stage-503", "W7 STOP update second-failure"], calls: { update: 2 } },
  { id: "A4", negative: true, point: "queued paused state classified", statuses: ["W7 STOP update queued", "W7 WAITING lead update-queued id=<id> words=deploy-recover,finish-later"], calls: { update: 1, deploy: 0 } },
  { id: "A4-deploy", negative: true, point: "deploy-recover decision consumed", statuses: ["W7 STOP update queued", "W7 WAITING lead update-queued id=<id> words=deploy-recover,finish-later", "W11 DONE done"], calls: { update: 1, deploy: 1 } },
  { id: "A4-later", negative: true, point: "finish-later decision consumed", statuses: ["W7 STOP update queued", "W7 WAITING lead update-queued id=<id> words=deploy-recover,finish-later", "W11 DONE done"], calls: { update: 1, deploy: 0 } },
  { id: "A5", negative: true, point: "stale alive file classified dead", statuses: ["W7 WAITING lead update-retry id=<id> words=continue,stop"], calls: { update: 1 }, meta: { processReadsBeforeRerun: 1, exitAfterLogClose: true } },
  { id: "A5-exit", negative: true, point: "unclassified exit observed", statuses: ["W7 WAITING lead update-retry id=<id> words=continue,stop"], calls: { update: 1 }, meta: { exitAfterLogClose: true } },
  { id: "A6", negative: true, point: "events anomaly yn-prompt", statuses: ["W7 WAITING lead update-retry id=<id> words=continue,stop"], calls: { update: 1 }, meta: { stdinTty: false, stdinEof: true, stdinBytes: 0 } },
  { id: "A6-hidden", negative: true, point: "hidden-token prompt anomaly", statuses: ["W7 WAITING lead update-retry id=<id> words=continue,stop"], calls: { update: 1 }, meta: { stdinTty: false, stdinEof: true, stdinBytes: 0 } },
  { id: "A7", negative: true, point: "raw output scan found every planted class", statuses: ["W7 WAITING lead update-retry id=<id> words=continue,stop"], calls: { update: 1 }, meta: { rawHits: { key: 1, hex64: 1, bookmark: 1, account: 1, email: 1 }, pageShaExemptions: 2 } },
  { id: "A8", negative: true, point: "fresh start found live update", statuses: ["W1 INFO update-running", "W7 INFO rejoin", "W7 PASS verified", "W11 DONE done"], calls: { update: 1 }, meta: { cleanLog: true } },
  { id: "A9", negative: true, point: "third read-only health attempt", statuses: ["W1 INFO health-ready"], calls: { health: 3 } },
  { id: "A9-three", negative: true, point: "third read-only refusal", statuses: ["W1 INFO health-unreadable"], calls: { health: 3, update: 0 } },
  { id: "A9-write", negative: true, point: "write refusal classified", statuses: ["W7 WAITING lead update-retry id=<id> words=continue,stop"], calls: { update: 1 } },
  { id: "A10", negative: true, point: "second verify failure", statuses: ["W3 INFO key-bad", "W3 STOP key two-bad"], calls: { verify: 2 }, meta: { keyFile: false } },
  { id: "A10-control", negative: true, point: "second verify accepted", statuses: ["W3 INFO key-bad", "W3 INFO key-saved"], calls: { verify: 2 }, meta: { keyFile: true, decryptedMatches: true } },
  { id: "A10-nodigit", negative: true, point: "no-digit forty-character candidate verified", statuses: ["W3 INFO key-saved"], calls: { verify: 1 }, meta: { keyFile: true } },
  { id: "A10-short", negative: true, point: "length rule evaluated", statuses: ["W3 WAITING owner copy-key"], calls: { verify: 0 }, meta: { gateCount: 1 } },
  { id: "A11", negative: true, point: "helper tier gate counter", statuses: [], calls: {}, meta: { helperOutput: ["Nothing more to run here today."], helperRecord: "start=tier2-off", gateCount: 1, windowOpened: false } },
  { id: "A11-empty", negative: true, point: "empty marker gate counter", statuses: [], calls: {}, meta: { helperOutput: ["Nothing more to run here today."], helperRecord: "start=tier2-off", gateCount: 1, windowOpened: false } },
  { id: "A11-probe", negative: true, point: "probe marker gate counter", statuses: [], calls: {}, meta: { helperOutput: ["Nothing more to run here today."], helperRecord: "start=tier2-off", gateCount: 1, windowOpened: false } },
  { id: "A11-on", negative: false, point: "tier marker opened window", statuses: ["RUN START start"], calls: {}, meta: { windowOpened: true } },
  { id: "A11-window", negative: true, point: "window preflight read tier state", statuses: ["W1 STOP preflight tier2-off", "W11 DONE done"], calls: {} },
  { id: "A11b", negative: true, point: "w8-only branch entered", statuses: ["RUN INFO tier2-off", "RUN INFO w8-only", "W1 INFO readout", "W8 INFO check-start", "W8 PASS calendar-ok", "W11 DONE done"], calls: { "google-calendar-check": 1 }, meta: { keyReadThrows: true } },
  { id: "A11b-off", negative: true, point: "w8-only helper gate evaluated", statuses: [], calls: {}, meta: { windowOpened: false, gateCount: 1 } },
  { id: "A12", negative: false, point: "drive state reader completed", statuses: ["W1 INFO drive-terminal n=3"], calls: { "drive-state": 1 }, meta: { driveReadMs: 420, convertReadMs: 610, boundMs: 5000, countsOnly: true } },
  { id: "A12-review", negative: true, point: "pending removal review read", statuses: ["W1 INFO drive-review", "W5 SKIP drive-not-terminal"], calls: { "drive-state": 1, "manifest-edit": 0 }, meta: { reviewApproved: false } },
  { id: "A13", negative: true, point: "pending migration phrase classified", statuses: ["W7 INFO pending-migration-seen", "W7 STOP kit pending-migration", "W11 DONE done"], calls: { update: 1, health: 1, "cli-version": 1 }, meta: { updateFinished: true } },
  { id: "A14", negative: true, point: "every registration site classified", statuses: [], calls: {}, meta: { registrationSites: ["window one-time task"], dailyCount: 0, keyRead: false, plantedDailyCaught: true } },
  { id: "A15-lock", negative: true, point: "google lease step called", statuses: ["W8 SKIP google-busy"], calls: { "google-lease": 1, "google-calendar-check": 0, "google-connect": 0 } },
  { id: "A15-dead", negative: true, point: "dead refresh transcript classified", statuses: ["W8 INFO reconnect-needed", "W8 WAITING owner google-consent"], calls: { "google-calendar-check": 1, "google-connect": 1 }, meta: { hostSentenceBeforeConsent: true, connectScopes: "drive,gmail,calendar" } },
  { id: "A15-preview", negative: true, point: "preview reconnect branch classified", statuses: ["W8 INFO reconnect-needed", "W8 WAITING owner google-consent"], calls: { "google-calendar-check": 1, "google-connect": 1 } },
  { id: "A15-scope", negative: true, point: "narrow stored-scope branch classified", statuses: ["W8 INFO reconnect-needed", "W8 WAITING owner google-consent"], calls: { "google-calendar-check": 1, "google-connect": 1 } },
  { id: "A15-none", negative: true, point: "no-record phrase classified", statuses: ["W8 SKIP google-none"], calls: { "google-scopes": 1, "google-connect": 0 } },
  { id: "A15-403", negative: true, point: "calendar 403 classified without reconnect", statuses: ["W8 STOP google check-failed"], calls: { "google-calendar-check": 1, "google-connect": 0 } },
  { id: "A15-partial", negative: true, point: "granted scope set compared", statuses: ["W8 INFO scope-missing-calendar", "W8 WAITING lead google-partial id=<id> words=restore,keep,retry"], calls: { "google-scopes": 2, "google-connect": 1 } },
  { id: "A15-full", negative: false, point: "full granted scope set compared", statuses: ["W8 PASS scopes-all"], calls: { "google-scopes": 2, "google-connect": 1 } },
  { id: "A16", negative: true, point: "kit byte hash compared", statuses: ["W6 STOP kit sha"], calls: { "npm-cli.js": 0 } },
  { id: "A17", negative: true, point: "key-visible decision consumed", statuses: ["W3 STOP key key-visible"], calls: { verify: 0 }, meta: { keyFile: false, cloudCallsAfter: 0 } }
];

export const armMap = new Map(armSpecs.map((arm) => [arm.id, arm]));

export const mutantExpectations = {
  O1: ["A6", "A6-hidden"],
  O2: ["A7"],
  O3: ["A0", "A13"],
  O4: ["A2"],
  O5: ["A11", "A11-empty", "A11-probe"],
  O11: ["A11b"],
  O12: ["A10-nodigit"],
  O6: ["A1", "A1-wait"],
  O7: ["A15-403"],
  O8: ["A9-write"],
  O9: ["A4", "A4-later"],
  O10: ["A14"]
};
