const state = {
  settings: {},
  accounts: [],
  instances: [],
  selectedId: null,
  tab: "home",
  instanceTab: "overview",
  instanceContentType: "mod",
  modUpdates: null,
  mpTimer: null,
  downloadType: "game",
  versions: null,
  versionsFilter: "",
  modpackQuery: "",
  modpackResults: [],
  openModpack: null,
  run: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败：HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, kind = "info") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast show ${kind === "error" ? "error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 3200);
}

/* ---------------- boot ---------------- */

async function boot() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
  $("#newInstance").addEventListener("click", promptNewInstance);

  const params = new URLSearchParams(location.search);
  const initial = params.get("tab") || location.hash.replace("#", "");
  if (["home", "instances", "download", "multiplayer", "accounts", "settings"].includes(initial)) {
    state.tab = initial;
    document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === initial));
  }
  if (params.get("type")) state.downloadType = params.get("type");
  if (params.get("itab")) state.instanceTab = params.get("itab");
  if (params.get("ctab")) state.instanceContentType = params.get("ctab");

  try {
    [state.settings, state.accounts, state.instances] = await Promise.all([
      api("/api/settings"),
      api("/api/accounts"),
      api("/api/instances"),
    ]);
  } catch (error) {
    toast(error.message, "error");
  }
  state.selectedId = state.instances[0]?.id ?? null;
  renderInstances();
  renderPanel();

  // 直接打开新建实例弹窗（方便分享链接，也方便截图）
  if (new URLSearchParams(location.search).get("new") === "1") promptNewInstance();
  if (params.get("export") === "1" && state.instances[0]) openExportModal(state.instances[0]);
  if (params.get("modify") === "1" && state.instances[0]) openModifyModal(state.instances[0]);
}

function switchTab(tab) {
  if (state.mpTimer) {
    clearInterval(state.mpTimer);
    state.mpTimer = null;
  }
  state.tab = tab;
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
  renderPanel();
}

/* ---------------- instances ---------------- */

function renderInstances() {
  const list = $("#instanceList");
  if (!state.instances.length) {
    list.innerHTML = `<li class="empty">还没有实例，点「整合包」装一个，或点右上角 ＋</li>`;
    return;
  }
  list.innerHTML = state.instances
    .map(
      (i) => `<li data-id="${i.id}" class="${i.id === state.selectedId ? "active" : ""}">
        <div class="name">${esc(i.name)}</div>
        <div class="sub">${esc(i.mcVersion || "?")} · ${esc(i.loader || "vanilla")}${i.modpack ? " · " + esc(i.modpack.name) : ""}</div>
      </li>`
    )
    .join("");
  list.querySelectorAll("li[data-id]").forEach((li) => {
    li.addEventListener("click", () => {
      state.selectedId = li.dataset.id;
      renderInstances();
      renderPanel();
    });
  });
}

async function promptNewInstance() {
  if (document.getElementById("newModal")) return;

  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div class="modal-backdrop show" id="newModal">
      <div class="modal">
        <h3>新建实例</h3>
        <div class="field">
          <label>名称</label>
          <input id="niName" type="text" value="新实例 ${state.instances.length + 1}" />
        </div>
        <div class="field">
          <label>游戏版本</label>
          <select id="niVersion"></select>
        </div>
        <div class="field">
          <label>Loader</label>
          <select id="niLoader">
            <option value="vanilla">原版</option>
            <option value="fabric">Fabric</option>
            <option value="quilt">Quilt</option>
            <option value="forge">Forge</option>
            <option value="neoforge">NeoForge</option>
          </select>
        </div>
        <div class="field" id="niLoaderVersionField" style="display:none">
          <label>Loader 版本</label>
          <select id="niLoaderVersion"></select>
        </div>
        <div class="row" style="margin-top:16px">
          <span class="spacer"></span>
          <button class="btn ghost" id="niCancel">取消</button>
          <button class="btn" id="niCreate">创建</button>
        </div>
        <div id="niStatus" class="hint" style="margin-top:10px"></div>
      </div>
    </div>`;
  document.body.appendChild(wrapper.firstElementChild);
  const modal = document.getElementById("newModal");

  const close = () => modal.remove();
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  document.getElementById("niCancel").addEventListener("click", close);

  // 游戏版本列表
  const versionSelect = document.getElementById("niVersion");
  versionSelect.innerHTML = `<option value="">加载中…</option>`;
  try {
    if (!state.versions) {
      state.versions = await api(`/api/versions?mirror=${encodeURIComponent(state.settings.mirror || "official")}`);
    }
    const releases = state.versions.versions.filter((v) => v.type === "release").slice(0, 60);
    versionSelect.innerHTML = releases.map((v) => `<option value="${esc(v.id)}">${esc(v.id)}</option>`).join("");
  } catch (error) {
    versionSelect.innerHTML = `<option value="">${esc(error.message)}</option>`;
  }

  // loader 版本列表
  const loaderSelect = document.getElementById("niLoader");
  const loaderVersionField = document.getElementById("niLoaderVersionField");
  const loaderVersionSelect = document.getElementById("niLoaderVersion");

  const loadLoaderVersions = async () => {
    const kind = loaderSelect.value;
    const mc = versionSelect.value;
    if (kind === "vanilla" || !mc) {
      loaderVersionField.style.display = "none";
      return;
    }
    loaderVersionField.style.display = "block";
    loaderVersionSelect.innerHTML = `<option value="">加载中…</option>`;
    try {
      const list = await api(`/api/loaders/${kind}?mc=${encodeURIComponent(mc)}`);
      if (!Array.isArray(list) || !list.length) {
        const reason = list?.message || "这个版本没有可用的 " + kind;
        loaderVersionSelect.innerHTML = `<option value="">${esc(reason)}</option>`;
        return;
      }
      loaderVersionSelect.innerHTML = list
        .slice(0, 40)
        .map((v) => {
          const ver = v.version || v.id;
          const tag = v.stable === false ? " (测试版)" : v.type === "latest" ? " (最新)" : "";
          return `<option value="${esc(ver)}">${esc(ver)}${tag}</option>`;
        })
        .join("");
    } catch (error) {
      loaderVersionSelect.innerHTML = `<option value="">${esc(error.message)}</option>`;
    }
  };

  loaderSelect.addEventListener("change", loadLoaderVersions);
  versionSelect.addEventListener("change", loadLoaderVersions);

  document.getElementById("niCreate").addEventListener("click", async () => {
    const name = document.getElementById("niName").value.trim();
    const mcVersion = versionSelect.value;
    const loader = loaderSelect.value;
    const loaderVersion = loaderVersionSelect.value;
    if (!name || !mcVersion) return toast("名称和版本都要填", "error");

    const btn = document.getElementById("niCreate");
    btn.disabled = true;
    const status = document.getElementById("niStatus");
    try {
      status.textContent = "创建实例…";
      const instance = await api("/api/instances", {
        method: "POST",
        body: JSON.stringify({ name, mcVersion, loader: "vanilla" }),
      });
      state.instances.unshift(instance);
      state.selectedId = instance.id;
      renderInstances();

      if (loader !== "vanilla") {
        if (!loaderVersion) throw new Error("没有选到可用的 loader 版本");
        status.textContent = `安装 ${loader} ${loaderVersion}…`;
        const { jobId } = await api(`/api/instances/${instance.id}/loader`, {
          method: "POST",
          body: JSON.stringify({ kind: loader, version: loaderVersion }),
        });
        await waitForJob(jobId, (job) => {
          const p = job.progress || {};
          status.textContent = `${labelOf(p.phase)}${p.done && p.total ? ` ${p.done}/${p.total}` : ""}${p.message ? " " + p.message : ""}`;
        });
        const refreshed = await api("/api/instances");
        state.instances = refreshed;
        renderInstances();
      }

      close();
      renderPanel();
      toast(loader === "vanilla" ? "实例已创建" : `${loader} 安装完成`);
    } catch (error) {
      status.textContent = error.message;
      toast(error.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

/** 轮询一个后台任务直到结束，结束时抛错或用结果 resolve。 */
function waitForJob(jobId, onProgress) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      let job;
      try {
        job = await api(`/api/jobs/${jobId}`);
      } catch (error) {
        clearInterval(timer);
        reject(error);
        return;
      }
      onProgress?.(job);
      if (job.status === "done") {
        clearInterval(timer);
        resolve(job.result);
      } else if (job.status === "failed") {
        clearInterval(timer);
        reject(new Error(job.error));
      }
    }, 700);
  });
}

/* ---------------- panel ---------------- */

function renderPanel() {
  const panel = $("#panel");
  panel.innerHTML = "";
  if (state.tab === "download") {
    renderDownloadPanel(panel);
    return;
  }
  if (state.tab === "home") {
    renderHomePage(panel);
    return;
  }
  if (state.tab === "multiplayer") {
    renderMultiplayerPage(panel);
    return;
  }
  const render = {
    instances: renderInstancePanel,
    accounts: renderAccountsPanel,
    settings: renderSettingsPanel,
  }[state.tab];
  render?.(panel);
}

/* ---------------- multiplayer ---------------- */

const MP_STATES = {
  waiting: "等待中",
  "host-scanning": "正在创建房间…",
  "host-starting": "正在启动房间…",
  "host-ok": "房间已创建",
  "guest-connecting": "正在连接房主…",
  "guest-starting": "正在建立隧道…",
  "guest-ok": "已连接",
  exception: "连接出错",
  error: "未启动",
};

function renderMultiplayerPage(panel) {
  if (state.mpTimer) clearInterval(state.mpTimer);
  const player = state.accounts[0]?.name || "玩家";

  panel.innerHTML = `
    <h2>联机</h2>
    <p class="hint">用陶瓦联机跟朋友开黑。房主要先在游戏里「对局域网开放」，然后创建房间把码发给朋友。</p>
    <div class="card">
      <div class="card-title">状态</div>
      <div class="row" style="margin-bottom:12px">
        <span class="badge" id="mpBadge">…</span>
        <span class="hint" id="mpText" style="margin:0">正在查询…</span>
      </div>
      <div class="row">
        <button class="btn" id="mpHost">创建房间</button>
        <input id="mpRoom" placeholder="房间码" style="width:150px" />
        <button class="btn ghost" id="mpJoin">加入房间</button>
        <span class="spacer"></span>
        <button class="btn ghost" id="mpStop">关闭联机</button>
        <button class="btn ghost" id="mpReset">重置</button>
      </div>
      <div class="hint" id="mpPlayer" style="margin:10px 0 0">昵称：${esc(player)}</div>
    </div>
    <div class="card" id="mpRoomCard" style="display:none">
      <div class="card-title">房间码</div>
      <div class="mp-code" id="mpCode">----</div>
      <div class="hint" style="margin:0">把这个码发给朋友，让他们在「加入房间」里输入。</div>
    </div>`;

  const badge = $("#mpBadge");
  const text = $("#mpText");
  const roomCard = $("#mpRoomCard");
  const codeEl = $("#mpCode");

  const applyState = (s) => {
    const label = MP_STATES[s.state] || s.state || "未知";
    badge.textContent = label;
    badge.className = "badge " + (s.state === "host-ok" || s.state === "guest-ok" ? "ok" : s.state === "exception" || s.state === "error" ? "warn" : "");
    if (s.state === "host-ok") {
      roomCard.style.display = "block";
      codeEl.textContent = s.room || "----";
      text.textContent = "等朋友加入";
    } else if (s.state === "guest-ok") {
      roomCard.style.display = "none";
      text.textContent = s.url ? `已连上房主：${s.url}` : "已连上房主";
    } else {
      roomCard.style.display = "none";
      text.textContent = s.message || "";
    }
  };

  const poll = async () => {
    try {
      const st = await api("/api/multiplayer/state");
      applyState(st);
    } catch {
      badge.textContent = "未启动";
      text.textContent = "";
    }
  };

  $("#mpHost").addEventListener("click", async () => {
    badge.textContent = "准备中…";
    text.textContent = "首次使用会下载陶瓦联机组件（约 8 MB）";
    try {
      await api("/api/multiplayer/host", { method: "POST", body: JSON.stringify({ player }) });
      poll();
    } catch (error) {
      text.textContent = error.message;
      toast(error.message, "error");
    }
  });

  $("#mpJoin").addEventListener("click", async () => {
    const room = $("#mpRoom").value.trim();
    if (!room) return toast("先填房间码", "error");
    badge.textContent = "连接中…";
    try {
      await api("/api/multiplayer/join", { method: "POST", body: JSON.stringify({ room, player }) });
      poll();
    } catch (error) {
      text.textContent = error.message;
      toast(error.message, "error");
    }
  });

  $("#mpStop").addEventListener("click", async () => {
    try {
      await api("/api/multiplayer/stop", { method: "POST", body: "{}" });
      badge.textContent = "已关闭";
      text.textContent = "下次点「创建房间」会重新启动";
      roomCard.style.display = "none";
    } catch (error) {
      toast(error.message, "error");
    }
  });

  $("#mpReset").addEventListener("click", async () => {
    try {
      await api("/api/multiplayer/reset", { method: "POST", body: "{}" });
      poll();
    } catch (error) {
      toast(error.message, "error");
    }
  });

  if (!$("#mp_style")) {
    const style = document.createElement("style");
    style.id = "mp_style";
    style.textContent = `.mp-code{font:700 34px/1.3 Consolas,"Cascadia Mono",monospace;letter-spacing:4px;margin:8px 0 10px;color:#fff}`;
    document.head.appendChild(style);
  }

  poll();
  state.mpTimer = setInterval(poll, 2500);
}

