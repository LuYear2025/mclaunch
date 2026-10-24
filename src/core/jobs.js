import crypto from "node:crypto";

const jobs = new Map();

export function createJob(type, runner) {
  const id = crypto.randomUUID();
  const job = {
    id,
    type,
    status: "running",
    progress: { phase: "starting" },
    createdAt: Date.now(),
    result: null,
    error: null,
  };
  jobs.set(id, job);

  const report = (progress) => {
    job.progress = { ...progress, updatedAt: Date.now() };
  };

  runner(report)
    .then((result) => {
      job.status = "done";
      job.result = result;
      job.progress = { phase: "done" };
    })
    .catch((error) => {
      job.status = "failed";
      job.error = error.message || String(error);
    })
    .finally(() => {
      job.finishedAt = Date.now();
      setTimeout(() => jobs.delete(id), 30 * 60_000).unref?.();
    });

  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}
