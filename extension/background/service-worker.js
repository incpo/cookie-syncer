"use strict";

// ─── Constants ────────────────────────────────────────────────────
const HEARTBEAT_MINUTES = 180;
const AUTO_SYNC_MINUTES = 2;
const PBKDF2_ITERATIONS = 600000;
const DEBOUNCE_MS = 5000;

const CONFIG_DEFAULTS = {
  serverUrl: "",
  roomId: "",
  secret: "",
  role: "",
  autoSync: false,
  lastSyncTs: 0,
  domains: [],
  domainHashes: {},
};

const SESSION_DEFAULTS = {
  serverSecret: "",
};

// ─── Crypto ───────────────────────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(str) {
  const bin = atob(str);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

async function deriveKey(secret, roomId) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]
  );
  const salt = await crypto.subtle.digest("SHA-256", enc.encode(roomId));
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new Uint8Array(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encrypt(data, secret, roomId) {
  const key = await deriveKey(secret, roomId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data))
  );
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), 12);
  return toBase64(combined);
}

async function decrypt(encoded, secret, roomId) {
  const key = await deriveKey(secret, roomId);
  const combined = fromBase64(encoded);
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv }, key, ct
  );
  return JSON.parse(dec.decode(plain));
}

// ─── Storage Client ───────────────────────────────────────────────
async function apiRequest(method, url, data, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });
  if (res.status === 401) throw new Error("Unauthorized — check your server secret");
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

function createRoom(serverUrl, token) { return apiRequest("POST", `${serverUrl}/room`, undefined, token); }
function getRoom(serverUrl, roomId, token) { return apiRequest("GET", `${serverUrl}/room/${roomId}`, undefined, token); }
function updateRoom(serverUrl, roomId, data, token) { return apiRequest("PUT", `${serverUrl}/room/${roomId}`, { data }, token); }

// ─── Config ───────────────────────────────────────────────────────
async function getConfig() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(CONFIG_DEFAULTS),
    chrome.storage.session.get(SESSION_DEFAULTS),
  ]);
  return { ...local, ...session };
}

async function saveConfig(partial) {
  const sessionKeys = Object.keys(SESSION_DEFAULTS);
  const sessionData = {};
  const localData = {};
  for (const [k, v] of Object.entries(partial)) {
    if (sessionKeys.includes(k)) sessionData[k] = v;
    else localData[k] = v;
  }
  const ops = [];
  if (Object.keys(localData).length) ops.push(chrome.storage.local.set(localData));
  if (Object.keys(sessionData).length) ops.push(chrome.storage.session.set(sessionData));
  await Promise.all(ops);
}

async function clearConfig() {
  await Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]);
}

// ─── Cookie Manager ──────────────────────────────────────────────
function cookieUrl(cookie) {
  // Always use https — Chrome rejects http:// for cookies with domain attributes
  const host = (cookie.domain || "").replace(/^\./, "");
  return `https://${host}${cookie.path || "/"}`;
}

async function listCookies(domain) {
  // Query exact domain + all parent domains to catch .google.com cookies on gemini.google.com etc.
  const parts = domain.split(".");
  const domains = new Set();
  domains.add(domain);
  for (let i = 1; i < parts.length - 1; i++) {
    domains.add(parts.slice(i).join("."));
  }

  const seen = new Map(); // name+domain+path → cookie (dedup)
  for (const d of domains) {
    const cookies = await chrome.cookies.getAll({ domain: d });
    for (const c of cookies) {
      const key = `${c.name}|${c.domain}|${c.path}`;
      if (!seen.has(key)) seen.set(key, c);
    }
  }
  return [...seen.values()];
}

async function setCookies(cookies) {
  let ok = 0, fail = 0;
  for (const c of cookies) {
    try {
      // Normalize sameSite: null/undefined/"unspecified" → "lax"
      let sameSite = "lax";
      if (c.sameSite === "no_restriction" || c.sameSite === "none") {
        sameSite = "no_restriction";
      } else if (c.sameSite === "strict") {
        sameSite = "strict";
      }

      // Chrome requires secure=true for sameSite="no_restriction" (SameSite=None)
      const secure = sameSite === "no_restriction" ? true : (c.secure || false);

      const details = {
        url: cookieUrl(c),
        name: c.name,
        value: c.value || "",
        path: c.path || "/",
        secure,
        httpOnly: c.httpOnly || false,
        sameSite,
      };

      // __Host- cookies MUST NOT have a domain attribute (browser security requirement)
      // __Secure- cookies are fine with domain
      const isHostPrefix = c.name.startsWith("__Host-");
      if (c.domain && !isHostPrefix) details.domain = c.domain;
      // __Host- cookies also require path="/" and secure=true
      if (isHostPrefix) {
        details.secure = true;
        details.path = "/";
      }

      // Only set expirationDate for persistent cookies (not session cookies)
      if (c.expirationDate && !c.session) {
        details.expirationDate = c.expirationDate;
      } else if (!c.session) {
        details.expirationDate = Date.now() / 1000 + 365 * 24 * 3600;
      }
      // session cookies: omit expirationDate entirely

      const result = await chrome.cookies.set(details);
      if (result) {
        ok++;
      } else {
        // chrome.cookies.set returns null on failure without throwing
        console.warn(`[CookieSync] set returned null for "${c.name}" — details:`, JSON.stringify(details), "original:", JSON.stringify(c));
        fail++;
      }
    } catch (err) {
      console.error(`[CookieSync] set THREW "${c.name}":`, err.message, "details:", JSON.stringify(c));
      fail++;
    }
  }
  return { ok, fail };
}

