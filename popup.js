"use strict";

const DEFAULTS = {
  folder:  "deep-extract",
  saveAs:  false,
  naming:  "original",
  dedup:   true,
  toasts:  true,
};

const $ = (id) => document.getElementById(id);

// Tracks the folder name chosen via the native picker.
// Initialized from storage, updated when user picks a new folder.
let currentFolder = DEFAULTS.folder;

// ─── Tab nav ──────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`panel-${btn.dataset.tab}`).classList.add("active");
  });
});

// ─── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  currentFolder             = s.folder;
  setFolderDisplay(s.folder);
  $('saveAsToggle').checked = s.saveAs;
  $('namingSelect').value   = s.naming;
  $('dedupToggle').checked  = s.dedup;
  $('toastToggle').checked  = s.toasts;
}

// ─── Folder Picker ────────────────────────────────────────────────────────────

function setFolderDisplay(name) {
  const el = $('folderDisplay');
  el.textContent = name || 'deep-extract';
  el.title = `~/Downloads/${name || 'deep-extract'}`;
}

$('browseFolderBtn').addEventListener('click', async () => {
  // showDirectoryPicker is available in extension popup (secure context).
  if (!window.showDirectoryPicker) {
    alert('Your browser does not support the folder picker. Please update Chrome.');
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    // Use the selected folder's name as the subfolder inside Downloads.
    // Chrome downloads API only supports paths relative to the Downloads dir.
    currentFolder = sanitize(handle.name);
    setFolderDisplay(currentFolder);
  } catch (err) {
    // User cancelled or permission denied — no action needed.
    if (err.name !== 'AbortError') console.warn('[Deep-Extract] Folder picker error:', err);
  }
});

function sanitize(name) {
  return (name || 'deep-extract').replace(/[/\\:*?"<>|]/g, '').trim() || 'deep-extract';
}

$('saveBtn').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    folder:  currentFolder,
    saveAs:  $('saveAsToggle').checked,
    naming:  $('namingSelect').value,
    dedup:   $('dedupToggle').checked,
    toasts:  $('toastToggle').checked,
  });

  const msg = $('saveStatus');
  msg.textContent = '✓ Saved';
  setTimeout(() => { msg.textContent = ''; }, 2000);
});

// ─── History ──────────────────────────────────────────────────────────────────
async function loadHistory() {
  const { downloadHistory = [] } = await chrome.storage.local.get("downloadHistory");
  const { sessionDownloads = 0 } = await chrome.storage.local.get("sessionDownloads");
  renderHistory(downloadHistory);
  $("sessionCount").textContent = `${sessionDownloads} download${sessionDownloads !== 1 ? "s" : ""}`;
}

function renderHistory(items) {
  const badge = $("history-badge");
  badge.textContent = items.length;
  $("historyCount").textContent = `${items.length} image${items.length !== 1 ? "s" : ""}`;

  const grid = $("historyGrid");

  if (items.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">↓</div>
        <div class="empty-text">
          No downloads yet.<br/>Right-click any image<br/>and choose <strong>Force Download Image</strong>.
        </div>
      </div>`;
    return;
  }

  grid.innerHTML = [...items].reverse().map((item) => {
    const a = esc(item.url);
    const t = esc(item.thumb || item.url);
    const p = esc(item.pageUrl || item.url);
    const time = relTime(item.ts);

    return `<div class="thumb">
      <img src="${t}" loading="lazy" alt="" onerror="this.style.display='none'" />
      <span class="thumb-ts">${time}</span>
      <div class="thumb-cover">
        <button class="thumb-btn" data-action="dl"   data-url="${a}">↓ Download</button>
        <button class="thumb-btn" data-action="page" data-url="${p}">↗ Source page</button>
      </div>
    </div>`;
  }).join("");

  grid.querySelectorAll(".thumb-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const { action, url } = btn.dataset;
      if (action === "dl") {
        chrome.runtime.sendMessage({ type: "REDOWNLOAD", url });
      } else if (action === "page") {
        chrome.tabs.create({ url, active: true });
      }
    });
  });
}

$("clearHistoryBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({ downloadHistory: [], sessionDownloads: 0 });
  renderHistory([]);
  $("sessionCount").textContent = "0 downloads";
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function relTime(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60_000)    return "now";
  if (d < 3600_000)  return `${Math.floor(d / 60_000)}m`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h`;
  return `${Math.floor(d / 86400_000)}d`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  await loadSettings();
  await loadHistory();
})();
