import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { paths, readJson, writeJson } from "../paths.js";

function safeName(name) {
  const cleaned = String(name || "").replace(/[\\/:*?"<>|]/g, "").trim();
  if (!cleaned) throw new Error("实例名不能为空");
  return cleaned;
}

export function listInstances() {
  if (!fs.existsSync(paths.instances)) return [];
  return fs
    .readdirSync(paths.instances, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const meta = readJson(path.join(paths.instances, d.name, "instance.json"), null);
      return meta ? { ...meta, dir: path.join(paths.instances, d.name) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function getInstance(id) {
  return listInstances().find((i) => i.id === id) || null;
}

export function createInstance({ name, mcVersion, loader = "vanilla", modpack = null }) {
  const id = crypto.randomUUID();
  const dir = path.join(paths.instances, id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    id,
    name: safeName(name),
    mcVersion,
    loader,
    modpack,
    createdAt: Date.now(),
  };
  writeJson(path.join(dir, "instance.json"), meta);
  return { ...meta, dir };
}

export function updateInstance(id, patch) {
  const instance = getInstance(id);
  if (!instance) throw new Error("实例不存在");
  const next = { ...instance, ...patch, id: instance.id };
  delete next.dir;
  writeJson(path.join(instance.dir, "instance.json"), next);
  return { ...next, dir: instance.dir };
}

export function deleteInstance(id) {
  const instance = getInstance(id);
  if (!instance) throw new Error("实例不存在");
  fs.rmSync(instance.dir, { recursive: true, force: true });
}

export function instanceDir(id) {
  const instance = getInstance(id);
  if (!instance) throw new Error("实例不存在");
  return instance.dir;
}

export function modsDir(id) {
  const dir = path.join(instanceDir(id), "mods");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
