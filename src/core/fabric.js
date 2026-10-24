import fs from "node:fs";
import path from "node:path";
import { paths, writeJson } from "../paths.js";
import { downloadFile, pool } from "./download.js";
import { mirrorUrl } from "./mojang.js";

/**
 * Fabric / Quilt loader 安装。
 * 两个 loader 的元数据接口结构一致，只有域名和版本号前缀不同，这里用一张表统一处理。
 * 元数据接口总是直连官方，只有库文件下载才走 mirrorUrl()。
 */
const META = {
  fabric: {
    name: "Fabric",
    listUrl: (mc) => `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`,
    profileUrl: (mc, loader) =>
      `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`,
    maven: "https://maven.fabricmc.net/",
  },
  quilt: {
    name: "Quilt",
    listUrl: (mc) => `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}`,
    profileUrl: (mc, loader) =>
      `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`,
    maven: "https://maven.quiltmc.org/repository/release/",
  },
};

const osName = { win32: "windows", darwin: "osx", linux: "linux" }[process.platform] || process.platform;
const osArch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "arm64" : process.arch;

/* ---- rules：与 mojang.js / launch.js 同一套语义，规则非空时默认拒绝 ---- */

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

/* ---- 版本号排序：按点分段比较，预发布后缀（-beta.1）比同号正式版旧 ---- */

const PRERELEASE = /(alpha|beta|pre|rc|snapshot)/i;

function isStableVersion(version) {
  return !PRERELEASE.test(String(version));
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/);
  const pb = String(b).split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx - ny;
      continue;
    }
    if (x === y) continue;
    if (nx !== null) return 1; // 数字段比非数字段新
    if (ny !== null) return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/* ---- 网络 ---- */

async function fetchJson(url, what) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${what}失败：HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${what}失败：返回内容不是 JSON`);
  }
}

/* ---- 库路径 ---- */

/** group:artifact:version[:classifier] → group/with/slashes/artifact/version/artifact-version[-classifier].jar */
function mavenPath(name) {
  const [group, artifact, version, classifier] = String(name || "").split(":");
  if (!group || !artifact || !version) return null;
  const file = classifier ? `${artifact}-${version}-${classifier}.jar` : `${artifact}-${version}.jar`;
  return `${group.replace(/\./g, "/")}/${artifact}/${version}/${file}`;
}

/**
 * 把 profile JSON 里的 libraries 转成下载任务。
 * Fabric/Quilt 的库通常没有 downloads.artifact，只有 name + maven 基址（url 字段），
 * 路径自己拼、链接用 <基址>/<路径>；有 downloads.artifact 时优先用它给出的 path/url。
 */
function libraryJobs(kind, json, mirror) {
  const api = META[kind];
  const jobs = new Map();
  for (const lib of json.libraries || []) {
    if (!ruleAllowed(lib.rules)) continue;
    const artifact = lib.downloads?.artifact;
    const rel = artifact?.path || mavenPath(lib.name);
    if (!rel) continue;
    const base = String(lib.url || api.maven).replace(/\/+$/, "");
    const url = mirrorUrl(artifact?.url || `${base}/${rel}`, mirror);
    // 同一路径只下载一次；校验信息优先取 downloads.artifact，其次用库条目自带的 sha1/size
    if (jobs.has(rel)) continue;
    jobs.set(rel, {
      url,
      dest: path.join(paths.libraries, rel),
      sha1: artifact?.sha1 || lib.sha1,
      size: artifact?.size || lib.size,
    });
  }
  return [...jobs.values()];
}

/* ---- 列表 ---- */

async function listLoaders(kind, mcVersion) {
  const api = META[kind];
  if (!mcVersion) throw new Error("缺少游戏版本");
  const data = await fetchJson(api.listUrl(mcVersion), `获取 ${api.name} 版本列表`);
  if (!Array.isArray(data)) throw new Error(`获取 ${api.name} 版本列表失败：返回格式不正确`);
  return data
    .filter((entry) => entry?.loader?.version)
    .map((entry) => ({
      version: String(entry.loader.version),
      // Quilt 的接口没有 stable 字段，只能从版本号后缀推断
      stable: typeof entry.loader.stable === "boolean" ? entry.loader.stable : isStableVersion(entry.loader.version),
    }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/* ---- 安装 ---- */

async function installLoader(kind, mcVersion, loaderVersion, { mirror = "official", onProgress = () => {} } = {}) {
  const api = META[kind];
  if (!mcVersion) throw new Error("缺少游戏版本");
  if (!loaderVersion) throw new Error(`请选择一个 ${api.name} 版本`);
  if (!fs.existsSync(path.join(paths.versions, mcVersion, `${mcVersion}.json`))) {
    throw new Error(`先安装原版 ${mcVersion} 再装 loader`);
  }

  onProgress({ phase: "meta", message: `读取 ${api.name} 安装配置` });
  const json = await fetchJson(api.profileUrl(mcVersion, loaderVersion), `获取 ${api.name} 安装配置`);
  const profileId = json?.id;
  if (!profileId) throw new Error(`${api.name} 安装配置缺少 id，无法确定版本名`);

  // 原样保存（保留 inheritsFrom），继承链由 versionResolver 展开
  writeJson(path.join(paths.versions, profileId, `${profileId}.json`), json);

  const jobs = libraryJobs(kind, json, mirror);
  let done = 0;
  onProgress({ phase: "libraries", done: 0, total: jobs.length });
  await pool(jobs, 6, async (job) => {
    await downloadFile(job.url, job.dest, { sha1: job.sha1, size: job.size });
    done += 1;
    onProgress({ phase: "libraries", done, total: jobs.length });
  });

  fs.writeFileSync(path.join(paths.versions, profileId, ".installed"), new Date().toISOString());
  onProgress({ phase: "done" });
  return { profileId, json };
}

/* ---- 对外接口 ---- */

export async function listFabricLoaders(mcVersion) {
  return listLoaders("fabric", mcVersion);
}

export async function installFabric(mcVersion, loaderVersion, { mirror = "official", onProgress = () => {} } = {}) {
  return installLoader("fabric", mcVersion, loaderVersion, { mirror, onProgress });
}

export async function listQuiltLoaders(mcVersion) {
  return listLoaders("quilt", mcVersion);
}

export async function installQuilt(mcVersion, loaderVersion, { mirror = "official", onProgress = () => {} } = {}) {
  return installLoader("quilt", mcVersion, loaderVersion, { mirror, onProgress });
}
