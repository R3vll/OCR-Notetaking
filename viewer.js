// viewer.js — loads image/screenshot/region, crops if needed, runs Tesseract OCR,
// renders selectable text boxes over the image.
const $ = (id) => document.getElementById(id);
const SESSION_KEY_PREFIX = 'ocr-payload-';

const params = new URLSearchParams(location.search);
const payloadId = params.get('id');
const imageUrlParam = params.get('imageUrl');

let currentDataUrl = null;   // final (possibly cropped) image
let lastResult = null;

function setProgress(pct, text) {
  $('progressBar').style.width = Math.round(pct * 100) + '%';
  $('progressText').textContent = text || '';
}

async function loadPayload() {
  if (payloadId) {
    const key = SESSION_KEY_PREFIX + payloadId;
    const obj = await chrome.storage.session.get(key);
    const payload = obj[key];
    if (!payload) throw new Error('Image data expired. Please try again.');
    // optional cleanup
    chrome.storage.session.remove(key).catch(() => {});
    return payload; // {dataUrl, rect?, source}
  }
  if (imageUrlParam) return { imageUrl: imageUrlParam, source: 'image-url' };
  throw new Error('No image provided.');
}

async function resolveToDataUrl(payload) {
  if (payload.dataUrl) {
    $('srcLabel').textContent = '· ' + (payload.source || 'screenshot');
    if (payload.rect) return cropDataUrl(payload.dataUrl, payload.rect);
    return payload.dataUrl;
  }
  if (payload.imageUrl) {
    $('srcLabel').textContent = '· ' + payload.imageUrl.slice(0, 80);
    // Try background fetch first (bypasses CORS with host_permissions)
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'ocr-fetch-image', url: payload.imageUrl });
      if (resp && resp.ok && resp.dataUrl) return resp.dataUrl;
      throw new Error(resp?.error || 'fetch failed');
    } catch (e) {
      // fallback: direct load (may taint canvas, but <img> display still works;
      // OCR will re-fetch via <img> + canvas which may fail — surface error clearly)
      console.warn('background fetch failed, falling back to direct URL', e);
      return payload.imageUrl;
    }
  }
  throw new Error('Unsupported payload.');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    if (!src.startsWith('data:') && !src.startsWith('blob:')) im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Could not load image. The site may block hotlinking — try Upload or Screenshot instead.'));
    im.src = src;
  });
}

async function cropDataUrl(fullDataUrl, rect) {
  const im = await loadImage(fullDataUrl);
  // captureVisibleTab is in device pixels; rect is in CSS pixels.
  const scale = im.naturalWidth / rect.viewportW;
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.min(im.naturalWidth - sx, Math.round(rect.w * scale));
  const sh = Math.min(im.naturalHeight - sy, Math.round(rect.h * scale));
  if (sw <= 0 || sh <= 0) throw new Error('Invalid region.');
  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  c.getContext('2d').drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
  return c.toDataURL('image/png');
}

const TESS_NAMES = { eng: 'English', fra: 'French', spa: 'Spanish', deu: 'German', hin: 'Hindi', ara: 'Arabic', chi_sim: 'Chinese (Simp)', jpn: 'Japanese' };
// Chrome built-in LanguageDetector (on-device, no key) returns ISO 639-1 → map to Tesseract codes
const ISO_TO_TESS = { en: 'eng', fr: 'fra', es: 'spa', de: 'deu', hi: 'hin', ar: 'ara', zh: 'chi_sim', ja: 'jpn' };

// Offline heuristic fallback: script ranges + diacritics + common words. No network needed.
function heuristicDetect(text) {
  const t = text || '';
  const count = (re) => ((t.match(re) || []).length);
  const total = t.replace(/[\s\d\W_]/g, '').length || 1;
  const han = count(/[\u4e00-\u9fff]/g);
  const kana = count(/[\u3040-\u30ff]/g);
  const arabic = count(/[\u0600-\u06ff]/g);
  const deva = count(/[\u0900-\u097f]/g);
  if (kana >= 2) return { lang: 'jpn', confidence: Math.min(0.95, 0.5 + kana / total), method: 'script' };
  if (han >= 3 && han / total > 0.15) return { lang: 'chi_sim', confidence: Math.min(0.95, 0.4 + han / total), method: 'script' };
  if (arabic >= 3 && arabic / total > 0.15) return { lang: 'ara', confidence: Math.min(0.95, 0.4 + arabic / total), method: 'script' };
  if (deva >= 3 && deva / total > 0.15) return { lang: 'hin', confidence: Math.min(0.95, 0.4 + deva / total), method: 'script' };

  const scores = {
    spa: count(/[áéíóúñ¿¡]/g) * 3 + count(/\b(el|la|los|las|un|una|del|que|con|para|como|esta|este|nuevo|nueva|contra|empieza|desplegar|escudo|espana|drones)\b/gi),
    fra: count(/[àâçèêëîïôûùœ]/g) * 3 + count(/\b(le|les|des|une|avec|pour|comme|cette|dans|contre|texte|reconnaissance)\b/gi),
    deu: count(/[äöüß]/g) * 3 + count(/\b(der|die|das|und|mit|für|von|nicht|eine|gegen|text|erkennung)\b/gi),
    eng: count(/\b(the|and|with|from|this|that|text|recognition|against|shield|deploy|start)\b/gi)
  };
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = ranked[0];
  const secondScore = ranked[1][1];
  if (bestScore <= 0) return { lang: 'eng', confidence: 0.2, method: 'heuristic' };
  return { lang: best, confidence: bestScore / (bestScore + secondScore + 2), method: 'heuristic' };
}

