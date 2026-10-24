import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** 扫一遍各盘根目录下名字像 Minecraft 的文件夹 */
function driveCandidates() {
  const found = [];
  for (const letter of ["C", "D", "E", "F", "G"]) {
    const root = `${letter}:\\`;
    if (!fs.existsSync(root)) continue;
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (/minecraft|\.minecraft|^mc$|^mc[-_ ]|pcl|hmcl|^mc—/i.test(entry.name)) {
          found.push(path.join(root, entry.name));
        }
      }
    } catch {
      // 盘符读不了就跳过
    }
  }
  return found;
}

/** 常见启动器的默认游戏目录 */
function defaultCandidates() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const home = os.homedir();
  return [
    path.join(appData, ".minecraft"),
    path.join(home, ".minecraft"),
    path.join(appData, "PrismLauncher"),
    path.join(process.env.LOCALAPPDATA || "", "PrismLauncher"),
    "D:\\MC",
    "D:\\Minecraft",
    "D:\\MCL",
    "C:\\MC",
    "E:\\MC",
    "E:\\Minecraft",
    ...driveCandidates(),
  ].filter(Boolean);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function detectSource(dir) {
  // PCL / PCL CE 会在游戏目录里放 PCL 文件夹或配置文件
  if (fs.existsSync(path.join(dir, "PCL")) || fs.existsSync(path.join(dir, "PCL.ini"))) return "PCL / PCL CE";
  if (fs.existsSync(path.join(dir, "hmcl.json")) || fs.existsSync(path.join(dir, "hmclversion.cfg"))) return "HMCL";
  if (fs.existsSync(path.join(dir, "launcher_profiles.json"))) return "官方启动器";
  return "未知";
}

function countFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).length;
  } catch {
    return 0;
  }
}

/** 扫描一个游戏目录，列出它能提供什么。 */
export function inspectGameDir(dir) {
  const versionsDir = path.join(dir, "versions");
  const versions = [];
  try {
    for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const jsonPath = path.join(versionsDir, entry.name, `${entry.name}.json`);
      if (!fs.existsSync(jsonPath)) continue;
      const json = readJsonSafe(jsonPath);
      const isolated = fs.existsSync(path.join(versionsDir, entry.name, "mods"));
      versions.push({
        id: entry.name,
        type: json?.type || "release",
        inheritsFrom: json?.inheritsFrom || null,
        isolated,
        mods: countFiles(path.join(versionsDir, entry.name, "mods")),
      });
    }
  } catch {
    // 不是游戏目录
  }

  return {
    path: dir,
    source: detectSource(dir),
    versions,
    mods: countFiles(path.join(dir, "mods")),
    hasAssets: fs.existsSync(path.join(dir, "assets")),
    hasLibraries: fs.existsSync(path.join(dir, "libraries")),
  };
}

/** 扫描候选目录，返回所有看起来是 Minecraft 游戏目录的。 */
export function scanGameDirs(extra = []) {
  const seen = new Set();
  const results = [];
  for (const candidate of [...defaultCandidates(), ...extra]) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!fs.existsSync(resolved)) continue;
    const info = inspectGameDir(resolved);
    if (info.versions.length || info.hasAssets || info.hasLibraries) results.push(info);
  }
  return results;
}
