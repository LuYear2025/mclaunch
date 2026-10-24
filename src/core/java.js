import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const PROBE_TIMEOUT = 10_000;
const PROBE_CONCURRENCY = 6;
const isWin = process.platform === "win32";
const javaBinName = isWin ? "java.exe" : "java";

// 路径 -> 探测结果（null 表示坏掉的安装，同样缓存以避免反复等超时）
const probeCache = new Map();

function run(file, args, timeout = PROBE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      // 只有根本没跑起来才算失败；非 0 退出的输出仍交给上层解析
      if (error && (error.code === "ENOENT" || error.code === "EACCES" || error.killed || error.signal)) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function spawnFailure(file, error) {
  if (error.killed || error.signal) return new Error(`探测 Java 超时（${PROBE_TIMEOUT / 1000} 秒）：${file}`);
  const reason = error.code === "ENOENT" ? "文件不存在" : error.code === "EACCES" ? "没有执行权限" : error.message;
  return new Error(`无法启动 Java（${file}）：${reason}`);
}

function parsePropertyLines(text) {
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(java\.version|java\.home|java\.vendor)\s*=\s*(.+?)\s*$/.exec(line);
    if (match) props[match[1]] = match[2];
  }
  return props;
}

function parseVersionBanner(text) {
  const match = /(?:java|openjdk)\s+version\s+"([^"]+)"/i.exec(text);
  return match ? match[1] : null;
}

function parseMajor(version) {
  if (!version) return null;
  const match = /^(\d+)(?:\.(\d+))?/.exec(String(version).trim());
  if (!match) return null;
  const first = Number(match[1]);
  // 8 及以前的版本号形如 1.8.0_392，主版本是第二段
  if (first === 1 && match[2] !== undefined) return Number(match[2]);
  return first;
}

export async function javaVersionInfo(javaPath) {
  if (typeof javaPath !== "string" || !javaPath.trim()) throw new Error("javaVersionInfo: 缺少 Java 可执行文件路径");
  const file = javaPath.trim();

  let text;
  let props;
  try {
    const { stdout, stderr } = await run(file, ["-XshowSettings:properties", "-version"]);
    text = `${stderr}\n${stdout}`;
    props = parsePropertyLines(text);
    if (!props["java.version"]) {
      // 部分旧版 / 精简 JRE 不认 -XshowSettings，退回 -version 的版本横幅
      const fallback = await run(file, ["-version"]);
      text = `${fallback.stderr}\n${fallback.stdout}\n${text}`;
      props = { ...parsePropertyLines(text), ...props };
    }
  } catch (error) {
    throw spawnFailure(file, error);
  }

  const version = props["java.version"] || parseVersionBanner(text);
  if (!version) throw new Error(`无法解析 Java 版本信息：${file}`);
  return {
    path: file,
    major: parseMajor(version),
    version,
    vendor: props["java.vendor"] || null,
  };
}

export function requiredJavaMajor(versionJson) {
  // 新版 manifest 用 majorVersion，老版本用 major，两个都要认
  return versionJson?.javaVersion?.major ?? versionJson?.javaVersion?.majorVersion ?? 8;
}

function javaExec(dir) {
  return path.join(dir, "bin", javaBinName);
}

async function listChildDirs(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function pathJavaCandidates() {
  const found = [];
  try {
    const { stdout } = await run(isWin ? "where" : "which", ["java"], 5_000);
    for (const line of stdout.split(/\r?\n/)) {
      const file = line.trim().replace(/^"|"$/g, "");
      if (file) found.push(file);
    }
  } catch {
    // where/which 不可用时退回手动扫描 PATH
  }
  if (found.length === 0) {
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      if (dir) found.push(javaExec(dir));
    }
  }
  return found;
}

const REGISTRY_KEYS = [
  "HKLM\\SOFTWARE\\JavaSoft\\JDK",
  "HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit",
  "HKLM\\SOFTWARE\\Eclipse Adoptium\\JDK",
];

function expandEnv(value) {
  return value.replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all);
}