async function detectLanguage(text) {
  const sample = (text || '').trim().slice(0, 2000);
  if (sample.length < 5) return { lang: 'eng', confidence: 0, method: 'none' };
  // 1) Chrome built-in on-device detector when available (no API key)
  try {
    if (typeof LanguageDetector !== 'undefined' && LanguageDetector.availability) {
      const avail = await LanguageDetector.availability();
      if (avail !== 'unavailable') {
        const det = await LanguageDetector.create();
        const results = await det.detect(sample);
        const top = results && results[0];
        const code = (top && top.detectedLanguage || '').toLowerCase().split('-')[0];
        if (code && ISO_TO_TESS[code] && top.confidence > 0.4) {
          return { lang: ISO_TO_TESS[code], confidence: top.confidence, method: 'browser' };
        }
      }
    }
  } catch (e) { /* fall through to heuristic */ }
  // 2) offline heuristic
  return heuristicDetect(sample);
}

// All dropdown languages in one combined model for auto mode.
const AUTO_LANGS = ['eng', 'spa', 'fra', 'deu', 'ara', 'hin', 'chi_sim', 'jpn'];

function singleLinePsm() {
  try { return Tesseract.PSM.SINGLE_LINE; } catch (e) { return '7'; }
}

// Upscale small captures + auto-invert light-on-dark images (Tesseract needs
// dark text on light background). Returns { dataUrl, psm }.
async function preprocessImage(src) {
  const im = await loadImage(src);
  const w = im.naturalWidth, h = im.naturalHeight;
  const aspectPsm = (h / Math.max(1, w) < 0.25) ? singleLinePsm() : null;
  const scale = Math.min(4, Math.max(1, 480 / Math.min(w, h)));
  if (scale === 1) {
    // Still check brightness on the original via a downscaled probe.
    const probe = document.createElement('canvas');
    probe.width = Math.min(400, w); probe.height = Math.max(1, Math.round(probe.width * h / w));
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    pctx.drawImage(im, 0, 0, probe.width, probe.height);
    try {
      const d = pctx.getImageData(0, 0, probe.width, probe.height).data;
      let sum = 0, n = 0;
      for (let i = 0; i < d.length; i += 16) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
      if (sum / Math.max(1, n) >= 110) return { dataUrl: src, psm: aspectPsm };
    } catch (e) { return { dataUrl: src, psm: aspectPsm }; } // tainted canvas (hotlink) — use as-is
  }
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(im, 0, 0, cw, ch);
  try {
    const img = ctx.getImageData(0, 0, cw, ch);
    const d = img.data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 28) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
    if (sum / Math.max(1, n) < 110) {
      for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
      ctx.putImageData(img, 0, 0);
    }
    return { dataUrl: c.toDataURL('image/png'), psm: aspectPsm };
  } catch (e) {
    return { dataUrl: src, psm: aspectPsm }; // tainted canvas — use original
  }
}

async function runOCR(dataUrl, lang, psm) {
  setProgress(0.02, 'Initializing OCR engine…');
  // MV3-compatible: engine local, lang data fetched once then cached in IndexedDB
  const worker = await Tesseract.createWorker(lang || 'eng', Tesseract.OEM.LSTM, {
    workerPath: chrome.runtime.getURL('lib/worker.min.js'),
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    corePath: chrome.runtime.getURL('lib'),
    workerBlobURL: false,
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        setProgress(0.05 + m.progress * 0.9, `Recognizing text… ${Math.round(m.progress * 100)}%`);
      } else if (m.status) {
        setProgress(0.05, m.status + '…');
      }
    }
  });
  try {
    if (psm != null) {
      try { await worker.setParameters({ tessedit_pageseg_mode: String(psm) }); } catch (e) {}
    }
    const { data } = await worker.recognize(dataUrl);
    return data;
  } finally {
    await worker.terminate();
  }
}

// Auto mode: ONE pass with all language models loaded. Tesseract segments by script
// itself, so Arabic/Chinese/etc. come out as real characters (not English gibberish).
// Language is then just a label — no slow second pass.
async function runOCRAuto(dataUrl, psm) {
  setProgress(0.02, 'Auto: recognizing… (first run downloads models once, then cached)');
  const data = await runOCR(dataUrl, AUTO_LANGS, psm);
  const sample = (data.text || '').trim();
  if (sample.length >= 5) {
    const det = await detectLanguage(sample);
    if (det.lang && det.confidence >= 0.3) {
      data.detectedLang = det.lang;
      data.detectConfidence = det.confidence;
      data.detectionMethod = det.method;
    }
  }
  return data;
}

