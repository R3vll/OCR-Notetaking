// Page highlighter: select text -> bubble with 4 colors (like screenshot) + note / copy / close.
// Highlights persist locally in chrome.storage.local under `highlights`.
(() => {
  if (window.__nwHlLoaded) return;
  window.__nwHlLoaded = true;

  const COLORS = ['pink', 'yellow', 'green', 'blue'];
  const urlKey = () => location.href.split('#')[0];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  let toolbar = null;
  let activeRange = null;
  let activeHlId = null;

  function getXPath(node) {
    if (node.nodeType === Node.DOCUMENT_NODE) return '/';
    const parts = [];
    while (node && node.nodeType !== Node.DOCUMENT_NODE) {
      let i = 1, sib = node.previousSibling;
      while (sib) { if (sib.nodeName === node.nodeName) i++; sib = sib.previousSibling; }
      parts.unshift(`${node.nodeName.toLowerCase()}[${i}]`);
      node = node.parentNode;
    }
    return '/' + parts.join('/');
  }

  function getNodeByXPath(xpath) {
    try {
      const r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue;
    } catch { return null; }
  }

  function getTextNodeAt(xpath, offsetTarget) {
    const el = getNodeByXPath(xpath);
    if (!el) return null;
    if (el.nodeType === Node.TEXT_NODE) return { node: el, offset: Math.min(offsetTarget, el.length) };
    // element: find text node at offset
    let i = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (i === offsetTarget) return { node: n, offset: 0 };
      i++;
    }
    return null;
  }

  function ensureToolbar() {
    if (toolbar) return toolbar;
    toolbar = document.createElement('div');
    toolbar.id = 'nw-hl-toolbar';
    toolbar.innerHTML = `
      <button class="nw-dot" data-color="pink" title="Pink"></button>
      <button class="nw-dot" data-color="yellow" title="Yellow"></button>
      <button class="nw-dot" data-color="green" title="Green"></button>
      <button class="nw-dot" data-color="blue" title="Blue"></button>
      <span class="nw-sep"></span>
      <button class="nw-icon" data-act="clear" title="Clear highlight over selected text"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg></button>
      <button class="nw-icon" data-act="note" title="Save with description">✎</button>
      <button class="nw-icon" data-act="copy" title="Copy">❝</button>
      <button class="nw-icon" data-act="close" title="Close">✕</button>`;
    toolbar.addEventListener('mousedown', (e) => e.preventDefault());
    toolbar.addEventListener('click', onToolbarClick);
    document.documentElement.appendChild(toolbar);
    return toolbar;
  }

  function hideToolbar() {
    if (toolbar) toolbar.style.display = 'none';
    activeRange = null;
    activeHlId = null;
  }

  function showToolbar(x, top, bottom) {
    const tb = ensureToolbar();
    tb.style.display = 'flex';
    tb.style.visibility = 'hidden';
    const tbW = tb.offsetWidth || 260;
    const tbH = tb.offsetHeight || 40;
    const GAP = 10;
    tb.style.left = `${Math.max(8, Math.min(x, window.innerWidth - tbW - 8)) + window.scrollX}px`;
    // Prefer BELOW the selection to avoid colliding with other extension toolbars.
    let y = bottom + window.scrollY + GAP;
    // Flip above only if there is no room below.
    if (bottom + tbH + GAP + 8 > window.innerHeight) {
      y = top + window.scrollY - tbH - GAP;
    }
    tb.style.top = `${Math.max(window.scrollY + 8, y)}px`;
    tb.style.visibility = '';
  }

  async function onToolbarClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.classList.contains('nw-dot')) {
      const color = btn.dataset.color;
      if (activeHlId) await recolorHighlight(activeHlId, color);
      else if (activeRange) await applyHighlight(activeRange, color);
      hideToolbar();
      window.getSelection()?.removeAllRanges();
    } else if (btn.dataset.act === 'close') {
      hideToolbar();
      window.getSelection()?.removeAllRanges();
    } else if (btn.dataset.act === 'clear') {
      await clearHighlightForSelection();
      hideToolbar();
      window.getSelection()?.removeAllRanges();
    } else if (btn.dataset.act === 'copy') {
      const t = window.getSelection()?.toString() || '';
      try { await navigator.clipboard.writeText(t); btn.textContent = '✓'; setTimeout(hideToolbar, 400); } catch {}
    } else if (btn.dataset.act === 'note') {
      const t = window.getSelection()?.toString() || activeHlId
        ? (document.querySelector(`[data-hl-id="${activeHlId}"]`)?.textContent || window.getSelection()?.toString() || '')
        : '';
      chrome.runtime.sendMessage({ action: 'nw-open-quickadd', type: 'note', text: t || '', url: location.href });
      hideToolbar();
    }
  }

  function wrapRange(range, id, color) {
    const span = document.createElement('span');
    span.className = 'nw-hl';
    span.dataset.color = color;
    span.dataset.hlId = id;
    try {
      range.surroundContents(span);
      return span;
    } catch {
      // Fallback for ranges spanning partial nodes
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
      return span;
    }
  }

  async function applyHighlight(range, color) {
    const text = range.toString().slice(0, 2000);
    if (!text.trim()) return;
    const id = uid();
    const startXPath = getXPath(range.startContainer.nodeType === 3 ? range.startContainer.parentNode : range.startContainer);
    const endXPath = getXPath(range.endContainer.nodeType === 3 ? range.endContainer.parentNode : range.endContainer);
    // For text-node precision also store character offsets within parent text content
    const rec = {
      id, color, text,
      url: urlKey(), title: document.title,
      startXPath, startOffset: range.startOffset,
      endXPath, endOffset: range.endOffset,
      createdAt: Date.now(),
    };
    try {
      wrapRange(range.cloneRange(), id, color);
    } catch {}
    const { highlights = [] } = await chrome.storage.local.get({ highlights: [] });
    highlights.push(rec);
    await chrome.storage.local.set({ highlights });
  }

  async function recolorHighlight(id, color) {
    const el = document.querySelector(`[data-hl-id="${id}"]`);
    if (el) el.dataset.color = color;
    const { highlights = [] } = await chrome.storage.local.get({ highlights: [] });
    const next = highlights.map((h) => (h.id === id ? { ...h, color } : h));
    await chrome.storage.local.set({ highlights: next });
  }

  async function removeHighlight(id) {
    const el = document.querySelector(`[data-hl-id="${id}"]`);
    if (el) {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    }
    const { highlights = [] } = await chrome.storage.local.get({ highlights: [] });
    await chrome.storage.local.set({ highlights: highlights.filter((h) => h.id !== id) });
  }

  // Clear any highlight colors overlapping the current selection.
  // Also covers clicking an existing highlight (activeHlId) then hitting clear.
  async function clearHighlightForSelection() {
    const ids = new Set();
    if (activeHlId) ids.add(activeHlId);
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const holder = range.commonAncestorContainer;
      const scope = holder.nodeType === 3 ? holder.parentElement : holder;
      const root = scope instanceof Element ? scope : document.body;
      root.querySelectorAll('.nw-hl').forEach((el) => {
        try {
          if (sel.containsNode(el, true)) ids.add(el.dataset.hlId);
        } catch {}
      });
      // Selection inside (or spanning out of) a highlight: catch ancestors.
      const ancestors = [range.startContainer, range.endContainer, range.commonAncestorContainer];
      for (const n of ancestors) {
        const el = n.nodeType === 3
          ? n.parentElement?.closest?.('.nw-hl')
          : n.closest?.('.nw-hl');
        if (el) ids.add(el.dataset.hlId);
      }
    }
    for (const id of ids) {
      if (id) await removeHighlight(id);
    }
  }

  function restoreOne(rec) {
    try {
      const startEl = getNodeByXPath(rec.startXPath);
      const endEl = getNodeByXPath(rec.endXPath);
      if (!startEl || !endEl) return fallbackRestore(rec);
      // Find text nodes containing rec.text
      const range = document.createRange();
      // Simplest: locate first occurrence of rec.text under common container
      const container = startEl === endEl ? startEl : document.body;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.parentElement?.closest('.nw-hl')) continue;
        const idx = n.textContent.indexOf(rec.text.slice(0, 30));
        if (idx !== -1 && n.textContent.includes(rec.text.slice(0, Math.min(10, rec.text.length)))) {
          range.setStart(n, idx);
          range.setEnd(n, Math.min(n.textContent.length, idx + rec.text.length));
          wrapRange(range, rec.id, rec.color);
          return;
        }
      }
      fallbackRestore(rec);
    } catch { fallbackRestore(rec); }
  }

  function fallbackRestore(rec) {
    // Last resort: text search across body text nodes (first match only per id)
    if (document.querySelector(`[data-hl-id="${rec.id}"]`)) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.parentElement?.closest('script,style,#nw-hl-toolbar,.nw-hl')) continue;
      nodes.push(n);
    }
    const needle = rec.text.slice(0, 40);
    for (const t of nodes) {
      const idx = t.textContent.indexOf(needle);
      if (idx !== -1) {
        try {
          const range = document.createRange();
          range.setStart(t, idx);
          range.setEnd(t, Math.min(t.textContent.length, idx + rec.text.length));
          wrapRange(range, rec.id, rec.color);
        } catch {}
        return;
      }
    }
  }

  async function restoreAll() {
    try {
      const { highlights = [] } = await chrome.storage.local.get({ highlights: [] });
      highlights.filter((h) => h.url === urlKey()).forEach(restoreOne);
    } catch {}
  }

  // Show toolbar on selection
  document.addEventListener('mouseup', (e) => {
    if (e.target.closest?.('#nw-hl-toolbar')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) return;
      // ignore selections inside existing highlight editing? still allow
      try {
        activeRange = sel.getRangeAt(0).cloneRange();
        activeHlId = null;
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        showToolbar(rect.left + rect.width / 2 - 110, rect.top, rect.bottom);
      } catch {}
    }, 30);
  });

  // Click existing highlight -> offer recolor/remove (shift-click removes instantly)
  document.addEventListener('click', async (e) => {
    const hl = e.target.closest?.('.nw-hl');
    if (!hl) {
      if (!e.target.closest?.('#nw-hl-toolbar')) hideToolbar();
      return;
    }
    if (e.shiftKey) { await removeHighlight(hl.dataset.hlId); return; }
    e.stopPropagation();
    activeHlId = hl.dataset.hlId;
    activeRange = null;
    const rect = hl.getBoundingClientRect();
    showToolbar(rect.left + rect.width / 2 - 110, rect.top, rect.bottom);
    // Right-click on highlight deletes it
  });

  document.addEventListener('contextmenu', async (e) => {
    const hl = e.target.closest?.('.nw-hl');
    if (hl && e.altKey) {
      e.preventDefault();
      await removeHighlight(hl.dataset.hlId);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideToolbar();
  });
  document.addEventListener('scroll', () => hideToolbar(), { passive: true });

  // Keep in sync if popup deletes highlights
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.highlights) return;
    const before = new Set([...document.querySelectorAll('.nw-hl')].map((x) => x.dataset.hlId));
    const after = new Set(changes.highlights.newValue.filter((h) => h.url === urlKey()).map((h) => h.id));
    // remove deleted
    [...before].filter((id) => !after.has(id)).forEach((id) => {
      const el = document.querySelector(`[data-hl-id="${id}"]`);
      if (el) { const p = el.parentNode; while (el.firstChild) p.insertBefore(el.firstChild, el); p.removeChild(el); }
    });
    // recolor changed
    (changes.highlights.newValue || []).forEach((h) => {
      const el = document.querySelector(`[data-hl-id="${h.id}"]`);
      if (el && el.dataset.color !== h.color) el.dataset.color = h.color;
    });
  });

  restoreAll();
})();
