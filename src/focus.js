/*
 * Focus mode: hides everything on a musescore.com score page except the
 * score pages and the player (toolbar, mixer, keyboard, etc.).
 *
 * The site's class names are hashed and change between deployments, so the
 * layout is found structurally: the page scroller is the scrollable ancestor
 * of the score images, the player is its enclosing <main>.
 */
(function () {
  'use strict';

  const HIDE = 'data-msnn-hide';
  const MAIN = 'data-msnn-main';
  let on = false;
  let mo = null;
  let pending = false;

  function scoreImage() {
    return [...document.images].find((i) => /\/score_\d+\.(svg|png)/.test(i.src) && i.offsetWidth > 200);
  }

  function findScroller(img) {
    for (let el = img; el && el !== document.body; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
    }
    return null;
  }

  function mark(el) {
    if (el && !el.hasAttribute(HIDE)) el.setAttribute(HIDE, '');
  }

  function apply() {
    pending = false;
    if (!on) return;
    const img = scoreImage();
    const scroller = img && findScroller(img);
    if (!scroller) return; // not a score page (yet)
    const main = scroller.closest('main') || scroller.parentElement?.parentElement?.parentElement;
    if (!main) return;
    if (!main.hasAttribute(MAIN)) main.setAttribute(MAIN, '');

    // Sidebar, its resize handle and collapse button.
    for (const sib of main.parentElement.children) {
      if (sib !== main && !/^(SCRIPT|STYLE|LINK)$/.test(sib.tagName)) mark(sib);
    }
    // Site header / promo banner / footer further up. Generic <div>s at the
    // top level are left alone: modals and menus get mounted there.
    for (let el = main.parentElement; el && el !== document.body; el = el.parentElement) {
      for (const sib of el.parentElement.children) {
        if (sib !== el && /^(HEADER|ASIDE|FOOTER|NAV)$/.test(sib.tagName)) mark(sib);
      }
    }
    // Inside the scroller: keep only the page containers (recommendations,
    // comments and the rating prompt live there too).
    const pageEl = [...scroller.children].find((c) => c.contains(img));
    const pageClass = pageEl && pageEl.className;
    if (pageClass) {
      for (const c of scroller.children) {
        if (c.className !== pageClass) mark(c);
      }
    }
    ensureExitButton();
  }

  function schedule() {
    if (pending || !on) return;
    pending = true;
    requestAnimationFrame(apply);
  }

  function ensureExitButton() {
    if (!on || document.getElementById('msnn-exit-focus')) return;
    const b = document.createElement('button');
    b.id = 'msnn-exit-focus';
    b.type = 'button';
    b.textContent = 'Exit focus';
    b.title = 'Exit focus mode (Esc)';
    b.addEventListener('click', () => setFocus(false, true));
    document.body.appendChild(b);
  }

  function setFocus(value, persist) {
    on = !!value;
    document.documentElement.classList.toggle('msnn-focus', on);
    if (on) {
      apply();
      if (!mo) {
        mo = new MutationObserver(schedule);
        mo.observe(document.body, { childList: true, subtree: true });
      }
    } else {
      mo?.disconnect();
      mo = null;
      document.querySelectorAll(`[${HIDE}]`).forEach((e) => e.removeAttribute(HIDE));
      document.querySelectorAll(`[${MAIN}]`).forEach((e) => e.removeAttribute(MAIN));
      document.getElementById('msnn-exit-focus')?.remove();
    }
    // Let the viewer recompute its layout for the new size.
    window.dispatchEvent(new Event('resize'));
    if (persist && typeof chrome !== 'undefined' && chrome.storage) chrome.storage.sync.set({ focus: on });
  }

  document.addEventListener('keydown', (e) => {
    if (!on || e.key !== 'Escape' || e.defaultPrevented) return;
    // Leave Esc to open dialogs (mixer etc.) first.
    if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    setFocus(false, true);
  });

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get({ focus: false }, (s) => setFocus(s.focus, false));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.focus) setFocus(changes.focus.newValue, false);
    });
  }

  window.MSNN = window.MSNN || {};
  // Re-injection (dev harness): switch the previous instance off first.
  if (window.MSNN.setFocus) window.MSNN.setFocus(false, false);
  window.MSNN.setFocus = setFocus;
})();
