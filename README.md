# Deep-Extract Image Downloader

> A Chrome Extension (Manifest V3) that bypasses transparent overlay protections to forcefully extract and download the underlying image asset at your right-click coordinates.

---

## The Problem It Solves

Many platforms (Instagram, 500px, stock photo sites, etc.) prevent native "Save Image As…" by placing an invisible `<div>` directly over `<img>` elements, or by rendering images as CSS `background-image`. Standard right-click downloads are blocked.

**Deep-Extract** pierces through those overlay layers by using `document.elementsFromPoint(x, y)` to inspect the full Z-axis DOM stack at the cursor's exact position, finds the actual image source, and downloads it directly.

---

## Project Structure

```
Image Catcher/
├── manifest.json        # Extension manifest (MV3)
├── background.js        # Service worker: context menu, messaging, downloads
├── content.js           # Content script: coordinate tracking, DOM extraction
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## How It Works

```
User right-clicks on a page
        │
        ▼
content.js stores (clientX, clientY)         ← passive contextmenu listener
        │
User clicks "⬇️ Force Download Image"
        │
        ▼
background.js receives contextMenus.onClicked
        │
        ▼
Sends { type: "DEEP_EXTRACT_IMAGE" } to content.js
        │
        ▼
content.js runs document.elementsFromPoint(x, y)
        │
        ├── Finds <img src="...">        → returns img.src
        ├── Finds <img srcset="...">     → resolves highest-res candidate
        ├── Finds CSS background-image   → strips url("...") wrapper
        ├── Finds <canvas>               → exports as data URL (PNG)
        ├── Finds <video poster="...">   → returns poster URL
        └── Nothing found               → returns null
        │
        ▼
background.js receives the URL
        │
        ├── Valid URL → chrome.downloads.download({ url, filename })
        │              Downloads to: ~/Downloads/deep-extract/<filename>
        │
        └── null / error → injects toast notification into the page
```

---

## Image Source Detection (Priority Order)

| Priority | Source Type | Method |
|----------|------------|--------|
| 1 | `<img src>` | Direct `element.src` |
| 2 | `<img srcset>` | Highest-density/width candidate |
| 3 | CSS `background-image` | `getComputedStyle().backgroundImage` → regex |
| 4 | `<canvas>` | `canvas.toDataURL("image/png")` |
| 5 | `<video poster>` | `element.poster` |

---

## Installation (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions/`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Select the **`Image Catcher`** folder (this directory)
5. The extension icon will appear in your Chrome toolbar

---

## Usage

1. Browse to any page with protected images (Instagram, 500px, etc.)
2. **Right-click** anywhere over the image area
3. Select **"⬇️ Force Download Image"** from the context menu
4. The image downloads automatically to your `Downloads/deep-extract/` folder

---

## Edge Cases & Error Handling

| Scenario | Behavior |
|----------|----------|
| No image at coordinates | Toast notification shown in-page |
| Cross-origin `<canvas>` (tainted) | Skipped silently; moves to next element |
| `blob:` or `data:` URLs | Direct download or opened in new tab as fallback |
| Ambiguous filename (no extension) | Timestamped fallback: `image-YYYY-MM-DDTHH-MM-SS.jpg` |
| Content script not ready | Error caught in background; toast injected via `scripting` API |
| Duplicate filename | Auto-renamed via `conflictAction: "uniquify"` |

---

## Permissions Used

| Permission | Purpose |
|------------|---------|
| `contextMenus` | Creates "Force Download Image" right-click menu item |
| `activeTab` | Sends messages to the current tab |
| `scripting` | Injects failure-state toast notifications |
| `downloads` | Triggers file downloads |
| `<all_urls>` | Runs content script on all pages |

---

## Technical Notes

- **MV3 Compliant:** Uses a service worker (not persistent background page). No `eval()`, no remote code execution.
- **Passive Listeners:** `contextmenu` listener uses `{ passive: true }` — zero performance cost.
- **`capture: true`:** Listener runs before any page-level handler that might call `stopPropagation()`.
- **CORS:** `chrome.downloads.download()` operates outside the page's CORS context — it can download cross-origin images that `fetch()` cannot.
- **Self-Contained Toast:** The injected `showToast` function is a fully isolated closure with no dependency on service worker variables, compliant with MV3's `scripting.executeScript` requirements.
