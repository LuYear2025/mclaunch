import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { downloadFile, pool } from "./download.js";
import { createInstance, instanceDir, updateInstance } from "./instances.js";
import { installVersion } from "./mojang.js";
import { resolveCurseForgeFiles } from "./curseforge.js";
import { installFabric, installQuilt } from "./fabric.js";
import { installForge, installNeoForge } from "./forge.js";
import { findJava } from "./java.js";

const MODRINTH = "https://api.modrinth.com/v2";
const USER_AGENT = "mclaunch/0.1.0 (github.com/LuYear2025)";

function modrinthHeaders() {
  return { "User-Agent": USER_AGENT, Accept: "application/json" };
}

export async function searchModrinth(query, limit = 20) {
  const url = new URL(`${MODRINTH}/search`);
  url.searchParams.set("query", query || "");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("facets", JSON.stringify([["project_type:modpack"]]));
  url.searchParams.set("index", query ? "relevance" : "downloads");
  const res = await fetch(url, { headers: modrinthHeaders() });
  if (!res.ok) throw new Error(`Modrinth 搜索失败：HTTP ${res.status}`);
  const data = await res.json();
  return data.hits.map((hit) => ({
    source: "modrinth",
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    icon: hit.icon_url,
    downloads: hit.downloads,
    versions: hit.versions?.length ?? 0,
    categories: hit.categories || [],
  }));
}

export async function modrinthVersions(slug) {
  const res = await fetch(`${MODRINTH}/project/${encodeURIComponent(slug)}/version`, {
    headers: modrinthHeaders(),
  });
  if (!res.ok) throw new Error(`Modrinth 版本列表失败：HTTP ${res.status}`);
  const list = await res.json();
  return list.map((v) => ({
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    gameVersions: v.game_versions,
    loaders: v.loaders,
    files: v.files.map((f) => ({
      url: f.url,
      filename: f.filename,
      size: f.size,
      primary: f.primary,
    })),
  }));
}

