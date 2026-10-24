const CF_BASE = "https://api.curseforge.com/v1";
const MODRINTH_CF_FALLBACK = "https://www.curseforge.com/minecraft/modpacks";

export function hasCurseForgeKey(settings) {
  return Boolean(settings?.curseForgeKey);
}

async function cfFetch(path, key) {
  if (!key) throw new Error("还没有填 CurseForge API Key（设置页可以填）");
  const res = await fetch(`${CF_BASE}${path}`, {
    headers: { Accept: "application/json", "x-api-key": key },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CurseForge 请求失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function curseforgeSearch(query, key, limit = 20) {
  const params = new URLSearchParams({
    gameId: "432",
    classId: "4471",
    searchFilter: query || "",
    pageSize: String(limit),
    sortField: query ? "2" : "6",
    sortOrder: "desc",
  });
  const data = await cfFetch(`/mods/search?${params}`, key);
  return (data.data || []).map((mod) => ({
    source: "curseforge",
    id: mod.id,
    slug: mod.slug,
    title: mod.name,
    description: mod.summary || "",
    icon: mod.logo?.thumbnailUrl || "",
    downloads: mod.downloadCount || 0,
    versions: 0,
    authors: (mod.authors || []).map((a) => a.name),
  }));
}

export async function curseforgeModFiles(modId, key) {
  const data = await cfFetch(`/mods/${modId}/files?pageSize=50`, key);
  return (data.data || []).map((file) => ({
    id: file.id,
    name: file.displayName || file.fileName,
    fileName: file.fileName,
    releaseType: file.releaseType,
    fileDate: file.fileDate,
    gameVersions: file.gameVersions || [],
    downloadUrl: file.downloadUrl,
  }));
}

export function forgeCdnUrl(fileId, fileName) {
  const id = String(fileId);
  return `https://edge.forgecdn.net/files/${id.slice(0, 4)}/${id.slice(4)}/${encodeURIComponent(fileName)}`;
}

export async function curseforgeModpackDownload(modId, fileId, key) {
  const data = await cfFetch(`/mods/${modId}/files/${fileId}`, key);
  const file = data.data;
  return file.downloadUrl || forgeCdnUrl(file.id, file.fileName);
}

/** Resolves a CurseForge manifest file list into concrete download jobs. */
export async function resolveCurseForgeFiles(files, key, onProgress = () => {}) {
  const jobs = [];
  let done = 0;
  for (const entry of files) {
    try {
      const data = await cfFetch(`/mods/${entry.projectID}/files/${entry.fileID}`, key);
      const file = data.data;
      jobs.push({
        path: `mods/${file.fileName}`,
        url: file.downloadUrl || forgeCdnUrl(file.id, file.fileName),
      });
    } catch {
      // file removed or restricted; skip it instead of failing the whole pack
    }
    done += 1;
    onProgress({ done, total: files.length });
  }
  return jobs;
}

export { MODRINTH_CF_FALLBACK };
