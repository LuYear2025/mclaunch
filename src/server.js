import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureDirs, paths, readJson, writeJson, setDataHome, readConfiguredHome, setGameHome, readConfiguredGameHome } from "./paths.js";
import * as auth from "./core/auth.js";
import * as mojang from "./core/mojang.js";
import * as instances from "./core/instances.js";
import * as modpack from "./core/modpack.js";
import * as resources from "./core/resources.js";
import * as mods from "./core/mods.js";
import * as packExport from "./core/export.js";
import * as home from "./core/home.js";
import * as terracotta from "./core/terracotta.js";
import * as detect from "./core/detect.js";
import * as curseforge from "./core/curseforge.js";
import * as java from "./core/java.js";
import * as launch from "./core/launch.js";
import * as fabric from "./core/fabric.js";
import * as forge from "./core/forge.js";
import { resolveVersion } from "./core/versionResolver.js";
import { createRun, appendLog, finishRun, getRun, listRuns, logsAfter } from "./core/runs.js";
import { createJob, getJob } from "./core/jobs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

/** 内容类型 → 实例里的子目录 */
const CONTENT_DIRS = {
  mod: "mods",
  datapack: "datapacks",
  resourcepack: "resourcepacks",
  shader: "shaderpacks",
  world: "saves",
};

