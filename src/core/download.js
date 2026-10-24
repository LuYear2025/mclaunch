import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function fileMatches(file, sha1, size) {
  try {
    const stat = fs.statSync(file);
    if (typeof size === "number" && stat.size !== size) return false;
    if (!sha1) return true;
    return (await sha1File(file)) === sha1.toLowerCase();
  } catch {
    return false;
  }
}

async function fetchWithRetry(url, options = {}, retries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return res;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Downloads one file, verifies its SHA1 and reports progress.
 * Writes to a temporary ".part" file so a broken download is never treated as complete.
 */
export async function downloadFile(url, dest, { sha1, size, onProgress, signal } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (await fileMatches(dest, sha1, size)) {
    onProgress?.({ done: size || 0, total: size || 0, skipped: true });
    return;
  }

  const part = `${dest}.part`;
  const res = await fetchWithRetry(url, { signal });
  const total = Number(res.headers.get("content-length")) || size || 0;
  const out = fs.createWriteStream(part);
  let done = 0;
  let lastReport = 0;

  try {
    for await (const chunk of res.body) {
      out.write(chunk);
      done += chunk.length;
      const now = Date.now();
      if (now - lastReport > 200) {
        lastReport = now;
        onProgress?.({ done, total });
      }
    }
    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });
  } catch (error) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw error;
  }

  if (sha1 && (await sha1File(part)) !== sha1.toLowerCase()) {
    fs.rmSync(part, { force: true });
    throw new Error(`SHA1 mismatch: ${path.basename(dest)}`);
  }
  fs.renameSync(part, dest);
  onProgress?.({ done: total || done, total: total || done, skipped: false });
}

/** Runs async tasks with a concurrency limit. */
export async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}
