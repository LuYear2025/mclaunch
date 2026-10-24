import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** 记录用户选的数据目录，重启后生效 */
const configDir = path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "mclaunch");
const locationFile = path.join(configDir, "location.txt");
const gameDirFile = path.join(configDir, "game-dir.txt");

function resolveHome() {
  if (process.env.MCLAUNCH_HOME) return process.env.MCLAUNCH_HOME;
  try {
    const saved = fs.readFileSync(locationFile, "utf8").trim();
    if (saved) return saved;
  } catch {
    // 没有配置就用默认目录
  }
  return path.join(os.homedir(), ".mclaunch");
}

function resolveGameHome(fallback) {
  try {
    const saved = fs.readFileSync(gameDirFile, "utf8").trim();
    if (saved) return saved;
  } catch {
    // 没配置时跟数据目录一致
  }
  return fallback;
}

const home = resolveHome();
const gameHome = resolveGameHome(home);

export const paths = {
  root: home,
  gameHome,
  versions: path.join(gameHome, "versions"),
  libraries: path.join(gameHome, "libraries"),
  assets: path.join(gameHome, "assets"),
  instances: path.join(home, "instances"),
  cache: path.join(home, "cache"),
  accounts: path.join(home, "accounts.json"),
  settings: path.join(home, "settings.json"),
};

/** 保存新的数据目录（下次启动生效）。 */
export function setDataHome(dir) {
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(locationFile, resolved, "utf8");
  return resolved;
}

/** 保存游戏文件目录（versions/libraries/assets），传空字符串表示跟数据目录一致。 */
export function setGameHome(dir) {
  fs.mkdirSync(configDir, { recursive: true });
  const value = String(dir || "").trim();
  if (!value) {
    fs.rmSync(gameDirFile, { force: true });
    return null;
  }
  const resolved = path.resolve(value);
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(gameDirFile, resolved, "utf8");
  return resolved;
}

/** 读当前配置的数据目录（可能是还没生效的新路径）。 */
export function readConfiguredHome() {
  try {
    return fs.readFileSync(locationFile, "utf8").trim() || home;
  } catch {
    return home;
  }
}

/** 读当前配置的游戏文件目录（null 表示跟数据目录一致）。 */
export function readConfiguredGameHome() {
  try {
    return fs.readFileSync(gameDirFile, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function ensureDirs() {
  for (const dir of [paths.root, paths.libraries, paths.assets, paths.instances, paths.cache]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
