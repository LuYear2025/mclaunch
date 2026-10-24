import fs from "node:fs";
import path from "node:path";
import { downloadFile } from "./download.js";
import { instanceDir } from "./instances.js";
import { readZip, readEntry } from "./modpack.js";

const MODRINTH = "https://api.modrinth.com/v2";
const USER_AGENT = "mclaunch/0.1.0 (github.com/LuYear2025)";

export const resourceTypes = ["mod", "modpack", "datapack", "resourcepack", "shader", "world"];

/** 每种资源在实例目录里的落点 */
const TARGET_DIR = {
  mod: "mods",
  resourcepack: "resourcepacks",
  shader: "shaderpacks",
  datapack: "datapacks",
};

const CF_CLASS_ID = {
  mod: "6",
  modpack: "4471",
  resourcepack: "12",
  shader: "6552",
  datapack: "6945",
  world: "17",
};

function modrinthHeaders() {
  return { "User-Agent": USER_AGENT, Accept: "application/json" };
}

/* ---------------- Modrinth ---------------- */

export async function searchModrinth(type, query, { gameVersion, loader, limit = 20 } = {}) {
  if (type === "world") return []; // Modrinth 没有世界分类，世界走 CurseForge
  const facets = [[`project_type:${type}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loader && type === "mod") facets.push([`categories:${loader}`]);

  const url = new URL(`${MODRINTH}/search`);
  url.searchParams.set("query", query || "");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("facets", JSON.stringify(facets));
  url.searchParams.set("index", query ? "relevance" : "downloads");

  const res = await fetch(url, { headers: modrinthHeaders() });
  if (!res.ok) throw new Error(`Modrinth 搜索失败：HTTP ${res.status}`);
  const data = await res.json();
  return (data.hits || []).map((hit) => ({
    source: "modrinth",
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    icon: hit.icon_url,
    downloads: hit.downloads,
    categories: hit.categories || [],
  }));
}

export async function modrinthResourceVersions(slug, { gameVersion, loader } = {}) {
  const url = new URL(`${MODRINTH}/project/${encodeURIComponent(slug)}/version`);
  if (loader) url.searchParams.set("loaders", JSON.stringify([loader]));
  if (gameVersion) url.searchParams.set("game_versions", JSON.stringify([gameVersion]));
  const res = await fetch(url, { headers: modrinthHeaders() });
  if (!res.ok) throw new Error(`Modrinth 版本列表失败：HTTP ${res.status}`);
  const list = await res.json();
  return list.map((v) => ({
    id: v.id,
    projectId: v.project_id,
    name: v.name,
    versionNumber: v.version_number,
    gameVersions: v.game_versions,
    loaders: v.loaders,
    dependencies: v.dependencies || [],
    files: v.files.map((f) => ({ url: f.url, filename: f.filename, size: f.size, primary: f.primary })),
  }));
}

export function modrinthPrimaryFile(version) {
  const file = version.files.find((f) => f.primary) || version.files[0];
  if (!file) throw new Error("这个版本没有可下载的文件");
  return {
    url: file.url,
    filename: file.filename,
    label: version.name || file.filename,
    projectId: version.projectId,
    versionId: version.id,
    versionNumber: version.versionNumber || version.name,
  };
}

/**
 * 展开 Modrinth 模组的必需前置（dependencies 里 dependency_type === "required"）。
 * 返回下载项列表，第一个是被点的那一个，后面依次是前置。
 */
export async function resolveModrinthMod(slug, versionId, { gameVersion, loader, maxDepth = 5, maxItems = 40 } = {}) {
  const versions = await modrinthResourceVersions(slug, { gameVersion, loader });
  if (!versions.length) throw new Error("这个模组没有匹配当前版本的文件");
  const root = versionId ? versions.find((v) => v.id === versionId) : versions[0];
  if (!root) throw new Error("找不到这个版本");

  const items = [modrinthPrimaryFile(root)];
  const seen = new Set([root.projectId || slug]);
  await walkModrinthDeps(root, { gameVersion, loader }, seen, items, 0, maxDepth, maxItems);
  return items;
}

async function walkModrinthDeps(version, options, seen, items, depth, maxDepth, maxItems) {
  if (depth >= maxDepth || items.length >= maxItems) return;
  for (const dep of version.dependencies || []) {
    if (dep.dependency_type !== "required") continue;
    const key = dep.project_id || dep.version_id;
    if (!key || seen.has(key)) continue;
    seen.add(key);

    let depVersion = null;
    if (dep.version_id) {
      const res = await fetch(`${MODRINTH}/version/${dep.version_id}`, { headers: modrinthHeaders() });
      if (res.ok) depVersion = await res.json();
    }
    if (!depVersion && dep.project_id) {
      const list = await modrinthResourceVersions(dep.project_id, options);
      depVersion = list[0] ? await materialize(list[0]) : null;
    }
    if (!depVersion?.files?.length) continue;

    const file = depVersion.files.find((f) => f.primary) || depVersion.files[0];
    items.push({ url: file.url, filename: file.filename, label: depVersion.name || file.filename });
    await walkModrinthDeps(depVersion, options, seen, items, depth + 1, maxDepth, maxItems);
  }
}

/** Modrinth 的 /version/{id} 返回原始结构，转成和列表一致的形状。 */
async function materialize(version) {
  return {
    id: version.id,
    projectId: version.project_id,
    name: version.name,
    versionNumber: version.version_number,
    dependencies: version.dependencies || [],
    files: (version.files || []).map((f) => ({ url: f.url, filename: f.filename, size: f.size, primary: f.primary })),
  };
}

/** 把 Modrinth / CurseForge 的结果统一转成待下载项（模组会带上前置）。 */
export async function resolveInstallItems({
  type,
  source,
  slug,
  versionId,
  modId,
  fileId,
  key,
  gameVersion,
  loader,
  onProgress = () => {},
}) {
  if (type !== "mod") {
    // 其余类型没有依赖，直接给一个文件
    if (source === "curseforge") {
      const files = await curseForgeResourceFiles(modId, key, { gameVersion });
      const file = files.find((f) => String(f.id) === String(fileId)) || files[0];
      if (!file) throw new Error("找不到这个文件");
      return [{ url: file.downloadUrl || forgeCdnUrl(file.id, file.fileName), filename: file.fileName, label: file.fileName }];
    }
    const versions = await modrinthResourceVersions(slug, { gameVersion, loader });
    const version = versionId ? versions.find((v) => v.id === versionId) : versions[0];
    if (!version) throw new Error("找不到这个版本");
    return [modrinthPrimaryFile(version)];
  }

  onProgress({ phase: "resolve", message: "解析前置依赖" });

  if (source === "curseforge") {
    const items = [];
    const seen = new Set([String(modId)]);
    await walkCurseForgeDeps(String(modId), String(fileId), key, { gameVersion }, seen, items, 0);
    if (!items.length) throw new Error("找不到这个文件");
    return items;
  }

  return resolveModrinthMod(slug, versionId, { gameVersion, loader });
}

async function walkCurseForgeDeps(modId, fileId, key, options, seen, items, depth) {
  if (depth > 5 || items.length >= 40) return;
  const files = await curseForgeResourceFiles(modId, key, options);
  const file = files.find((f) => String(f.id) === String(fileId)) || files[0];
  if (!file) return;
  items.push({
    url: file.downloadUrl || forgeCdnUrl(file.id, file.fileName),
    filename: file.fileName,
    label: file.fileName,
  });
  for (const dep of file.dependencies || []) {
    if (dep.relationType !== 3) continue; // 3 = required
    const depId = String(dep.modId);
    if (seen.has(depId)) continue;
    seen.add(depId);
    await walkCurseForgeDeps(depId, null, key, options, seen, items, depth + 1);
  }
}

/* ---------------- 安装 ---------------- */

/** 直接把本地文件/压缩包装进实例（不经过网络）。 */
export async function installLocalContent({ type, instanceId, buffer, filename, onProgress = () => {} }) {
  if (!resourceTypes.includes(type)) throw new Error(`不支持的类型：${type}`);
  const instancePath = instanceDir(instanceId);
  const safeName = String(filename || "file.bin").replace(/[\\/:*?"<>|]/g, "_");

  if (type === "world") {
    const base = safeName.replace(/\.[^.]+$/, "");
    const savesDir = path.join(instancePath, "saves", base);
    fs.mkdirSync(savesDir, { recursive: true });
    const entries = await readZip(buffer);
    let done = 0;
    for (const entry of entries) {
      const target = path.resolve(savesDir, entry.name);
      if (!target.startsWith(path.resolve(savesDir) + path.sep)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, readEntry(buffer, entry));
      done += 1;
      if (done % 20 === 0) onProgress({ phase: "extract", done, total: entries.length });
    }
    onProgress({ phase: "done" });
    return { path: savesDir };
  }

  const target = installTarget(type, instanceId);
  const dest = path.join(target, safeName);
  fs.writeFileSync(dest, buffer);
  onProgress({ phase: "done" });
  return { path: dest };
}

function installTarget(type, instanceId) {
  const dir = instanceDir(instanceId);
  if (type === "world") return dir;
  if (type === "modpack") return dir;
  const sub = TARGET_DIR[type];
  if (!sub) throw new Error(`不支持的资源类型：${type}`);
  const target = path.join(dir, sub);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/**
 * 把一个资源文件装进实例。
 * type=world 时把 zip 解压成 saves/<name>/。
 */
export async function installResource({
  type,
  instanceId,
  url,
  filename,
  label,
  onProgress = () => {},
}) {
  if (!resourceTypes.includes(type)) throw new Error(`不支持的资源类型：${type}`);
  if (!instanceId) throw new Error("先选一个实例");

  const dir = instanceDir(instanceId);
  const safeName = String(filename || "download.bin").replace(/[\\/:*?"<>|]/g, "_");

  if (type === "world") {
    const tmp = path.join(dir, `.world-${Date.now()}.zip`);
    onProgress({ phase: "download", message: label || safeName });
    await downloadFile(url, tmp, { onProgress: (p) => onProgress({ phase: "download", ...p }) });
    const buffer = fs.readFileSync(tmp);
    const entries = await readZip(buffer);
    const base = safeName.replace(/\.[^.]+$/, "");
    const savesDir = path.join(dir, "saves", base);
    fs.mkdirSync(savesDir, { recursive: true });
    let done = 0;
    for (const entry of entries) {
      const data = readEntry(buffer, entry);
      const target = path.join(savesDir, entry.name);
      const resolved = path.resolve(target);
      if (!resolved.startsWith(path.resolve(savesDir) + path.sep)) continue; // 防穿越
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, data);
      done += 1;
      if (done % 20 === 0) onProgress({ phase: "extract", done, total: entries.length });
    }
    fs.rmSync(tmp, { force: true });
    onProgress({ phase: "done" });
    return { path: savesDir };
  }

  const target = installTarget(type, instanceId);
  const dest = path.join(target, safeName);
  await downloadFile(url, dest, { onProgress: (p) => onProgress({ phase: "download", ...p }) });
  onProgress({ phase: "done" });
  return { path: dest };
}

/* ---------------- CurseForge ---------------- */

async function cfFetch(pathname, key) {
  if (!key) throw new Error("还没有填 CurseForge API Key（设置页可以填）");
  const res = await fetch(`https://api.curseforge.com/v1${pathname}`, {
    headers: { Accept: "application/json", "x-api-key": key },
  });
  if (!res.ok) throw new Error(`CurseForge 请求失败：HTTP ${res.status}`);
  return res.json();
}

