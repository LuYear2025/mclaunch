import { paths, readJson, writeJson } from "../paths.js";

// Public Xbox Live application id used by the legacy live.com OAuth flow.
// It is Microsoft's own well-known id, not a private secret.
const CLIENT_ID = "00000000402b5328";
const SCOPE = "service::user.auth.xboxlive.com::MBI_SSL";
const REDIRECT_URI = "https://login.live.com/oauth20_desktop.srf";
const TOKEN_URL = "https://login.live.com/oauth20_token.srf";

export const authEndpoints = {
  authorize:
    "https://login.live.com/oauth20_authorize.srf" +
    `?client_id=${CLIENT_ID}` +
    "&response_type=code" +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
  redirectUri: REDIRECT_URI,
};

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status} ${url}`);
    error.status = res.status;
    error.body = json;
    throw error;
  }
  return json;
}

async function postForm(url, form) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(json.error_description || json.error || `HTTP ${res.status}`);
    error.status = res.status;
    error.body = json;
    throw error;
  }
  return json;
}

async function xblAuthenticate(accessToken) {
  // 微软两套写法都还在用：新版要 "d=" 前缀，老版直接给 token。两个都试，兼容性最好。
  let lastError;
  for (const rpsTicket of [`d=${accessToken}`, accessToken]) {
    try {
      return await postJson("https://user.auth.xboxlive.com/user/authenticate", {
        Properties: {
          AuthMethod: "RPS",
          SiteName: "user.auth.xboxlive.com",
          RpsTicket: rpsTicket,
        },
        RelyingParty: "http://auth.xboxlive.com",
        TokenType: "JWT",
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Xbox Live 登录被拒（HTTP ${lastError?.status ?? "?"}）：${describeBody(lastError?.body)}`
  );
}

function describeBody(body) {
  if (!body) return "无返回内容";
  if (typeof body === "string") return body.slice(0, 200);
  return body.XErr ? `XErr ${body.XErr} ${body.Message || ""}` : JSON.stringify(body).slice(0, 200);
}

async function loginWithXbox(accessToken) {
  const xbl = await xblAuthenticate(accessToken);

  const xsts = await postJson("https://xsts.auth.xboxlive.com/xsts/authorize", {
    Properties: {
      SandboxId: "RETAIL",
      UserTokens: [xbl.Token],
    },
    RelyingParty: "rp://api.minecraftservices.com/",
    TokenType: "JWT",
  });

  const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;
  const mc = await postJson("https://api.minecraftservices.com/authentication/login_with_xbox", {
    identityToken: `XBL3.0 x=${uhs};${xsts.Token}`,
  });

  const profileRes = await fetch("https://api.minecraftservices.com/minecraft/profile", {
    headers: { Authorization: `Bearer ${mc.access_token}` },
  });
  if (profileRes.status === 404) {
    throw new Error("这个微软账号没有购买 Minecraft（未找到正版档案）");
  }
  if (!profileRes.ok) throw new Error(`获取 MC 档案失败：HTTP ${profileRes.status}`);
  const profile = await profileRes.json();

  return {
    uuid: formatUuid(profile.id),
    name: profile.name,
    skins: profile.skins || [],
    accessToken: mc.access_token,
    mcTokenExpiresAt: Date.now() + (mc.expires_in ?? 86400) * 1000,
  };
}

export async function loginWithCode(rawCode) {
  const code = extractCode(rawCode);
  const token = await postForm(TOKEN_URL, {
    client_id: CLIENT_ID,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });
  const account = await loginWithXbox(token.access_token);
  return {
    ...account,
    refreshToken: token.refresh_token,
    msTokenExpiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    createdAt: Date.now(),
  };
}

export async function refreshAccount(account) {
  const token = await postForm(TOKEN_URL, {
    client_id: CLIENT_ID,
    refresh_token: account.refreshToken,
    grant_type: "refresh_token",
    redirect_uri: REDIRECT_URI,
  });
  const refreshed = await loginWithXbox(token.access_token);
  return {
    ...account,
    ...refreshed,
    refreshToken: token.refresh_token ?? account.refreshToken,
    msTokenExpiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
  };
}

/** Accepts a full redirect URL pasted by the user or a bare code. */
export function extractCode(input) {
  const text = String(input || "").trim();
  if (!text) throw new Error("没有收到授权码");
  try {
    const url = new URL(text);
    const code = url.searchParams.get("code");
    if (code) return code;
  } catch {
    // not a URL, treat as raw code
  }
  return text;
}

function formatUuid(id) {
  const raw = String(id).replace(/-/g, "");
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    raw.slice(12, 16),
    raw.slice(16, 20),
    raw.slice(20),
  ].join("-");
}

export function listAccounts() {
  return readJson(paths.accounts, []);
}

export function saveAccount(account) {
  const accounts = listAccounts();
  const index = accounts.findIndex((a) => a.uuid === account.uuid);
  if (index >= 0) accounts[index] = account;
  else accounts.push(account);
  writeJson(paths.accounts, accounts);
  return account;
}

export function removeAccount(uuid) {
  const accounts = listAccounts().filter((a) => a.uuid !== uuid);
  writeJson(paths.accounts, accounts);
}
