// Quick-add window opened from context menu. Lets user add description/tags before saving.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const type = params.get('type') === 'word' ? 'word' : 'note';
const text = params.get('text') || '';
const url = params.get('url') || '';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const parseTags = (s) => [...new Set(s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];

$('qaTitle').textContent = type === 'note' ? 'Save selection as Note' : 'Save selection as Word';
$('qaText').textContent = text;
$('qaUrl').textContent = url;
$('qa-note-fields').hidden = type !== 'note';
$('qa-word-fields').hidden = type !== 'word';

if (type === 'note') {
  // prefill title with first line if short
  const firstLine = text.split('\n')[0].slice(0, 80);
  if (firstLine.length < 60) $('qaNoteTitle').value = firstLine;
} else {
  // if selection is a single word, prefill term; else leave full text visible and let user pick
  const single = text.trim().split(/\s+/);
  if (single.length === 1) $('qaWordTerm').value = single[0].slice(0, 120);
  else $('qaWordTerm').value = text.slice(0, 120);
  $('qaWordMeaning').focus();
}

$('qaForm').onsubmit = async (e) => {
  e.preventDefault();
  const tags = parseTags($('qaTags').value);
  const now = Date.now();
  const { notes = [], words = [] } = await chrome.storage.local.get({ notes: [], words: [] });
  if (type === 'note') {
    const title = $('qaNoteTitle').value.trim() || text.split('\n')[0].slice(0, 80) || '(from selection)';
    const description = $('qaDescription').value.trim();
    notes.unshift({ id: uid(), title, body: text, description, tags, sourceUrl: url, pinned: false, createdAt: now, updatedAt: now });
    await chrome.storage.local.set({ notes });
  } else {
    const term = $('qaWordTerm').value.trim() || text.slice(0, 120);
    const meaning = $('qaWordMeaning').value.trim();
    const example = $('qaWordExample').value.trim();
    const description = $('qaWordDescription').value.trim();
    if (!meaning && !description) {
      alert('Add a meaning or description.');
      return;
    }
    words.unshift({ id: uid(), term, meaning: meaning || description, description, example, tags, sourceUrl: url, pinned: false, createdAt: now, updatedAt: now });
    await chrome.storage.local.set({ words });
  }
  window.close();
};
