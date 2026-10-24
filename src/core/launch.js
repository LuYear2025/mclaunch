import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const LAUNCHER_NAME = "mclaunch";
const LAUNCHER_VERSION = "0.1.0";
const DEFAULT_MEMORY_MB = 2048;

const osName = { win32: "windows", darwin: "osx", linux: "linux" }[process.platform] || process.platform;
const osArch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "arm64" : process.arch;
const classpathSeparator = process.platform === "win32" ? ";" : ":";

const NATIVE_SUFFIX = { windows: "-natives-windows", osx: "-natives-macos", linux: "-natives-linux" };
const NATIVE_EXTENSIONS = [".dll", ".so", ".dylib", ".jnilib"];

/* ---- rules（与 mojang.js 保持同一套语义：规则非空时默认拒绝，只有 allow 命中才通过） ---- */

function ruleMatches(rule, features) {
  if (!rule || typeof rule !== "object") return false;
  if (rule.os) {
    if (rule.os.name && rule.os.name !== osName) return false;
    if (rule.os.arch && rule.os.arch !== osArch && !(rule.os.arch === "x86" && process.arch === "ia32")) return false;
  }
  if (rule.features) {
    for (const [key, expected] of Object.entries(rule.features)) {
      if (Boolean(features?.[key]) !== Boolean(expected)) return false;
    }
  }
  return true;
}

function ruleAllowed(rules, features) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let result = false;
  for (const rule of rules) {
    if (!ruleMatches(rule, features)) continue;
    result = rule.action === "allow";
  }
  return result;
}

/* ---- library / natives 解析 ---- */

function mavenPathFromName(name, classifier) {
  if (!name) return null;
  const [group, artifact, version, extra] = String(name).split(":");
  if (!group || !artifact || !version) return null;
  const suffix = classifier || extra;
  const file = suffix ? `${artifact}-${version}-${suffix}.jar` : `${artifact}-${version}.jar`;
  return `${group.replace(/\./g, "/")}/${artifact}/${version}/${file}`;
}

function artifactPath(lib) {
  const fromDownloads = lib.downloads?.artifact?.path;
  if (fromDownloads) return fromDownloads;
  return mavenPathFromName(lib.name);
}

function nativeClassifier(lib) {
  const key = osName === "osx" ? "natives-osx" : `natives-${osName}`;
  return lib.natives?.[osName]?.replace("${arch}", process.arch === "x64" ? "64" : "32") ?? lib.natives?.[key];
}

/**
 * 识别新版 JSON 里独立拆出的 natives artifact（...-natives-windows.jar）。
 * 返回 "generic"（通用包）/ "arch"（架构专用包），非 natives 包返回 null。
 * 所有 natives 包都不进 classpath，只有通用包和与当前架构匹配的专用包才需要解压。
 */
function nativesJarKind(rel) {
  if (!rel || !rel.endsWith(".jar")) return null;
  const base = rel.slice(0, -4);
  const systemSuffix = NATIVE_SUFFIX[osName];
  if (!systemSuffix) return null;

  const index = base.lastIndexOf(systemSuffix);
  if (index < 0) return null;

  const tail = base.slice(index + systemSuffix.length);
  if (tail === "") return "generic";
  if (tail === "-arm64" || tail === "-x86" || tail === "-x86_64" || tail === "-x86_32") return "arch";
  return null;
}

function archMatchesNativesName(rel) {
  if (process.arch === "arm64") return rel.includes("-arm64");
  if (process.arch === "ia32") return rel.includes("-x86");
  return false;
}

function resolveLibraries(versionJson, librariesDir, features) {
  const classpath = [];
  const natives = new Set();

  for (const lib of versionJson.libraries || []) {
    if (!ruleAllowed(lib.rules, features)) continue;

    const rel = artifactPath(lib);
    const classifier = nativeClassifier(lib);
    // 旧式 natives：新版 JSON 放在 downloads.classifiers，更早的清单放在 lib.classifiers
    const legacyNative =
      lib.natives && classifier ? lib.downloads?.classifiers?.[classifier] ?? lib.classifiers?.[classifier] : null;

    if (legacyNative) {
      // classifier 包只用于解压；只有显式声明 artifact 的库才进 classpath
      const nativeRel = legacyNative.path || mavenPathFromName(lib.name, classifier);
      if (nativeRel) natives.add(path.join(librariesDir, nativeRel));
      const mainArtifact = lib.downloads?.artifact?.path;
      if (mainArtifact) classpath.push(path.join(librariesDir, mainArtifact));
      continue;
    }

    if (!rel) continue;
    const nativesKind = nativesJarKind(rel);
    if (nativesKind) {
      // 架构专用包仅在架构匹配时解压（x64 只用通用包），但两者都不进 classpath
      if (nativesKind === "generic" || archMatchesNativesName(rel)) {
        natives.add(path.join(librariesDir, rel));
      }
      continue;
    }
    classpath.push(path.join(librariesDir, rel));
  }

  return { classpath, natives: [...natives] };
}