/* ---------------- home ---------------- */

async function renderHomePage(panel) {
  panel.innerHTML = `
    <h2>开始游戏</h2>
    <div class="home-grid">
      <div class="card home-launch">
        <div class="field" style="margin:0">
          <label>选择实例</label>
          <select id="homeInstance"></select>
        </div>
        <button class="btn home-launch-btn" id="homeLaunch">启动游戏</button>
        <div class="hint" id="homeHint">正在准备…</div>
      </div>
      <div id="homePreview"><div class="card"><div class="hint">正在从 zhMC wiki 拉取预览版介绍…</div></div></div>
    </div>`;

  const select = $("#homeInstance");
  const hint = $("#homeHint");

  if (!state.instances.length) {
    select.innerHTML = `<option value="">还没有实例</option>`;
    $("#homeLaunch").disabled = true;
    hint.textContent = "先去「实例」页新建一个，或到「下载」页装个整合包";
  } else {
    select.innerHTML = state.instances
      .map(
        (i) =>
          `<option value="${i.id}" ${i.id === state.selectedId ? "selected" : ""}>${esc(i.name)}（${esc(i.mcVersion || "?")} · ${esc(i.loader || "vanilla")}）</option>`
      )
      .join("");
    hint.textContent = "会按实例设置里的内存和 Java 启动";
  }

  $("#homeLaunch").addEventListener("click", async () => {
    const instance = state.instances.find((i) => i.id === select.value);
    if (!instance) return;
    hint.textContent = "启动中…";
    try {
      const res = await api(`/api/instances/${instance.id}/launch`, { method: "POST", body: "{}" });
      state.tab = "instances";
      state.selectedId = instance.id;
      state.instanceTab = "logs";
      document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === "instances"));
      renderInstances();
      renderPanel();
      startRunPolling(res.runId);
    } catch (error) {
      hint.textContent = error.message;
      toast(error.message, "error");
    }
  });

  try {
    renderHomePreview(await api("/api/home"));
  } catch (error) {
    $("#homePreview").innerHTML = `<div class="card"><div class="hint">预览版介绍加载失败：${esc(error.message)}</div></div>`;
  }
}

function renderHomePreview(data) {
  const preview = data.preview;
  const box = $("#homePreview");
  if (!box) return;
  if (!preview) {
    box.innerHTML = `<div class="card">
      <div class="card-title">最新预览版</div>
      <div class="hint">${esc(data.previewError || "暂时拿不到 wiki 上的预览版资料")}</div>
    </div>`;
    return;
  }
  box.innerHTML = `<div class="card">
    <div class="card-title">最新预览版</div>
    <div class="preview-layout">
      <div class="preview-text">
        <div class="row" style="align-items:baseline;gap:10px">
          <h3 style="margin:0;font-size:20px">${esc(preview.version)}</h3>
          ${preview.date ? `<span class="badge">${esc(preview.date)}</span>` : ""}
        </div>
        <p class="preview-summary">${esc(preview.summary)}</p>
        ${
          preview.changes.length
            ? `<ul class="preview-changes">${preview.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`
            : ""
        }
        <a class="hint" href="${esc(preview.url)}" target="_blank" rel="noreferrer">zh.minecraft.wiki 查看 →</a>
      </div>
      ${
        preview.image
          ? `<a class="preview-image" href="${esc(preview.url)}" target="_blank" rel="noreferrer">
               <img src="${esc(preview.image)}" alt="${esc(preview.version)}" loading="lazy" />
             </a>`
          : ""
      }
    </div>
  </div>`;
}

/* ---------------- download ---------------- */

const DOWNLOAD_TABS = [
  { key: "game", label: "游戏本体" },
  { key: "mod", label: "模组" },
  { key: "modpack", label: "整合包" },
  { key: "datapack", label: "数据包" },
  { key: "resourcepack", label: "资源包" },
  { key: "shader", label: "光影包" },
  { key: "world", label: "世界" },
];

const RESOURCE_HINT = {
  mod: "装到实例的 mods/ 目录",
  datapack: "装到实例的 datapacks/ 目录",
  resourcepack: "装到实例的 resourcepacks/ 目录",
  shader: "装到实例的 shaderpacks/ 目录",
  world: "下载后解压成实例的 saves/<名称>/",
};

function renderDownloadPanel(panel) {
  const type = state.downloadType || "game";
  panel.innerHTML = `
    <h2>下载</h2>
    <div class="sub-tabs">
      ${DOWNLOAD_TABS.map(
        (t) =>
          `<button class="sub-tab ${t.key === type ? "active" : ""}" data-type="${t.key}">${t.label}</button>`
      ).join("")}
    </div>
    <div id="downloadBody"></div>`;

  panel.querySelectorAll(".sub-tab").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.downloadType = btn.dataset.type;
      renderPanel();
    })
  );

  const body = $("#downloadBody");
  if (type === "game") renderGameVersions(body);
  else if (type === "modpack") renderModpackSection(body);
  else renderResourceSection(body, type);
}

