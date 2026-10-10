// Combined background (MV3 service worker): Lens OCR + Local Notes & Words.
// Merges extension 1 (ocr-*) and extension 2 (nw-*) without overlap.
// Context-menu IDs and runtime message types are namespaced, so no collisions.

const SESSION_KEY_PREFIX = 'ocr-payload-';

// ---- shared helpers (OCR) ----
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

async function savePayload(payload) {
  const id = makeId();
  await chrome.storage.session.set({ [SESSION_KEY_PREFIX + id]: payload });
  return id;
}

async function openViewer(params) {
  const url = chrome.runtime.getURL('viewer.html') + params;
  await chrome.tabs.create({ url });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ---- region select (OCR, from extension 1) ----
async function startRegionSelect(tabId, mode) {
  const msg = { type: 'ocr-start-select', mode: mode === 'copy' ? 'copy' : 'ocr' };
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-region.js']
    });
  } catch (e) {
    // file may already be injected; try to trigger via message
    try {
      await chrome.tabs.sendMessage(tabId, msg);
      return;
    } catch (err) {
      console.warn('region inject failed', e, err);
      return;
    }
  }
  // small delay then tell content to start (in case onload race)
  setTimeout(async () => {
    try { await chrome.tabs.sendMessage(tabId, msg); } catch (e) {}
  }, 150);
}

// ---- quick-add (Notes, from extension 2) ----
const MENU_NOTE = 'nw-save-note';
const MENU_WORD = 'nw-save-word';

function openQuickAdd(type, text, url) {
  const q = new URLSearchParams({ type, text, url }).toString();
  chrome.windows.create({
    url: `quickadd.html?${q}`,
    type: 'popup',
    width: 400,
    height: type === 'note' ? 520 : 560,
  });
}

// ---- combined context menus (single setup, no removeAll race) ----
async function setupMenus() {
  try {
    await chrome.contextMenus.removeAll();
    // OCR menus (extension 1)
    await chrome.contextMenus.create({
      id: 'ocr-image',
      title: 'Extract text from this image',
      contexts: ['image']
    });
    await chrome.contextMenus.create({
      id: 'ocr-region',
      title: 'Capture region & OCR',
      contexts: ['page', 'image', 'video', 'frame', 'action']
    });
    // Notes menus (extension 2, flat so they always show on selection)
    await chrome.contextMenus.create({
      id: MENU_NOTE,
      title: 'Save selection as Note',
      contexts: ['selection'],
    });
    await chrome.contextMenus.create({
      id: MENU_WORD,
      title: 'Save selection as Word',
      contexts: ['selection'],
    });
  } catch (e) {
    console.warn('menu setup failed', e);
  }
}

chrome.runtime.onInstalled.addListener(setupMenus);
chrome.runtime.onStartup.addListener(setupMenus);
// Also run at SW load: MV3 workers may start without onInstalled/onStartup
// firing after an update/reload.
setupMenus();

// ---- combined click handler ----
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // OCR (extension 1)
  if (info.menuItemId === 'ocr-image' && info.srcUrl) {
    await openViewer(`?imageUrl=${encodeURIComponent(info.srcUrl)}`);
    return;
  }
  if (info.menuItemId === 'ocr-region' && tab?.id) {
    await startRegionSelect(tab.id);
    return;
  }
  // Notes (extension 2)
  if (info.menuItemId === MENU_NOTE || info.menuItemId === MENU_WORD) {
    const type = info.menuItemId === MENU_NOTE ? 'note' : 'word';
    const text = (info.selectionText || '').trim().slice(0, 2000);
    if (!text) return;
    const url = tab?.url || info.pageUrl || '';
    openQuickAdd(type, text, url);
  }
});

// ---- combined message handler ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Notes toolbar button (extension 2, sync)
  if (msg?.action === 'nw-open-quickadd') {
    openQuickAdd(msg.type === 'word' ? 'word' : 'note', (msg.text || '').slice(0, 2000), msg.url || '');
    return false;
  }

  (async () => {
    if (msg.type === 'ocr-start-region') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await startRegionSelect(tab.id, 'ocr');
      sendResponse({ ok: true });
    }
    else if (msg.type === 'ocr-copy-region') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await startRegionSelect(tab.id, 'copy');
      sendResponse({ ok: true });
    }
    else if (msg.type === 'ocr-capture-visible') {
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
      const id = await savePayload({ dataUrl, source: 'screenshot', createdAt: Date.now() });
      await openViewer(`?id=${id}`);
      sendResponse({ ok: true });
    }
    else if (msg.type === 'ocr-region-selected') {
      // msg.rect = {x,y,w,h,dpr,viewportW,viewportH}, msg.mode = 'ocr' | 'copy'
      const mode = msg.mode === 'copy' ? 'copy' : 'ocr';
      const winId = sender?.tab?.windowId;
      const dataUrl = winId != null
        ? await chrome.tabs.captureVisibleTab(winId, { format: 'png' })
        : await chrome.tabs.captureVisibleTab({ format: 'png' });
      if (mode === 'copy') {
        // Crop + clipboard write happens in the page (has clipboard access).
        // Fall back to viewer if the target tab is gone.
        const targetTabId = sender?.tab?.id;
        if (targetTabId != null) {
          try {
            await chrome.tabs.sendMessage(targetTabId, {
              type: 'ocr-copy-image',
              dataUrl,
              rect: msg.rect
            });
          } catch (e) {
            const id = await savePayload({ dataUrl, rect: msg.rect, source: 'region-copy', createdAt: Date.now() });
            await openViewer(`?id=${id}`);
          }
        } else {
          const id = await savePayload({ dataUrl, rect: msg.rect, source: 'region-copy', createdAt: Date.now() });
          await openViewer(`?id=${id}`);
        }
        sendResponse({ ok: true });
        return;
      }
      const id = await savePayload({ dataUrl, rect: msg.rect, source: 'region', createdAt: Date.now() });
      await openViewer(`?id=${id}`);
      sendResponse({ ok: true });
    }
    else if (msg.type === 'ocr-region-cancelled') {
      sendResponse({ ok: true });
    }
    else if (msg.type === 'ocr-upload') {
      // msg.dataUrl from popup
      const id = await savePayload({ dataUrl: msg.dataUrl, source: 'upload', createdAt: Date.now() });
      await openViewer(`?id=${id}`);
      sendResponse({ ok: true, id });
    }
    else if (msg.type === 'ocr-open-url') {
      await openViewer(`?imageUrl=${encodeURIComponent(msg.url)}`);
      sendResponse({ ok: true });
    }
    else if (msg.type === 'ocr-fetch-image') {
      // Bypass CORS using host_permissions: fetch in service worker
      try {
        const res = await fetch(msg.url, { credentials: 'omit' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        const dataUrl = await blobToDataUrl(blob);
        sendResponse({ ok: true, dataUrl, contentType: blob.type });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    }
  })();
  return true; // async
});
