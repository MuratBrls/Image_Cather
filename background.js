/**
 * background.js — Deep-Extract Image Downloader v1.2
 * Background Service Worker (Manifest V3)
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const MENU_ITEM_ID    = "deep_extract_download";
const MENU_ITEM_TITLE = "⬇️ Force Download Image";
const MSG_EXTRACT     = "DEEP_EXTRACT_IMAGE";
const MAX_HISTORY     = 60;

// ─── Default Settings ─────────────────────────────────────────────────────────

const DEFAULTS = {
  folder:  "deep-extract",
  saveAs:  false,
  naming:  "original",
  dedup:   true,
  toasts:  true,
};

// ─── Lifecycle: Install ───────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ITEM_ID,
      title: MENU_ITEM_TITLE,
      contexts: ["all"],
    });
    console.log("[Deep-Extract] Context menu registered.");
  });

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    const missing = Object.fromEntries(
      Object.entries(DEFAULTS).filter(([k]) => stored[k] === undefined)
    );
    if (Object.keys(missing).length) chrome.storage.sync.set(missing);
  });
});

// ─── Context Menu Click Handler ───────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ITEM_ID) return;
  if (!tab?.id) return;

  const settings = await getSettings();
  let imageUrl = null;

  try {
    const response = await sendMessageWithFallback(tab.id, { type: MSG_EXTRACT });
    imageUrl = response?.url ?? null;
  } catch (err) {
    console.error("[Deep-Extract] Content script unreachable:", err.message);
    if (settings.toasts) await injectToast(tab.id, "Could not reach the page script.", "error");
    return;
  }

  if (!imageUrl) {
    if (settings.toasts) await injectToast(tab.id, "No image found at that location.", "error");
    return;
  }

  // ── Duplicate Guard ───────────────────────────────────────────────────────
  // Strategy: only BLOCK re-downloads that happen within 3 seconds of the
  // previous download of the same URL (true accidental double-click).
  // After 3 seconds: show an informational toast but still proceed.
  // This avoids false-positive blocks when a site uses the same CDN URL
  // structure for different products (e.g. all images loaded from same base URL).
  if (settings.dedup) {
    const { downloadHistory = [] } = await chrome.storage.local.get("downloadHistory");
    const historyEntry = downloadHistory.find((h) => h.url === imageUrl);

    if (historyEntry) {
      const secondsSince = (Date.now() - (historyEntry.ts ?? 0)) / 1000;

      if (secondsSince < 3) {
        // True double-click — block silently.
        console.info("[Deep-Extract] Double-click guard triggered, skipping.");
        return;
      }

      // URL seen before but not a double-click.
      // Check if the file still exists on disk; if so, warn the user.
      const fileExists = await checkDownloadExists(historyEntry.downloadId, imageUrl);
      if (fileExists && settings.toasts) {
        // Warn but DO NOT block — the user may be intentionally downloading
        // a different image that shares the same URL (CDN reuse, placeholders, etc.)
        await injectToast(tab.id, "Heads up: you've downloaded this URL before.", "warn");
      }
      // Continue to download regardless.
    }
  }


  await run(imageUrl, tab, settings);
});

// ─── Shared download flow (used by context menu + re-download) ────────────────

async function run(imageUrl, tab, settings) {
  const downloadId = await initiateDownload(imageUrl, tab, settings);

  if (downloadId == null) return; // initiateDownload handles its own error toast

  // Save to history with the real downloadId for later disk existence checks.
  await appendHistory({
    url:        imageUrl,
    thumb:      imageUrl,
    downloadId,
    pageUrl:    tab?.url ?? imageUrl,
    ts:         Date.now(),
  });

  const { sessionDownloads = 0 } = await chrome.storage.local.get("sessionDownloads");
  await chrome.storage.local.set({ sessionDownloads: sessionDownloads + 1 });

  if (settings.toasts) await injectToast(tab?.id, "Download started.", "success");
}

// ─── Re-download from History Panel ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender) => {
  if (message?.type !== "REDOWNLOAD") return false;

  (async () => {
    const settings = await getSettings();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Re-downloads always bypass the duplicate guard.
    await run(message.url, tab, { ...settings, dedup: false });
  })();

  return false;
});

// ─── Download Logic ───────────────────────────────────────────────────────────

/**
 * Starts a download and returns the download ID, or null on failure.
 *
 * @param {string} url
 * @param {chrome.tabs.Tab|undefined} tab
 * @param {object} settings
 * @returns {Promise<number|null>}
 */