export function createApp() {
  ensureDirs();

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, version: "0.1.0", dataDir: paths.root });
  });

  app.get("/api/home", async (req, res) => {
    try {
      res.json(await home.getHome());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /* ---------- multiplayer (terracotta) ---------- */
  app.get("/api/multiplayer/status", (req, res) => {
    res.json({ installed: terracotta.isInstalled(), version: terracotta.terracottaInfo.version });
  });

  app.get("/api/multiplayer/state", async (req, res) => {
    res.json(await terracotta.getState());
  });

  app.post("/api/multiplayer/host", async (req, res) => {
    try {
      const player = String(req.body?.player || "").trim() || "玩家";
      await terracotta.createRoom(player);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/multiplayer/join", async (req, res) => {
    try {
      const room = String(req.body?.room || "").trim();
      const player = String(req.body?.player || "").trim() || "玩家";
      if (!room) throw new Error("房间码不能为空");
      await terracotta.joinRoom(room, player);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/multiplayer/reset", async (req, res) => {
    try {
      await terracotta.reset();
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/multiplayer/logs", async (req, res) => {
    res.json({ logs: await terracotta.fetchLogs() });
  });

  app.post("/api/multiplayer/stop", (req, res) => {
    terracotta.stop();
    res.json({ ok: true });
  });

  /* ---------- settings ---------- */
  app.get("/api/settings", (req, res) => {
    const saved = readJson(paths.settings, {});
    res.json({
      ...saved,
      dataDir: paths.root,
      gameDir: paths.gameHome,
      configuredDataDir: readConfiguredHome(),
      configuredGameDir: readConfiguredGameHome(),
    });
  });
  app.post("/api/settings", (req, res) => {
    const current = readJson(paths.settings, {});
    const next = { ...current, ...req.body };
    writeJson(paths.settings, next);
    res.json({
      ...next,
      dataDir: paths.root,
      gameDir: paths.gameHome,
      configuredDataDir: readConfiguredHome(),
      configuredGameDir: readConfiguredGameHome(),
    });
  });

  app.post("/api/settings/location", (req, res) => {
    try {
      const dir = String(req.body?.path || "").trim();
      if (!dir) throw new Error("路径不能为空");
      const saved = setDataHome(dir);
      res.json({ ok: true, path: saved, restartRequired: saved !== paths.root });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/settings/game-dir", (req, res) => {
    try {
      const saved = setGameHome(String(req.body?.path || ""));
      res.json({ ok: true, path: saved, restartRequired: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  /* ---------- accounts ---------- */
  app.post("/api/auth/url", (req, res) => {
    res.json({ url: auth.authEndpoints.authorize });
  });

  app.post("/api/auth/code", async (req, res) => {
    try {
      const account = await auth.loginWithCode(req.body?.code);
      auth.saveAccount(account);
      res.json(publicAccount(account));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/accounts", (req, res) => {
    res.json(auth.listAccounts().map(publicAccount));
  });

  app.post("/api/accounts/:uuid/refresh", async (req, res) => {
    try {
      const account = auth.listAccounts().find((a) => a.uuid === req.params.uuid);
      if (!account) return res.status(404).json({ error: "账号不存在" });
      const refreshed = await auth.refreshAccount(account);
      auth.saveAccount(refreshed);
      res.json(publicAccount(refreshed));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/accounts/:uuid", (req, res) => {
    auth.removeAccount(req.params.uuid);
    res.json({ ok: true });
  });

  /* ---------- versions ---------- */
  app.get("/api/versions", async (req, res) => {
    try {
      const mirror = String(req.query.mirror || "official");
      const manifest = await mojang.getManifest(mirror);
      res.json({
        latest: manifest.latest,
        versions: manifest.versions.map((v) => ({
          id: v.id,
          type: v.type,
          releaseTime: v.releaseTime,
        })),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/versions/:id/install", (req, res) => {
    const mirror = req.body?.mirror || readJson(paths.settings, {}).mirror || "official";
    const job = createJob("version", async (report) => {
      await mojang.installVersion(req.params.id, { mirror, onProgress: report });
      return { version: req.params.id };
    });
    res.json({ jobId: job.id });
  });

  /* ---------- modpacks ---------- */
  app.get("/api/modpack/search", async (req, res) => {
    try {
      const query = String(req.query.q || "");
      if (req.query.source === "curseforge") {
        const settings = readJson(paths.settings, {});
        res.json(await curseforge.curseforgeSearch(query, settings.curseForgeKey));
      } else {
        res.json(await modpack.searchModrinth(query));
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/modpack/cf/:modId/files", async (req, res) => {
    try {
      const settings = readJson(paths.settings, {});
      res.json(await curseforge.curseforgeModFiles(req.params.modId, settings.curseForgeKey));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/modpack/:slug/versions", async (req, res) => {
    try {
      res.json(await modpack.modrinthVersions(req.params.slug));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/modpack/install", async (req, res) => {
    try {
      const settings = readJson(paths.settings, {});
      const mirror = settings.mirror || "official";
      const { source = "modrinth", slug, versionId, modId, fileId, name } = req.body || {};

      let downloadUrl;
      let displayName = name;
      if (source === "curseforge") {
        downloadUrl = await curseforge.curseforgeModpackDownload(modId, fileId, settings.curseForgeKey);
        if (!displayName) {
          const files = await curseforge.curseforgeModFiles(modId, settings.curseForgeKey);
          displayName = files.find((f) => String(f.id) === String(fileId))?.name;
        }
      } else {
        const versions = await modpack.modrinthVersions(slug);
        const version = versionId
          ? versions.find((v) => v.id === versionId)
          : versions.find((v) => v.files.some((f) => f.primary)) || versions[0];
        if (!version) throw new Error("找不到对应版本");
        const file = version.files.find((f) => f.primary) || version.files[0];
        downloadUrl = file.url;
        displayName ||= version.name;
      }

      const job = createJob("modpack", async (report) => {
        report({ phase: "download", message: "下载整合包" });
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error(`下载整合包失败：HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const instance = await modpack.installModpackZip(buffer, {
          instanceName: displayName,
          mirror,
          curseForgeKey: settings.curseForgeKey,
          onProgress: report,
        });
        return { instance: stripInstance(instance) };
      });
      res.json({ jobId: job.id });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post(
    "/api/modpack/import",
    express.raw({ type: "application/octet-stream", limit: "1024mb" }),
    (req, res) => {
      const buffer = req.body;
      if (!Buffer.isBuffer(buffer) || !buffer.length) {
        return res.status(400).json({ error: "没有收到文件" });
      }
      const name = decodeURIComponent(String(req.query.name || ""));
      const settings = readJson(paths.settings, {});
      const job = createJob("modpack", async (report) => {
        const instance = await modpack.installModpackZip(buffer, {
          instanceName: name,
          mirror: settings.mirror || "official",
          curseForgeKey: settings.curseForgeKey,
          onProgress: report,
        });
        return { instance: stripInstance(instance) };
      });
      res.json({ jobId: job.id });
    }
  );

  /* ---------- instances ---------- */
  app.get("/api/instances", (req, res) => {
    res.json(instances.listInstances().map(stripInstance));
  });

  app.post("/api/instances", (req, res) => {
    try {
      const { name, mcVersion, loader } = req.body || {};
      const instance = instances.createInstance({ name, mcVersion, loader });
      res.json(stripInstance(instance));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.patch("/api/instances/:id", (req, res) => {
    try {
      res.json(stripInstance(instances.updateInstance(req.params.id, req.body || {})));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/instances/:id", (req, res) => {
    try {
      instances.deleteInstance(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  /* ---------- launch ---------- */
  app.get("/api/java", async (req, res) => {
    try {
      res.json(await java.listJava());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/instances/:id/launch", async (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      const settings = readJson(paths.settings, {});

      if (!instance.mcVersion) throw new Error("实例没有绑定游戏版本");
      const launchVersionId = instance.profileId || instance.mcVersion;
      const versionJsonPath = path.join(paths.versions, launchVersionId, `${launchVersionId}.json`);
      if (!fs.existsSync(versionJsonPath)) throw new Error("这个实例的游戏版本还没下载，先去「版本」页装一下");
      const versionJson = resolveVersion(launchVersionId);
      const baseJar = path.join(paths.versions, instance.mcVersion, `${instance.mcVersion}.jar`);

      const accounts = auth.listAccounts();
      const account =
        accounts.find((a) => a.uuid === req.body?.accountUuid) || accounts[0];
      if (!account) throw new Error("先登录一个正版账号");

      let javaPath = req.body?.javaPath || instance.javaPath || settings.javaPath;
      const required = java.requiredJavaMajor(versionJson);
      if (!javaPath) {
        const found = await java.findJava(required);
        if (!found) throw new Error(`没找到 Java ${required}+，去设置里手动指定 java.exe`);
        javaPath = found.path;
      }

      const run = createRun(instance.id);
      const memoryMb = Number(req.body?.memoryMb || settings.memoryMb || 2048);
      const nativesDir = path.join(instances.instanceDir(instance.id), "natives");

      const { child } = launch.launchGame(
        {
          versionJson,
          versionDir: path.dirname(versionJsonPath),
          clientJarPath: fs.existsSync(baseJar) ? baseJar : undefined,
          librariesDir: paths.libraries,
          assetsDir: paths.assets,
          nativesDir,
          javaPath,
          memoryMb,
          gameDir: instances.instanceDir(instance.id),
          account: { name: account.name, uuid: account.uuid, accessToken: account.accessToken },
          extraJvmArgs: Array.isArray(req.body?.extraJvmArgs) ? req.body.extraJvmArgs : [],
        },
        {
          onLog: (text, stream) => appendLog(run.id, text, stream),
          onExit: (code, signal) => finishRun(run.id, code, signal),
        }
      );

      run.pid = child.pid;
      run.status = "running";
      run.child = child;
      instances.updateInstance(instance.id, { launchCount: (instance.launchCount || 0) + 1 });
      res.json({ runId: run.id, pid: child.pid });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/runs/:id/stop", (req, res) => {
    const run = getRun(req.params.id);
    if (!run) return res.status(404).json({ error: "进程不存在" });
    try {
      run.child?.kill();
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/runs/:id/log", (req, res) => {
    const data = logsAfter(req.params.id, Number(req.query.after || 0));
    if (!data) return res.status(404).json({ error: "进程不存在" });
    res.json(data);
  });

  app.get("/api/runs", (req, res) => {
    res.json(listRuns(String(req.query.instanceId || "") || undefined));
  });

  /* ---------- resources (mods / resourcepacks / shaders / datapacks / worlds) ---------- */
  app.get("/api/resources/search", async (req, res) => {
    try {
      const { type = "mod", q = "", source = "modrinth", mc, loader } = req.query;
      const settings = readJson(paths.settings, {});
      const options = { gameVersion: mc || undefined, loader: loader || undefined };
      const list =
        source === "curseforge"
          ? await resources.searchCurseForge(type, q, settings.curseForgeKey, options)
          : await resources.searchModrinth(type, q, options);
      res.json(list);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/resources/versions", async (req, res) => {
    try {
      const { source = "modrinth", slug, modId, mc, loader } = req.query;
      const settings = readJson(paths.settings, {});
      const list =
        source === "curseforge"
          ? await resources.curseForgeResourceFiles(modId, settings.curseForgeKey, { gameVersion: mc })
          : await resources.modrinthResourceVersions(slug, { gameVersion: mc, loader });
      res.json(list);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/resources/install", async (req, res) => {
    try {
      const { type, instanceId, source = "modrinth", slug, versionId, modId, fileId } = req.body || {};
      const settings = readJson(paths.settings, {});
      const instance = instances.getInstance(instanceId);
      if (!instance) throw new Error("先选一个实例");

      const job = createJob("resource", async (report) => {
        const items = await resources.resolveInstallItems({
          type,
          source,
          slug,
          versionId,
          modId,
          fileId,
          key: settings.curseForgeKey,
          gameVersion: instance.mcVersion,
          loader: instance.loader,
          onProgress: report,
        });

        let done = 0;
        for (const item of items) {
          report({ phase: "download", done, total: items.length, file: item.label });
          await resources.installResource({
            type,
            instanceId: instance.id,
            url: item.url,
            filename: item.filename,
            label: item.label,
          });
          if (type === "mod" && item.projectId) {
            mods.recordMod(instance.dir, item.filename, {
              source: "modrinth",
              projectId: item.projectId,
              versionId: item.versionId,
              versionNumber: item.versionNumber,
              fileName: item.filename,
              gameVersions: [instance.mcVersion],
              loaders: [instance.loader],
            });
          }
          done += 1;
        }
        report({ phase: "done", done: items.length, total: items.length });
        return { count: items.length, files: items.map((i) => i.filename) };
      });
      res.json({ jobId: job.id });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  /* ---------- instance maintenance ---------- */
  app.post("/api/instances/:id/open", (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      const target = String(req.body?.target || "dir");
      const subdirs = {
        dir: "",
        saves: "saves",
        mods: "mods",
        resourcepacks: "resourcepacks",
        shaderpacks: "shaderpacks",
        datapacks: "datapacks",
        logs: "logs",
        config: "config",
      };
      if (!(target in subdirs)) throw new Error("不支持这个目录");
      const dir = path.join(instance.dir, subdirs[target]);
      fs.mkdirSync(dir, { recursive: true });
      openInExplorer(dir);
      res.json({ ok: true, path: dir });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/instances/:id/repair", (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      const settings = readJson(paths.settings, {});
      const mirror = settings.mirror || "official";
      const job = createJob("repair", async (report) => {
        await mojang.installVersion(instance.mcVersion, { mirror, onProgress: report });
        if (instance.profileId) report({ phase: "done", message: "基础文件已校验" });
        return {};
      });
      res.json({ jobId: job.id });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/instances/:id/export", async (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      const launchVersionId = instance.profileId || instance.mcVersion;
      const versionJson = resolveVersion(launchVersionId);
      const accounts = auth.listAccounts();
      const account = accounts.find((a) => a.uuid === req.body?.accountUuid) || accounts[0];
      const settings = readJson(paths.settings, {});
      const found = await java.findJava(java.requiredJavaMajor(versionJson));
      const javaPath = settings.javaPath || found?.path;
      if (!javaPath) throw new Error("没找到 Java，先在设置里指定");

      const baseJar = path.join(paths.versions, instance.mcVersion, `${instance.mcVersion}.jar`);
      const { command } = launch.buildLaunchCommand({
        versionJson,
        versionDir: path.join(paths.versions, launchVersionId),
        clientJarPath: fs.existsSync(baseJar) ? baseJar : undefined,
        librariesDir: paths.libraries,
        assetsDir: paths.assets,
        nativesDir: path.join(instance.dir, "natives"),
        javaPath,
        memoryMb: settings.memoryMb || 2048,
        gameDir: instance.dir,
        account: account
          ? { name: account.name, uuid: account.uuid, accessToken: account.accessToken }
          : { name: "Player", uuid: "00000000-0000-0000-0000-000000000000", accessToken: "" },
      });

      const bat = `@echo off\r\ncd /d "%~dp0"\r\n${command}\r\npause\r\n`;
      const file = path.join(instance.dir, "launch.bat");
      fs.writeFileSync(file, bat, "utf8");
      res.json({ ok: true, path: file });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/instances/:id/reset", (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      // 只清游戏数据，保留 instance.json 与下载好的版本
      for (const sub of ["mods", "config", "saves", "logs", "resourcepacks", "shaderpacks", "datapacks", "natives", "crash-reports"]) {
        fs.rmSync(path.join(instance.dir, sub), { recursive: true, force: true });
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  /* ---------- instance content ---------- */
  app.get("/api/instances/:id/content", (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      const type = String(req.query.type || "mod");
      const sub = CONTENT_DIRS[type];
      if (!sub) throw new Error("不支持的内容类型");
      const dir = path.join(instance.dir, sub);
      const items = fs.existsSync(dir)
        ? fs
            .readdirSync(dir, { withFileTypes: true })
            .map((entry) => {
              const full = path.join(dir, entry.name);
              let size = 0;
              let mtime = 0;
              try {
                const stat = fs.statSync(full);
                size = stat.size;
                mtime = stat.mtimeMs;
              } catch {
                /* ignore */
              }
              return { name: entry.name, isDir: entry.isDirectory(), size, mtime };
            })
            .filter((item) => (type === "world" ? item.isDir : !item.isDir))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [];
      res.json(items);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/instances/:id/content", (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      const { type, name } = req.body || {};
      const sub = CONTENT_DIRS[type];
      if (!sub) throw new Error("不支持的内容类型");
      if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
        throw new Error("文件名不合法");
      }
      const target = path.join(instance.dir, sub, name);
      const root = path.resolve(path.join(instance.dir, sub));
      if (!path.resolve(target).startsWith(root + path.sep)) throw new Error("越界路径");
      fs.rmSync(target, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post(
    "/api/instances/:id/content/import",
    express.raw({ type: "application/octet-stream", limit: "1024mb" }),
    (req, res) => {
      try {
        const instance = instances.getInstance(req.params.id);
        if (!instance) throw new Error("实例不存在");
        const type = String(req.query.type || "mod");
        const name = decodeURIComponent(String(req.query.name || "file.bin"));
        const buffer = req.body;
        if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("没有收到文件");
        const job = createJob("import", async (report) =>
          resources.installLocalContent({
            type,
            instanceId: instance.id,
            buffer,
            filename: name,
            onProgress: report,
          })
        );
        res.json({ jobId: job.id });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    }
  );

  /* ---------- mod updates ---------- */
  app.post("/api/instances/:id/mods/scan", (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      const job = createJob("scan", async (report) =>
        mods.identifyByHash(instance.dir, { gameVersion: instance.mcVersion, loader: instance.loader, onProgress: report })
      );
      res.json({ jobId: job.id });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/instances/:id/mods/check", (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      const job = createJob("check", async (report) => {
        const options = { gameVersion: instance.mcVersion, loader: instance.loader, onProgress: report };
        await mods.identifyByHash(instance.dir, options);
        const updates = await mods.checkUpdates(instance.dir, options);
        return { updates };
      });
      res.json({ jobId: job.id });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/instances/:id/mods/update", (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
      if (!updates.length) throw new Error("没有要更新的模组");
      const job = createJob("update", async (report) => {
        let done = 0;
        for (const update of updates) {
          report({ phase: "download", done, total: updates.length, file: update.newFileName });
          await mods.applyUpdate(instance.dir, update);
          done += 1;
        }
        report({ phase: "done", done: updates.length, total: updates.length });
        return { count: updates.length };
      });
      res.json({ jobId: job.id });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  /* ---------- export as modpack ---------- */
  app.get("/api/instances/:id/export/options", (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      res.json({
        name: instance.name,
        version: "1.0.0",
        mcVersion: instance.mcVersion,
        loader: instance.loader,
        loaderVersion: instance.loaderVersion,
        groups: packExport.listExportable(instance.dir),
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/instances/:id/export/mrpack", (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      const { name, version, include } = req.body || {};
      const job = createJob("export", async (report) => {
        report({ phase: "pack", message: "打包中" });
        const result = packExport.exportMrpack(instance, {
          name,
          version,
          include: Array.isArray(include) ? include : [],
          outputDir: path.join(instance.dir, "exports"),
        });
        report({ phase: "done" });
        return result;
      });
      res.json({ jobId: job.id });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/instances/:id/export/download", (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      const file = String(req.query.file || "");
      const base = path.resolve(path.join(instance.dir, "exports"));
      const target = path.resolve(path.join(base, file));
      if (!target.startsWith(base + path.sep)) throw new Error("路径不合法");
      if (!fs.existsSync(target)) throw new Error("文件不存在");
      res.download(target);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  /* ---------- detect existing launchers ---------- */
  app.get("/api/detect/game-dirs", (req, res) => {
    try {
      const extra = String(req.query.path || "")
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      res.json(detect.scanGameDirs(extra));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/instances/import-external", (req, res) => {
    try {
      const { dir, versionId, name } = req.body || {};
      if (!dir || !versionId) throw new Error("缺少目录或版本");
      const base = path.resolve(dir);
      const versionDir = path.join(base, "versions", versionId);
      const versionJson = path.join(versionDir, `${versionId}.json`);
      if (!fs.existsSync(versionJson)) throw new Error("这个目录里找不到该版本");

      const instance = instances.createInstance({
        name: name || `导入 ${versionId}`,
        mcVersion: versionId,
        loader: "vanilla",
        modpack: null,
      });

      // 隔离实例直接拷版本目录里的 mods/config；否则拷 .minecraft 下的
      const sources = fs.existsSync(path.join(versionDir, "mods"))
        ? [versionDir]
        : [base];
      let copied = 0;
      for (const source of sources) {
        for (const sub of ["mods", "config", "resourcepacks", "shaderpacks"]) {
          const from = path.join(source, sub);
          if (!fs.existsSync(from)) continue;
          const to = path.join(instance.dir, sub);
          fs.mkdirSync(to, { recursive: true });
          for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
            copied += 1;
          }
        }
      }

      instances.updateInstance(instance.id, { installed: true, importedFrom: dir });
      res.json({ instance: stripInstance(instances.getInstance(instance.id)), copied });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  /* ---------- loaders ---------- */
  app.get("/api/loaders/:kind", async (req, res) => {
    try {
      const kind = req.params.kind;
      const mc = String(req.query.mc || "");
      if (!mc) throw new Error("缺少游戏版本");
      let list = [];
      if (kind === "fabric") list = await fabric.listFabricLoaders(mc);
      else if (kind === "quilt") list = await fabric.listQuiltLoaders(mc);
      else if (kind === "forge") {
        // Forge 从 1.21.1 起不再跟随新版本，1.21.1 及以后的版本只提供 NeoForge
        if (versionAtLeast(mc, "1.21.1")) {
          return res.json({ unsupported: true, message: "1.21.1 之后没有 Forge，请改用 NeoForge" });
        }
        list = await forge.listForgeVersions(mc);
      } else if (kind === "neoforge") {
        list = await forge.listNeoForgeVersions(mc);
      }
      res.json(list);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/instances/:id/loader", (req, res) => {
    try {
      const instance = instances.getInstance(req.params.id);
      if (!instance) throw new Error("实例不存在");
      const { kind, version } = req.body || {};
      if (!kind || !version) throw new Error("缺少 loader 类型或版本");
      const settings = readJson(paths.settings, {});
      const mirror = settings.mirror || "official";

      const job = createJob("loader", async (report) => {
        let result;
        if (kind === "fabric") {
          result = await fabric.installFabric(instance.mcVersion, version, { mirror, onProgress: report });
        } else if (kind === "quilt") {
          result = await fabric.installQuilt(instance.mcVersion, version, { mirror, onProgress: report });
        } else if (kind === "forge") {
          const found = await java.findJava(17);
          result = await forge.installForge(instance.mcVersion, version, {
            javaPath: settings.javaPath || found?.path,
            onProgress: report,
          });
        } else if (kind === "neoforge") {
          const found = await java.findJava(17);
          result = await forge.installNeoForge(instance.mcVersion, version, {
            javaPath: settings.javaPath || found?.path,
            onProgress: report,
          });
        } else {
          throw new Error(`不支持的 loader：${kind}`);
        }
        const updated = instances.updateInstance(instance.id, {
          loader: kind,
          loaderVersion: version,
          profileId: result.profileId,
        });
        return { instance: stripInstance(updated), profileId: result.profileId };
      });
      res.json({ jobId: job.id });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  /* ---------- jobs ---------- */
  app.get("/api/jobs/:id", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在" });
    res.json(job);
  });

  /* ---------- static ---------- */
  app.use(express.static(publicDir));
  app.get("*", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

  return app;
}

function publicAccount(account) {
  return {
    uuid: account.uuid,
    name: account.name,
    createdAt: account.createdAt,
    skins: account.skins,
  };
}

function stripInstance(instance) {
  const { dir, ...rest } = instance;
  return rest;
}

function openInExplorer(dir) {  const command =
    process.platform === "win32" ? ["explorer", [dir]] : process.platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]];
  try {
    spawn(command[0], command[1], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // 打不开就算了，前端会显示路径
  }
}

/** 比较 a、b 两个点分版本号，a >= b 时返回 true。 */function versionAtLeast(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10));
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10));
  if (pa.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}