async function hashCookies(cookies) {
  const sorted = [...cookies].sort((a, b) => a.name.localeCompare(b.name));
  const str = sorted.map((c) => `${c.name}=${c.value}`).join("|");
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return toBase64(hash);
}

// ─── Helpers ──────────────────────────────────────────────────────
function generateSecret(len = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

function normalizeDomain(d) {
  return (d || "").replace(/^\./, "").toLowerCase();
}

// ─── Sync Engine (multi-domain) ──────────────────────────────────
let debounceTimer = null;

async function pushCookies() {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.roomId || !cfg.secret || cfg.role !== "exit_node") return;
  if (!cfg.domains || cfg.domains.length === 0) return;

  try {
    const domainPayloads = [];
    const newHashes = { ...cfg.domainHashes };
    let anyChanged = false;

    for (const domain of cfg.domains) {
      const cookies = await listCookies(domain);
      const hash = await hashCookies(cookies);
      if (hash !== (cfg.domainHashes[domain] || "")) anyChanged = true;
      newHashes[domain] = hash;
      domainPayloads.push({ domain, cookies });
    }

    if (!anyChanged) {
      console.log("[CookieSync] push: skipped (all domains unchanged)");
      return;
    }

    const payload = { v: 2, ts: Date.now(), domains: domainPayloads };
    const encrypted = await encrypt(payload, cfg.secret, cfg.roomId);
    await updateRoom(cfg.serverUrl, cfg.roomId, encrypted, cfg.serverSecret);
    await saveConfig({ lastSyncTs: Date.now(), domainHashes: newHashes });
    console.log(`[CookieSync] push: ${cfg.domains.length} domains, ${domainPayloads.reduce((s, d) => s + d.cookies.length, 0)} cookies`);
  } catch (err) {
    console.error("[CookieSync] push failed:", err);
  }
}

async function pullCookies() {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.roomId || !cfg.secret || cfg.role !== "receiver") {
    return { error: "Not configured as receiver" };
  }

  try {
    const res = await getRoom(cfg.serverUrl, cfg.roomId, cfg.serverSecret);
    if (!res.data) return { error: "Room is empty — exit node hasn't pushed yet" };

    const payload = await decrypt(res.data, cfg.secret, cfg.roomId);

    if (payload.v !== 2 && payload.v !== 1) throw new Error("Unsupported payload version");

    let totalOk = 0, totalFail = 0;

    // Handle v1 (single domain) for backward compat
    const domainList = payload.v === 2
      ? payload.domains
      : [{ domain: payload.domain, cookies: payload.cookies }];

    for (const { domain, cookies } of domainList) {
      const { ok, fail } = await setCookies(cookies);
      totalOk += ok;
      totalFail += fail;
    }

    const domains = domainList.map((d) => d.domain);
    await saveConfig({ domains, lastSyncTs: Date.now() });
    console.log(`[CookieSync] pull: ${domains.length} domains, ${totalOk} ok, ${totalFail} failed`);
    return { success: true, applied: totalOk, failed: totalFail, domains };
  } catch (err) {
    console.error("[CookieSync] pull failed:", err);
    return { error: err.message };
  }
}

// Cookie change listener — checks against ALL configured domains
function onCookieChanged(changeInfo) {
  getConfig().then((cfg) => {
    if (cfg.role !== "exit_node" || !cfg.domains || cfg.domains.length === 0) return;
    const changed = normalizeDomain(changeInfo.cookie.domain);
    const match = cfg.domains.some((d) => {
      const target = normalizeDomain(d);
      return changed.endsWith(target) || target.endsWith(changed);
    });
    if (!match) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      pushCookies();
    }, DEBOUNCE_MS);
  });
}

async function startSync() {
  const cfg = await getConfig();
  if (!cfg.role || !cfg.serverUrl || !cfg.roomId) return;

  await chrome.alarms.clearAll();

  if (cfg.role === "exit_node") {
    if (!chrome.cookies.onChanged.hasListener(onCookieChanged)) {
      chrome.cookies.onChanged.addListener(onCookieChanged);
    }
    chrome.alarms.create("heartbeat", { periodInMinutes: HEARTBEAT_MINUTES });
    if (cfg.domains && cfg.domains.length > 0) pushCookies();
  } else if (cfg.role === "receiver" && cfg.autoSync) {
    chrome.alarms.create("autoSync", { periodInMinutes: AUTO_SYNC_MINUTES });
  }
}