async function initiateDownload(url, tab, settings) {
  const filename = deriveFilename(url, tab?.url, settings);

  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs:         settings.saveAs,
      conflictAction: "uniquify",
    });
    console.log(`[Deep-Extract] Download #${downloadId} → ${filename}`);
    return downloadId;
  } catch (err) {
    console.error("[Deep-Extract] Download failed:", err.message);

    if (url.startsWith("blob:") || url.startsWith("data:")) {
      await chrome.tabs.create({ url, active: false });
    } else if (tab?.id && settings.toasts) {
      await injectToast(tab.id, `Download failed: ${err.message}`, "error");
    }
    return null;
  }
}

// ─── Filename Derivation ──────────────────────────────────────────────────────

function deriveFilename(imageUrl, pageUrl, settings) {
  const folder = sanitizeFolder(settings.folder);
  const ext    = extractExtension(imageUrl) || "jpg";
  const ts     = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  switch (settings.naming) {
    case "timestamp":
      return `${folder}/img-${ts}.${ext}`;

    case "domain-ts": {
      let domain = "image";
      try { domain = new URL(pageUrl).hostname.replace(/^www\./, "").split(".")[0]; } catch {}
      return `${folder}/${domain}-${ts.slice(11)}.${ext}`;
    }

    default: {
      const original = extractOriginalName(imageUrl);
      return original ? `${folder}/${original}` : `${folder}/img-${ts}.${ext}`;
    }
  }
}

