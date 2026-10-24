import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { paths } from "../paths.js";
import { downloadFile, fileMatches, pool } from "./download.js";

const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

export const mirrors = {
  official: {
    label: "Mojang 官方源",
    manifest: MANIFEST_URL,
    rules: [
      ["https://piston-meta.mojang.com", "https://piston-meta.mojang.com"],
      ["https://launchermeta.mojang.com", "https://launchermeta.mojang.com"],
      ["https://piston-data.mojang.com", "https://piston-data.mojang.com"],
      ["https://libraries.minecraft.net", "https://libraries.minecraft.net"],
      ["https://resources.download.minecraft.net", "https://resources.download.minecraft.net"],
    ],
  },
  bmclapi: {
    label: "BMCLAPI 镜像（国内）",
    manifest: "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
    rules: [
      ["https://piston-meta.mojang.com", "https://bmclapi2.bangbang93.com"],
      ["https://launchermeta.mojang.com", "https://bmclapi2.bangbang93.com"],
      ["https://piston-data.mojang.com", "https://bmclapi2.bangbang93.com"],
      ["https://libraries.minecraft.net", "https://bmclapi2.bangbang93.com/maven"],
      ["https://resources.download.minecraft.net", "https://bmclapi2.bangbang93.com/assets"],
    ],
  },
};

export function mirrorUrl(url, mirror = "official") {
  const m = mirrors[mirror] || mirrors.official;
  for (const [from, to] of m.rules) {
    if (url.startsWith(from)) return to + url.slice(from.length);
  }
  return url;
}

let manifestCache = null;

export async function getManifest(mirror = "official") {
  if (manifestCache && Date.now() - manifestCache.at < 5 * 60_000) return manifestCache.data;
  const res = await fetch(mirrors[mirror]?.manifest || MANIFEST_URL);
  if (!res.ok) throw new Error(`获取版本列表失败：HTTP ${res.status}`);
  const data = await res.json();
  manifestCache = { at: Date.now(), data };
  return data;
}

const osName = { win32: "windows", darwin: "osx", linux: "linux" }[process.platform] || process.platform;
const osArch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "arm64" : process.arch;

function ruleAllowed(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let result = false;
  for (const rule of rules) {
    if (rule.os?.name && rule.os.name !== osName) continue;
    if (rule.os?.arch && rule.os.arch !== osArch && !(rule.os.arch === "x86" && process.arch === "ia32")) continue;
    if (rule.features && Object.values(rule.features).some(Boolean)) {
      if (!(rule.features.is_demo === undefined)) continue;
    }
    result = rule.action === "allow";
  }
  return result;
}

function nativeClassifier(lib) {
  const key = osName === "osx" ? "natives-osx" : `natives-${osName}`;
  return lib.natives?.[osName]?.replace("${arch}", process.arch === "x64" ? "64" : "32")
    ?? lib.natives?.[key];
}

function libraryPath(lib) {
  const artifact = lib.downloads?.artifact;
  if (artifact?.path) return artifact.path;
  const [group, name, version] = (lib.name || "").split(":");
  if (!group) return null;
  return `${group.replace(/\./g, "/")}/${name}/${version}/${name}-${version}.jar`;
}

