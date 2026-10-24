import { getManifest } from "./mojang.js";

const WIKI_API = "https://zh.minecraft.wiki/api.php";
const USER_AGENT = "mclaunch/0.1.0 (github.com/LuYear2025)";
const CACHE_MS = 10 * 60_000;

let cache = null;

function cleanWiki(text) {
  return String(text)
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/\{\{pa\|([^|}]+)[^}]*\}\}/g, "$1")
    .replace(/\{\{article\|[\s\S]*?\}\}/g, "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSnapshot(wikitext, version) {
  const dateMatch = wikitext.match(/\|date=([^\n|]+)/);
  const date = dateMatch ? dateMatch[1].trim() : "";
  const imageMatch = wikitext.match(/\|image=([^\n|\\]+)/);
  const imageFile = imageMatch ? imageMatch[1].trim() : "";

  // 简介：<onlyinclude> 之后的第一段
  const afterOnlyinclude = wikitext.split(/<onlyinclude>/)[1] || "";
  const blocks = afterOnlyinclude
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const summary = cleanWiki(blocks[0] || "");

  // 新内容：取「新内容」章节里的加粗条目和列表项
  const changes = [];
  const start = wikitext.indexOf("== 新内容 ==");
  let sectionText = "";
  if (start >= 0) {
    const rest = wikitext.slice(start + 8);
    // 只切到下一个二级标题（=== 是三级标题，不能当边界）
    const next = rest.search(/\n==(?!=)/);
    sectionText = next >= 0 ? rest.slice(0, next) : rest;
  }
  for (const line of sectionText.split(/\n/)) {
    const bold = line.match(/^'''(.+?)'''/);
    const bullet = line.match(/^\*\s+(.+)/);
    if (bold) {
      const value = cleanWiki(bold[1]);
      if (value && !changes.includes(value)) changes.push(value);
    } else if (bullet) {
      const value = cleanWiki(bullet[1]).slice(0, 80);
      if (value && !changes.includes(value)) changes.push(value);
    }
    if (changes.length >= 8) break;
  }

  return {
    version,
    date,
    imageFile,
    image: null,
    summary,
    changes,
    url: `https://zh.minecraft.wiki/w/Java%E7%89%88${encodeURIComponent(version)}`,
  };
}

async function fetchImageUrl(filename) {
  if (!filename) return null;
  try {
    const url = new URL(WIKI_API);
    url.searchParams.set("action", "query");
    url.searchParams.set("titles", `File:${filename}`);
    url.searchParams.set("prop", "imageinfo");
    url.searchParams.set("iiprop", "url");
    url.searchParams.set("format", "json");
    url.searchParams.set("formatversion", "2");
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.query?.pages?.[0]?.imageinfo?.[0]?.url || null;
  } catch {
    return null;
  }
}

async function fetchWikiPage(title) {
  const url = new URL(WIKI_API);
  url.searchParams.set("action", "parse");
  url.searchParams.set("page", title);
  url.searchParams.set("prop", "wikitext");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`zhMC wiki 请求失败：HTTP ${res.status}`);
  const data = await res.json();
  const wikitext = data?.parse?.wikitext;
  if (!wikitext) throw new Error("wiki 页面不存在");
  return wikitext;
}

/** 主页数据：最新正式版 / 最新预览版 + 预览版介绍（来自 zhMC wiki）。 */
export async function getHome() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;

  const manifest = await getManifest("official");
  const release = manifest.latest.release;
  const snapshot = manifest.latest.snapshot;

  let preview = null;
  let previewError = null;
  try {
    const wikitext = await fetchWikiPage(`Java版${snapshot}`);
    preview = parseSnapshot(wikitext, snapshot);
  } catch (error) {
    previewError = error.message;
    try {
      const wikitext = await fetchWikiPage(snapshot);
      preview = parseSnapshot(wikitext, snapshot);
      previewError = null;
    } catch {
      // 保持错误
    }
  }
  if (preview) {
    preview.image = await fetchImageUrl(preview.imageFile);
  }

  const data = {
    release,
    snapshot,
    preview,
    previewError,
    fetchedAt: Date.now(),
  };
  cache = { at: Date.now(), data };
  return data;
}