function sanitizeFolder(name) {
  return (name || "deep-extract").replace(/[/\\:*?"<>|]/g, "").trim() || "deep-extract";
}

function extractOriginalName(url) {
  try {
    const raw   = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    const clean = raw.split("?")[0].split("#")[0];
    if (/\.(jpg|jpeg|png|gif|webp|avif|svg|bmp|tiff?)$/i.test(clean)) return clean;
  } catch {}
  return null;
}

function extractExtension(url) {
  try {
    const name = new URL(url).pathname.split("/").pop() ?? "";
    const m    = name.match(/\.(jpg|jpeg|png|gif|webp|avif|svg|bmp|tiff?)$/i);
    return m ? m[1].toLowerCase() : null;
  } catch {}
  return null;
}

// ─── History Management ───────────────────────────────────────────────────────

async function appendHistory(entry) {
  const { downloadHistory = [] } = await chrome.storage.local.get("downloadHistory");
  downloadHistory.push(entry);
  await chrome.storage.local.set({ downloadHistory: downloadHistory.slice(-MAX_HISTORY) });
}

// ─── Disk Existence Check ─────────────────────────────────────────────────────

/**
 * Reliably determines if a downloaded file still exists on disk.
 *
 * Chrome's `DownloadItem.exists` flag is stale by default. According to MDN/Chrome docs,
 * calling search() TRIGGERS a background existence refresh, but the results returned
 * by that same call may still be stale. The fix: call search() once to trigger the
 * refresh, wait briefly for Chrome to update, then call search() again to read the
 * now-fresh `exists` value.
 *
 * Falls back to URL-based search if no downloadId is stored.
 *
 * @param {number|undefined} downloadId  - The stored chrome.downloads ID.
 * @param {string}           url         - The image URL as a fallback key.
 * @returns {Promise<boolean>}
 */
async function checkDownloadExists(downloadId, url) {
  try {
    // Build the search query — prefer ID lookup (exact match), fall back to URL.
    const query = downloadId != null ? { id: downloadId } : { url, limit: 10 };

    // First call triggers Chrome's background file-existence check.
    await chrome.downloads.search(query);

    // Give Chrome ~400ms to refresh the exists flag.
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Second call reads the freshly updated value.
    const results = await chrome.downloads.search(query);

    return results.some((d) => d.state === "complete" && d.exists === true);
  } catch {
    return false; // On any error, allow the download.
  }
}

// ─── Robust Message Sender ────────────────────────────────────────────────────

async function sendMessageWithFallback(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files:  ["content.js"],
      });
    } catch (injectErr) {
      throw new Error(`Auto-inject failed: ${injectErr.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

// ─── Toast Injection ──────────────────────────────────────────────────────────

async function injectToast(tabId, message, type = "success") {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func:   renderToast,
      args:   [message, type],
    });
  } catch (err) {
    console.warn("[Deep-Extract] Toast injection failed:", err.message);
  }
}

/**
 * Self-contained toast renderer — runs in page context, no service-worker refs.
 * Design: clean white card, colored icon circle, bold title, body message.
 *
 * @param {string} message
 * @param {"success"|"error"|"warn"} type
 */
function renderToast(message, type) {
  const ID = "__deep_extract_toast__";
  document.getElementById(ID)?.remove();

  const cfg = {
    success: { icon: "✓", color: "#16a34a", label: "Downloaded"    },
    warn:    { icon: "!", color: "#d97706", label: "Already saved"  },
    error:   { icon: "✕", color: "#dc2626", label: "Failed"         },
  }[type] || { icon: "✓", color: "#16a34a", label: "Done" };

  const wrap = document.createElement("div");
  wrap.id = ID;

  Object.assign(wrap.style, {
    position:    "fixed",
    bottom:      "22px",
    right:       "22px",
    zIndex:      "2147483647",
    display:     "flex",
    alignItems:  "flex-start",
    gap:         "12px",
    padding:     "14px 16px",
    minWidth:    "260px",
    maxWidth:    "340px",
    background:  "#ffffff",
    borderRadius:"12px",
    boxShadow:   "0 8px 30px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.07)",
    fontFamily:  "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    lineHeight:  "1",
    pointerEvents: "none",
    opacity:     "0",
    transform:   "translateY(8px)",
    transition:  "opacity 0.22s ease, transform 0.22s ease",
  });

  // Icon circle
  const icon = document.createElement("div");
  Object.assign(icon.style, {
    width:           "30px",
    height:          "30px",
    borderRadius:    "50%",
    background:      cfg.color,
    color:           "#fff",
    display:         "flex",
    alignItems:      "center",
    justifyContent:  "center",
    fontSize:        "15px",
    fontWeight:      "700",
    flexShrink:      "0",
    marginTop:       "1px",
  });
  icon.textContent = cfg.icon;

  // Text block
  const textWrap = document.createElement("div");

  const title = document.createElement("div");
  Object.assign(title.style, {
    fontSize:   "13px",
    fontWeight: "600",
    color:      "#09090b",
    marginBottom: "3px",
  });
  title.textContent = cfg.label;

  const body = document.createElement("div");
  Object.assign(body.style, {
    fontSize:   "12px",
    fontWeight: "400",
    color:      "#71717a",
    lineHeight: "1.4",
  });
  body.textContent = message;

  textWrap.appendChild(title);
  textWrap.appendChild(body);
  wrap.appendChild(icon);
  wrap.appendChild(textWrap);
  document.body.appendChild(wrap);

  requestAnimationFrame(() => {
    wrap.style.opacity   = "1";
    wrap.style.transform = "translateY(0)";
  });

  setTimeout(() => {
    wrap.style.opacity   = "0";
    wrap.style.transform = "translateY(6px)";
    setTimeout(() => wrap.remove(), 300);
  }, 4000);
}
