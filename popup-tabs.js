// Top-level OCR <-> Notes switcher (new file, no overlap with originals).
(() => {
  const ocrBtn = document.getElementById('top-ocr');
  const notesBtn = document.getElementById('top-notes');
  const ocrView = document.getElementById('view-ocr');
  const notesView = document.getElementById('view-notes');

  function show(which) {
    const isOcr = which === 'ocr';
    ocrView.hidden = !isOcr;
    notesView.hidden = isOcr;
    ocrBtn.classList.toggle('active', isOcr);
    notesBtn.classList.toggle('active', !isOcr);
    try { chrome.storage.local.set({ uiLastTab: which }); } catch {}
  }

  ocrBtn.addEventListener('click', () => show('ocr'));
  notesBtn.addEventListener('click', () => show('notes'));

  // Restore last tab (defaults to OCR)
  try {
    chrome.storage.local.get({ uiLastTab: 'ocr' }, (r) => {
      show(r.uiLastTab === 'notes' ? 'notes' : 'ocr');
    });
  } catch {
    show('ocr');
  }
})();