function renderInstancePanel(panel) {
  const instance = state.instances.find((i) => i.id === state.selectedId);
  if (!instance) {
    panel.innerHTML = `<h2>实例</h2><p class="hint">左侧列表里还没有实例。</p>`;
    return;
  }

  const tab = state.instanceTab || "overview";
  panel.innerHTML = `
    <h2>${esc(instance.name)}</h2>
    <p class="hint">${esc(instance.mcVersion || "未知版本")} · ${esc(instance.loader || "vanilla")}${instance.loaderVersion ? " " + esc(instance.loaderVersion) : ""}${instance.modpack ? " · 整合包 " + esc(instance.modpack.name) : ""}</p>
    <div class="sub-tabs">
      <button class="sub-tab ${tab === "overview" ? "active" : ""}" data-itab="overview">概览</button>
      <button class="sub-tab ${tab === "content" ? "active" : ""}" data-itab="content">内容</button>
      <button class="sub-tab ${tab === "logs" ? "active" : ""}" data-itab="logs">日志</button>
      <button class="sub-tab ${tab === "settings" ? "active" : ""}" data-itab="settings">设置</button>
    </div>
    <div id="instanceBody"></div>`;

  panel.querySelectorAll("[data-itab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.instanceTab = btn.dataset.itab;
      renderPanel();
    })
  );

  const body = $("#instanceBody");
  if (tab === "logs") renderInstanceLogs(body, instance);
  else if (tab === "content") renderInstanceContent(body, instance);
  else if (tab === "settings") renderInstanceSettings(body, instance);
  else renderInstanceOverview(body, instance);
  restoreRun();
}

async function renderInstanceSettings(body, instance) {
  body.innerHTML = `
    <div class="card">
      <div class="card-title">Java</div>
      <div class="row" style="margin-bottom:8px">
        <select id="instJava" style="min-width:360px"><option value="">自动（按版本选）</option></select>
        <button class="btn ghost small" id="refreshJava">刷新列表</button>
      </div>
      <div class="hint" id="javaHint" style="margin:0">正在检测本机 Java…</div>
    </div>
    <div class="card">
      <div class="card-title">保存</div>
      <button class="btn" id="saveInstanceSettings">保存</button>
      <span id="instStatus" class="hint" style="margin-left:10px"></span>
    </div>`;

  const select = $("#instJava");
  const hint = $("#javaHint");

  const loadJava = async () => {
    try {
      const list = await api("/api/java");
      select.innerHTML =
        `<option value="">自动（按版本选）</option>` +
        list
          .map(
            (j) =>
              `<option value="${esc(j.path)}" ${j.path === instance.javaPath ? "selected" : ""}>Java ${esc(String(j.major ?? "?"))} — ${esc(j.path)}</option>`
          )
          .join("");
      if (!instance.javaPath && list.length) {
        hint.textContent = `自动：启动时按游戏版本要求，从本机 ${list.length} 个 Java 里选最接近的那个`;
      } else if (!instance.javaPath) {
        hint.textContent = "本机没检测到 Java，请先安装或在下方手动填路径。";
      } else {
        hint.textContent = "当前手动指定了 Java。";
      }
    } catch (error) {
      hint.textContent = error.message;
    }
  };

  $("#refreshJava").addEventListener("click", loadJava);
  $("#saveInstanceSettings").addEventListener("click", async () => {
    const status = $("#instStatus");
    try {
      await api(`/api/instances/${instance.id}`, {
        method: "PATCH",
        body: JSON.stringify({ javaPath: select.value || null }),
      });
      instance.javaPath = select.value || null;
      status.textContent = "已保存";
      toast("已保存");
    } catch (error) {
      status.textContent = error.message;
    }
  });

  loadJava();
}

const CONTENT_TABS = [
  { key: "mod", label: "模组", dir: "mods" },
  { key: "datapack", label: "数据包", dir: "datapacks" },
  { key: "resourcepack", label: "资源包", dir: "resourcepacks" },
  { key: "shader", label: "光影包", dir: "shaderpacks" },
  { key: "world", label: "世界", dir: "saves" },
];

function formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

async function renderInstanceContent(body, instance) {
  const type = state.instanceContentType || "mod";
  const meta = CONTENT_TABS.find((t) => t.key === type) || CONTENT_TABS[0];

  body.innerHTML = `
    <div class="sub-tabs">
      ${CONTENT_TABS.map(
        (t) => `<button class="sub-tab ${t.key === type ? "active" : ""}" data-ctab="${t.key}">${t.label}</button>`
      ).join("")}
    </div>
    ${
      type === "mod"
        ? `<div class="row" style="margin-bottom:10px">
            <button class="btn ghost small" id="checkUpdates">检查更新</button>
            <span id="contentStatus" class="hint" style="margin:0"></span>
          </div>`
        : ""
    }
    <div id="modUpdates"></div>
    <div class="row" style="margin-bottom:12px">
      <span class="hint" style="margin:0">实例里的 <code>${meta.dir}/</code>，共 <b id="contentCount">…</b> 项</span>
      <span class="spacer"></span>
      <button class="btn ghost small" id="importContent">导入本地文件</button>
      <input id="contentFile" type="file" multiple hidden accept=".jar,.zip" />
      <button class="btn ghost small" id="openContentDir">打开目录</button>
      <button class="btn ghost small" id="refreshContent">刷新</button>
    </div>
    <div id="contentList" class="list"><div class="hint">读取中…</div></div>`;

  body.querySelectorAll("[data-ctab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.instanceContentType = btn.dataset.ctab;
      renderPanel();
    })
  );

  const load = async () => {
    const list = $("#contentList");
    if (!list) return;
    list.innerHTML = `<div class="hint">读取中…</div>`;
    try {
      const items = await api(`/api/instances/${instance.id}/content?type=${type}`);
      const count = $("#contentCount");
      if (count) count.textContent = String(items.length);
      list.innerHTML =
        items
          .map(
            (item) => `<div class="item">
              <div>
                <div class="title">${esc(item.name)}</div>
                <div class="sub">${item.isDir ? "文件夹" : formatSize(item.size)} · ${new Date(item.mtime).toLocaleString()}</div>
              </div>
              <span class="spacer"></span>
              <button class="btn danger small" data-del="${esc(item.name)}">删除</button>
            </div>`
          )
          .join("") ||
        `<div class="hint">这里还是空的，去「下载」页装几个${esc(meta.label)}吧</div>`;

      list.querySelectorAll("[data-del]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          if (!confirm(`删除「${btn.dataset.del}」？`)) return;
          btn.disabled = true;
          try {
            await api(`/api/instances/${instance.id}/content`, {
              method: "DELETE",
              body: JSON.stringify({ type, name: btn.dataset.del }),
            });
            toast("已删除");
            load();
          } catch (error) {
            toast(error.message, "error");
            btn.disabled = false;
          }
        })
      );
    } catch (error) {
      list.innerHTML = `<div class="hint">${esc(error.message)}</div>`;
    }
  };

  $("#openContentDir").addEventListener("click", async () => {
    try {
      await api(`/api/instances/${instance.id}/open`, {
        method: "POST",
        body: JSON.stringify({ target: meta.dir }),
      });
    } catch (error) {
      toast(error.message, "error");
    }
  });
  $("#refreshContent").addEventListener("click", load);

  $("#importContent").addEventListener("click", () => $("#contentFile").click());
  $("#contentFile").addEventListener("change", async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    const status = $("#contentStatus");
    for (const file of files) {
      if (status) status.textContent = `导入 ${file.name}…`;
      try {
        const { jobId } = await api(
          `/api/instances/${instance.id}/content/import?type=${type}&name=${encodeURIComponent(file.name)}`,
          { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file }
        );
        await waitForJob(jobId);
      } catch (error) {
        toast(error.message, "error");
      }
    }
    if (status) status.textContent = "";
    load();
  });

  const updates = state.modUpdates?.instanceId === instance.id ? state.modUpdates.items : [];
  if (type === "mod" && updates.length) {
    $("#modUpdates").innerHTML = `<div class="card" style="border-color: var(--accent)">
      <div class="row" style="margin-bottom:8px">
        <strong>${updates.length} 个模组可以更新</strong>
        <span class="spacer"></span>
        <button class="btn small" id="applyUpdates">全部更新</button>
        <button class="btn ghost small" id="dismissUpdates">忽略</button>
      </div>
      <div class="hint" style="margin:0">${updates
        .map((u) => `${esc(u.fileName)}：${esc(u.currentVersion)} → <b>${esc(u.latestVersion)}</b>`)
        .join("<br>")}</div>
    </div>`;

    $("#dismissUpdates").addEventListener("click", () => {
      state.modUpdates = null;
      renderPanel();
    });
    $("#applyUpdates").addEventListener("click", async () => {
      const status = $("#contentStatus");
      const preview = updates.map((u) => `${u.fileName}  ${u.currentVersion} → ${u.latestVersion}`).join("\n");
      if (!confirm(`确认更新下面 ${updates.length} 个模组？旧文件会被替换。\n\n${preview}`)) return;
      try {
        const { jobId } = await api(`/api/instances/${instance.id}/mods/update`, {
          method: "POST",
          body: JSON.stringify({ updates }),
        });
        status.textContent = "更新中…";
        await waitForJob(jobId, (job) => {
          const p = job.progress || {};
          status.textContent = `${labelOf(p.phase)} ${p.done ?? ""}/${p.total ?? ""}`;
        });
        state.modUpdates = null;
        toast("更新完成");
        renderPanel();
      } catch (error) {
        status.textContent = error.message;
        toast(error.message, "error");
      }
    });
  }

  $("#checkUpdates")?.addEventListener("click", async () => {
    const status = $("#contentStatus");
    status.textContent = "识别本地模组并检查更新…";
    try {
      const { jobId } = await api(`/api/instances/${instance.id}/mods/check`, { method: "POST", body: "{}" });
      const result = await waitForJob(jobId, (job) => {
        const p = job.progress || {};
        status.textContent = `${labelOf(p.phase)} ${p.done ?? ""}/${p.total ?? ""}`;
      });
      const list = result?.updates || [];
      state.modUpdates = { instanceId: instance.id, items: list };
      status.textContent = list.length ? "" : "已经是最新版本";
      renderPanel();
    } catch (error) {
      status.textContent = error.message;
      toast(error.message, "error");
    }
  });

  load();
}

