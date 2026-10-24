import fs from "node:fs";
import path from "node:path";
import { createZip } from "./zip.js";

/** 可导出的内容分类 → 实例里的路径 */
const GROUPS = {
  mods: { label: "模组", paths: ["mods"] },
  resourcepacks: { label: "资源包", paths: ["resourcepacks"] },
  shaderpacks: { label: "光影包", paths: ["shaderpacks"] },
  datapacks: { label: "数据包", paths: ["datapacks"] },
  config: { label: "配置", paths: ["config"] },
  saves: { label: "单人存档", paths: ["saves"] },
  options: { label: "游戏设置", paths: ["options.txt", "optionsof.txt", "servers.dat", "usercache.json"] },
};

function walk(root, relative = "") {
  const dir = path.join(root, relative);
  if (!fs.existsSync(dir)) return [];
  const stat = fs.statSync(dir);
  if (stat.isFile()) return [{ rel: relative, abs: dir, size: stat.size }];

  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...walk(root, next));
    else {
      const abs = path.join(root, next);
      files.push({ rel: next, abs, size: fs.statSync(abs).size });
    }
  }
  return files;
}

/** 列出实例里每种可导出内容的文件与体积，用于前端勾选。 */
export function listExportable(instanceDir) {
  return Object.entries(GROUPS).map(([key, group]) => {
    const files = group.paths.flatMap((p) => walk(instanceDir, p));
    return {
      key,
      label: group.label,
      count: files.length,
      size: files.reduce((sum, f) => sum + f.size, 0),
      files: files.map((f) => f.rel.replace(/\\/g, "/")),
    };
  });
}

/**
 * 把实例打包成 .mrpack（Modrinth 格式）。
 * include 里选中的分类放进 overrides/。
 */
export function exportMrpack(instance, { name, version, include = [], outputDir } = {}) {
  const instanceDir = instance.dir;
  const selected = new Set(include.length ? include : Object.keys(GROUPS));

  const entries = [];
  const indexFiles = [];

  for (const [key, group] of Object.entries(GROUPS)) {
    if (!selected.has(key)) continue;
    for (const rel of group.paths) {
      for (const file of walk(instanceDir, rel)) {
        const relPosix = file.rel.replace(/\\/g, "/");
        entries.push({ name: `overrides/${relPosix}`, data: fs.readFileSync(file.abs) });
      }
    }
  }

  const dependencies = { minecraft: instance.mcVersion };
  if (instance.loader === "fabric" && instance.loaderVersion) dependencies["fabric-loader"] = instance.loaderVersion;
  else if (instance.loader === "quilt" && instance.loaderVersion) dependencies["quilt-loader"] = instance.loaderVersion;
  else if (instance.loader === "forge" && instance.loaderVersion) dependencies.forge = instance.loaderVersion;
  else if (instance.loader === "neoforge" && instance.loaderVersion) dependencies.neoforge = instance.loaderVersion;

  const index = {
    formatVersion: 1,
    game: "minecraft",
    versionId: version || "1.0.0",
    name: name || instance.name,
    summary: instance.description || "",
    files: indexFiles,
    dependencies,
  };

  entries.unshift({
    name: "modrinth.index.json",
    data: Buffer.from(JSON.stringify(index, null, 2), "utf8"),
  });

  const zip = createZip(entries);
  fs.mkdirSync(outputDir, { recursive: true });
  const safeName = String(name || instance.name).replace(/[\\/:*?"<>|]/g, "_");
  const outPath = path.join(outputDir, `${safeName}-${version || "1.0.0"}.mrpack`);
  fs.writeFileSync(outPath, zip);
  return { path: outPath, size: zip.length, files: entries.length };
}
