import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { paths } from "../paths.js";

const VERSION = "0.4.2";
const CLASSIFIER = "windows-x86_64";
const PACKAGE = `terracotta-${VERSION}-${CLASSIFIER}-pkg.tar.gz`;
const DOWNLOADS = [
  `https://cnb.cool/HMCL-Terracotta/Terracotta/-/releases/download/v${VERSION}/${PACKAGE}`,
  `https://gitee.com/burningtnt/Terracotta/releases/download/v${VERSION}/${PACKAGE}`,
  `https://github.com/burningtnt/Terracotta/releases/download/v${VERSION}/${PACKAGE}`,
];
const NODE_LIST = "https://terracotta.glavo.site/nodes";
const USER_AGENT = "mclaunch/0.1.0 (github.com/LuYear2025)";

const installDir = path.join(paths.cache, "terracotta", VERSION);
const exePath = path.join(installDir, `terracotta-${VERSION}-${CLASSIFIER}.exe`);

let child = null;
let port = null;
let portFile = null;
let starting = null;

function untar(buffer) {
  const files = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const name = buffer.toString("utf8", offset, offset + 100).replace(/\0.*$/, "").trim();
    if (!name) break;
    const size = Number.parseInt(buffer.toString("utf8", offset + 124, offset + 136).replace(/\0.*$/, "").trim() || "0", 8) || 0;
    const type = String.fromCharCode(buffer[offset + 156]);
    const start = offset + 512;
    if (type === "0" || type === "\0" || type === "5" || type === "") {
      files.push({ name, data: buffer.subarray(start, start + size) });
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  return buffer.length;
}

export function isInstalled() {
  return fs.existsSync(exePath);
}

export async function ensureInstalled(onProgress = () => {}) {
  if (isInstalled()) return exePath;
  fs.mkdirSync(installDir, { recursive: true });

  let lastError;
  for (const url of DOWNLOADS) {
    try {
      onProgress({ phase: "download", message: `下载陶瓦联机 ${VERSION}` });
      const tmp = path.join(installDir, PACKAGE);
      await download(url, tmp);
      onProgress({ phase: "extract", message: "解压中" });
      const gz = zlib.gunzipSync(fs.readFileSync(tmp));
      for (const file of untar(gz)) {
        const base = path.basename(file.name);
        if (!base) continue;
        fs.writeFileSync(path.join(installDir, base), file.data);
      }
      fs.rmSync(tmp, { force: true });
      if (!isInstalled()) throw new Error("压缩包里没找到可执行文件");
      return exePath;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`陶瓦联机下载失败：${lastError?.message || "未知错误"}`);
}

export async function fetchNodes() {
  try {
    const res = await fetch(NODE_LIST, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return [];
    const list = await res.json();
    return (list || []).map((n) => n?.url).filter(Boolean);
  } catch {
    return [];
  }
}

async function startProcess() {
  if (child && !child.killed && port) return port;
  if (starting) return starting;

  starting = (async () => {
    await ensureInstalled();
    fs.mkdirSync(installDir, { recursive: true });
    portFile = path.join(installDir, "http");
    fs.rmSync(portFile, { force: true });

    child = spawn(exePath, ["--hmcl", portFile], {
      cwd: installDir,
      windowsHide: true,
      stdio: "ignore",
    });
    if (child.pid) {
      try {
        fs.writeFileSync(path.join(installDir, "pid.txt"), String(child.pid), "utf8");
      } catch {
        // ignore
      }
    }
    child.on("exit", () => {
      child = null;
      port = null;
    });

    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(portFile)) {
        try {
          const json = JSON.parse(fs.readFileSync(portFile, "utf8"));
          if (json?.port) {
            port = Number(json.port);
            return port;
          }
        } catch {
          // 文件还没写完
        }
      }
      if (!child) throw new Error("陶瓦联机进程启动失败");
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("等待陶瓦联机启动超时");
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

async function api(pathname) {
  const p = await startProcess();
  const res = await fetch(`http://127.0.0.1:${p}${pathname}`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`陶瓦联机返回 HTTP ${res.status}`);
  return res;
}

export async function getState() {
  try {
    const res = await api("/state");
    const data = await res.json();
    return { ...data, port };
  } catch (error) {
    return { state: "error", message: error.message };
  }
}

export async function createRoom(player) {
  const nodes = await fetchNodes();
  const qs = new URLSearchParams();
  qs.set("player", player || "玩家");
  for (const node of nodes) qs.append("public_nodes", node);
  const res = await api(`/state/scanning?${qs.toString()}`);
  return res.status;
}

export async function joinRoom(room, player) {
  const nodes = await fetchNodes();
  const qs = new URLSearchParams();
  qs.set("room", String(room).trim());
  qs.set("player", player || "玩家");
  for (const node of nodes) qs.append("public_nodes", node);
  const res = await api(`/state/guesting?${qs.toString()}`);
  return res.status;
}

export async function reset() {
  try {
    const res = await api("/state/ide");
    return res.status;
  } catch {
    return 200;
  }
}

export async function fetchLogs() {
  try {
    const res = await api("/log?fetch=true");
    return (await res.text()).slice(-20000);
  } catch {
    return "";
  }
}

export function stop() {
  const pidFile = path.join(installDir, "pid.txt");
  const pids = new Set();

  if (child?.pid) pids.add(child.pid);
  try {
    const saved = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (saved) pids.add(saved);
  } catch {
    // 没有记录
  }

  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // ignore
    }
  }

  // 兜底：按镜像名收掉（这个镜像只由本启动器拉起，pid 记录可能在异常退出时丢失）
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/IM", `terracotta-${VERSION}-${CLASSIFIER}.exe`, "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      // ignore
    }
  }

  child = null;
  port = null;
  fs.rmSync(pidFile, { force: true });
}

export const terracottaInfo = { version: VERSION, exePath };
