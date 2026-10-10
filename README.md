# Combined Extension — Lens OCR + Local Notes & Words

Merged from `extension 1` (Lens OCR) and `extension 2` (Local Notes & Words) with no overlaps.

## How overlaps were resolved

| Conflict | Extension 1 | Extension 2 | Resolution |
|---|---|---|---|
| `manifest.json` | OCR perms + viewer + CSP + icons | storage + highlighter content-script | Union: all perms (`activeTab, scripting, contextMenus, tabs, storage, clipboardWrite`), `host_permissions: <all_urls>`, CSP `wasm-unsafe-eval`, content-script kept, `web_accessible_resources` + icons kept |
| `background.js` | `ocr-*` menus + messages, `removeAll` then create 2 | `nw-*` menus + messages, `removeAll` then create 2 | Single `setupMenus()` creates all 4 (`ocr-image`, `ocr-region`, `nw-save-note`, `nw-save-word`); single `onClicked` + single `onMessage` (`ocr-*` via `msg.type`, notes via `msg.action === nw-open-quickadd`). IDs/message types were already namespaced so no rename needed |
| `popup.html` | OCR buttons (`btnUpload`, `btnShot`, …) | Notes editor (`tab-notes`, `editor`, …) | One popup with top switcher `◉ OCR | Notes & Words` → `#view-ocr` + `#view-notes`. No duplicate IDs (verified) |
| `popup.js` (`const $` collision) | OCR logic | Notes logic | Split into `popup-ocr.js` + `popup-notes.js`, each wrapped in IIFE; `popup-tabs.js` handles the top switcher (inline scripts are banned by MV3 CSP) |
| `popup.css` (`.row`, `body`, `button`) | OCR styles | Notes styles | Merged into one file; OCR rules scoped under `#view-ocr`, notes rules under `#view-notes`, shared `.row`/`#saveBtn` kept for `quickadd.html` compat |
| Content scripts | `content-region.js` (OCR drag-select) | `highlighter.js/css` (text highlight) | Both kept as-is; different filenames, different `__window` guards, different z-index usage — coexist |
| Pages | `viewer.html/js/css` + `lib/*` + `icons/*` | `quickadd.html/js` | All kept as-is, no filename collisions |

## Install

1. `chrome://extensions` → Developer mode → Load unpacked → select `combined-extension/`
2. Pin it. Popup opens on OCR tab; last tab is remembered in `chrome.storage.local.uiLastTab`.

## Test checklist

- Right-click image → Extract text (OCR viewer opens)
- Right-click page → Capture region & OCR (drag overlay)
- Popup → OCR → Upload / Capture / Region / URL
- Select text on any page → highlight bubble (pink/yellow/green/blue, note/copy)
- Right-click selection → Save as Note / Word → quick-add window saves with description/tags
- Popup → Notes & Words → add/edit/pin/search/tag/export/import; Highlights tab lists page highlights