/* ---- ZIP 读取：EOCD → 中央目录 → 本地文件头 ---- */

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  let loose = -1;
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(i + 20);
    if (i + 22 + commentLength === buffer.length) return i;
    if (loose < 0) loose = i;
  }
  return loose;
}

function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("jar 不是有效的 ZIP 文件");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  // ZIP64 的 natives 包可忽略，标准版客户端不包含
  if (offset === 0xffffffff || count === 0xffff) throw new Error("暂不支持 ZIP64 格式的 jar");

  const entries = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    // 名称在 flags & 0x800 时是 UTF-8，否则为 CP437；natives 里基本都是 ASCII
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (!name || name.endsWith("/")) continue;
    if (name.startsWith("META-INF/") || name.includes("/META-INF/")) continue;
    if (flags & 0x1) continue; // 加密条目跳过

    entries.push({ name, method, compressedSize, localOffset });
  }
  return entries;
}

function readZipEntryData(buffer, entry) {
  const header = entry.localOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== 0x04034b50) return null;

  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start > buffer.length) return null;
  const raw = buffer.subarray(start, Math.min(end, buffer.length));

  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(raw);
    } catch {
      return null;
    }
  }
  return null; // bzip2 / lzma 等压缩方式不支持
}

function extractNatives(nativesDir, jarFiles) {
  fs.mkdirSync(nativesDir, { recursive: true });
  const extracted = [];

  for (const jarFile of jarFiles) {
    let buffer;
    try {
      buffer = fs.readFileSync(jarFile);
    } catch {
      continue; // 本地库缺失时跳过，交由 Java 启动阶段报错
    }

    let entries;
    try {
      entries = readZipEntries(buffer);
    } catch (error) {
      throw new Error(`读取本地库失败（${path.basename(jarFile)}）：${error.message}`);
    }

    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (!NATIVE_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;

      const data = readZipEntryData(buffer, entry);
      if (!data || data.length === 0) continue;

      // 只取文件名，天然阻止 ../ 路径穿越
      const fileName = path.basename(entry.name.replace(/\\/g, "/"));
      if (!fileName) continue;

      const target = path.join(nativesDir, fileName);
      fs.writeFileSync(target, data);
      extracted.push(target);
    }
  }

  return extracted;
}

/* ---- 占位符替换 ---- */

const PLACEHOLDER = /\$\{([^}]+)\}/g;

function substitute(value, variables) {
  if (typeof value !== "string") return value;
  return value.replace(PLACEHOLDER, (match, key) =>
    typeof variables[key] === "string" ? variables[key] : match,
  );
}

function hasPlaceholder(value) {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(value);
}

/** 展开 arguments.jvm / arguments.game：字符串直接替换，对象先过 rules 再展开 value 数组 */
function expandVersionArguments(list, variables, features) {
  const output = [];

  for (const entry of list || []) {
    if (typeof entry === "string") {
      const value = substitute(entry, variables);
      if (!hasPlaceholder(value)) output.push(value);
      continue;
    }

    if (!entry || typeof entry !== "object") continue;
    if (!ruleAllowed(entry.rules, features)) continue;

    const values = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const item of values) {
      const value = substitute(item, variables);
      if (typeof value === "string" && value.length > 0 && !hasPlaceholder(value)) output.push(value);
    }
  }

  return output;
}

