# Privacy Policy for Deep-Extract Image Downloader

**Last Updated:** July 14, 2026

Deep-Extract Image Downloader ("we," "our," or "the extension") is committed to protecting your privacy. This Privacy Policy explains our practices regarding data collection and usage inside the extension.

---

## 1. No Data Collection

The extension does **not** collect, store, transmit, or share any personal data, browsing history, or user information. 

- **Local Storage:** All settings and download history are saved entirely on your local device using Chrome's secure storage APIs (`chrome.storage.sync` and `chrome.storage.local`).
- **No External Servers:** The extension operates entirely inside your local browser environment. It does not communicate with any external servers or APIs under our control.
- **No Tracking:** We do not use cookies, trackers, or analytics scripts inside the extension.

---

## 2. Permissions Justification

To perform its functions, the extension requests the following permissions, strictly adhering to the **Chrome Web Store Minimal Permissions Policy**:

- **`activeTab`**: Temporary permission used to capture page view screenshots or communicate with the content script in the current active tab when you explicitly trigger the extension.
- **`scripting`**: Used to programmatically inject the core image resolution script into pages that were already open before the extension was installed/updated, avoiding page-reload requirements.
- **`downloads`**: Used to save resolved images and screenshots directly to your local computer's `Downloads` folder.
- **`storage` / `unlimitedStorage`**: Used to persist your preferred configuration (naming styles, subfolder name) and lightweight history logs locally.
- **`<all_urls>`**: Required to allow the content script to run on all pages so you can bypass download protections on any website you browse.

---

## 3. Policy Changes

We may update this Privacy Policy from time to time. Any updates will be reflected in the version history of the extension on the Chrome Web Store.

---

## 4. Contact

If you have any questions or feedback regarding this privacy policy, please open an issue on our GitHub repository:
[https://github.com/MuratBrls/Image_Cather](https://github.com/MuratBrls/Image_Cather)
