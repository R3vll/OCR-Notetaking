// popup-ocr.js — from extension 1, wrapped in IIFE to avoid collisions.
(() => {
  const $ = (id) => document.getElementById(id);
  const status = (t) => { $('status').textContent = t || ''; };

  $('btnUpload').addEventListener('click', () => $('fileInput').click());

  $('fileInput').addEventListener('change', () => {
    const f = $('fileInput').files[0];
    if (!f) return;
    status('Loading image…');
    const r = new FileReader();
    r.onload = async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'ocr-upload', dataUrl: r.result });
        status('');
        window.close();
      } catch (e) {
        status('Failed: ' + e.message);
      }
    };
    r.readAsDataURL(f);
  });

  $('btnShot').addEventListener('click', async () => {
    status('Capturing…');
    try {
      await chrome.runtime.sendMessage({ type: 'ocr-capture-visible' });
      window.close();
    } catch (e) {
      status('Capture failed: ' + e.message);
    }
  });

  $('btnRegion').addEventListener('click', async () => {
    status('Drag a region on the page…');
    try {
      await chrome.runtime.sendMessage({ type: 'ocr-start-region' });
    } catch (e) {
      status('Failed: ' + e.message);
      return;
    }
    setTimeout(() => window.close(), 300);
  });

  $('btnCopyRegion').addEventListener('click', async () => {
    status('Drag a region to copy…');
    try {
      await chrome.runtime.sendMessage({ type: 'ocr-copy-region' });
    } catch (e) {
      status('Failed: ' + e.message);
      return;
    }
    setTimeout(() => window.close(), 300);
  });

  $('btnUrl').addEventListener('click', async () => {
    const url = $('urlInput').value.trim();
    if (!url) return;
    try {
      await chrome.runtime.sendMessage({ type: 'ocr-open-url', url });
      window.close();
    } catch (e) {
      status('Failed: ' + e.message);
    }
  });
  $('urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnUrl').click();
  });
})();
