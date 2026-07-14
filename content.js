/**
 * content.js — Deep-Extract Image Downloader v1.5
 * Content Script — runs on all pages at document_idle.
 *
 * v1.5 improvements:
 *  1. Double-Layer Defense System:
 *     - Layer 1 (Direct Element): We capture the exact clicked DOM node using
 *       `event.target` on contextmenu/mousedown. We resolve the image starting
 *       directly from this node and walking its local DOM subtree/parents.
 *       This is 100% immune to scroll, zoom, or coordinate mismatch bugs.
 *     - Layer 2 (Coordinate Fallback): If Layer 1 fails, we fall back to viewport
 *       coordinates and document.elementsFromPoint(x, y).
 *
 *  2. Robust event capture on `window` (capture phase).
 */

(() => {
  "use strict";

  // ─── State ────────────────────────────────────────────────────────────────────

  let lastRightClickedElement = null;

  const lastClickCoords = {
    x: Math.round(window.innerWidth  / 2),
    y: Math.round(window.innerHeight / 2),
  };

  // ─── Event Capture (Window Level, Capture Phase) ─────────────────────────────

  function updateState(ev) {
    if (ev.clientX !== undefined && ev.clientY !== undefined) {
      lastClickCoords.x = ev.clientX;
      lastClickCoords.y = ev.clientY;
    }
    if (ev.target) {
      lastRightClickedElement = ev.target;
    }
  }

  const events = ["contextmenu", "mousedown", "mouseup", "pointerdown", "pointerup"];
  events.forEach((evt) => {
    window.addEventListener(
      evt,
      (ev) => {
        if (evt === "contextmenu" || ev.button === 2) {
          updateState(ev);
        }
      },
      { passive: true, capture: true }
    );
  });

  // ─── Lazy-load Attributes ────────────────────────────────────────────────────

  const LAZY_ATTRS = [
    "data-src",
    "data-lazy",
    "data-lazy-src",
    "data-original",
    "data-url",
    "data-image",
    "data-img",
    "data-hi-res",
    "data-full",
    "data-full-src",
    "data-zoom-image",
    "data-large",
    "data-large-src",
    "data-high-res-src",
  ];

  const LAZY_SRCSET_ATTRS = ["data-srcset"];

  // ─── Main Routing Extraction ─────────────────────────────────────────────────

  function extractImage() {
    // ── Layer 1: Try resolving directly from the clicked element ─────────────
    if (lastRightClickedElement) {
      console.log("[Deep-Extract] Layer 1: Resolving from target element:", lastRightClickedElement.tagName);
      const url = extractImageFromElement(lastRightClickedElement);
      if (url) return url;
    }

    // ── Layer 2: Viewport coordinate fallback ────────────────────────────────
    const { x, y } = lastClickCoords;
    console.log(`[Deep-Extract] Layer 2: Resolving via coordinates (${x}, ${y})`);
    return extractImageAtPoint(x, y);
  }

  // ─── Layer 1: Local Element Resolution ───────────────────────────────────────

  /**
   * Resolves the image by inspecting the clicked element, its children,
   * its parent card container, and siblings.
   *
   * @param {Element} el
   * @returns {string|null}
   */
  function extractImageFromElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;

    // 1. Is the target element itself an <img> or <picture>?
    const direct = resolveElement(el);
    if (direct) return direct;

    // 2. Does the target element itself have a lazy-load attribute?
    const lazy = resolveLazyAttrs(el);
    if (lazy) return lazy;

    // 3. Does it have nested images (e.g. wrapper div)?
    const nestedImg = el.querySelector("img");
    if (nestedImg) {
      const url = resolveImg(nestedImg);
      if (url) return url;
    }
    const nestedPic = el.querySelector("picture");
    if (nestedPic) {
      const url = resolvePicture(nestedPic);
      if (url) return url;
    }

    // 4. Does it have a background image?
    const bg = resolveBackground(el);
    if (bg) return bg;

    // 5. Walk up parent nodes to find the card container context
    let parent = el.parentElement;
    let depth  = 0;
    while (parent && depth < 6) {
      // Check parent direct
      const parentDirect = resolveElement(parent);
      if (parentDirect) return parentDirect;

      const parentLazy = resolveLazyAttrs(parent);
      if (parentLazy) return parentLazy;

      // Check siblings/children of the card container
      const pImg = parent.querySelector("img");
      if (pImg) {
        const url = resolveImg(pImg);
        if (url) return url;
      }
      const pPic = parent.querySelector("picture");
      if (pPic) {
        const url = resolvePicture(pPic);
        if (url) return url;
      }

      const pBg = resolveBackground(parent);
      if (pBg) return pBg;

      parent = parent.parentElement;
      depth++;
    }

    return null;
  }

  // ─── Layer 2: Viewport Coordinate Resolution ─────────────────────────────────

  function extractImageAtPoint(x, y) {
    let elements;
    try {
      elements = document.elementsFromPoint(x, y);
    } catch (err) {
      return null;
    }
    if (!elements || elements.length === 0) return null;

    // Direct <img>/<picture> in the stack
    for (const el of elements) {
      const url = resolveElement(el);
      if (url) return url;
    }

    // Bounding box match for pointer-events: none elements
    for (const el of elements) {
      const tag = el.tagName?.toUpperCase();
      if (tag !== "IMG" && tag !== "PICTURE") {
        const lazyUrl = resolveLazyAttrs(el);
        if (lazyUrl) return lazyUrl;

        const targetImg = findImgAtCoordinates(el, x, y);
        if (targetImg) {
          const url = resolveElement(targetImg);
          if (url) return url;
        }
      }
    }

    // CSS background-images
    for (const el of elements) {
      const url = resolveBackground(el);
      if (url) return url;
    }

    // Canvas / Video
    for (const el of elements) {
      const tag = el.tagName?.toUpperCase();
      if (tag === "CANVAS") {
        try {
          const d = el.toDataURL("image/png");
          if (d && d !== "data:,") return d;
        } catch { /* tainted */ }
      }
      if (tag === "VIDEO" && el.poster && isValidUrl(el.poster)) {
        return el.poster;
      }
    }

    return null;
  }

  // ─── Resolve Image Elements ──────────────────────────────────────────────────

  function resolveElement(el) {
    if (!el) return null;
    const tag = el.tagName?.toUpperCase();
    if (tag === "IMG") return resolveImg(el);
    if (tag === "PICTURE") return resolvePicture(el);
    return null;
  }

  function resolveImg(el) {
    const lazy = resolveLazyAttrs(el);
    if (lazy) return lazy;

    for (const attr of LAZY_SRCSET_ATTRS) {
      const val = el.getAttribute(attr);
      if (val) {
        const best = resolveBestSrcset(val);
        if (best) return best;
      }
    }

    if (el.currentSrc && isValidUrl(el.currentSrc)) return el.currentSrc;
    if (el.src && isValidUrl(el.src)) return el.src;

    const ss = el.srcset || el.getAttribute("srcset") || "";
    if (ss) {
      const best = resolveBestSrcset(ss);
      if (best) return best;
    }
    return null;
  }

  function resolvePicture(pictureEl) {
    const img = pictureEl.querySelector("img");
    if (img?.currentSrc && isValidUrl(img.currentSrc)) return img.currentSrc;

    for (const source of pictureEl.querySelectorAll("source")) {
      const ss = source.srcset || source.getAttribute("srcset") || "";
      if (ss) {
        const best = resolveBestSrcset(ss);
        if (best) return best;
      }
    }

    if (img?.src && isValidUrl(img.src)) return img.src;
    return null;
  }

  function resolveLazyAttrs(el) {
    for (const attr of LAZY_ATTRS) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      try {
        const resolved = new URL(val.trim(), document.baseURI).href;
        if (isValidUrl(resolved)) return resolved;
      } catch { /* skip */ }
    }
    return null;
  }

  function resolveBackground(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;

    try {
      const style = window.getComputedStyle(el);
      if (style.position === "fixed" || style.position === "sticky") return null;
      if (isLayoutContainer(el)) return null;

      const bg = style.backgroundImage;
      if (!bg || bg === "none") return null;

      const urlRegex = /url\(["']?([^"')]+)["']?\)/g;
      let match;
      while ((match = urlRegex.exec(bg)) !== null) {
        try {
          const resolved = new URL(match[1].trim(), document.baseURI).href;
          if (isValidUrl(resolved)) return resolved;
        } catch { /* skip */ }
      }

      const inline = el.style?.backgroundImage;
      if (inline && inline !== "none") {
        const m = /url\(["']?([^"')]+)["']?\)/.exec(inline);
        if (m) {
          try {
            const resolved = new URL(m[1].trim(), document.baseURI).href;
            if (isValidUrl(resolved)) return resolved;
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
    return null;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  function findImgAtCoordinates(container, x, y) {
    if (!container.querySelectorAll) return null;

    const imgs = container.querySelectorAll("img");
    for (const img of imgs) {
      if (isCoordinateInside(img, x, y)) return img;
    }

    const pictures = container.querySelectorAll("picture");
    for (const pic of pictures) {
      if (isCoordinateInside(pic, x, y)) return pic;
    }
    return null;
  }

  function isCoordinateInside(el, x, y) {
    try {
      const rect = el.getBoundingClientRect();
      return (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom &&
        rect.width > 0 &&
        rect.height > 0
      );
    } catch {
      return false;
    }
  }

  function isLayoutContainer(el) {
    try {
      const rect = el.getBoundingClientRect();
      return rect.width > window.innerWidth * 0.70 && rect.height > 150;
    } catch {
      return false;
    }
  }

  function isValidUrl(url) {
    if (!url || typeof url !== "string") return false;
    const t = url.trim();
    if (!t || t === "about:blank" || t.startsWith("javascript:")) return false;
    if (t.startsWith("data:image/svg+xml")) return false;
    if (t === "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7") return false;
    if (t.startsWith("data:image/gif;base64,R0lGODlh") && t.length < 100) return false;

    return (
      t.startsWith("http://")     ||
      t.startsWith("https://")    ||
      t.startsWith("data:image/") ||
      t.startsWith("blob:")
    );
  }

  function resolveBestSrcset(srcset) {
    if (!srcset) return null;

    const candidates = srcset
      .split(",")
      .map((part) => {
        const trimmed  = part.trim();
        const spaceIdx = trimmed.lastIndexOf(" ");
        if (spaceIdx === -1) return { url: trimmed, density: 1 };

        const url        = trimmed.substring(0, spaceIdx).trim();
        const descriptor = trimmed.substring(spaceIdx + 1).trim();
        let   density    = 1;

        if (descriptor.endsWith("x")) {
          density = parseFloat(descriptor) || 1;
        } else if (descriptor.endsWith("w")) {
          density = (parseFloat(descriptor) || 100) / 100;
        }
        return { url, density };
      })
      .filter((c) => {
        if (!c.url) return false;
        try {
          c.url = new URL(c.url, document.baseURI).href;
          return isValidUrl(c.url);
        } catch { return false; }
      });

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.density - a.density);
    return candidates[0].url;
  }

  // ─── Message Handler ──────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "DEEP_EXTRACT_IMAGE") return false;

    const url = extractImage();

    if (url) {
      console.log("[Deep-Extract] ✅ Resolved:", url);
    } else {
      console.warn("[Deep-Extract] ❌ Failed to extract any image.");
    }

    sendResponse({ url });
    return false;
  });

  console.log("[Deep-Extract] Content script v1.5 loaded.");
})();
