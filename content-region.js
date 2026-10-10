// content-region.js — drag-to-select a screen region for OCR
// Injected via chrome.scripting.executeScript. Listens for 'ocr-start-select'.
(function () {
  if (window.__ocrRegionActive) {
    // already loaded, just (re)start
    return;
  }
  window.__ocrRegionActive = true;
  let overlay = null;
  let box = null;
  let hint = null;
  let startX = 0, startY = 0, curX = 0, curY = 0, dragging = false;
  let pendingMode = 'ocr'; // 'ocr' | 'copy'

  function cleanup() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = box = hint = null;
    dragging = false;
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      cleanup();
      chrome.runtime.sendMessage({ type: 'ocr-region-cancelled' });
    }
  }

  function start(mode) {
    pendingMode = (mode === 'copy') ? 'copy' : 'ocr';
    cleanup();

    overlay = document.createElement('div');
    overlay.id = '__ocr_region_overlay';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '2147483647',
      background: 'rgba(0,0,0,0.35)', cursor: 'crosshair',
      margin: '0', padding: '0'
    });

    box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed', display: 'none',
      border: '2px solid #1a73e8', background: 'rgba(26,115,232,0.15)',
      zIndex: '2147483648', pointerEvents: 'none'
    });
    document.documentElement.appendChild(box);

    hint = document.createElement('div');
    hint.textContent = pendingMode === 'copy'
      ? 'Drag to select a region to copy — Esc to cancel'
      : 'Drag to select a region for OCR — Esc to cancel';
    Object.assign(hint.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
      background: '#202124', color: '#fff', padding: '8px 14px',
      borderRadius: '8px', fontSize: '13px', fontFamily: 'Arial,sans-serif',
      zIndex: '2147483649', pointerEvents: 'none', whiteSpace: 'nowrap'
    });

    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(hint);

    overlay.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      curX = startX; curY = startY;
      draw();
    }, true);

    overlay.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      e.preventDefault(); e.stopPropagation();
      curX = e.clientX; curY = e.clientY;
      draw();
    }, true);

    overlay.addEventListener('mouseup', (e) => {
      if (!dragging) return;
      e.preventDefault(); e.stopPropagation();
      dragging = false;
      curX = e.clientX; curY = e.clientY;
      const x = Math.min(startX, curX), y = Math.min(startY, curY);
      const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
      const ow = overlay, hb = box, ht = hint;
      if (ow.parentNode) ow.parentNode.removeChild(ow);
      if (hb.parentNode) hb.parentNode.removeChild(hb);
      if (ht.parentNode) ht.parentNode.removeChild(ht);
      overlay = box = hint = null;
      document.removeEventListener('keydown', onKey, true);
      if (w < 8 || h < 8) return; // too small, ignore
      chrome.runtime.sendMessage({
        type: 'ocr-region-selected',
        mode: pendingMode,
        rect: {
          x, y, w, h,
          dpr: window.devicePixelRatio || 1,
          viewportW: window.innerWidth,
          viewportH: window.innerHeight
        }
      });
    }, true);

    document.addEventListener('keydown', onKey, true);
  }

  function draw() {
    if (!box) return;
    const x = Math.min(startX, curX), y = Math.min(startY, curY);
    const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
    Object.assign(box.style, {
      display: 'block', left: x + 'px', top: y + 'px',
      width: w + 'px', height: h + 'px'
    });
    if (hint) hint.textContent = `${Math.round(w)} × ${Math.round(h)} — release to capture`;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ocr-start-select') start(msg.mode);
    if (msg && msg.type === 'ocr-copy-image') copyImageToClipboard(msg.dataUrl, msg.rect);
  });

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Could not load screenshot.'));
      im.src = src;
    });
  }

  async function copyImageToClipboard(dataUrl, rect) {
    try {
      const im = await loadImage(dataUrl);
      const scale = im.naturalWidth / rect.viewportW;
      const sx = Math.max(0, Math.round(rect.x * scale));
      const sy = Math.max(0, Math.round(rect.y * scale));
      const sw = Math.min(im.naturalWidth - sx, Math.round(rect.w * scale));
      const sh = Math.min(im.naturalHeight - sy, Math.round(rect.h * scale));
      if (sw <= 0 || sh <= 0) throw new Error('Invalid region.');
      const c = document.createElement('canvas');
      c.width = sw; c.height = sh;
      c.getContext('2d').drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      if (!blob) throw new Error('Crop failed.');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      chrome.runtime.sendMessage({ type: 'ocr-copy-done' });
    } catch (e) {
      chrome.runtime.sendMessage({ type: 'ocr-copy-failed', error: String((e && e.message) || e) });
    }
  }

  // auto-start when first injected via context menu / popup flow handled by background ping
})();