function quoteForDisplay(value) {
  const text = String(value);
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

/* ---- 启动命令构建 ---- */

/**
 * 把已安装的版本 JSON 转成可执行的 Java 命令。
 * 除了解压 natives 到 nativesDir 之外没有副作用。
 */
export function buildLaunchCommand({
  versionJson,
  versionDir,
  librariesDir,
  assetsDir,
  nativesDir,
  javaPath,
  memoryMb = DEFAULT_MEMORY_MB,
  account,
  gameDir,
  extraJvmArgs,
  extraGameArgs,
  width,
  height,
  clientJarPath,
} = {}) {
  if (!versionJson || typeof versionJson !== "object") throw new Error("缺少版本 JSON，无法启动");
  if (versionJson.inheritsFrom) throw new Error("暂不支持继承版本（loader 版本），二期再补");
  if (!versionJson.mainClass) throw new Error("版本 JSON 缺少 mainClass，无法启动");
  if (!javaPath) throw new Error("未指定 Java 可执行文件，无法启动");
  if (!versionDir) throw new Error("未指定版本目录，无法启动");
  if (!librariesDir) throw new Error("未指定 libraries 目录，无法启动");
  if (!assetsDir) throw new Error("未指定 assets 目录，无法启动");
  if (!nativesDir) throw new Error("未指定 natives 目录，无法启动");
  if (!gameDir) throw new Error("未指定游戏目录，无法启动");

  const versionId = path.basename(versionDir);
  const versionName = versionJson.id || versionId;
  const memory = Math.max(1, Math.floor(Number(memoryMb) || DEFAULT_MEMORY_MB));
  const player = account || {};

  const requestedWidth = Number(width);
  const requestedHeight = Number(height);
  const hasResolution = requestedWidth > 0 && requestedHeight > 0;

  const features = {
    is_demo_user: false,
    has_custom_resolution: hasResolution,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
  };

  const { classpath, natives } = resolveLibraries(versionJson, librariesDir, features);
  // loader 版本的客户端 jar 留在父版本目录里，调用方可以显式指定
  const clientJar = clientJarPath || path.join(versionDir, `${versionId}.jar`);
  if (!classpath.includes(clientJar)) classpath.push(clientJar);

  const classpathString = [...new Set(classpath)].join(classpathSeparator);

  const variables = {
    auth_player_name: String(player.name ?? "Player"),
    auth_uuid: String(player.uuid ?? ""),
    auth_access_token: String(player.accessToken ?? ""),
    auth_session: `token:${player.accessToken ?? ""}:${player.uuid ?? ""}`,
    auth_xuid: "",
    clientid: "",
    user_type: versionJson.arguments ? "msa" : "legacy",
    user_properties: "{}",
    version_name: String(versionName),
    version_type: String(versionJson.type || "release"),
    game_directory: gameDir,
    assets_root: assetsDir,
    // 旧版 virtual assets 暂不展开，直接用 assets 根目录
    game_assets: assetsDir,
    assets_index_name: String(versionJson.assets ?? versionJson.assetIndex?.id ?? "legacy"),
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    classpath: classpathString,
    classpath_separator: classpathSeparator,
    natives_directory: nativesDir,
    library_directory: librariesDir,
  };
  if (hasResolution) {
    variables.resolution_width = String(requestedWidth);
    variables.resolution_height = String(requestedHeight);
  }

  if (natives.length) extractNatives(nativesDir, natives);

  const jvmArgs = [
    `-Xmx${memory}M`,
    `-Xms${Math.min(512, memory)}M`,
    `-Djava.library.path=${nativesDir}`,
    `-Dminecraft.launcher.brand=${LAUNCHER_NAME}`,
    `-Dminecraft.launcher.version=${LAUNCHER_VERSION}`,
    ...expandVersionArguments(versionJson.arguments?.jvm, variables, features),
  ];
  // 旧版 JSON 的 jvm 参数里没有 -cp，这里补上
  if (!jvmArgs.includes("-cp") && !jvmArgs.includes("-classpath")) {
    jvmArgs.push("-cp", classpathString);
  }
  if (Array.isArray(extraJvmArgs)) jvmArgs.push(...extraJvmArgs.map(String));

  // Forge/NeoForge 的 -DignoreList 默认写着 ${version_name}.jar，但 loader 版本下真实的客户端 jar
  // 还叫 <基础版本>.jar，对不上就会把它当模块加载，触发 "exports package ... to module" 冲突。
  const clientJarName = path.basename(clientJar);
  const ignoreIndex = jvmArgs.findIndex(
    (arg) => typeof arg === "string" && arg.startsWith("-DignoreList=")
  );
  if (ignoreIndex >= 0 && !jvmArgs[ignoreIndex].includes(clientJarName)) {
    jvmArgs[ignoreIndex] = `${jvmArgs[ignoreIndex]},${clientJarName}`;
  }

  let gameArgs;
  if (versionJson.arguments?.game) {
    gameArgs = expandVersionArguments(versionJson.arguments.game, variables, features);
  } else if (typeof versionJson.minecraftArguments === "string") {
    gameArgs = versionJson.minecraftArguments
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => substitute(token, variables))
      .filter((token) => !hasPlaceholder(token));
  } else {
    throw new Error("版本 JSON 缺少启动参数（arguments.game 或 minecraftArguments）");
  }
  if (Array.isArray(extraGameArgs)) gameArgs.push(...extraGameArgs.map(String));

  const args = [...jvmArgs, versionJson.mainClass, ...gameArgs];
  const command = [javaPath, ...args].map(quoteForDisplay).join(" ");

  return { command, args, cwd: gameDir, classpath: [...new Set(classpath)] };
}

/* ---- 进程启动 ---- */

/**
 * 启动 buildLaunchCommand 生成的 Java 进程。
 * stdout / stderr 按行回调 onLog(line, stream)，退出时回调 onExit(code, signal)。
 */
export function launchGame(options, { onLog, onExit } = {}) {
  const result = buildLaunchCommand(options);
  const child = spawn(options.javaPath, result.args, {
    cwd: result.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  const wire = (stream, name) => {
    if (!stream) return;
    stream.setEncoding("utf8");
    let buffered = "";
    stream.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length) onLog?.(line, name);
      }
    });
    stream.on("end", () => {
      if (buffered.length) onLog?.(buffered, name);
      buffered = "";
    });
  };
  wire(child.stdout, "stdout");
  wire(child.stderr, "stderr");

  let finished = false;
  const finish = (code, signal) => {
    if (finished) return;
    finished = true;
    onExit?.(code, signal);
  };

  child.on("error", (error) => {
    onLog?.(`启动 Java 进程失败：${error.message}`, "stderr");
    finish(-1, null);
  });
  child.on("close", (code, signal) => finish(code, signal));

  return { child, command: result.command };
}
