import crypto from "node:crypto";

const MAX_LOG_LINES = 4000;
const runs = new Map();

export function createRun(instanceId) {
  const id = crypto.randomUUID();
  const run = {
    id,
    instanceId,
    status: "starting",
    pid: null,
    startedAt: Date.now(),
    exitCode: null,
    logs: [],
  };
  runs.set(id, run);
  return run;
}

export function appendLog(runId, text, stream = "stdout") {
  const run = runs.get(runId);
  if (!run) return;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    run.logs.push({ t: Date.now(), stream, line });
  }
  if (run.logs.length > MAX_LOG_LINES) run.logs.splice(0, run.logs.length - MAX_LOG_LINES);
}

export function getRun(runId) {
  return runs.get(runId) || null;
}

export function listRuns(instanceId) {
  return [...runs.values()]
    .filter((r) => !instanceId || r.instanceId === instanceId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((r) => ({ ...r, logs: undefined, logCount: r.logs.length }));
}

export function logsAfter(runId, after = 0) {
  const run = runs.get(runId);
  if (!run) return null;
  return {
    status: run.status,
    exitCode: run.exitCode,
    lines: run.logs.slice(after),
    next: run.logs.length,
  };
}

export function finishRun(runId, code, signal) {
  const run = runs.get(runId);
  if (!run) return;
  run.status = code === 0 ? "exited" : "crashed";
  run.exitCode = code;
  run.signal = signal || null;
  run.endedAt = Date.now();
}

export function forgetRun(runId) {
  runs.delete(runId);
}