async function stopSync() {
  await chrome.alarms.clearAll();
  if (chrome.cookies.onChanged.hasListener(onCookieChanged)) {
    chrome.cookies.onChanged.removeListener(onCookieChanged);
  }
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "heartbeat") await pushCookies();
  if (alarm.name === "autoSync") await pullCookies();
});

// ─── Message Handler ─────────────────────────────────────────────
async function handleMessage(msg) {
  switch (msg.action) {
    case "getStatus": {
      const cfg = await getConfig();
      return {
        role: cfg.role,
        domains: cfg.domains || [],
        serverUrl: cfg.serverUrl,
        roomId: cfg.roomId,
        lastSyncTs: cfg.lastSyncTs,
        autoSync: cfg.autoSync,
      };
    }

    case "addDomain": {
      const cfg = await getConfig();
      if (cfg.role !== "exit_node") return { error: "Only exit nodes can add domains" };
      const domain = normalizeDomain(msg.domain);
      if (!domain) return { error: "Domain required" };
      const domains = cfg.domains || [];
      if (domains.includes(domain)) return { error: "Domain already shared" };
      domains.push(domain);
      await saveConfig({ domains });
      // Force push with new domain
      await saveConfig({ domainHashes: {} });
      pushCookies();
      return { success: true, domains };
    }

    case "removeDomain": {
      const cfg = await getConfig();
      if (cfg.role !== "exit_node") return { error: "Only exit nodes can remove domains" };
      const domain = normalizeDomain(msg.domain);
      const domains = (cfg.domains || []).filter((d) => d !== domain);
      const domainHashes = { ...cfg.domainHashes };
      delete domainHashes[domain];
      await saveConfig({ domains, domainHashes });
      pushCookies();
      return { success: true, domains };
    }

    case "getDomains": {
      const cfg = await getConfig();
      const result = [];
      for (const domain of (cfg.domains || [])) {
        let cookieCount = 0;
        try {
          const cookies = await listCookies(domain);
          cookieCount = cookies.length;
        } catch { /* ignore */ }
        result.push({ domain, cookieCount });
      }
      return { domains: result };
    }

    case "createRoom": {
      const { serverUrl, serverSecret } = msg;
      if (!serverUrl) return { error: "Server URL required" };
      try {
        const { id } = await createRoom(serverUrl, serverSecret);
        const secret = generateSecret();
        await saveConfig({
          serverUrl,
          serverSecret: serverSecret || "",
          roomId: id,
          secret,
          role: "exit_node",
          autoSync: true,
          lastSyncTs: 0,
          domains: [],
          domainHashes: {},
        });
        await startSync();
        return { success: true, shareString: `${serverUrl}|${id}|${secret}` };
      } catch (err) {
        return { error: err.message };
      }
    }

    case "joinRoom": {
      const { shareString, serverSecret } = msg;
      if (!shareString) return { error: "Share string required" };
      const parts = shareString.split("|");
      if (parts.length !== 3) return { error: "Invalid format (expected serverUrl|roomId|secret)" };
      const [serverUrl, roomId, secret] = parts;
      try {
        await getRoom(serverUrl, roomId, serverSecret);
        await saveConfig({
          serverUrl,
          serverSecret: serverSecret || "",
          roomId,
          secret,
          role: "receiver",
          autoSync: false,
          lastSyncTs: 0,
          domains: [],
          domainHashes: {},
        });
        return { success: true };
      } catch (err) {
        return { error: `Could not connect: ${err.message}` };
      }
    }

    case "syncNow": {
      const cfg = await getConfig();
      if (cfg.role === "exit_node") {
        await saveConfig({ domainHashes: {} });
        await pushCookies();
        return { success: true, message: "Cookies pushed" };
      } else if (cfg.role === "receiver") {
        return await pullCookies();
      }
      return { error: "Not in a room" };
    }

    case "toggleAutoSync": {
      const cfg = await getConfig();
      if (cfg.role !== "receiver") return { error: "Auto-sync is for receivers only" };
      const newVal = !cfg.autoSync;
      await saveConfig({ autoSync: newVal });
      if (newVal) {
        chrome.alarms.create("autoSync", { periodInMinutes: AUTO_SYNC_MINUTES });
      } else {
        await chrome.alarms.clear("autoSync");
      }
      return { autoSync: newVal };
    }

    case "leaveRoom": {
      await stopSync();
      await clearConfig();
      return { success: true };
    }

    case "getShareString": {
      const cfg = await getConfig();
      if (!cfg.roomId) return { error: "Not in a room" };
      return { shareString: `${cfg.serverUrl}|${cfg.roomId}|${cfg.secret}` };
    }

    default:
      return { error: `Unknown action: ${msg.action}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse);
  return true;
});

// ─── Init ─────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => startSync());
chrome.runtime.onStartup.addListener(() => startSync());
startSync();
