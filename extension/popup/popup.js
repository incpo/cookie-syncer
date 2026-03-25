"use strict";

// ─── Helpers ──────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function formatTime(ts) {
  if (!ts) return "never";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function faviconUrl(domain) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
}

function showMsg(elId, text, type) {
  const el = $(elId);
  el.textContent = text;
  el.className = `message ${type || ""}`;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 5000);
}

function showModal(title, bodyHtml) {
  return new Promise((resolve) => {
    $("modalTitle").textContent = title;
    $("modalBody").innerHTML = bodyHtml;
    $("modal").classList.add("visible");

    function cleanup(result) {
      $("modal").classList.remove("visible");
      $("modalConfirm").removeEventListener("click", onConfirm);
      $("modalCancel").removeEventListener("click", onCancel);
      resolve(result);
    }
    function onConfirm() { cleanup(true); }
    function onCancel() { cleanup(false); }

    $("modalConfirm").addEventListener("click", onConfirm);
    $("modalCancel").addEventListener("click", onCancel);
  });
}

function hideAll(parent) {
  parent.querySelectorAll("[hidden]").forEach(() => {});
  for (const child of parent.children) {
    if (child.classList.contains("tab-content") || child.hasAttribute("hidden")) continue;
  }
}

// ─── Tab Switching ────────────────────────────────────────────────
document.querySelectorAll(".tab-bar .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab-bar .tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    $(tab.dataset.tab).classList.add("active");
  });
});

// ─── State ────────────────────────────────────────────────────────
let currentDomain = "";
let status = null;

async function getCurrentTabDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) return new URL(tab.url).hostname;
  } catch { /* ignore */ }
  return "";
}

