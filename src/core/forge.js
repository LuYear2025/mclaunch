import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { paths } from "../paths.js";
import { findJava } from "./java.js";
import { downloadFile } from "./download.js";

const FORGE_PROMOS_URL = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_METADATA_URL = "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml";
const NEOFORGE_METADATA_URL = "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";

const FETCH_TIMEOUT = 30_000;
const METADATA_TTL = 10 * 60_000;
const INSTALLER_TIMEOUT = 10 * 60_000;
const TAIL_LINES = 200;

// 元数据较大（Forge maven-metadata.xml 约 200KB），短时间内重复调用直接复用
const textCache = new Map();

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url, label) {
  const cached = textCache.get(url);
  if (cached && Date.now() - cached.at < METADATA_TTL) return cached.text;

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      textCache.set(url, { at: Date.now(), text });
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(500 * (attempt + 1));
    }
  }
  throw new Error(`获取${label}失败：${lastError?.message || lastError}`);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 取出版本号开头的数字段，用于“最新在前”的排序（47.4.28 -> [47, 4, 28]）。 */
function versionNumbers(text) {
  const match = /^\d+(?:\.\d+)*/.exec(String(text).trim());
  return match ? match[0].split(".").map((part) => Number(part)) : [];
}

function compareVersionNumbers(a, b) {
  const left = versionNumbers(a);
  const right = versionNumbers(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const l = left[i] ?? -1;
    const r = right[i] ?? -1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

function compareVersionsDesc(a, b) {
  return -compareVersionNumbers(a, b);
}

/** 极简 maven-metadata.xml 解析：只取 <version> 列表。 */
function parseMavenVersions(xml) {
  const versions = [];
  for (const match of String(xml).matchAll(/<version>([^<]+)<\/version>/g)) {
    const value = match[1].trim();
    if (value) versions.push(value);
  }
  return versions;
}

function requireMcVersion(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("缺少 Minecraft 版本号");
  return text;
}

/** 默认 Java 主版本：1.17+ 用 17，更老的用 8，日历版本号（26.x）用 21。 */
function defaultJavaMajor(mcVersion) {
  const parts = versionNumbers(mcVersion);
  const major = parts[0] ?? 1;
  if (major !== 1) return 21;
  return (parts[1] ?? 0) >= 17 ? 17 : 8;
}

/**
 * NeoForge 版本号与 MC 版本一一对应：
 * 1.20.4 -> 20.4.、1.21.1 -> 21.1.、1.21 -> 21.0.（缺 patch 时补 0）。
 */
function neoVersionPrefix(mcVersion) {
  const parts = mcVersion.split(".");
  if (parts[0] === "1") {
    const minor = Number(parts[1] ?? 0);
    const patch = parts[2] === undefined ? 0 : Number(parts[2]);
    return `${minor}.${patch}.`;
  }
  // 日历版本号（如 26.3）直接对齐 NeoForge 的 26.3.x
  return `${mcVersion}.`;
}

/* ------------------------------------------------------------------ */
/* 版本列表                                                            */
/* ------------------------------------------------------------------ */

/**
 * 列出某个 MC 版本可用的全部 Forge 构建（不止推荐版）。
 * 促销信息来自 promotions_slim.json，完整列表来自 maven-metadata.xml。
 * @returns {Promise<Array<{version: string, type: "recommended"|"latest"|"other"}>>} 最新在前
 */
export async function listForgeVersions(mcVersion) {
  const mc = requireMcVersion(mcVersion);

  // 产品规则：Forge 从 1.21.1 起不再跟进新版本，只提供 NeoForge（server 层已有一道拦截）
  if (compareVersionNumbers(mc, "1.21.1") >= 0) return [];

  const [metadataXml, promosText] = await Promise.all([
    fetchText(FORGE_METADATA_URL, "Forge 版本列表"),
    // 推荐信息只是锦上添花，单独失败时仍返回完整构建列表
    fetchText(FORGE_PROMOS_URL, "Forge 推荐版本").catch(() => ""),
  ]);

  let promos = {};
  if (promosText) {
    try {
      promos = JSON.parse(promosText)?.promos || {};
    } catch {
      promos = {};
    }
  }
  const recommended = promos[`${mc}-recommended`];
  const latest = promos[`${mc}-latest`];

  const prefix = `${mc}-`;
  const builds = new Map();
  for (const full of parseMavenVersions(metadataXml)) {
    if (!full.startsWith(prefix)) continue;
    const version = full.slice(prefix.length);
    if (!version || builds.has(version)) continue;
    builds.set(version, true);
  }
  // 促销里的版本万一还没进 metadata，也照样列出
  for (const promoted of [recommended, latest]) {
    if (promoted && !builds.has(promoted)) builds.set(promoted, true);
  }

  return [...builds.keys()]
    .map((version) => ({
      version,
      type: version === recommended ? "recommended" : version === latest ? "latest" : "other",
    }))
    .sort((a, b) => compareVersionsDesc(a.version, b.version));
}

/**
 * 列出某个 MC 版本可用的 NeoForge 版本（过滤掉 snapshot/beta 后缀）。
 * @returns {Promise<Array<{version: string}>>} 最新在前
 */
export async function listNeoForgeVersions(mcVersion) {
  const mc = requireMcVersion(mcVersion);
  const prefix = neoVersionPrefix(mc);
  const xml = await fetchText(NEOFORGE_METADATA_URL, "NeoForge 版本列表");

  const versions = new Set();
  for (const value of parseMavenVersions(xml)) {
    if (!value.startsWith(prefix)) continue;
    // 只要稳定构建：20.4.237 / 21.1.72，排除 21.1.0-beta、26.1.0.0-alpha+snapshot-1
    if (!/^\d+(?:\.\d+)+$/.test(value)) continue;
    versions.add(value);
  }

  return [...versions].sort(compareVersionsDesc).map((version) => ({ version }));
}

/* ------------------------------------------------------------------ */
/* 安装                                                                */
/* ------------------------------------------------------------------ */

const LOADERS = {
  forge: {
    label: "Forge",
    tempPrefix: "forge-installer",
    installerUrl: (mcVersion, version) =>
      `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${version}/forge-${mcVersion}-${version}-installer.jar`,
    // Forge 安装器生成的目录名通常是 <mc>-forge-<ver>，老版本可能是 Forge 开头的变体
    profileIds: (mcVersion, version) => [
      `${mcVersion}-forge-${version}`,
      `forge-${mcVersion}-${version}`,
      `${mcVersion}-Forge${version}`,
    ],
    matchesProfileName: (name) => /forge/i.test(name) && !/neoforge/i.test(name),
  },
  neoforge: {
    label: "NeoForge",
    tempPrefix: "neoforge-installer",
    installerUrl: (_mcVersion, version) =>
      `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`,
    profileIds: (mcVersion, version) => [
      `neoforge-${version}`,
      `${mcVersion}-neoforge-${version}`,
      `forge-${mcVersion}-${version}`,
    ],
    matchesProfileName: (name) => /neoforge/i.test(name),
  },
};

function normalizeLoaderVersion(loader, mcVersion, value) {
  const label = LOADERS[loader].label;
  let text = String(value ?? "").trim();
  if (!text) throw new Error(`缺少 ${label} 版本号`);

  // 兼容调用方直接传完整 maven 版本号：1.20.1-47.4.28 / neoforge-21.1.72
  if (text.toLowerCase().startsWith(`${mcVersion.toLowerCase()}-`)) text = text.slice(mcVersion.length + 1);
  if (loader === "neoforge" && text.toLowerCase().startsWith("neoforge-")) text = text.slice("neoforge-".length);
  if (!/^[0-9A-Za-z._+-]+$/.test(text)) throw new Error(`非法的 ${label} 版本号：${value}`);
  return text;
}

/** 已存在的 loader 版本目录 -> { profileId, versionJsonPath }，坏目录返回 null。 */
function validProfile(dirName, mcVersion) {
  const file = path.join(paths.versions, dirName, `${dirName}.json`);
  if (!fs.existsSync(file)) return null;
  const json = readJsonSafe(file);
  if (!json) return null;
  // 只认继承自目标原版的目录，别把别的 MC 版本的 loader 当成已安装
  if (json.inheritsFrom && json.inheritsFrom !== mcVersion) return null;
  return { profileId: dirName, versionJsonPath: file };
}

function libraryRelativePath(lib) {
  const artifactPath = lib?.downloads?.artifact?.path;
  if (artifactPath) return artifactPath;
  const [group, name, version] = String(lib?.name || "").split(":");
  if (!group || !name || !version) return null;
  return `${group.replace(/\./g, "/")}/${name}/${version}/${name}-${version}.jar`;
}

/**
 * 安装器会先写版本 JSON 再下库、跑处理器；如果进程被中途杀掉，
 * 只凭 JSON 存在会把半成品当成“已安装”，所以跳装前再确认声明的库都在磁盘上。
 */
function profileLibrariesPresent(versionJsonPath) {
  const json = readJsonSafe(versionJsonPath);
  if (!json || !Array.isArray(json.libraries)) return true;
  for (const lib of json.libraries) {
    const relative = libraryRelativePath(lib);
    if (!relative) continue;
    if (!fs.existsSync(path.join(paths.libraries, relative))) return false;
  }
  return true;
}

function findInstalledProfile(mcVersion, candidateIds) {
  const wanted = new Set(candidateIds.map((id) => id.toLowerCase()));
  for (const dir of listDirs(paths.versions)) {
    if (!wanted.has(dir.toLowerCase())) continue;
    const profile = validProfile(dir, mcVersion);
    if (profile && profileLibrariesPresent(profile.versionJsonPath)) return profile;
  }
  return null;
}

/** 新装出的目录必须带 JSON，且 inheritsFrom 指向原版，否则视为安装失败。 */
function verifyProfile(dirName, mcVersion) {
  const file = path.join(paths.versions, dirName, `${dirName}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`安装器生成的版本 ${dirName} 缺少版本 JSON：${file}`);
  }
  const json = readJsonSafe(file);
  if (!json) throw new Error(`版本 JSON 无法解析：${file}`);
  if (json.inheritsFrom !== mcVersion) {
    throw new Error(`版本 ${dirName} 的 inheritsFrom 是 ${json.inheritsFrom ?? "（缺失）"}，不是原版 ${mcVersion}`);
  }
  return { profileId: dirName, versionJsonPath: file };
}

function findCreatedProfile({ created, mcVersion, expectedIds, label, matchesProfileName }) {
  const wanted = expectedIds.map((id) => id.toLowerCase());

  // 1. 安装器没按预期命名时，先找“新建 + 继承目标原版”的目录
  for (const dir of created) {
    if (expectedIds.includes(dir)) return verifyProfile(dir, mcVersion);
  }
  for (const dir of created) {
    if (wanted.includes(dir.toLowerCase())) return verifyProfile(dir, mcVersion);
  }
  for (const dir of created) {
    // 只认本 loader 的目录，避免把并发安装的别的 loader 当成本次结果
    if (matchesProfileName?.(dir) && validProfile(dir, mcVersion)) return verifyProfile(dir, mcVersion);
  }
  // 2. 目录 diff 为空（例如安装器判定内容已存在）：再按 id 和继承关系兜底查找
  const all = listDirs(paths.versions);
  for (const dir of expectedIds) {
    if (all.includes(dir) && validProfile(dir, mcVersion)) return verifyProfile(dir, mcVersion);
  }
  for (const dir of all) {
    if (wanted.includes(dir.toLowerCase()) && validProfile(dir, mcVersion)) return verifyProfile(dir, mcVersion);
  }

  throw new Error(`${label} 安装器已结束，但没有生成 ${mcVersion} 的版本目录（预期 ${expectedIds[0]}），请检查安装器输出`);
}

function ensureLauncherProfiles() {
  fs.mkdirSync(paths.root, { recursive: true });
  const file = path.join(paths.root, "launcher_profiles.json");
  // Forge/NeoForge 安装器缺少这个文件会直接拒绝安装
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ profiles: {} }), "utf8");
}

async function resolveJava(vanillaJsonPath, javaPath, mcVersion, onProgress) {
  if (javaPath) {
    const file = path.resolve(String(javaPath).trim());
    if (!fs.existsSync(file)) throw new Error(`指定的 Java 不存在：${file}`);
    onProgress({ phase: "java", message: `使用指定的 Java：${file}` });
    return file;
  }

  const versionJson = readJsonSafe(vanillaJsonPath);
  // 原版 JSON 里的 javaVersion 最准（1.20.1 是 majorVersion: 17），拿不到再退回规则
  const required =
    versionJson?.javaVersion?.major ?? versionJson?.javaVersion?.majorVersion ?? defaultJavaMajor(mcVersion);
  const found = await findJava(required);
  if (!found) throw new Error(`找不到 Java ${required} 或更高版本，请先安装 Java 或指定 javaPath`);
  onProgress({ phase: "java", message: `使用 Java ${found.version}：${found.path}` });
  return found.path;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {
        try {
          child.kill();
        } catch {
          /* 进程可能已经退出 */
        }
      });
      return;
    } catch {
      // 退回普通 kill
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* 进程可能已经退出 */
  }
}

/**
 * 跑 `java -jar <installer> --installClient <root>`：
 * 逐行把 stdout/stderr 抛给 onProgress，超时强杀，非 0 退出带最近输出报错。
 */
function runInstaller(javaPath, installerPath, targetRoot, label, onProgress) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        javaPath,
        ["-Djava.awt.headless=true", "-jar", installerPath, "--installClient", targetRoot],
        {
          cwd: targetRoot,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      reject(new Error(`无法启动 ${label} 安装器：${error.message}`));
      return;
    }

    const tail = [];
    let settled = false;

    const pushLine = (line) => {
      if (settled) return;
      const text = String(line).replace(/\s+$/, "");
      if (!text) return;
      tail.push(text);
      if (tail.length > TAIL_LINES) tail.shift();
      try {
        onProgress({ phase: "installer", message: text });
      } catch {
        // 上层回调出错不应该中断安装
      }
    };

    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r\n|\n|\r/);
        buffer = lines.pop() ?? "";
        for (const line of lines) pushLine(line);
      });
      stream.on("end", () => {
        if (buffer) pushLine(buffer);
        buffer = "";
      });
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      reject(new Error(`${label} 安装超时（${INSTALLER_TIMEOUT / 60_000} 分钟），已终止安装器进程`));
    }, INSTALLER_TIMEOUT);
    timer.unref?.();

    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error(`无法启动 ${label} 安装器：${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      const recent = tail.slice(-20).join("\n");
      reject(new Error(`${label} 安装器失败（退出码 ${code}）${recent ? `：\n${recent}` : ""}`));
    });
  });
}