export async function readZip(buffer) {
  const entries = [];
  const end = findEnd(buffer);
  if (end < 0) throw new Error("不是有效的 zip 文件");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString(flags & 0x800 ? "utf8" : "utf8", offset + 46, offset + 46 + nameLen);
    if (!name.endsWith("/")) {
      entries.push({ name, method, compSize, localOffset });
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function findEnd(buffer) {
  const min = Math.max(0, buffer.length - 66000);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

export function readEntry(buffer, entry) {
  const i = entry.localOffset;
  if (buffer.readUInt32LE(i) !== 0x04034b50) throw new Error("损坏的 zip 条目");
  const nameLen = buffer.readUInt16LE(i + 26);
  const extraLen = buffer.readUInt16LE(i + 28);
  const start = i + 30 + nameLen + extraLen;
  const data = buffer.subarray(start, start + entry.compSize);
  return entry.method === 8 ? zlib.inflateRawSync(data) : data;
}

export async function inspectModpackZip(buffer) {
  const entries = await readZip(buffer);
  const index = entries.find((e) => e.name === "modrinth.index.json");
  if (index) {
    const json = JSON.parse(readEntry(buffer, index).toString("utf8"));
    return {
      kind: "modrinth",
      name: json.name || "未命名整合包",
      versionId: json.versionId,
      minecraft: json.dependencies?.minecraft,
      loader: detectLoader(json.dependencies),
      dependencies: json.dependencies || {},
      files: json.files || [],
      entries,
    };
  }
  const manifest = entries.find((e) => e.name === "manifest.json");
  if (manifest) {
    const json = JSON.parse(readEntry(buffer, manifest).toString("utf8"));
    const dependencies = parseCurseForgeLoaders(json.minecraft?.modLoaders);
    return {
      kind: "curseforge",
      name: json.name || "未命名整合包",
      versionId: json.version,
      minecraft: json.minecraft?.version,
      loader: detectLoader(dependencies),
      dependencies,
      files: (json.files || []).map((f) => ({ projectID: f.projectID, fileID: f.fileID })),
      entries,
    };
  }
  // Plain instance zip: treat everything as an instance we can copy.
  return { kind: "minecraft", name: "未命名整合包", minecraft: undefined, loader: "vanilla", dependencies: {}, files: [], entries };
}

/** CurseForge 的 modLoaders 形如 [{ id: "forge-47.2.0" }]，转成 modrinth 风格的依赖表。 */
function parseCurseForgeLoaders(modLoaders = []) {
  const primary = modLoaders.find((m) => m.primary) || modLoaders[0];
  if (!primary?.id) return {};
  const id = String(primary.id);
  const dash = id.indexOf("-");
  const kind = id.slice(0, dash);
  const version = id.slice(dash + 1);
  if (kind === "forge") return { forge: version };
  if (kind === "neoforge") return { neoforge: version };
  if (kind === "fabric") return { "fabric-loader": version };
  if (kind === "quilt") return { "quilt-loader": version };
  return {};
}

function versionAtLeast(a, b) {
  const pa = String(a || "").split(".").map((n) => Number.parseInt(n, 10));
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10));
  if (pa.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function detectLoader(deps = {}) {
  if (deps["fabric-loader"]) return "fabric";
  if (deps["quilt-loader"]) return "quilt";
  if (deps.neoforge) return "neoforge";
  if (deps.forge) return "forge";
  return "vanilla";
}

export async function installModpackZip(buffer, { instanceName, mirror = "official", curseForgeKey = "", onProgress = () => {} } = {}) {
  const pack = await inspectModpackZip(buffer);
  const instance = createInstance({
    name: instanceName || pack.name,
    mcVersion: pack.minecraft,
    loader: pack.loader,
    modpack: { kind: pack.kind, name: pack.name, versionId: pack.versionId },
  });
  const dir = instanceDir(instance.id);

  if (pack.kind === "modrinth") {
    let done = 0;
    await pool(pack.files, 6, async (file) => {
      const dest = path.join(dir, file.path);
      await downloadFile(file.downloads[0], dest, { sha1: file.hashes?.sha1 });
      done += 1;
      onProgress({ phase: "files", done, total: pack.files.length, file: path.basename(file.path) });
    });
  } else if (pack.kind === "curseforge") {
    if (!curseForgeKey) {
      onProgress({ phase: "warn", message: "没有 CurseForge API Key，只解压了覆盖文件" });
    } else {
      const jobs = await resolveCurseForgeFiles(pack.files, curseForgeKey, (p) =>
        onProgress({ phase: "resolve", ...p })
      );
      let done = 0;
      await pool(jobs, 6, async (job) => {
        await downloadFile(job.url, path.join(dir, job.path));
        done += 1;
        onProgress({ phase: "files", done, total: jobs.length, file: path.basename(job.path) });
      });
    }
  }

  // Apply overrides/ (both formats use the same folder name).
  const overrides = pack.entries.filter((e) => e.name.startsWith("overrides/"));
  for (const entry of overrides) {
    const rel = entry.name.slice("overrides/".length);
    if (!rel) continue;
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readEntry(buffer, entry));
  }

  if (pack.minecraft) {
    try {
      await installVersion(pack.minecraft, { mirror, onProgress: (p) => onProgress({ phase: `game:${p.phase}`, ...p }) });
    } catch (error) {
      onProgress({ phase: "warn", message: `游戏版本下载失败：${error.message}` });
    }
  }

  // 装整合包依赖的 loader，让实例真能带着 mod 启动
  let profileId = null;
  let loaderVersion = null;
  const deps = pack.dependencies || {};
  try {
    if (pack.minecraft && deps["fabric-loader"]) {
      loaderVersion = deps["fabric-loader"];
      profileId = (await fabric.installFabric(pack.minecraft, loaderVersion, { mirror, onProgress })).profileId;
    } else if (pack.minecraft && deps["quilt-loader"]) {
      loaderVersion = deps["quilt-loader"];
      profileId = (await fabric.installQuilt(pack.minecraft, loaderVersion, { mirror, onProgress })).profileId;
    } else if (pack.minecraft && deps.neoforge) {
      loaderVersion = deps.neoforge;
      const java = await findJava(17);
      profileId = (await forge.installNeoForge(pack.minecraft, loaderVersion, { javaPath: java?.path, onProgress })).profileId;
    } else if (pack.minecraft && deps.forge) {
      if (versionAtLeast(pack.minecraft, "1.21.1")) {
        onProgress({ phase: "warn", message: "1.21.1 之后没有 Forge，跳过 loader 安装" });
      } else {
        loaderVersion = deps.forge;
        const java = await findJava(17);
        profileId = (await forge.installForge(pack.minecraft, loaderVersion, { javaPath: java?.path, onProgress })).profileId;
      }
    }
  } catch (error) {
    onProgress({ phase: "warn", message: `loader 安装失败：${error.message}` });
  }

  updateInstance(instance.id, { installed: true, profileId, loaderVersion, loader: pack.loader });
  return getInstanceWithDir(instance.id);
}

function getInstanceWithDir(id) {
  const dir = instanceDir(id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "instance.json"), "utf8"));
  return { ...meta, dir };
}

export function modpackFromFile(filePath) {
  return fs.readFileSync(filePath);
}

export function tempPath(name) {
  return path.join(os.tmpdir(), `mclaunch-${Date.now()}-${name}`);
}