// ─── Render ───────────────────────────────────────────────────────
function switchTab(tabId) {
  document.querySelectorAll(".tab-bar .tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
  document.querySelector(`.tab-bar .tab[data-tab="${tabId}"]`).classList.add("active");
  $(tabId).classList.add("active");
}

async function render() {
  status = await send({ action: "getStatus" });
  currentDomain = await getCurrentTabDomain();

  // Default to Connect tab if no room configured
  if (!status.role) switchTab("connect");

  renderThisSite();
  renderShared();
  renderConnect();
}

// ─── Tab 1: This Site ─────────────────────────────────────────────
function renderThisSite() {
  $("tsNoRoom").hidden = true;
  $("tsExitNode").hidden = true;
  $("tsReceiver").hidden = true;
  $("tsStatus").hidden = true;

  if (!status.role) {
    $("tsNoRoom").hidden = false;
    return;
  }

  // Status bar
  $("tsStatus").hidden = false;
  $("tsRole").textContent = status.role === "exit_node" ? "Exit Node" : "Receiver";
  $("tsDomainCount").textContent = (status.domains || []).length;
  $("tsLastSync").textContent = formatTime(status.lastSyncTs);

  const domains = status.domains || [];
  const isShared = domains.includes(currentDomain);

  if (status.role === "exit_node") {
    $("tsExitNode").hidden = false;
    $("tsFavicon").src = faviconUrl(currentDomain);
    $("tsDomain").textContent = currentDomain || "unknown";

    $("tsSharing").hidden = !isShared;
    $("tsNotSharing").hidden = isShared;
  } else {
    $("tsReceiver").hidden = false;
    $("tsRcFavicon").src = faviconUrl(currentDomain);
    $("tsRcDomain").textContent = currentDomain || "unknown";

    $("tsRcSynced").hidden = !isShared;
    $("tsRcNotSynced").hidden = isShared;
  }
}

// ─── Tab 2: Shared List ───────────────────────────────────────────
async function renderShared() {
  const res = await send({ action: "getDomains" });
  const domains = res.domains || [];
  const list = $("sharedList");
  list.innerHTML = "";

  if (domains.length === 0) {
    $("sharedEmpty").hidden = false;
    return;
  }

  $("sharedEmpty").hidden = true;

  for (const { domain, cookieCount } of domains) {
    const row = document.createElement("div");
    row.className = "domain-row";
    row.innerHTML = `
      <img class="favicon" src="${faviconUrl(domain)}" alt="">
      <div class="domain-info">
        <div class="domain-name">${escapeHtml(domain)}</div>
        <div class="domain-meta">${cookieCount} cookies</div>
      </div>
      ${status.role === "exit_node" ? `<button class="btn-remove danger" data-domain="${escapeHtml(domain)}">Remove</button>` : ""}
    `;
    list.appendChild(row);
  }

  // Bind remove buttons
  list.querySelectorAll(".btn-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await send({ action: "removeDomain", domain: btn.dataset.domain });
      await render();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function getParentDomains(domain) {
  const parts = domain.split(".");
  const parents = [];
  for (let i = 1; i < parts.length - 1; i++) {
    parents.push(parts.slice(i).join("."));
  }
  return parents;
}

// ─── Tab 3: Connect ───────────────────────────────────────────────
function renderConnect() {
  $("cnSetup").hidden = true;
  $("cnExitNode").hidden = true;
  $("cnReceiver").hidden = true;

  if (!status.role) {
    $("cnSetup").hidden = false;
    return;
  }

  if (status.role === "exit_node") {
    $("cnExitNode").hidden = false;
    $("cnServer").textContent = status.serverUrl;
    $("cnRoom").textContent = status.roomId ? status.roomId.slice(0, 8) + "..." : "";
  } else {
    $("cnReceiver").hidden = false;
    $("cnRcServer").textContent = status.serverUrl;
    $("cnRcRoom").textContent = status.roomId ? status.roomId.slice(0, 8) + "..." : "";
    $("autoSyncToggle").checked = status.autoSync;
  }
}

// ─── Tab 1 Events ─────────────────────────────────────────────────
$("btnAddDomain").addEventListener("click", async () => {
  const parents = getParentDomains(currentDomain);
  let body = `<span class="domain-tag">${escapeHtml(currentDomain)}</span>`;
  if (parents.length > 0) {
    body += `<p style="margin-top:10px">This will also include cookies from:</p>`;
    body += parents.map((d) => `<span class="domain-tag parent">${escapeHtml(d)}</span>`).join(" ");
  }

  const ok = await showModal("Share this site's cookies?", body);
  if (!ok) return;

  $("btnAddDomain").disabled = true;
  const res = await send({ action: "addDomain", domain: currentDomain });
  $("btnAddDomain").disabled = false;
  if (res.error) {
    showMsg("tsMessage", res.error, "error");
  } else {
    await render();
    showMsg("tsMessage", `Now sharing ${currentDomain}`, "success");
  }
});

$("btnRemoveDomain").addEventListener("click", async () => {
  $("btnRemoveDomain").disabled = true;
  await send({ action: "removeDomain", domain: currentDomain });
  $("btnRemoveDomain").disabled = false;
  await render();
});

$("btnShareAccess").addEventListener("click", async () => {
  const res = await send({ action: "getShareString" });
  if (res.shareString) {
    try {
      await navigator.clipboard.writeText(res.shareString);
      showMsg("tsMessage", "Share string copied!", "success");
    } catch {
      showMsg("tsMessage", res.shareString, "");
    }
  }
});

// ─── Tab 3 Events ─────────────────────────────────────────────────
$("btnCreate").addEventListener("click", async () => {
  const serverUrl = $("serverUrl").value.trim().replace(/\/+$/, "");
  if (!serverUrl) { $("cnError").textContent = "Server URL required"; $("cnError").hidden = false; return; }

  $("btnCreate").disabled = true;
  $("cnError").hidden = true;
  const serverSecret = $("serverSecret").value.trim();
  const res = await send({ action: "createRoom", serverUrl, serverSecret });
  $("btnCreate").disabled = false;

  if (res.error) {
    $("cnError").textContent = res.error;
    $("cnError").hidden = false;
    return;
  }

  try { await navigator.clipboard.writeText(res.shareString); } catch { /* ignore */ }
  await render();
  showMsg("cnEnMessage", "Room created! Share string copied.", "success");
});

$("btnJoin").addEventListener("click", async () => {
  const shareString = $("shareString").value.trim();
  if (!shareString) { $("cnError").textContent = "Paste the share string"; $("cnError").hidden = false; return; }

  $("btnJoin").disabled = true;
  $("cnError").hidden = true;
  const serverSecret = $("joinServerSecret").value.trim();
  const res = await send({ action: "joinRoom", shareString, serverSecret });
  $("btnJoin").disabled = false;

  if (res.error) {
    $("cnError").textContent = res.error;
    $("cnError").hidden = false;
    return;
  }

  await render();
});

$("btnCopyShare").addEventListener("click", async () => {
  const res = await send({ action: "getShareString" });
  if (res.shareString) {
    try {
      await navigator.clipboard.writeText(res.shareString);
      showMsg("cnEnMessage", "Share string copied!", "success");
    } catch {
      showMsg("cnEnMessage", res.shareString, "");
    }
  }
});

$("btnSyncEn").addEventListener("click", async () => {
  $("btnSyncEn").disabled = true;
  const res = await send({ action: "syncNow" });
  $("btnSyncEn").disabled = false;
  await render();
  showMsg("cnEnMessage", res.message || "Synced!", "success");
});

$("btnLeaveEn").addEventListener("click", async () => {
  const ok = await showModal("Leave room?", "This will stop sharing all cookies and delete your room configuration.");
  if (!ok) return;
  await send({ action: "leaveRoom" });
  await render();
});

$("btnSyncRc").addEventListener("click", async () => {
  $("btnSyncRc").disabled = true;
  const res = await send({ action: "syncNow" });
  $("btnSyncRc").disabled = false;
  await render();
  if (res.error) {
    showMsg("cnRcMessage", res.error, "error");
  } else {
    showMsg("cnRcMessage", `Applied ${res.applied} cookies across ${(res.domains || []).length} domains. Reload pages.`, "success");
  }
});

$("autoSyncToggle").addEventListener("change", async () => {
  const res = await send({ action: "toggleAutoSync" });
  if (res.autoSync !== undefined) $("autoSyncToggle").checked = res.autoSync;
});

$("btnLeaveRc").addEventListener("click", async () => {
  const ok = await showModal("Leave room?", "This will stop receiving cookies and clear your connection.");
  if (!ok) return;
  await send({ action: "leaveRoom" });
  await render();
});

// ─── Persistent Inputs ────────────────────────────────────────────
// Save to local storage (survives popup close)
const LOCAL_INPUTS = ["serverUrl", "shareString"];
// Save to session storage (cleared on browser close — secrets)
const SESSION_INPUTS = ["serverSecret", "joinServerSecret"];

async function restoreInputs() {
  const local = await chrome.storage.local.get(LOCAL_INPUTS.map((id) => `input_${id}`));
  for (const id of LOCAL_INPUTS) {
    const saved = local[`input_${id}`];
    if (saved !== undefined && saved !== "") $(id).value = saved;
  }
  const session = await chrome.storage.session.get(SESSION_INPUTS.map((id) => `input_${id}`));
  for (const id of SESSION_INPUTS) {
    const saved = session[`input_${id}`];
    if (saved !== undefined && saved !== "") $(id).value = saved;
  }
}

for (const id of LOCAL_INPUTS) {
  $(id).addEventListener("input", () => {
    chrome.storage.local.set({ [`input_${id}`]: $(id).value });
  });
}

for (const id of SESSION_INPUTS) {
  $(id).addEventListener("input", () => {
    chrome.storage.session.set({ [`input_${id}`]: $(id).value });
  });
}

// ─── Init ─────────────────────────────────────────────────────────
restoreInputs().then(() => render());
