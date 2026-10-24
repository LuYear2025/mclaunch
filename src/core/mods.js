import fs from "node:fs";
import path from "node:path";
import { downloadFile, sha1File } from "./download.js";
import { modrinthResourceVersions, modrinthPrimaryFile } from "./resources.js";

const INDEX_FILE = "mods.json";
const MODRINTH = "https://api.modrinth.com/v2";
const USER_AGENT = "mclaunch/0.1.0 (github.com/LuYear2025)";

function headers() {
  return { "User-Agent": USER_AGENT, Accept: "application/json", "Content-Type": "application/json" };
}

export function readModIndex(instanceDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(instanceDir, INDEX_FILE), "utf8"));
  } catch {
    return {};
  }
}

export function writeModIndex(instanceDir, index) {
  fs.writeFileSync(path.join(instanceDir, INDEX_FILE), JSON.stringify(index, null, 2), "utf8");
}

export function recordMod(instanceDir, fileName, info) {
  const index = readModIndex(instanceDir);
  index[fileName] = { ...info, recordedAt: Date.now() };
  writeModIndex(instanceDir, index);
}

export function forgetMod(instanceDir, fileName) {
  const index = readModIndex(instanceDir);
  delete index[fileName];
  writeModIndex(instanceDir, index);
}

/** 用 Modrinth 的文件 hash 接口，把磁盘上已有的 mod 认出来（补录来源）。 */
export async function identifyByHash(instanceDir, { gameVersion, loader, onProgress = () => {} } = {}) {
  const modsDir = path.join(instanceDir, "mods");
  if (!fs.existsSync(modsDir)) return { identified: 0, total: 0 };

  const files = fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith(".jar"));
  const index = readModIndex(instanceDir);
  const pending = files.filter((f) => !index[f]?.projectId);
  if (!pending.length) return { identified: 0, total: files.length };

  onProgress({ phase: "identify", done: 0, total: pending.length });
  const hashToFile = new Map();
  for (const file of pending) {
    try {
      hashToFile.set(await sha1File(path.join(modsDir, file)), file);
    } catch {
      // 读不了就跳过
    }
  }
  if (!hashToFile.size) return { identified: 0, total: files.length };

  const res = await fetch(`${MODRINTH}/version_files`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ hashes: [...hashToFile.keys()], algorithm: "sha1" }),
  });
  if (!res.ok) throw new Error(`Modrinth 识别失败：HTTP ${res.status}`);
  const data = await res.json();

  let identified = 0;
  for (const [hash, version] of Object.entries(data)) {
    const file = hashToFile.get(hash);
    if (!file) continue;
    const fileInfo = (version.files || []).find((f) => f.hashes?.sha1 === hash) || version.files?.[0];
    index[file] = {
      source: "modrinth",
      projectId: version.project_id,
      slug: version.project_id,
      versionId: version.id,
      versionNumber: version.version_number,
      fileName: file,
      fileSize: fileInfo?.size,
      gameVersions: version.game_versions,
      loaders: version.loaders,
      recordedAt: Date.now(),
    };
    identified += 1;
  }
  writeModIndex(instanceDir, index);
  return { identified, total: files.length };
}

/** 检查每个已记录 mod 是否有更新。 */
export async function checkUpdates(instanceDir, { gameVersion, loader, onProgress = () => {} } = {}) {
  const index = readModIndex(instanceDir);
  const entries = Object.entries(index).filter(([, info]) => info.source === "modrinth" && info.projectId);
  const updates = [];
  let done = 0;

  for (const [fileName, info] of entries) {
    const exists = fs.existsSync(path.join(instanceDir, "mods", fileName));
    if (!exists) {
      done += 1;
      onProgress({ phase: "check", done, total: entries.length });
      continue;
    }
    try {
      const versions = await modrinthResourceVersions(info.projectId, { gameVersion, loader });
      const latest = versions[0];
      if (latest && latest.id !== info.versionId) {
        const file = modrinthPrimaryFile(latest);
        updates.push({
          fileName,
          projectId: info.projectId,
          currentVersion: info.versionNumber || info.versionId,
          latestVersion: latest.name || latest.versionNumber || latest.id,
          versionId: latest.id,
          url: file.url,
          newFileName: file.filename,
        });
      }
    } catch {
      // 单个查询失败不影响其它
    }
    done += 1;
    onProgress({ phase: "check", done, total: entries.length });
  }
  return updates;
}

/** 下载一个更新，删掉旧文件，并更新清单。 */
export async function applyUpdate(instanceDir, update, { onProgress = () => {} } = {}) {
  const modsDir = path.join(instanceDir, "mods");
  const dest = path.join(modsDir, update.newFileName);
  onProgress({ phase: "download", message: update.newFileName });
  await downloadFile(update.url, dest, { onProgress: (p) => onProgress({ phase: "download", ...p }) });

  const index = readModIndex(instanceDir);
  const old = index[update.fileName];
  if (update.newFileName !== update.fileName) {
    fs.rmSync(path.join(modsDir, update.fileName), { force: true });
    delete index[update.fileName];
  }
  index[update.newFileName] = {
    ...(old || {}),
    source: "modrinth",
    projectId: update.projectId,
    versionId: update.versionId,
    versionNumber: update.latestVersion,
    fileName: update.newFileName,
    recordedAt: Date.now(),
  };
  writeModIndex(instanceDir, index);
  onProgress({ phase: "done" });
  return { file: update.newFileName };
}