async function registryJavaHomes() {
  const homes = [];
  for (const key of REGISTRY_KEYS) {
    let text;
    try {
      // /s 递归，一次拿到所有版本子键；键不存在时 reg 只报错并非 0 退出
      text = (await run("reg", ["query", key, "/s"], 5_000)).stdout;
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      // JavaSoft 写 JavaHome，Adoptium 只写 MSI\Path，两者都指向 JDK 根目录
      const match = /^\s*(?:JavaHome|Path)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line);
      if (match) homes.push(expandEnv(match[1]));
    }
  }
  return homes;
}

const WINDOWS_VENDOR_DIRS = ["Java", "Eclipse Adoptium", "Microsoft", "Zulu", "BellSoft", "Amazon Corretto"];

async function windowsScanCandidates() {
  const localPrograms = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Programs")
    : path.join(os.homedir(), "AppData", "Local", "Programs");
  const roots = [process.env.ProgramFiles || "C:\\Program Files", localPrograms];
  const found = [];
  for (const root of roots) {
    for (const vendor of WINDOWS_VENDOR_DIRS) {
      // 厂商目录下一层就是具体版本（Microsoft 为 jdk*，Adoptium 为 jdk-x-hotspot）
      for (const install of await listChildDirs(path.join(root, vendor))) {
        found.push(javaExec(install));
      }
    }
  }
  return found;
}

async function posixScanCandidates() {
  if (process.platform === "darwin") {
    const bundles = await listChildDirs("/Library/Java/JavaVirtualMachines");
    return bundles.map((bundle) => javaExec(path.join(bundle, "Contents", "Home")));
  }
  if (process.platform === "linux") {
    const dirs = await listChildDirs("/usr/lib/jvm");
    return dirs.map((dir) => javaExec(dir));
  }
  return [];
}

async function discoverJavaCandidates() {
  const seen = new Set();
  const candidates = [];
  const add = (file) => {
    if (!file) return;
    const abs = path.resolve(file);
    const key = isWin ? abs.toLowerCase() : abs;
    if (seen.has(key)) return;
    seen.add(key);
    // 先按存在性过滤，避免为不存在的路径白等探测超时
    if (!fs.existsSync(abs)) return;
    candidates.push(abs);
  };

  const javaHome = process.env.JAVA_HOME?.trim();
  if (javaHome) add(javaExec(javaHome));
  for (const file of await pathJavaCandidates()) add(file);

  if (isWin) {
    for (const home of await registryJavaHomes()) add(javaExec(home));
    for (const file of await windowsScanCandidates()) add(file);
  } else {
    for (const file of await posixScanCandidates()) add(file);
  }

  return candidates;
}

async function probeCandidate(file) {
  const key = isWin ? path.resolve(file).toLowerCase() : path.resolve(file);
  if (probeCache.has(key)) return probeCache.get(key);
  let info = null;
  try {
    info = await javaVersionInfo(file);
  } catch {
    info = null; // 坏掉的安装只记为不可用，不影响其它候选
  }
  probeCache.set(key, info);
  return info;
}

export async function listJava() {
  const candidates = await discoverJavaCandidates();
  const results = new Array(candidates.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(PROBE_CONCURRENCY, candidates.length) }, async () => {
    while (next < candidates.length) {
      const index = next++;
      results[index] = await probeCandidate(candidates[index]);
    }
  });
  await Promise.all(runners);
  // 高版本在前，方便设置页直接展示
  return results.filter(Boolean).sort((a, b) => (b.major ?? -1) - (a.major ?? -1));
}

export async function findJava(minMajor = 8) {
  const min = Number(minMajor);
  const required = Number.isFinite(min) ? min : 8;
  const runtimes = await listJava();
  // 取“够用且最接近”的版本：Minecraft 在过新的 JDK 上常出兼容问题（如 1.20.1 用 25 会崩）
  const eligible = runtimes
    .filter((runtime) => typeof runtime.major === "number" && runtime.major >= required)
    .sort((a, b) => a.major - b.major);
  return eligible[0] ?? null;
}