function renderInstanceOverview(body, instance) {
  const loaderName = { vanilla: "原版", fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" }[instance.loader] || instance.loader || "原版";
  const loaderText =
    instance.loader === "vanilla" ? "原版" : instance.loaderVersion ? `${loaderName} ${instance.loaderVersion}` : loaderName;
  const cube = `<svg width="46" height="46" viewBox="0 0 100 100" aria-hidden="true">
      <polygon points="50,6 94,29 50,52 6,29" fill="#5aa2ff"/>
      <polygon points="6,29 50,52 50,94 6,71" fill="#2b62b8"/>
      <polygon points="94,29 50,52 50,94 94,71" fill="#3d8bfd"/>
    </svg>`;

  body.innerHTML = `
    <div class="card hero">
      <div class="hero-icon">${cube}</div>
      <div class="hero-stats">
        <div class="hero-stat">
          <div class="value">${instance.launchCount || 0}</div>
          <div class="label">启动次数</div>
        </div>
        <div class="hero-sep"></div>
        <div class="hero-stat">
          <div class="value">${esc(instance.mcVersion || "?")}</div>
          <div class="label">Minecraft</div>
        </div>
        <div class="hero-sep"></div>
        <div class="hero-stat">
          <div class="value">${esc(loaderText)}</div>
          <div class="label">模组加载器</div>
        </div>
      </div>
      <span class="spacer"></span>
      <span class="badge ${instance.installed ? "ok" : "warn"}">${instance.installed ? "已安装" : "未完成安装"}</span>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <button class="btn" id="launchBtn">启动游戏</button>
        <button class="btn ghost" id="stopBtn" disabled>停止</button>
        <button class="btn ghost" id="modifyBtn">修改实例</button>
        <input id="memInput" type="number" min="1024" step="512" value="${state.settings.memoryMb || 2048}" style="width:110px" title="内存 (MB)" />
        <span class="badge">MB 内存</span>
      </div>
      <div class="job" id="runBanner" style="display:none">
        <div class="job-head"><span class="job-title"></span><span class="job-pct"></span></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">快捷方式</div>
      <div class="row">
        <button class="btn ghost small" data-open="dir">实例文件夹</button>
        <button class="btn ghost small" data-open="saves">存档文件夹</button>
        <button class="btn ghost small" data-open="mods">模组文件夹</button>
        <button class="btn ghost small" data-open="logs">日志文件夹</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">高级管理</div>
      <div class="row">
        <button class="btn ghost small" id="exportBat">导出启动脚本</button>
        <button class="btn ghost small" id="exportPack">导出整合包</button>
        <button class="btn ghost small" id="testGame">测试游戏</button>
        <button class="btn ghost small" id="repairBtn">补全文件</button>
        <button class="btn ghost small" id="resetBtn">重置</button>
        <button class="btn danger small" id="deleteInstance">删除实例</button>
      </div>
      <div id="maintStatus" class="hint" style="margin-top:8px"></div>
    </div>`;

  const launch = () => {
    $("#launchBtn").disabled = true;
    api(`/api/instances/${instance.id}/launch`, {
      method: "POST",
      body: JSON.stringify({ memoryMb: Number($("#memInput").value) || 2048 }),
    })
      .then((res) => {
        state.instanceTab = "logs";
        renderPanel();
        startRunPolling(res.runId);
      })
      .catch((error) => {
        toast(error.message, "error");
        $("#launchBtn").disabled = false;
      });
  };

  $("#launchBtn").addEventListener("click", launch);
  $("#modifyBtn").addEventListener("click", () => openModifyModal(instance));
  $("#testGame").addEventListener("click", launch);
  $("#stopBtn").addEventListener("click", async () => {
    if (!state.run?.id) return;
    try {
      await api(`/api/runs/${state.run.id}/stop`, { method: "POST" });
    } catch (error) {
      toast(error.message, "error");
    }
  });

  body.querySelectorAll("[data-open]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/instances/${instance.id}/open`, {
          method: "POST",
          body: JSON.stringify({ target: btn.dataset.open }),
        });
      } catch (error) {
        toast(error.message, "error");
      }
    })
  );

  $("#exportPack").addEventListener("click", () => openExportModal(instance));

  $("#exportBat").addEventListener("click", async () => {
    const status = $("#maintStatus");
    try {
      const res = await api(`/api/instances/${instance.id}/export`, { method: "POST", body: "{}" });
      status.textContent = `已导出：${res.path}`;
    } catch (error) {
      status.textContent = error.message;
    }
  });

  $("#repairBtn").addEventListener("click", async () => {
    try {
      const { jobId } = await api(`/api/instances/${instance.id}/repair`, { method: "POST", body: "{}" });
      trackJob(jobId, $("#maintStatus"));
    } catch (error) {
      toast(error.message, "error");
    }
  });

  $("#resetBtn").addEventListener("click", async () => {
    if (!confirm("重置会清掉 mods、config、saves、日志和资源包，只保留实例本身和已下载的版本。继续？")) return;
    try {
      await api(`/api/instances/${instance.id}/reset`, { method: "POST", body: "{}" });
      toast("已重置");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  $("#deleteInstance").addEventListener("click", () => {
    if (!confirm(`确定删除实例「${instance.name}」？目录会被整个删掉。`)) return;
    api(`/api/instances/${instance.id}`, { method: "DELETE" })
      .then(() => {
        state.instances = state.instances.filter((i) => i.id !== instance.id);
        state.selectedId = state.instances[0]?.id ?? null;
        renderInstances();
        renderPanel();
        toast("已删除");
      })
      .catch((error) => toast(error.message, "error"));
  });
}

async function openModifyModal(instance) {
  if (document.getElementById("modifyModal")) return;

  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div class="modal-backdrop show" id="modifyModal">
      <div class="modal" style="width:min(520px,94vw)">
        <h3>修改实例</h3>
        <div class="field">
          <label>游戏版本</label>
          <select id="mdVersion"><option value="${esc(instance.mcVersion || "")}">${esc(instance.mcVersion || "?")}</option></select>
        </div>
        <div class="field">
          <label>加载器</label>
          <select id="mdLoader">
            <option value="vanilla">原版</option>
            <option value="fabric">Fabric</option>
            <option value="quilt">Quilt</option>
            <option value="forge">Forge</option>
            <option value="neoforge">NeoForge</option>
          </select>
        </div>
        <div class="field" id="mdLoaderVersionField" style="display:none">
          <label>加载器版本</label>
          <select id="mdLoaderVersion"></select>
        </div>
        <div class="hint" id="mdHint" style="margin:0 0 12px"></div>
        <div class="row">
          <span class="spacer"></span>
          <button class="btn ghost" id="mdCancel">取消</button>
          <button class="btn" id="mdSave">保存</button>
        </div>
        <div id="mdStatus" class="hint" style="margin-top:10px"></div>
      </div>
    </div>`;
  document.body.appendChild(wrapper.firstElementChild);
  const modal = document.getElementById("modifyModal");

  const versionSelect = document.getElementById("mdVersion");
  const loaderSelect = document.getElementById("mdLoader");
  const loaderVersionField = document.getElementById("mdLoaderVersionField");
  const loaderVersionSelect = document.getElementById("mdLoaderVersion");
  const hint = document.getElementById("mdHint");

  loaderSelect.value = instance.loader || "vanilla";
  hint.textContent =
    instance.loader && instance.loader !== "vanilla" && !instance.loaderVersion
      ? "这个实例还没有装加载器，保存后会安装你选的版本。"
      : "换游戏版本会让原有加载器失效；加载器选「原版」即移除。";

  const close = () => modal.remove();
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  document.getElementById("mdCancel").addEventListener("click", close);

  const loadLoaderVersions = async () => {
    const kind = loaderSelect.value;
    const mc = versionSelect.value;
    if (kind === "vanilla" || !mc) {
      loaderVersionField.style.display = "none";
      return;
    }
    loaderVersionField.style.display = "block";
    loaderVersionSelect.innerHTML = `<option value="">加载中…</option>`;
    try {
      const list = await api(`/api/loaders/${kind}?mc=${encodeURIComponent(mc)}`);
      if (!Array.isArray(list) || !list.length) {
        loaderVersionSelect.innerHTML = `<option value="">${esc(list?.message || "这个版本没有可用的 " + kind)}</option>`;
        return;
      }
      loaderVersionSelect.innerHTML = list
        .slice(0, 40)
        .map((v) => {
          const ver = v.version || v.id;
          const tag = v.stable === false ? " (测试版)" : v.type === "latest" ? " (最新)" : "";
          const selected = kind === instance.loader && ver === instance.loaderVersion ? "selected" : "";
          return `<option value="${esc(ver)}" ${selected}>${esc(ver)}${tag}</option>`;
        })
        .join("");
    } catch (error) {
      loaderVersionSelect.innerHTML = `<option value="">${esc(error.message)}</option>`;
    }
  };

  loaderSelect.addEventListener("change", loadLoaderVersions);
  versionSelect.addEventListener("change", loadLoaderVersions);

  // 版本列表
  try {
    if (!state.versions) {
      state.versions = await api(`/api/versions?mirror=${encodeURIComponent(state.settings.mirror || "official")}`);
    }
    const releases = state.versions.versions.filter((v) => v.type === "release");
    versionSelect.innerHTML = releases
      .map((v) => `<option value="${esc(v.id)}" ${v.id === instance.mcVersion ? "selected" : ""}>${esc(v.id)}</option>`)
      .join("");
  } catch (error) {
    hint.textContent = `版本列表加载失败：${error.message}`;
  }
  await loadLoaderVersions();

  document.getElementById("mdSave").addEventListener("click", async () => {
    const btn = document.getElementById("mdSave");
    const status = document.getElementById("mdStatus");
    const mc = versionSelect.value;
    const loader = loaderSelect.value;
    const loaderVersion = loaderVersionSelect.value;
    const mcChanged = mc !== instance.mcVersion;
    const loaderChanged = loader !== (instance.loader || "vanilla") || (loader !== "vanilla" && loaderVersion !== instance.loaderVersion);

    if (!mcChanged && !loaderChanged) {
      status.textContent = "没有改动";
      return;
    }
    if (loader !== "vanilla" && !loaderVersion) {
      status.textContent = "没有可用的加载器版本";
      return;
    }
    if (mcChanged && !confirm(`把游戏版本从 ${instance.mcVersion} 换成 ${mc}？原有的 loader 会失效，需要重新安装。`)) return;

    btn.disabled = true;
    try {
      if (mcChanged) {
        status.textContent = "更新实例信息…";
        await api(`/api/instances/${instance.id}`, {
          method: "PATCH",
          body: JSON.stringify({ mcVersion: mc, loader: "vanilla", loaderVersion: null, profileId: null, installed: false }),
        });
        status.textContent = `下载 ${mc}…`;
        const { jobId } = await api(`/api/versions/${encodeURIComponent(mc)}/install`, { method: "POST", body: "{}" });
        await waitForJob(jobId, (job) => {
          const p = job.progress || {};
          status.textContent = `下载 ${mc}：${labelOf(p.phase)} ${p.done ?? ""}/${p.total ?? ""}`;
        });
      }

      if (loader === "vanilla") {
        await api(`/api/instances/${instance.id}`, {
          method: "PATCH",
          body: JSON.stringify({ loader: "vanilla", loaderVersion: null, profileId: null }),
        });
        status.textContent = "已切回原版";
      } else {
        status.textContent = `安装 ${loader} ${loaderVersion}…`;
        const { jobId } = await api(`/api/instances/${instance.id}/loader`, {
          method: "POST",
          body: JSON.stringify({ kind: loader, version: loaderVersion }),
        });
        await waitForJob(jobId, (job) => {
          const p = job.progress || {};
          status.textContent = `${labelOf(p.phase)} ${p.done ?? ""}/${p.total ?? ""}${p.message ? " " + p.message : ""}`;
        });
        status.textContent = "完成";
      }

      const refreshed = await api("/api/instances");
      state.instances = refreshed;
      renderInstances();
      close();
      renderPanel();
      toast("实例已更新");
    } catch (error) {
      status.textContent = error.message;
      toast(error.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function openExportModal(instance) {
  if (document.getElementById("exportModal")) return;

  let options;
  try {
    options = await api(`/api/instances/${instance.id}/export/options`);
  } catch (error) {
    toast(error.message, "error");
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div class="modal-backdrop show" id="exportModal">
      <div class="modal" style="width:min(600px,94vw)">
        <h3>导出为整合包</h3>
        <div class="row" style="align-items:flex-end;margin-bottom:14px">
          <div class="field" style="flex:1;margin:0">
            <label>整合包名称</label>
            <input id="exName" type="text" value="${esc(options.name)}" />
          </div>
          <div class="field" style="width:120px;margin:0">
            <label>版本</label>
            <input id="exVersion" type="text" value="${esc(options.version)}" />
          </div>
        </div>
        <div class="hint" style="margin:0 0 10px">${esc(options.mcVersion || "?")} · ${esc(options.loader || "vanilla")}${options.loaderVersion ? " " + esc(options.loaderVersion) : ""}</div>
        <div class="card-title">导出内容</div>
        <div id="exGroups" class="list"></div>
        <div class="row" style="margin-top:16px">
          <span class="spacer"></span>
          <button class="btn ghost" id="exCancel">取消</button>
          <button class="btn" id="exStart">开始导出</button>
        </div>
        <div id="exStatus" class="hint" style="margin-top:10px"></div>
      </div>
    </div>`;
  document.body.appendChild(wrapper.firstElementChild);
  const modal = document.getElementById("exportModal");

  const groups = document.getElementById("exGroups");
  groups.innerHTML =
    options.groups
      .map(
        (g) => `<label class="row" style="gap:10px;padding:6px 0;cursor:pointer">
          <input type="checkbox" data-group="${g.key}" ${g.count ? "checked" : "disabled"} />
          <span>${esc(g.label)}</span>
          <span class="hint" style="margin:0">${g.count} 个文件 · ${formatSize(g.size)}</span>
        </label>`
      )
      .join("") || `<div class="hint">这个实例里还没有可导出的内容</div>`;

  const close = () => modal.remove();
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  document.getElementById("exCancel").addEventListener("click", close);

  document.getElementById("exStart").addEventListener("click", async () => {
    const btn = document.getElementById("exStart");
    const status = document.getElementById("exStatus");
    const include = [...modal.querySelectorAll("[data-group]:checked")].map((el) => el.dataset.group);
    if (!include.length) {
      status.textContent = "至少选一项内容";
      return;
    }
    btn.disabled = true;
    status.textContent = "打包中…";
    try {
      const { jobId } = await api(`/api/instances/${instance.id}/export/mrpack`, {
        method: "POST",
        body: JSON.stringify({
          name: document.getElementById("exName").value.trim(),
          version: document.getElementById("exVersion").value.trim() || "1.0.0",
          include,
        }),
      });
      const result = await waitForJob(jobId, (job) => {
        const p = job.progress || {};
        status.textContent = labelOf(p.phase);
      });
      const fileName = result.path.split(/[\\/]/).pop();
      status.innerHTML = `导出完成：${esc(fileName)}（${formatSize(result.size)}）<br>
        <a class="btn small" style="display:inline-block;margin-top:8px;text-decoration:none"
           href="/api/instances/${instance.id}/export/download?file=${encodeURIComponent(fileName)}" download>下载 .mrpack</a>`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      btn.disabled = false;
    }
  });
}

function patchInstance(instance, patch) {
  return api(`/api/instances/${instance.id}`, { method: "PATCH", body: JSON.stringify(patch) })
    .then((updated) => {
      Object.assign(instance, updated);
      renderInstances();
      renderPanel();
    })
    .catch((error) => toast(error.message, "error"));
}

function renderInstanceLogs(body, instance) {
  body.innerHTML = `
    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <strong>运行日志</strong>
        <span class="spacer"></span>
        <button class="btn ghost small" id="clearLog">清空</button>
      </div>
      <pre id="runLog" class="console"></pre>
    </div>
    <div class="job" id="runBanner" style="display:none">
      <div class="job-head"><span class="job-title"></span><span class="job-pct"></span></div>
    </div>`;

  $("#clearLog").addEventListener("click", () => {
    $("#runLog").textContent = "";
  });
}

/* ---------------- run polling ---------------- */

function startRunPolling(runId) {
  stopRunPolling();
  state.run = { id: runId, after: 0 };
  const log = $("#runLog");
  const banner = $("#runBanner");
  if (log) log.textContent = "";
  if (banner) banner.style.display = "block";

  state.run.timer = setInterval(async () => {
    try {
      const data = await api(`/api/runs/${state.run.id}/log?after=${state.run.after}`);
      const log = $("#runLog");
      if (log && data.lines.length) {
        for (const entry of data.lines) {
          log.textContent += entry.line + "\n";
        }
        log.scrollTop = log.scrollHeight;
      }
      state.run.after = data.next;

      const banner = $("#runBanner");
      if (banner) {
        const title = banner.querySelector(".job-title");
        const pct = banner.querySelector(".job-pct");
        if (data.status === "running") {
          title.textContent = "运行中";
          pct.textContent = `PID ${state.run.pid || ""}`;
        } else {
          title.textContent = data.status === "exited" ? "已退出" : "异常退出";
          pct.textContent = `退出码 ${data.exitCode}`;
        }
      }
      if (data.status !== "running") {
        stopRunPolling();
        const launch = $("#launchBtn");
        const stop = $("#stopBtn");
        if (launch) launch.disabled = false;
        if (stop) stop.disabled = true;
      }
    } catch {
      // server restarted; stop polling quietly
      stopRunPolling();
    }
  }, 1000);
}

function stopRunPolling() {
  if (state.run?.timer) clearInterval(state.run.timer);
  state.run = null;
  const stop = $("#stopBtn");
  if (stop) stop.disabled = true;
  const launch = $("#launchBtn");
  if (launch) launch.disabled = false;
}

async function restoreRun() {
  try {
    const runs = await api(`/api/runs?instanceId=${state.selectedId}`);
    const running = runs.find((r) => r.status === "running");
    if (running) startRunPolling(running.id);
  } catch {
    // ignore
  }
}

function trackJob(jobId, container) {
  const node = $("#jobTemplate").content.firstElementChild.cloneNode(true);
  container.appendChild(node);
  const title = node.querySelector(".job-title");
  const pct = node.querySelector(".job-pct");
  const fill = node.querySelector(".bar-fill");
  const detail = node.querySelector(".job-detail");

  const timer = setInterval(async () => {
    let job;
    try {
      job = await api(`/api/jobs/${jobId}`);
    } catch {
      return;
    }
    const p = job.progress || {};
    title.textContent = labelOf(p.phase);
    if (typeof p.done === "number" && p.total) {
      const percent = Math.min(100, Math.round((p.done / p.total) * 100));
      fill.style.width = `${percent}%`;
      pct.textContent = `${percent}%`;
      detail.textContent = `${p.done} / ${p.total}${p.file ? " · " + p.file : ""}`;
    } else {
      fill.style.width = "40%";
      pct.textContent = "";
      detail.textContent = p.message || "";
    }

    if (job.status === "done") {
      clearInterval(timer);
      fill.style.width = "100%";
      title.textContent = "完成";
      setTimeout(() => node.remove(), 2500);
      if (job.type === "modpack") {
        const instance = job.result?.instance;
        if (instance) {
          state.instances.unshift(instance);
          state.selectedId = instance.id;
          renderInstances();
          if (state.tab === "instances") renderPanel();
        }
      }
    } else if (job.status === "failed") {
      clearInterval(timer);
      title.textContent = "失败";
      pct.textContent = "";
      fill.style.background = "var(--danger)";
      detail.textContent = job.error;
      node.querySelector(".bar").style.opacity = ".5";
    }
  }, 600);
}

function labelOf(phase) {
  const map = {
    starting: "准备中",
    meta: "读取版本信息",
    client: "下载客户端 jar",
    libraries: "下载依赖库",
    assets: "下载资源文件",
    files: "下载整合包文件",
    download: "下载",
    resolve: "解析前置依赖",
    extract: "解压",
    done: "完成",
    warn: "提示",
  };
  if (!phase) return "处理中";
  if (phase.startsWith("game:")) return "下载游戏 " + labelOf(phase.slice(5));
  return map[phase] || phase;
}

/* ---------------- resources (mods / packs / worlds) ---------------- */

function renderResourceSection(body, type) {
  const label = DOWNLOAD_TABS.find((t) => t.key === type)?.label || type;
  const instances = state.instances;
  const current = instances.find((i) => i.id === state.selectedId) || instances[0];
  const onlyCurseForge = type === "world";

  body.innerHTML = `
    <p class="hint">${esc(RESOURCE_HINT[type] || "")}</p>
    <div class="row" style="margin-bottom:10px">
      <select id="resSource">
        <option value="modrinth" ${onlyCurseForge ? "disabled" : ""}>Modrinth</option>
        <option value="curseforge" ${onlyCurseForge ? "selected" : ""}>CurseForge</option>
      </select>
      <input id="resQuery" class="grow" type="search" placeholder="搜索${esc(label)}" />
      <button class="btn" id="resSearch">搜索</button>
    </div>
    <div class="row" style="margin-bottom:14px">
      <span class="hint" style="margin:0">装到实例：</span>
      <select id="resInstance">
        ${
          instances
            .map(
              (i) =>
                `<option value="${i.id}" ${i.id === current?.id ? "selected" : ""}>${esc(i.name)}（${esc(i.mcVersion || "?")}）</option>`
            )
            .join("") || `<option value="">（还没有实例，先去新建）</option>`
        }
      </select>
    </div>
    <div id="resList" class="list"></div>
    <div id="resJobs"></div>`;

  const draw = (results) => {
    $("#resList").innerHTML =
      results
        .map(
          (r) => `<div class="item">
            ${r.icon ? `<img src="${esc(r.icon)}" alt="" />` : ""}
            <div>
              <div class="title">${esc(r.title)}</div>
              <div class="sub">${esc(String(r.description || "").slice(0, 110))}</div>
            </div>
            <span class="spacer"></span>
            <span class="badge">${Number(r.downloads || 0).toLocaleString()}</span>
            <button class="btn small" data-slug="${esc(r.slug)}" data-id="${esc(r.id)}">版本</button>
          </div>`
        )
        .join("") || `<div class="hint">没有结果</div>`;

    $("#resList").querySelectorAll("[data-slug]").forEach((btn) =>
      btn.addEventListener("click", () =>
        showVersions(btn.dataset.slug, btn.dataset.id, btn.closest(".item"))
      )
    );
  };

  const showVersions = async (slug, id, item) => {
    const source = $("#resSource").value;
    const instance = state.instances.find((i) => i.id === $("#resInstance").value);
    const box = document.createElement("div");
    box.className = "card";
    box.innerHTML = `<div class="hint">加载版本…</div>`;
    item.after(box);
    try {
      const params = new URLSearchParams({ source, mc: instance?.mcVersion || "" });
      if (source === "curseforge") params.set("modId", id);
      else {
        params.set("slug", slug);
        if (instance?.loader) params.set("loader", instance.loader);
      }
      const versions = await api(`/api/resources/versions?${params}`);
      box.innerHTML =
        versions
          .slice(0, 15)
          .map(
            (v) => `<div class="row" style="padding:6px 0">
              <div>
                <div class="title">${esc(v.name || v.fileName)}</div>
                <div class="sub">${esc((v.gameVersions || []).slice(0, 6).join(", "))}${v.loaders ? " · " + esc(v.loaders.join(", ")) : ""}</div>
              </div>
              <span class="spacer"></span>
              <button class="btn small" data-version="${esc(v.id)}" data-name="${esc(v.name || v.fileName)}">安装</button>
            </div>`
          )
          .join("") || `<div class="hint">这个版本没有匹配的文件</div>`;

      box.querySelectorAll("[data-version]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const payload =
              source === "curseforge"
                ? { type, instanceId: $("#resInstance").value, source, modId: id, fileId: btn.dataset.version, name: btn.dataset.name }
                : { type, instanceId: $("#resInstance").value, source, slug, versionId: btn.dataset.version, name: btn.dataset.name };
            const { jobId } = await api("/api/resources/install", {
              method: "POST",
              body: JSON.stringify(payload),
            });
            trackJob(jobId, $("#resJobs"));
          } catch (error) {
            toast(error.message, "error");
            btn.disabled = false;
          }
        })
      );
    } catch (error) {
      box.innerHTML = `<div class="hint">${esc(error.message)}</div>`;
    }
  };

  const search = async () => {
    const source = $("#resSource").value;
    const q = $("#resQuery").value.trim();
    const instance = state.instances.find((i) => i.id === $("#resInstance").value);
    const params = new URLSearchParams({ type, source, q, mc: instance?.mcVersion || "" });
    if (instance?.loader) params.set("loader", instance.loader);
    $("#resList").innerHTML = `<div class="hint">搜索中…</div>`;
    try {
      draw(await api(`/api/resources/search?${params}`));
    } catch (error) {
      $("#resList").innerHTML = `<div class="hint">${esc(error.message)}</div>`;
    }
  };

  $("#resSearch").addEventListener("click", search);
  $("#resQuery").addEventListener("keydown", (e) => e.key === "Enter" && search());
  $("#resInstance").addEventListener("change", search);
  $("#resSource").addEventListener("change", search);
  search();
}

