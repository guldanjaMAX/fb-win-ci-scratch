export function validateRealSessionEvidence(result) {
  const errors = [];
  if (result?.target !== "windows") errors.push("not-windows");
  if (result?.decision_point?.source !== "session") errors.push("decision-not-session");
  if (result?.meta?.sessionEvidence !== true) errors.push("session-marker-missing");
  if (result?.meta?.bridge?.launched !== true || result?.meta?.bridge?.pass !== true) errors.push("window-not-launched");
  if (result?.meta?.sessionRunnerExit !== 0) errors.push("session-runner-failed");
  if (!Number.isInteger(result?.meta?.actualStatusCount) || result.meta.actualStatusCount < 1) errors.push("status-not-session-derived");
  if (!Array.isArray(result?.status_lines)) errors.push("status-lines-missing");
  if (result?.decision_point?.reached !== true) errors.push("decision-point-missed");
  if (result?.meta?.harnessVoid === true) errors.push("harness-void");
  return { pass: errors.length === 0, errors };
}

export function silentExpectedStubCalls(calls) {
  return (calls || []).filter((call) => call.output_expected === true && (!Number.isInteger(call.output_bytes) || call.output_bytes < 1));
}
