#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createApp } from "../src/server.js";
import { stop as stopTerracotta } from "../src/core/terracotta.js";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.PORT || 27140);
const noOpen = args.includes("--no-open");

const app = createApp();
const server = app.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`mclaunch 已启动：${url}`);
  console.log("按 Ctrl+C 或关掉这个窗口即可停止");
  if (!noOpen) openBrowser(url);
});

// 退出时把连带启动的子进程（陶瓦联机）一起收掉
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    stopTerracotta();
  } catch {
    // ignore
  }
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

server.on("error", (error) => {
  console.error(`启动失败：${error.message}`);
  process.exit(1);
});

function openBrowser(url) {
  const platform = process.platform;
  const child =
    platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
      : platform === "darwin"
        ? spawn("open", [url], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
