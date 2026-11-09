/* Service worker: cross-origin SVG fetches and the keyboard shortcut. */

const ALLOWED_HOST = /(^|\.)musescore\.com$/i;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'fetch-svg') {
    let url;
    try { url = new URL(msg.url); } catch { sendResponse({ ok: false, error: 'bad url' }); return; }
    if (url.protocol !== 'https:' || !ALLOWED_HOST.test(url.hostname)) {
      sendResponse({ ok: false, error: 'host not allowed' });
      return;
    }
    fetch(url.href, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        sendResponse({ ok: true, text: await r.text() });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  }
});

const TOGGLES = { 'toggle-note-names': ['enabled', true], 'toggle-focus-mode': ['focus', false] };

chrome.commands.onCommand.addListener((command) => {
  const t = TOGGLES[command];
  if (!t) return;
  const [key, def] = t;
  chrome.storage.sync.get({ [key]: def }, (s) => chrome.storage.sync.set({ [key]: !s[key] }));
});
