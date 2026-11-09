const DEFAULTS = {
  enabled: true,
  system: 'english',
  octave: false,
  position: 'beside',
  size: 2.0,
  color: '#d0021b',
  colorByNote: false,
  asciiAccidentals: false,
};

const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS, (s) => {
  for (const [key, value] of Object.entries(s)) {
    const el = $(key);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = value;
    else el.value = value;
  }
  document.body.classList.toggle('disabled', !s.enabled);
});

for (const key of Object.keys(DEFAULTS)) {
  const el = $(key);
  if (!el) continue;
  el.addEventListener('input', () => {
    let value = el.type === 'checkbox' ? el.checked : el.value;
    if (key === 'size') value = parseFloat(value);
    chrome.storage.sync.set({ [key]: value });
    if (key === 'enabled') document.body.classList.toggle('disabled', !value);
  });
}

// Focus mode button (state lives in storage so it follows you between scores).
const focusBtn = $('focus');
chrome.storage.sync.get({ focus: false }, ({ focus }) => focusBtn.setAttribute('aria-pressed', String(focus)));
focusBtn.addEventListener('click', () => {
  const next = focusBtn.getAttribute('aria-pressed') !== 'true';
  focusBtn.setAttribute('aria-pressed', String(next));
  chrome.storage.sync.set({ focus: next });
});

// Ask the content script in the active tab how it is doing.
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const status = $('status');
  if (!tab || !/^https:\/\/([^/]+\.)?musescore\.com\//.test(tab.url || '')) return;
  chrome.tabs.sendMessage(tab.id, { type: 'status' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      status.textContent = 'Reload the page to activate note names.';
      return;
    }
    if (res.pages) {
      status.textContent = `${res.notes} notes named on ${res.pages} page${res.pages === 1 ? '' : 's'}` +
        (res.pending ? ` (${res.pending} loading…)` : '') + '. More pages load as you scroll.';
    } else if (res.raster) {
      status.textContent = 'This score is only available as images (PNG), so note names cannot be read from it.';
      status.classList.add('warn');
    } else if (res.pending) {
      status.textContent = 'Reading the score…';
    } else {
      status.textContent = 'No score found on this page.';
    }
  });
});
