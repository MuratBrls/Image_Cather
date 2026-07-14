/**
 * background.js — Deep-Extract Image Downloader v1.2
 * Background Service Worker (Manifest V3)
 *
 * New in v1.2:
 *  - Added context menu for page view screenshot ("Capture Page View").
 *  - Added message handler for screenshot capture from popup.
 *  - Uses OffscreenCanvas in the service worker to generate lightweight thumbnails
 *    for screenshots in the history panel.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const MENU_ITEM_ID      = "deep_extract_download";
const MENU_ITEM_TITLE   = "⬇️ Force Download Image";
const MENU_ITEM_SS_ID   = "deep_extract_screenshot";
const MENU_ITEM_SS_TITLE  = "📸 Capture Page View";
const MSG_EXTRACT       = "DEEP_EXTRACT_IMAGE";
const MAX_HISTORY       = 60;

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
    // 1. Force Download context item
    chrome.contextMenus.create({
      id: MENU_ITEM_ID,
      title: MENU_ITEM_TITLE,
      contexts: ["all"],
    });

    // 2. Screenshot context item
    chrome.contextMenus.create({
      id: MENU_ITEM_SS_ID,
      title: MENU_ITEM_SS_TITLE,
      contexts: ["page", "frame", "selection", "link"],
    });

    console.log("[Deep-Extract] Context menus registered.");
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
  if (!tab?.id) return;

  if (info.menuItemId === MENU_ITEM_ID) {
    // --- FORCE DOWNLOAD FLOW ---
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

    // Duplicate Guard
    if (settings.dedup) {
      const { downloadHistory = [] } = await chrome.storage.local.get("downloadHistory");
      const historyEntry = downloadHistory.find((h) => h.url === imageUrl);

      if (historyEntry) {
        const secondsSince = (Date.now() - (historyEntry.ts ?? 0)) / 1000;
        if (secondsSince < 3) {
          console.info("[Deep-Extract] Double-click guard triggered, skipping.");
          return;
        }

        const fileExists = await checkDownloadExists(historyEntry.downloadId, imageUrl);
        if (fileExists && settings.toasts) {
          await injectToast(tab.id, "Heads up: you've downloaded this URL before.", "warn");
        }
      }
    }

    await run(imageUrl, tab, settings);

  } else if (info.menuItemId === MENU_ITEM_SS_ID) {
    // --- SCREENSHOT CAPTURE FLOW ---
    await captureScreenshot(tab);
  }
});

// ─── Shared download flow (used by context menu + re-download) ────────────────

async function run(imageUrl, tab, settings, isScreenshot = false) {
  const downloadId = await initiateDownload(imageUrl, tab, settings);
  if (downloadId == null) return;

  // For screenshot history, the url itself is the screenshot dataURL.
  // We will downscale it to keep the history list lightweight.
  let thumbUrl = imageUrl;
  if (isScreenshot) {
    thumbUrl = await createThumbnail(imageUrl, 150, 150);
  }

  await appendHistory({
    url:        imageUrl,
    thumb:      thumbUrl,
    downloadId,
    pageUrl:    tab?.url ?? imageUrl,
    ts:         Date.now(),
    isScreenshot,
  });

  const { sessionDownloads = 0 } = await chrome.storage.local.get("sessionDownloads");
  await chrome.storage.local.set({ sessionDownloads: sessionDownloads + 1 });

  if (settings.toasts) {
    await injectToast(tab?.id, isScreenshot ? "Screenshot saved." : "Download started.", "success");
  }
}

// ─── Message Listener (Handles Re-download & Screenshot from Popup) ──────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CAPTURE_VISIBLE") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const res = await captureScreenshot(tab);
        sendResponse(res);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep message channel open for async response
  }

  if (message?.type === "REDOWNLOAD") {
    (async () => {
      const settings = await getSettings();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const isScreenshot = message.url.startsWith("data:image/");
      await run(message.url, tab, { ...settings, dedup: false }, isScreenshot);
    })();
    return false;
  }

  return false;
});

// ─── Screenshot Flow ──────────────────────────────────────────────────────────

/**
 * Captures the visible area of the active tab and starts downloading it.
 * Saves a lightweight downscaled thumbnail to storage history.
 *
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function captureScreenshot(tab) {
  if (!tab?.id || !tab?.windowId) {
    throw new Error("No active window/tab context found.");
  }

  const settings = await getSettings();

  try {
    // 1. Capture viewport as PNG data URL
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

    // 2. Trigger download flow using run()
    await run(dataUrl, tab, settings, true);

    return { success: true };
  } catch (err) {
    console.error("[Deep-Extract] Screenshot capture failed:", err.message);
    if (tab?.id && settings.toasts) {
      await injectToast(tab.id, `Screenshot failed: ${err.message}`, "error");
    }
    return { success: false, error: err.message };
  }
}

/**
 * Compresses a screenshot data URL into a lightweight thumbnail blob using
 * OffscreenCanvas in the Service Worker.
 *
 * @param {string} dataUrl
 * @param {number} maxWidth
 * @param {number} maxHeight
 * @returns {Promise<string>} Base64 thumbnail data URL.
 */
async function createThumbnail(dataUrl, maxWidth, maxHeight) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const img = await createImageBitmap(blob);

    let width = img.width;
    let height = img.height;

    if (width > height) {
      if (width > maxWidth) {
        height = Math.round(height * (maxWidth / width));
        width = maxWidth;
      }
    } else {
      if (height > maxHeight) {
        width = Math.round(width * (maxHeight / height));
        height = maxHeight;
      }
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);

    const thumbBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.70 });
    
    // Safely convert Blob to Base64 in Service Worker
    const buffer = await thumbBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch (err) {
    console.warn("[Deep-Extract] Failed to make thumbnail, using original:", err.message);
    return dataUrl;
  }
}

// ─── Download Logic ───────────────────────────────────────────────────────────

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
  const ext    = extractExtension(imageUrl) || "png";
  const ts     = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // If it's a screenshot data URL, name it screenshot-timestamp.ext
  if (imageUrl.startsWith("data:image/") || imageUrl.includes("base64")) {
    return `${folder}/screenshot-${ts}.${ext}`;
  }

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
  if (url.startsWith("data:image/")) {
    const m = url.match(/^data:image\/([a-zA-Z+]+);/);
    if (m) return m[1] === "jpeg" ? "jpg" : m[1];
  }
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

async function checkDownloadExists(downloadId, url) {
  try {
    const query = downloadId != null ? { id: downloadId } : { url, limit: 10 };
    await chrome.downloads.search(query);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const results = await chrome.downloads.search(query);
    return results.some((d) => d.state === "complete" && d.exists === true);
  } catch {
    return false;
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

function renderToast(message, type) {
  const ID = "__deep_extract_toast__";
  document.getElementById(ID)?.remove();

  const cfg = {
    success: { icon: "✓", color: "#16a34a", label: "Success"        },
    warn:    { icon: "!", color: "#d97706", label: "Warning"        },
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