export async function installVersion(versionId, { mirror = "official", onProgress = () => {} } = {}) {
  const manifest = await getManifest(mirror);
  const entry = manifest.versions.find((v) => v.id === versionId);
  if (!entry) throw new Error(`未知版本：${versionId}`);

  const versionDir = path.join(paths.versions, versionId);
  fs.mkdirSync(versionDir, { recursive: true });

  onProgress({ phase: "meta", message: "读取版本信息" });
  // BMCLAPI exposes version JSON under /version/<id>/<id>.json instead of the
  // hashed piston-meta path, so it cannot go through mirrorUrl().
  const metaUrl =
    mirror === "bmclapi"
      ? `https://bmclapi2.bangbang93.com/version/${encodeURIComponent(versionId)}/${encodeURIComponent(versionId)}.json`
      : entry.url;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) throw new Error(`读取版本 JSON 失败：HTTP ${metaRes.status}`);
  const version = await metaRes.json();
  fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(version, null, 2));

  const client = version.downloads?.client;
  if (client) {
    onProgress({ phase: "client", done: 0, total: client.size });
    await downloadFile(mirrorUrl(client.url, mirror), path.join(versionDir, `${versionId}.jar`), {
      sha1: client.sha1,
      size: client.size,
      onProgress: (p) => onProgress({ phase: "client", ...p }),
    });
  }

  const libs = (version.libraries || []).filter((lib) => ruleAllowed(lib.rules));
  const libJobs = [];
  const natives = [];

  for (const lib of libs) {
    const classifier = nativeClassifier(lib);
    if (lib.natives && classifier && lib.downloads?.classifiers?.[classifier]) {
      natives.push({ lib, classifier, artifact: lib.downloads.classifiers[classifier] });
      continue;
    }
    const artifact = lib.downloads?.artifact;
    const rel = libraryPath(lib);
    if (!artifact?.url || !rel) continue;
    libJobs.push({ url: mirrorUrl(artifact.url, mirror), dest: path.join(paths.libraries, rel), sha1: artifact.sha1, size: artifact.size });
  }

  let libDone = 0;
  await pool(libJobs, 8, async (job) => {
    await downloadFile(job.url, job.dest, { sha1: job.sha1, size: job.size });
    libDone += 1;
    onProgress({ phase: "libraries", done: libDone, total: libJobs.length });
  });

  const nativesDir = path.join(versionDir, "natives");
  if (natives.length) {
    fs.mkdirSync(nativesDir, { recursive: true });
    for (const { classifier, artifact } of natives) {
      const rel = artifact.path || `${classifier}.jar`;
      const dest = path.join(paths.libraries, rel);
      await downloadFile(mirrorUrl(artifact.url, mirror), dest, { sha1: artifact.sha1, size: artifact.size });
      const data = fs.readFileSync(dest);
      const zip = await readZip(data);
      for (const name of zip) extractZipEntry(data, name, nativesDir);
    }
  }

  let assetsDone = 0;
  if (version.assetIndex) {
    const indexDir = path.join(paths.assets, "indexes");
    fs.mkdirSync(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, `${version.assetIndex.id}.json`);
    const indexUrl = mirrorUrl(version.assetIndex.url, mirror);
    if (!(await fileMatches(indexPath, version.assetIndex.sha1, version.assetIndex.size))) {
      const res = await fetch(indexUrl);
      if (!res.ok) throw new Error(`获取资源索引失败：HTTP ${res.status}`);
      fs.writeFileSync(indexPath, await res.text());
    }
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const objects = Object.entries(index.objects || {});
    onProgress({ phase: "assets", done: 0, total: objects.length });
    await pool(objects, 16, async ([, obj]) => {
      const dir = obj.hash.slice(0, 2);
      const dest = path.join(paths.assets, "objects", dir, obj.hash);
      if ((await fileMatches(dest, obj.hash, obj.size))) {
        assetsDone += 1;
        onProgress({ phase: "assets", done: assetsDone, total: objects.length });
        return;
      }
      await downloadFile(`https://resources.download.minecraft.net/${dir}/${obj.hash}`, dest, { sha1: obj.hash, size: obj.size });
      assetsDone += 1;
      onProgress({ phase: "assets", done: assetsDone, total: objects.length });
    });
  }

  fs.writeFileSync(path.join(versionDir, ".installed"), new Date().toISOString());
  onProgress({ phase: "done" });
  return version;
}

/* Minimal zip reader for native libraries (store + deflate, no zip64). */
async function readZip(buffer) {
  const names = [];
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--) {
    if (buffer.readUInt32LE(i) !== 0x06054b50) continue;
    const count = buffer.readUInt16LE(i + 10);
    let offset = buffer.readUInt32LE(i + 16);
    for (let n = 0; n < count; n++) {
      if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
      const nameLen = buffer.readUInt16LE(offset + 28);
      const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen);
      if (!name.endsWith("/")) names.push(name);
      offset += 46 + nameLen + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    }
    break;
  }
  return names;
}

function extractZipEntry(buffer, name, outDir) {
  for (let i = 0; i < buffer.length - 4; i++) {
    if (buffer.readUInt32LE(i) !== 0x04034b50) continue;
    const method = buffer.readUInt16LE(i + 8);
    const compSize = buffer.readUInt32LE(i + 18);
    const nameLen = buffer.readUInt16LE(i + 26);
    const extraLen = buffer.readUInt16LE(i + 28);
    const entryName = buffer.toString("utf8", i + 30, i + 30 + nameLen);
    if (entryName !== name) continue;
    const start = i + 30 + nameLen + extraLen;
    const data = buffer.subarray(start, start + compSize);
    const out = method === 8 ? zlib.inflateRawSync(data) : data;
    const target = path.join(outDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, out);
    return;
  }
}
