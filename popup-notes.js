// popup-notes.js — from extension 2, wrapped in IIFE to avoid collisions.
// Local Notes & Words - MV3 popup, 100% local via chrome.storage.local
(() => {
const $ = (id) => document.getElementById(id);
const store = {
  async get() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const r = await chrome.storage.local.get({ notes: [], words: [], highlights: [] });
      return { notes: r.notes || [], words: r.words || [], highlights: r.highlights || [] };
    }
    // fallback for testing outside extension
    return {
      notes: JSON.parse(localStorage.getItem('notes') || '[]'),
      words: JSON.parse(localStorage.getItem('words') || '[]'),
      highlights: JSON.parse(localStorage.getItem('highlights') || '[]'),
    };
  },
  async set(data) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set(data);
    } else {
      localStorage.setItem('notes', JSON.stringify(data.notes));
      localStorage.setItem('words', JSON.stringify(data.words));
      localStorage.setItem('highlights', JSON.stringify(data.highlights || []));
    }
  },
};

let db = { notes: [], words: [], highlights: [] };
let tab = 'notes';
let editId = null;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const parseTags = (s) => [...new Set(s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
const fmtDate = (ts) => new Date(ts).toLocaleString();

function currentList() { return tab === 'notes' ? db.notes : db.words; }
function setList(arr) { if (tab === 'notes') db.notes = arr; else db.words = arr; }

async function load() {
  db = await store.get();
  render();
}

function filtered() {
  const q = $('search').value.trim().toLowerCase();
  const tag = $('tagFilter').value;
  const pinnedOnly = $('pinnedOnly').checked;
  let items = [...currentList()];
  items.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  return items.filter((it) => {
    if (pinnedOnly && !it.pinned) return false;
    if (tag && !(it.tags || []).includes(tag)) return false;
    if (!q) return true;
    const hay = tab === 'notes'
      ? `${it.title} ${it.body} ${it.description || ''} ${(it.tags || []).join(' ')}`
      : `${it.term} ${it.meaning} ${it.example || ''} ${it.description || ''} ${(it.tags || []).join(' ')}`;
    return hay.toLowerCase().includes(q);
  });
}

function refreshTagFilter() {
  const all = new Set();
  [...db.notes, ...db.words].forEach((it) => (it.tags || []).forEach((t) => all.add(t)));
  const sel = $('tagFilter');
  const prev = sel.value;
  sel.innerHTML = '<option value="">All tags</option>';
  [...all].sort().forEach((t) => {
    const o = document.createElement('option');
    o.value = o.textContent = t;
    sel.appendChild(o);
  });
  sel.value = [...all].includes(prev) ? prev : '';
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  // tabs + views
  $('tab-notes').classList.toggle('active', tab === 'notes');
  $('tab-words').classList.toggle('active', tab === 'words');
  $('tab-hl').classList.toggle('active', tab === 'hl');
  $('view-main').hidden = tab === 'hl';
  $('view-hl').hidden = tab !== 'hl';
  $('wipeBtn').textContent = tab === 'hl' ? 'Clear highlights' : 'Clear tab';
  if (tab === 'hl') { renderHl(); return; }
  $('fields-notes').hidden = tab !== 'notes';
  $('fields-words').hidden = tab !== 'words';
  $('saveBtn').textContent = editId ? 'Save' : 'Add';
  $('cancelBtn').hidden = !editId;

  refreshTagFilter();
  const items = filtered();
  $('count').textContent = `${currentList().length} (${items.length} shown)`;
  $('empty').style.display = items.length ? 'none' : 'block';

  const ul = $('list');
  ul.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'card' + (it.pinned ? ' pinned' : '');
    const tags = (it.tags || []).map((t) => `<span class="tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('');
    const src = it.sourceUrl ? `<div><a href="${escapeHtml(it.sourceUrl)}" target="_blank" style="font-size:11px">source</a></div>` : '';
    const desc = it.description ? `<p class="desc">ℹ ${escapeHtml(it.description)}</p>` : '';
    const head = tab === 'notes'
      ? `<h3><span>${it.pinned ? '📌 ' : ''}${escapeHtml(it.title || '(untitled)')}</span><time>${fmtDate(it.updatedAt)}</time></h3>
         <p>${escapeHtml(it.body || '')}</p>${desc}${src}`
      : `<h3><span>${it.pinned ? '📌 ' : ''}${escapeHtml(it.term)}</span><time>${fmtDate(it.updatedAt)}</time></h3>
         <p class="meaning">${escapeHtml(it.meaning)}</p>
         ${it.example ? `<p class="example">“${escapeHtml(it.example)}”</p>` : ''}${desc}${src}`;
    li.innerHTML = `${head}<div class="meta">${tags}</div>
      <div class="actions">
        <button data-act="pin">${it.pinned ? 'Unpin' : 'Pin'}</button>
        <button data-act="edit">Edit</button>
        <button data-act="copy">Copy</button>
        <button data-act="del" class="danger">Delete</button>
      </div>`;
    li.querySelector('[data-act="pin"]').onclick = () => togglePin(it.id);
    li.querySelector('[data-act="edit"]').onclick = () => startEdit(it.id);
    li.querySelector('[data-act="del"]').onclick = () => del(it.id);
    li.querySelector('[data-act="copy"]').onclick = (e) => copyItem(it, e.target);
    li.querySelectorAll('.tag').forEach((el) => {
      el.onclick = () => { $('tagFilter').value = el.dataset.tag; render(); };
    });
    ul.appendChild(li);
  }
}

async function persist() { await store.set(db); render(); }

const HL_COLORS = { pink: '#ff8fa3', yellow: '#ffe45e', green: '#7bf1a8', blue: '#a9d6ff' };

function renderHl() {
  const q = ($('search')?.value || '').trim().toLowerCase();
  let items = [...(db.highlights || [])].sort((a, b) => b.createdAt - a.createdAt);
  if (q) items = items.filter((h) => `${h.text} ${h.title || ''} ${h.url || ''}`.toLowerCase().includes(q));
  $('count').textContent = `${(db.highlights || []).length} (${items.length} shown)`;
  $('hlEmpty').style.display = items.length ? 'none' : 'block';
  const ul = $('hlList');
  ul.innerHTML = '';
  for (const h of items) {
    const li = document.createElement('li');
    li.className = 'card';
    li.style.borderLeft = `6px solid #E62E2D`;
    li.innerHTML = `<p style="background:${HL_COLORS[h.color] || '#eee'}55;border-radius:4px;padding:2px 4px">${escapeHtml(h.text)}</p>
      <time>${fmtDate(h.createdAt)} — ${escapeHtml(h.title || '')}</time>
      <div class="meta"><span class="tag">${escapeHtml(h.color || '')}</span></div>
      <div class="actions">
        <button data-act="go">Open page</button>
        <button data-act="del" class="danger">Delete</button>
      </div>`;
    li.querySelector('[data-act="del"]').onclick = async () => {
      db.highlights = db.highlights.filter((x) => x.id !== h.id);
      await persist();
    };
    li.querySelector('[data-act="go"]').onclick = () => {
      if (typeof chrome !== 'undefined' && chrome.tabs) chrome.tabs.create({ url: h.url });
      else window.open(h.url, '_blank');
    };
    ul.appendChild(li);
  }
}

async function togglePin(id) {
  const arr = currentList().map((it) => (it.id === id ? { ...it, pinned: !it.pinned, updatedAt: Date.now() } : it));
  setList(arr);
  await persist();
}

async function del(id) {
  if (!confirm('Delete this item?')) return;
  setList(currentList().filter((it) => it.id !== id));
  if (editId === id) resetForm();
  await persist();
}

function startEdit(id) {
  const it = currentList().find((x) => x.id === id);
  if (!it) return;
  editId = id;
  $('editId').value = id;
  $('tags').value = (it.tags || []).join(', ');
  if (tab === 'notes') {
    $('noteTitle').value = it.title || '';
    $('noteBody').value = it.body || '';
    $('noteDesc').value = it.description || '';
    $('noteTitle').focus();
  } else {
    $('wordTerm').value = it.term || '';
    $('wordMeaning').value = it.meaning || '';
    $('wordExample').value = it.example || '';
    $('wordDesc').value = it.description || '';
    $('wordTerm').focus();
  }
  render();
}

function resetForm() {
  editId = null;
  $('editor').reset();
  render();
}

async function onSave(e) {
  e.preventDefault();
  const tags = parseTags($('tags').value);
  const now = Date.now();
  if (tab === 'notes') {
    const title = $('noteTitle').value.trim();
    const body = $('noteBody').value.trim();
    const description = $('noteDesc').value.trim();
    if (!title && !body) return;
    if (editId) {
      setList(currentList().map((it) => (it.id === editId ? { ...it, title, body, description, tags, updatedAt: now } : it)));
    } else {
      const item = { id: uid(), title, body, description, tags, pinned: false, createdAt: now, updatedAt: now };
      setList([item, ...currentList()]);
    }
  } else {
    const term = $('wordTerm').value.trim();
    const meaning = $('wordMeaning').value.trim();
    const example = $('wordExample').value.trim();
    const description = $('wordDesc').value.trim();
    if (!term || !meaning) { alert('Word and meaning are required.'); return; }
    if (editId) {
      setList(currentList().map((it) => (it.id === editId ? { ...it, term, meaning, example, description, tags, updatedAt: now } : it)));
    } else {
      const item = { id: uid(), term, meaning, example, description, tags, pinned: false, createdAt: now, updatedAt: now };
      setList([item, ...currentList()]);
    }
  }
  editId = null;
  $('editor').reset();
  await persist();
}

async function copyItem(it, btn) {
  const text = tab === 'notes'
    ? `${it.title || ''}\n${it.body || ''}${it.description ? `\nDesc: ${it.description}` : ''}\n${(it.tags || []).map((t) => '#' + t).join(' ')}`.trim()
    : `${it.term} — ${it.meaning}${it.example ? `\nEx: ${it.example}` : ''}${it.description ? `\nDesc: ${it.description}` : ''}`;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
    setTimeout(() => render(), 800);
  } catch { alert('Copy failed'); }
}

function exportJson() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), notes: db.notes, words: db.words, highlights: db.highlights || [] }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `notes-words-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importJson(file) {
  const r = new FileReader();
  r.onload = async () => {
    try {
      const d = JSON.parse(r.result);
      const notes = Array.isArray(d.notes) ? d.notes : Array.isArray(d) ? d : [];
      const words = Array.isArray(d.words) ? d.words : [];
      const highlights = Array.isArray(d.highlights) ? d.highlights : [];
      // basic sanitize + merge by id
      const merge = (oldArr, newArr) => {
        const map = new Map(oldArr.map((x) => [x.id, x]));
        for (const x of newArr) if (x && x.id) map.set(x.id, x); else if (x) map.set(uid(), { ...x, id: uid() });
        return [...map.values()];
      };
      db.notes = merge(db.notes, notes);
      db.words = merge(db.words, words);
      db.highlights = merge(db.highlights || [], highlights);
      await persist();
      alert(`Imported. Notes: ${db.notes.length}, Words: ${db.words.length}, Highlights: ${db.highlights.length}`);
    } catch { alert('Invalid JSON file.'); }
  };
  r.readAsText(file);
}

// events
$('tab-notes').onclick = () => { tab = 'notes'; editId = null; $('editor').reset(); render(); };
$('tab-words').onclick = () => { tab = 'words'; editId = null; $('editor').reset(); render(); };
$('tab-hl').onclick = () => { tab = 'hl'; render(); };
$('search').oninput = render;
$('tagFilter').onchange = render;
$('pinnedOnly').onchange = render;
$('editor').onsubmit = onSave;
$('cancelBtn').onclick = resetForm;
$('exportBtn').onclick = exportJson;
$('importFile').onchange = (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; };
$('wipeBtn').onclick = async () => {
  if (tab === 'hl') {
    if (!confirm('Delete ALL highlights? This cannot be undone.')) return;
    db.highlights = [];
    await persist();
    return;
  }
  if (!confirm(`Delete ALL ${tab}? This cannot be undone.`)) return;
  setList([]);
  editId = null;
  $('editor').reset();
  await persist();
};

load();
})();