/* ---------------- versions ---------------- */

async function renderGameVersions(body) {
  body.innerHTML = `
    <p class="hint">拉取 Mojang 版本清单，选中后下载客户端、依赖库与资源文件。</p>
    <div class="row" style="margin-bottom:12px">
      <input id="versionSearch" class="grow" type="search" placeholder="搜索版本号，例如 1.20.1" value="${esc(state.versionsFilter)}" />
      <select id="versionType">
        <option value="release">正式版</option>
        <option value="all">全部</option>
      </select>
    </div>
    <div id="versionList" class="list"></div>
    <div id="versionJobs"></div>`;
  const list = $("#versionList");
  list.innerHTML = `<div class="hint">加载中…</div>`;

  if (!state.versions) {
    try {
      state.versions = await api(`/api/versions?mirror=${encodeURIComponent(state.settings.mirror || "official")}`);
    } catch (error) {
      list.innerHTML = `<div class="hint">${esc(error.message)}</div>`;
      return;
    }
  }

  const draw = () => {
    const query = state.versionsFilter.trim().toLowerCase();
    const type = $("#versionType").value;
    const items = state.versions.versions
      .filter((v) => (type === "all" ? true : v.type === "release"))
      .filter((v) => !query || v.id.toLowerCase().includes(query))
      .slice(0, 120);
    list.innerHTML =
      items
        .map(
          (v) => `<div class="item">
            <div>
              <div class="title">${esc(v.id)}</div>
              <div class="sub">${esc(v.type)} · ${new Date(v.releaseTime).toLocaleDateString()}</div>
            </div>
            <span class="spacer"></span>
            <button class="btn small" data-install="${esc(v.id)}">安装</button>
          </div>`
        )
        .join("") || `<div class="hint">没有匹配的版本</div>`;

    list.querySelectorAll("[data-install]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const { jobId } = await api(`/api/versions/${encodeURIComponent(btn.dataset.install)}/install`, {
            method: "POST",
            body: JSON.stringify({ mirror: state.settings.mirror || "official" }),
          });
          trackJob(jobId, $("#versionJobs"));
        } catch (error) {
          toast(error.message, "error");
          btn.disabled = false;
        }
      })
    );
  };

  $("#versionSearch").addEventListener("input", (e) => {
    state.versionsFilter = e.target.value;
    draw();
  });
  $("#versionType").addEventListener("change", draw);
  draw();
}