function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 安装器可能还占着文件句柄；临时目录会被系统清理，这里只做尽力而为
  }
}

/* ------------------------------------------------------------------ */
/* 安装主流程                                                          */
/* ------------------------------------------------------------------ */

async function installLoader(loader, mcVersion, loaderVersion, { javaPath, onProgress = () => {} } = {}) {
  const config = LOADERS[loader];
  const mc = requireMcVersion(mcVersion);
  const version = normalizeLoaderVersion(loader, mc, loaderVersion);
  const expectedIds = config.profileIds(mc, version);

  // 1. 必须先有原版，否则 loader 的 inheritsFrom 无解
  const vanillaJsonPath = path.join(paths.versions, mc, `${mc}.json`);
  if (!fs.existsSync(vanillaJsonPath)) throw new Error(`先安装原版 ${mc} 再装 loader`);

  // 2. 已装过就直接返回，不重复跑安装器
  const existing = findInstalledProfile(mc, expectedIds);
  if (existing) {
    onProgress({ phase: "skip", message: "已安装" });
    return existing;
  }

  // 3. Java
  const java = await resolveJava(vanillaJsonPath, javaPath, mc, onProgress);

  // 4. 安装器需要 launcher_profiles.json
  ensureLauncherProfiles();
  fs.mkdirSync(paths.versions, { recursive: true });
  const before = new Set(listDirs(paths.versions).map((name) => name.toLowerCase()));

  // 5. 下载安装器到临时目录
  const jar = path.join(os.tmpdir(), `${config.tempPrefix}-${crypto.randomBytes(4).toString("hex")}.jar`);
  const installerUrl = config.installerUrl(mc, version);
  try {
    onProgress({
      phase: "download",
      message: `下载 ${config.label} 安装器 ${mc}-${version}`,
      done: 0,
      total: 0,
    });
    await downloadFile(installerUrl, jar, {
      onProgress: (progress) =>
        onProgress({
          phase: "download",
          message: `下载 ${config.label} 安装器 ${mc}-${version}`,
          ...progress,
        }),
    });

    // 6. 无界面安装
    onProgress({ phase: "installer", message: `运行 ${config.label} 安装器（${java}）` });
    await runInstaller(java, jar, paths.root, config.label, onProgress);
  } finally {
    // 7. 删安装器和安装器自己在 cwd 留下的日志
    removeFile(jar);
    removeFile(path.join(paths.root, `${path.basename(jar)}.log`));
  }

  // 8. 用 versions/ 前后 diff 找出新建的版本目录
  const created = listDirs(paths.versions).filter((name) => !before.has(name.toLowerCase()));
  const profile = findCreatedProfile({
    created,
    mcVersion: mc,
    expectedIds,
    label: config.label,
    matchesProfileName: config.matchesProfileName,
  });

  onProgress({ phase: "done", message: `已安装 ${profile.profileId}` });
  return profile;
}

/**
 * 安装 Forge（跑官方安装器的 installClient）。
 * @returns {Promise<{profileId: string, versionJsonPath: string}>}
 */
export async function installForge(mcVersion, forgeVersion, options = {}) {
  return installLoader("forge", mcVersion, forgeVersion, options);
}

/**
 * 安装 NeoForge（跑官方安装器的 installClient）。
 * @returns {Promise<{profileId: string, versionJsonPath: string}>}
 */
export async function installNeoForge(mcVersion, neoVersion, options = {}) {
  return installLoader("neoforge", mcVersion, neoVersion, options);
}