const LOADER_ID = { forge: "1", fabric: "4", quilt: "5", neoforge: "6" };

export async function searchCurseForge(type, query, key, { gameVersion, loader, limit = 20 } = {}) {
  const classId = CF_CLASS_ID[type];
  if (!classId) throw new Error(`CurseForge 不支持这个类型：${type}`);
  const params = new URLSearchParams({
    gameId: "432",
    classId,
    searchFilter: query || "",
    pageSize: String(limit),
    // 2 = 相关度，6 = 总下载量；没有关键词时按下载量排
    sortField: query ? "2" : "6",
    sortOrder: "desc",
  });
  if (gameVersion) params.set("gameVersion", gameVersion);
  if (loader && LOADER_ID[loader] && type === "mod") params.set("modLoaderType", LOADER_ID[loader]);

  const data = await cfFetch(`/mods/search?${params}`, key);
  return (data.data || []).map((mod) => ({
    source: "curseforge",
    id: mod.id,
    slug: mod.slug,
    title: mod.name,
    description: mod.summary || "",
    icon: mod.logo?.thumbnailUrl || "",
    downloads: mod.downloadCount || 0,
    categories: [],
  }));
}

export async function curseForgeResourceFiles(modId, key, { gameVersion } = {}) {
  const params = new URLSearchParams({ pageSize: "50" });
  if (gameVersion) params.set("gameVersion", gameVersion);
  const data = await cfFetch(`/mods/${modId}/files?${params}`, key);
  return (data.data || []).map((file) => ({
    id: file.id,
    name: file.displayName || file.fileName,
    fileName: file.fileName,
    downloadUrl: file.downloadUrl,
    gameVersions: file.gameVersions || [],
    dependencies: file.dependencies || [],
  }));
}

export function forgeCdnUrl(fileId, fileName) {
  const id = String(fileId);
  return `https://edge.forgecdn.net/files/${id.slice(0, 4)}/${id.slice(4)}/${encodeURIComponent(fileName)}`;
}