/* ---------------- modpacks ---------------- */

function renderModpackSection(body) {  body.innerHTML = `
    <p class="hint">整包安装会新建一个实例，loader 会一并装好。已有的 .mrpack / 整合包 zip 直接导入就行。</p>
    <div class="row" style="margin-bottom:14px">
      <select id="packSource">
        <option value="modrinth">Modrinth</option>
        <option value="curseforge">CurseForge</option>
      </select>
      <input id="modpackSearch" class="grow" type="search" placeholder="搜索整合包，例如 create" value="${esc(state.modpackQuery)}" />
      <button class="btn" id="doSearch">搜索</button>
      <button class="btn" id="doImport">导入本地整合包</button>
      <input id="modpackFile" type="file" accept=".mrpack,.zip" hidden />
    </div>
    <div id="modpackList" class="list"></div>
    <div id="modpackJobs"></div>`;

  const draw = () => {
    $("#modpackList").innerHTML =
      state.modpackResults
        .map(
          (pack) => `<div class="item" data-slug="${esc(pack.slug)}" data-id="${esc(pack.id)}">
            ${pack.icon ? `<img src="${esc(pack.icon)}" alt="" />` : ""}
            <div>
              <div class="title">${esc(pack.title)}</div>
              <div class="sub">${esc(pack.description.slice(0, 110))}</div>
            </div>
            <span class="spacer"></span>
            <span class="badge">${(pack.downloads || 0).toLocaleString()} 下载</span>
            <button class="btn small" data-versions="${esc(pack.slug)}" data-packid="${esc(pack.id)}">版本</button>
          </div>`
        )
        .join("") || `<div class="hint">${state.modpackQuery ? "没有结果" : "输入关键词后搜索"}</div>`;

    $("#modpackList").querySelectorAll("[data-versions]").forEach((btn) =>
      btn.addEventListener("click", () =>
        showVersions(btn.dataset.versions, btn.dataset.packid, btn.closest(".item"))
      )
    );
  };

  const search = async () => {
    state.modpackQuery = $("#modpackSearch").value.trim();
    const source = $("#packSource").value;
    $("#modpackList").innerHTML = `<div class="hint">搜索中…</div>`;
    try {
      state.modpackResults = await api(
        `/api/modpack/search?source=${source}&q=${encodeURIComponent(state.modpackQuery)}`
      );
      draw();
    } catch (error) {
      $("#modpackList").innerHTML = `<div class="hint">${esc(error.message)}</div>`;
    }
  };

  const showVersions = async (slug, modId, item) => {
    const source = $("#packSource").value;
    const box = document.createElement("div");
    box.className = "card";
    box.innerHTML = `<div class="hint">加载版本…</div>`;
    item.after(box);
    try {
      const versions =
        source === "curseforge"
          ? await api(`/api/modpack/cf/${encodeURIComponent(modId)}/files`)
          : await api(`/api/modpack/${encodeURIComponent(slug)}/versions`);

      box.innerHTML = versions
        .slice(0, 15)
        .map(
          (v) => `<div class="row" style="padding:6px 0">
            <div>
              <div class="title">${esc(v.name)}</div>
              <div class="sub">${esc((v.gameVersions || []).join(", "))}${v.loaders ? " · " + esc(v.loaders.join(", ")) : ""}</div>
            </div>
            <span class="spacer"></span>
            <button class="btn small" data-version="${esc(v.id)}" data-name="${esc(v.name)}">安装</button>
          </div>`
        )
        .join("");
      box.querySelectorAll("[data-version]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const payload =
              source === "curseforge"
                ? { source: "curseforge", modId, fileId: btn.dataset.version, name: btn.dataset.name }
                : { source: "modrinth", slug, versionId: btn.dataset.version, name: btn.dataset.name };
            const { jobId } = await api("/api/modpack/install", {
              method: "POST",
              body: JSON.stringify(payload),
            });
            trackJob(jobId, $("#modpackJobs"));
          } catch (error) {
            toast(error.message, "error");
            btn.disabled = false;
          }
        })
      );
    } catch (error) {
      box.innerHTML = `<div class="hint">${esc(error.message)}</div>`;
    }
  };

  $("#doSearch").addEventListener("click", search);
  $("#modpackSearch").addEventListener("keydown", (e) => e.key === "Enter" && search());
  $("#doImport").addEventListener("click", () => $("#modpackFile").click());
  $("#modpackFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    try {
      const { jobId } = await api(`/api/modpack/import?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      trackJob(jobId, $("#modpackJobs"));
    } catch (error) {
      toast(error.message, "error");
    }
  });

  draw();
  if (!state.modpackResults.length) search();
}

/* ---------------- accounts ---------------- */

function renderAccountsPanel(panel) {
  panel.innerHTML = `
    <h2>正版账号</h2>
    <p class="hint">用微软账号登录，只接受正版。</p>
    <div class="card">
      <div class="row">
        <button class="btn" id="startLogin">打开微软登录页</button>
        <span class="badge">第 1 步</span>
      </div>
      <div class="row" style="margin-top:12px">
        <input id="authCode" class="grow" placeholder="第 2 步：把地址栏里的 code 或整条网址粘到这里" />
        <button class="btn ghost" id="submitCode">完成登录</button>
      </div>
    </div>
    <div class="list" id="accountList"></div>`;

  $("#startLogin").addEventListener("click", async () => {
    try {
      const { url } = await api("/api/auth/url", { method: "POST" });
      window.open(url, "_blank", "noopener");
      toast("登录完成后，把地址栏整条粘贴到输入框");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  $("#submitCode").addEventListener("click", async () => {
    const code = $("#authCode").value;
    if (!code.trim()) return toast("先粘贴 code", "error");
    const btn = $("#submitCode");
    btn.disabled = true;
    try {
      const account = await api("/api/auth/code", { method: "POST", body: JSON.stringify({ code }) });
      state.accounts.push(account);
      drawAccounts();
      $("#authCode").value = "";
      toast(`登录成功：${account.name}`);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      btn.disabled = false;
    }
  });

  const drawAccounts = () => {
    $("#accountList").innerHTML =
      state.accounts
        .map(
          (a) => `<div class="item">
            <div>
              <div class="title">${esc(a.name)}</div>
              <div class="sub">${esc(a.uuid)}</div>
            </div>
            <span class="spacer"></span>
            <button class="btn ghost small" data-remove="${esc(a.uuid)}">移除</button>
          </div>`
        )
        .join("") || `<div class="hint">还没有登录账号</div>`;

    $("#accountList").querySelectorAll("[data-remove]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await api(`/api/accounts/${btn.dataset.remove}`, { method: "DELETE" });
        state.accounts = state.accounts.filter((a) => a.uuid !== btn.dataset.remove);
        drawAccounts();
      })
    );
  };
  drawAccounts();
}

/* ---------------- settings ---------------- */

function renderSettingsPanel(panel) {
  panel.innerHTML = `
    <h2>设置</h2>
    <p class="hint">下载源、内存、Java 路径、数据目录。</p>
    <div class="card">
      <div class="field">
        <label>下载源</label>
        <select id="mirrorSelect">
          <option value="official">Mojang 官方源</option>
          <option value="bmclapi">BMCLAPI 镜像（国内推荐）</option>
        </select>
      </div>
      <div class="field">
        <label>默认内存（MB）</label>
        <input id="memoryMb" type="number" min="1024" step="512" />
      </div>
      <div class="field">
        <label>Java 路径（留空自动检测）</label>
        <div class="row">
          <input id="javaPath" type="text" placeholder="例如 C:\Program Files\Eclipse Adoptium\jdk-21\bin\java.exe" />
          <button class="btn ghost small" id="detectJava">检测</button>
        </div>
        <div id="javaList" class="hint" style="margin-top:8px"></div>
      </div>
      <div class="field">
        <label>CurseForge API Key（可选）</label>
        <input id="cfKey" type="text" placeholder="没有就留空，CurseForge 搜索会用不了" />
      </div>
      <button class="btn" id="saveSettings">保存</button>
    </div>

    <div class="card">
      <div class="card-title">已有启动器</div>
      <div class="row" style="margin-bottom:10px">
        <button class="btn ghost small" id="scanDirs">扫描本机</button>
        <input id="scanExtra" class="grow" type="text" placeholder="也可以手动填游戏目录，多个用 | 分隔" />
      </div>
      <div id="dirList" class="list"><div class="hint">点「扫描本机」找 PCL / HMCL / PCL CE 的游戏目录</div></div>
    </div>

    <div class="card">
      <div class="card-title">游戏文件目录</div>
      <div class="row">
        <input id="gameDir" class="grow" type="text" value="${esc(state.settings.gameDir || "")}" placeholder="留空 = 跟数据目录一致" />
        <button class="btn ghost small" id="saveGameDir">更改</button>
      </div>
      <div class="hint" style="margin:8px 0 0">版本、依赖库、资源文件都下到这里（几十 GB 级别），可以单独指到别的盘。<br>
        改完要重启启动器才生效。</div>
    </div>

    <div class="card">
      <div class="card-title">数据目录</div>
      <div class="row">
        <input id="dataDir" class="grow" type="text" value="${esc(state.settings.dataDir || "")}" />
        <button class="btn ghost small" id="saveDataDir">更改</button>
      </div>
      <div class="hint" style="margin:8px 0 0">实例、账号、设置放在这里。<br>
        改完要重启启动器才生效。</div>
    </div>`;

  $("#mirrorSelect").value = state.settings.mirror || "official";
  $("#memoryMb").value = state.settings.memoryMb || 2048;
  $("#javaPath").value = state.settings.javaPath || "";
  $("#cfKey").value = state.settings.curseForgeKey || "";

  $("#detectJava").addEventListener("click", async () => {
    const box = $("#javaList");
    box.textContent = "检测中…";
    try {
      const list = await api("/api/java");
      box.innerHTML = list.length
        ? list
            .map(
              (j) =>
                `<div class="row" style="gap:8px;margin:4px 0"><span class="badge ok">Java ${esc(String(j.major))}</span><span class="mono">${esc(j.path)}</span></div>`
            )
            .join("")
        : "没找到已安装的 Java";
    } catch (error) {
      box.textContent = error.message;
    }
  });

  $("#saveSettings").addEventListener("click", async () => {
    try {
      state.settings = await api("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          mirror: $("#mirrorSelect").value,
          memoryMb: Number($("#memoryMb").value) || 2048,
          javaPath: $("#javaPath").value.trim(),
          curseForgeKey: $("#cfKey").value.trim(),
        }),
      });
      state.versions = null;
      toast("已保存");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  $("#saveDataDir").addEventListener("click", async () => {
    const dir = $("#dataDir").value.trim();
    if (!dir) return toast("路径不能为空", "error");
    try {
      const res = await api("/api/settings/location", {
        method: "POST",
        body: JSON.stringify({ path: dir }),
      });
      state.settings.dataDir = res.path;
      toast(res.restartRequired ? "已保存，重启启动器后生效" : "已保存");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  $("#saveGameDir").addEventListener("click", async () => {
    const dir = $("#gameDir").value.trim();
    try {
      const res = await api("/api/settings/game-dir", {
        method: "POST",
        body: JSON.stringify({ path: dir }),
      });
      toast(dir ? "游戏文件目录已保存，重启后生效" : "已恢复为跟数据目录一致，重启后生效");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  const renderDirs = (list) => {
    const box = $("#dirList");
    if (!list.length) {
      box.innerHTML = `<div class="hint">没找到，试试手动填路径再扫描</div>`;
      return;
    }
    box.innerHTML = list
      .map(
        (d) => `<div class="item" style="flex-wrap:wrap">
          <div style="min-width:0">
            <div class="title">${esc(d.path)} <span class="badge">${esc(d.source)}</span></div>
            <div class="sub">${d.versions.length} 个版本 · ${d.mods} 个 mod${d.hasAssets ? " · 有资源文件" : ""}</div>
          </div>
          <span class="spacer"></span>
          <button class="btn ghost small" data-use="${esc(d.path)}">设为游戏目录</button>
          <button class="btn small" data-import="${esc(d.path)}">导入实例</button>
          <div class="dir-versions" style="display:none;width:100%;margin-top:10px"></div>
        </div>`
      )
      .join("");

    box.querySelectorAll("[data-use]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        try {
          await api("/api/settings/game-dir", {
            method: "POST",
            body: JSON.stringify({ path: btn.dataset.use }),
          });
          toast("已设为游戏文件目录，重启启动器后生效");
        } catch (error) {
          toast(error.message, "error");
        }
      })
    );

    box.querySelectorAll("[data-import]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const item = btn.closest(".item");
        const panel = item.querySelector(".dir-versions");
        if (panel.style.display === "block") {
          panel.style.display = "none";
          return;
        }
        const info = list.find((d) => d.path === btn.dataset.import);
        if (!info) return;
        panel.style.display = "block";
        panel.innerHTML =
          info.versions.length === 0
            ? `<div class="hint">这个目录里没有可用版本</div>`
            : `<div class="hint" style="margin:0 0 6px">选一个版本导入（会复制它的 mods/config 到新实例）：</div>` +
              info.versions
                .slice(0, 30)
                .map(
                  (v) =>
                    `<button class="btn ghost small" style="margin:2px 4px 2px 0"
                       data-ver="${esc(v.id)}" data-dir="${esc(d.path)}">${esc(v.id)}${v.mods ? ` (${v.mods} mod)` : ""}</button>`
                )
                .join("");
        panel.querySelectorAll("[data-ver]").forEach((b) =>
          b.addEventListener("click", async () => {
            b.disabled = true;
            try {
              const res = await api("/api/instances/import-external", {
                method: "POST",
                body: JSON.stringify({ dir: b.dataset.dir, versionId: b.dataset.ver }),
              });
              state.instances.unshift(res.instance);
              toast(`已导入实例（复制 ${res.copied} 个文件）`);
              state.selectedId = res.instance.id;
              renderInstances();
            } catch (error) {
              toast(error.message, "error");
              b.disabled = false;
            }
          })
        );
      })
    );
  };

  $("#scanDirs").addEventListener("click", async () => {
    const box = $("#dirList");
    box.innerHTML = `<div class="hint">扫描中…</div>`;
    try {
      const extra = $("#scanExtra").value.trim();
      renderDirs(await api(`/api/detect/game-dirs${extra ? "?path=" + encodeURIComponent(extra) : ""}`));
    } catch (error) {
      box.innerHTML = `<div class="hint">${esc(error.message)}</div>`;
    }
  });
}

boot();
