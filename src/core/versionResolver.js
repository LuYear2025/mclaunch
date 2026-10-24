import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.js";

/**
 * 读取版本 JSON 并展开 inheritsFrom 链（Fabric/Quilt/Forge 的版本 JSON 都只写增量）。
 * 合并规则：子版本覆盖父版本的同名字段，libraries 与 arguments 按顺序拼接。
 */
export function resolveVersion(versionId, seen = new Set()) {
  const file = path.join(paths.versions, versionId, `${versionId}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`版本 ${versionId} 还没安装`);
  }
  const json = JSON.parse(fs.readFileSync(file, "utf8"));

  if (!json.inheritsFrom) return json;
  if (seen.has(versionId)) throw new Error("版本继承出现了循环引用");
  seen.add(versionId);

  const parent = resolveVersion(json.inheritsFrom, seen);
  return mergeVersion(parent, json);
}

function mergeVersion(parent, child) {
  const merged = { ...parent, ...child };

  merged.id = child.id ?? parent.id;
  merged.libraries = mergeLibraries(parent.libraries, child.libraries);
  merged.arguments = mergeArguments(parent.arguments, child.arguments);

  if (!child.minecraftArguments && parent.minecraftArguments) {
    merged.minecraftArguments = parent.minecraftArguments;
  }
  delete merged.inheritsFrom;
  return merged;
}

function mergeLibraries(parentLibs = [], childLibs = []) {
  const merged = new Map();
  for (const lib of [...parentLibs, ...childLibs]) {
    const key = lib?.name || JSON.stringify(lib);
    merged.set(key, lib);
  }
  return [...merged.values()];
}

function mergeArguments(parentArgs, childArgs) {
  if (!parentArgs && !childArgs) return undefined;
  const result = {
    game: [...(parentArgs?.game || []), ...(childArgs?.game || [])],
    jvm: [...(parentArgs?.jvm || []), ...(childArgs?.jvm || [])],
  };
  if (!result.game.length) delete result.game;
  if (!result.jvm.length) delete result.jvm;
  return result;
}

/** 找出某个基础版本上已安装的 loader 版本目录（用于界面展示）。 */
export function findLoaderProfiles(mcVersion) {
  if (!fs.existsSync(paths.versions)) return [];
  return fs
    .readdirSync(paths.versions, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const file = path.join(paths.versions, d.name, `${d.name}.json`);
      if (!fs.existsSync(file)) return null;
      try {
        const json = JSON.parse(fs.readFileSync(file, "utf8"));
        return json.inheritsFrom === mcVersion ? { id: json.id || d.name, mainClass: json.mainClass } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