function doneText(data) {
  const n = data.words?.length || 0;
  const conf = Math.round(data.confidence || 0);
  const dl = data.detectedLang ? `Detected ${TESS_NAMES[data.detectedLang]} · ` : '';
  return `${dl}${n} words, mean confidence ${conf}%`;
}

function renderResults(data, imgEl) {
  lastResult = data;
  const text = (data.text || '').trim();
  $('fullText').textContent = text || '(no text detected)';
  const words = (data.words || []).filter(w => (w.text || '').trim());
  $('wordCount').textContent = words.length;
  const box = $('words');
  box.innerHTML = '';
  words.forEach(w => {
    const d = document.createElement('div');
    d.className = 'w';
    d.textContent = w.text;
    d.title = `Confidence ${Math.round((w.confidence || 0))}% — click to copy`;
    d.addEventListener('click', () => navigator.clipboard.writeText(w.text));
    box.appendChild(d);
  });
  renderOverlay(words, imgEl);
}

function renderOverlay(words, imgEl) {
  const ov = $('overlay');
  ov.innerHTML = '';
  const show = $('overlayToggle').checked;
  if (!show) return;
  // natural size for % positioning
  const W = imgEl.naturalWidth, H = imgEl.naturalHeight;
  if (!W || !H) return;
  words.forEach(w => {
    const b = w.bbox || w; // {x0,y0,x1,y1}
    if (b.x1 <= b.x0 || b.y1 <= b.y0) return;
    const d = document.createElement('div');
    d.className = 'ocr-box';
    d.style.left = (b.x0 / W * 100) + '%';
    d.style.top = (b.y0 / H * 100) + '%';
    d.style.width = ((b.x1 - b.x0) / W * 100) + '%';
    d.style.height = ((b.y1 - b.y0) / H * 100) + '%';
    d.title = `${w.text} (${Math.round(w.confidence || 0)}%) — drag to select, click box to copy`;
    const s = document.createElement('span');
    s.textContent = w.text;
    // scale font to box height so selection maps onto image
    const boxHpx = imgEl.getBoundingClientRect().height * ((b.y1 - b.y0) / H);
    s.style.fontSize = Math.max(8, boxHpx * 0.85) + 'px';
    d.appendChild(s);
    d.addEventListener('click', (e) => {
      if (window.getSelection().toString()) return; // user was selecting
      navigator.clipboard.writeText(w.text);
      d.style.background = 'rgba(26,115,232,.45)';
      setTimeout(() => d.style.background = '', 400);
    });
    ov.appendChild(d);
  });
}

async function main() {
  try {
    setProgress(0.01, 'Loading image…');
    const payload = await loadPayload();
    const src = await resolveToDataUrl(payload);
    currentDataUrl = src;
    const im = await loadImage(src);
    $('img').src = src; // show original; OCR runs on the enhanced copy
    await new Promise((res, rej) => { $('img').onload = res; $('img').onerror = rej; });
    setProgress(0.05, 'Enhancing image…');
    const prep = await preprocessImage(src);
    setProgress(0.05, 'Running OCR… (first run downloads models once, then cached)');
    const sel = $('lang').value;
    const data = sel === 'auto' ? await runOCRAuto(prep.dataUrl, prep.psm) : await runOCR(prep.dataUrl, sel, prep.psm);
    if (data.detectedLang) $('detectedLabel').textContent = '→ ' + TESS_NAMES[data.detectedLang];
    setProgress(1, 'Done — ' + doneText(data));
    renderResults(data, $('img'));
  } catch (e) {
    console.error(e);
    setProgress(1, 'Error');
    $('fullText').textContent = 'Error: ' + (e.message || e);
    $('progressText').textContent = 'Error: ' + (e.message || e);
  }
}

$('btnCopy').addEventListener('click', () => {
  navigator.clipboard.writeText($('fullText').textContent || '');
});
$('btnDownload').addEventListener('click', () => {
  const blob = new Blob([$('fullText').textContent || ''], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ocr-text.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$('btnRetry').addEventListener('click', async () => {
  if (!currentDataUrl) return main();
  try {
    setProgress(0.05, 'Enhancing image…');
    const prep = await preprocessImage(currentDataUrl);
    setProgress(0.05, 'Running OCR…');
    const sel = $('lang').value;
    const data = sel === 'auto' ? await runOCRAuto(prep.dataUrl, prep.psm) : await runOCR(prep.dataUrl, sel, prep.psm);
    if (data.detectedLang) $('detectedLabel').textContent = '→ ' + TESS_NAMES[data.detectedLang];
    else $('detectedLabel').textContent = '';
    setProgress(1, 'Done — ' + doneText(data));
    renderResults(data, $('img'));
  } catch (e) {
    $('progressText').textContent = 'Error: ' + (e.message || e);
  }
});
$('overlayToggle').addEventListener('change', () => {
  if (lastResult) renderOverlay((lastResult.words || []).filter(w => (w.text || '').trim()), $('img'));
});
window.addEventListener('resize', () => {
  if (lastResult) renderOverlay((lastResult.words || []).filter(w => (w.text || '').trim()), $('img'));
});

main();
