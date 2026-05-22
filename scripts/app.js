/* =====================================================================
 *  Slow Read — minimalist English reading app (MVP demo)
 *
 *  Architecture:
 *    1. Fetch article-001.json
 *    2. Bind home card
 *    3. On card tap → render reader (sentences → chunks → tokens)
 *    4. Word drawer is pre-rendered in DOM; tap only toggles text + class
 *    5. Modes: skim (long-press for word) / intensive (tap for word + 译 icon)
 *
 *  Performance contract: pointerdown → drawer paint <200ms.
 *  Implementation: drawer is composited (transform), no layout work on tap.
 *  Measurement is logged to console and exposed as window.__lastDrawerLatency
 * ===================================================================== */

(() => {
  'use strict';

  // ---------- state ----------
  const state = {
    article: null,
    mode: 'skim', // 'skim' | 'intensive'
    promptedIntensive: localStorage.getItem('sr.promptedIntensive') === '1',
  };

  // ---------- DOM ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const homeScreen      = $('#home-screen');
  const readerScreen    = $('#reader-screen');
  const cardEl          = $('#today-card');
  const articleBody     = $('#article-body');
  const drawer          = $('#drawer');
  const drawerBackdrop  = $('#drawer-backdrop');
  const drawerWord      = $('#drawer-word');
  const drawerIpa       = $('#drawer-ipa');
  const drawerZh        = $('#drawer-zh');
  const drawerExample   = $('#drawer-example');
  const drawerClose     = $('#drawer-close');
  const backBtn         = $('#back-btn');
  const modeOpts        = document.querySelectorAll('.mode-toggle__opt');
  const toast           = $('#intensive-toast');
  const toastTry        = $('#toast-try');
  const toastDismiss    = $('#toast-dismiss');
  const progressBar     = document.querySelector('#reader-progress .reader__progress-bar');

  // ---------- bootstrap ----------
  async function init() {
    try {
      const res = await fetch('data/article-001.json', { cache: 'force-cache' });
      state.article = await res.json();
    } catch (err) {
      console.error('Failed to load article:', err);
      return;
    }
    bindHome();
    renderArticle();
    wireEvents();
  }

  // ---------- home ----------
  function bindHome() {
    const a = state.article;
    document.querySelectorAll('[data-bind="title"]').forEach(el => el.textContent = a.title);
    document.querySelectorAll('[data-bind="hook"]').forEach(el => el.textContent = a.hook);
    document.querySelectorAll('[data-bind="time"]').forEach(el => el.textContent = `${a.estimated_minutes} min`);
    document.querySelectorAll('[data-bind="level"]').forEach(el => el.textContent = a.level);
  }

  // ---------- reader render ----------
  function renderArticle() {
    const a = state.article;
    articleBody.dataset.mode = state.mode;
    articleBody.innerHTML = '';

    // Title block (h2 + meta row) inside the article
    const h2 = document.createElement('h2');
    h2.textContent = a.title;
    articleBody.appendChild(h2);

    const meta = document.createElement('div');
    meta.className = 'meta-row';
    meta.innerHTML =
      `<span>${a.level}</span><span class="dot"></span>` +
      `<span>${a.word_count} words</span><span class="dot"></span>` +
      `<span>~${a.estimated_minutes} min</span>`;
    articleBody.appendChild(meta);

    const sentenceMap = new Map(a.sentences.map(s => [s.id, s]));
    for (const para of a.paragraphs) {
      const p = document.createElement('p');
      p.className = 'para';
      for (let i = 0; i < para.sentence_ids.length; i++) {
        const s = sentenceMap.get(para.sentence_ids[i]);
        if (!s) continue;
        renderSentence(s, p);
        // Space between sentences within a paragraph
        if (i < para.sentence_ids.length - 1) {
          p.appendChild(document.createTextNode(' '));
        }
      }
      articleBody.appendChild(p);
    }

    // End sentinel for "finished skim reading" detection
    const sentinel = document.createElement('div');
    sentinel.id = 'end-sentinel';
    sentinel.style.height = '1px';
    articleBody.appendChild(sentinel);
    observeEnd(sentinel);
  }

  function renderSentence(sentence, parentEl) {
    const sentenceEl = document.createElement('span');
    sentenceEl.className = 'sentence';
    sentenceEl.dataset.sentenceId = sentence.id;

    for (let i = 0; i < sentence.chunks.length; i++) {
      const chunkStr = sentence.chunks[i];
      renderChunk(chunkStr, sentenceEl);
      if (i < sentence.chunks.length - 1) {
        sentenceEl.appendChild(document.createTextNode(' '));
        const sep = document.createElement('span');
        sep.className = 'chunk-sep';
        sep.setAttribute('aria-hidden', 'true');
        sentenceEl.appendChild(sep);
      }
    }

    // Translate icon (intensive mode only via CSS)
    const transBtn = document.createElement('button');
    transBtn.className = 'sentence-trans';
    transBtn.type = 'button';
    transBtn.textContent = '译';
    transBtn.setAttribute('aria-label', 'Toggle Chinese translation');
    transBtn.dataset.action = 'toggle-trans';
    sentenceEl.appendChild(transBtn);

    // Translation reveal (sibling div, since it's block-level)
    parentEl.appendChild(sentenceEl);
    const transDiv = document.createElement('span');
    transDiv.className = 'sentence-zh';
    transDiv.dataset.transFor = sentence.id;
    transDiv.textContent = sentence.translation;
    parentEl.appendChild(transDiv);
  }

  // Splits a chunk string into clickable word spans + punctuation/space text nodes.
  // Bounding-box constraint: only word characters are inside .tok spans, so taps
  // on whitespace/punctuation don't fire the lookup.
  function renderChunk(chunkStr, parentEl) {
    const chunkEl = document.createElement('span');
    chunkEl.className = 'chunk';

    // word | punctuation-run | whitespace-run
    const re = /([A-Za-z][A-Za-z''\-]*)|([^A-Za-z\s]+)|(\s+)/g;
    let m;
    while ((m = re.exec(chunkStr)) !== null) {
      if (m[1] !== undefined) {
        const tok = document.createElement('span');
        tok.className = 'tok';
        tok.dataset.lemma = m[1].toLowerCase().replace(/[''‘’]/g, "'");
        tok.textContent = m[1];
        chunkEl.appendChild(tok);
      } else if (m[2] !== undefined) {
        chunkEl.appendChild(document.createTextNode(m[2]));
      } else if (m[3] !== undefined) {
        chunkEl.appendChild(document.createTextNode(m[3]));
      }
    }
    parentEl.appendChild(chunkEl);
  }

  // ---------- drawer ----------
  let drawerOpen = false;
  let lastTokenDownTs = 0;

  function openDrawerForToken(tokEl, originTs) {
    const lemma = tokEl.dataset.lemma;
    const entry = (state.article.glossary || {})[lemma];

    drawerWord.textContent = tokEl.textContent;
    if (entry) {
      drawerIpa.textContent = entry.ipa || '';
      drawerZh.textContent = entry.zh || '（暂无释义）';
      drawerExample.textContent = entry.example || '';
    } else {
      drawerIpa.textContent = '';
      drawerZh.textContent = '（暂无释义，可后续补全）';
      drawerExample.textContent = '';
    }

    // Flash the tapped word briefly
    document.querySelectorAll('.tok.is-flash').forEach(el => el.classList.remove('is-flash'));
    tokEl.classList.add('is-flash');

    if (!drawerOpen) {
      drawer.classList.add('is-open');
      drawerBackdrop.classList.add('is-open');
      drawerBackdrop.hidden = false;
      drawer.setAttribute('aria-hidden', 'false');
      drawerOpen = true;
    }

    // Performance instrumentation: pointerdown → next paint frame
    const startTs = originTs || lastTokenDownTs || performance.now();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const elapsed = performance.now() - startTs;
        window.__lastDrawerLatency = elapsed;
        // eslint-disable-next-line no-console
        console.log(`[perf] tap → drawer paint = ${elapsed.toFixed(1)} ms`);
      });
    });
  }

  function closeDrawer() {
    if (!drawerOpen) return;
    drawer.classList.remove('is-open');
    drawerBackdrop.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    drawerOpen = false;
    document.querySelectorAll('.tok.is-flash').forEach(el => el.classList.remove('is-flash'));
    setTimeout(() => {
      if (!drawerOpen) drawerBackdrop.hidden = true;
    }, 220);
  }

  // ---------- long-press (skim mode) ----------
  let pressTimer = null;
  let pressTokEl = null;
  let pressStartXY = null;
  let pressStartTs = 0;
  const PRESS_MS = 400;
  const PRESS_TOL = 6;

  function startPress(tokEl, x, y, ts) {
    pressTokEl = tokEl;
    pressStartXY = [x, y];
    pressStartTs = ts;
    pressTimer = setTimeout(() => {
      if (pressTokEl) openDrawerForToken(pressTokEl, pressStartTs);
      pressTimer = null;
    }, PRESS_MS);
  }
  function cancelPress() {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
    pressTokEl = null;
    pressStartXY = null;
  }

  // ---------- mode toggle ----------
  function setMode(next) {
    if (next === state.mode) return;
    state.mode = next;
    articleBody.dataset.mode = next;
    modeOpts.forEach(b => {
      b.setAttribute('aria-selected', b.dataset.mode === next ? 'true' : 'false');
    });
  }

  // ---------- screen navigation ----------
  function goReader() {
    homeScreen.hidden = true;
    readerScreen.hidden = false;
    window.scrollTo({ top: 0 });
  }
  function goHome() {
    closeDrawer();
    hideToast();
    readerScreen.hidden = true;
    homeScreen.hidden = false;
    window.scrollTo({ top: 0 });
  }

  // ---------- "try intensive" prompt ----------
  function maybePrompt() {
    if (state.promptedIntensive) return;
    if (state.mode !== 'skim') return;
    state.promptedIntensive = true;
    localStorage.setItem('sr.promptedIntensive', '1');
    showToast();
  }
  function showToast() {
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add('is-open'));
  }
  function hideToast() {
    toast.classList.remove('is-open');
    setTimeout(() => { if (!toast.classList.contains('is-open')) toast.hidden = true; }, 220);
  }

  function observeEnd(sentinel) {
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          maybePrompt();
          io.disconnect();
          break;
        }
      }
    }, { threshold: 0.4 });
    io.observe(sentinel);
  }

  // ---------- progress bar ----------
  function updateProgress() {
    const bodyTop = articleBody.offsetTop;
    const bodyH   = articleBody.offsetHeight;
    const winH    = window.innerHeight;
    const scroll  = window.scrollY;
    const passed  = scroll + winH - bodyTop;
    const ratio   = Math.max(0, Math.min(1, passed / bodyH));
    if (progressBar) progressBar.style.width = (ratio * 100).toFixed(2) + '%';
  }

  // ---------- wire events ----------
  function wireEvents() {
    cardEl.addEventListener('click', goReader);
    cardEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goReader(); }
    });

    backBtn.addEventListener('click', goHome);

    modeOpts.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

    // Token tap (intensive) / long-press (skim).
    // Intensive mode opens drawer on pointerdown for <200ms perceived latency —
    // waiting for click would add the 50-300ms tap-to-click gap on touch devices.
    articleBody.addEventListener('pointerdown', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (!t.classList.contains('tok')) return;
      lastTokenDownTs = e.timeStamp || performance.now();
      if (state.mode === 'skim') {
        startPress(t, e.clientX, e.clientY, lastTokenDownTs);
      } else {
        openDrawerForToken(t, lastTokenDownTs);
      }
    });
    articleBody.addEventListener('pointermove', (e) => {
      if (!pressTimer || !pressStartXY) return;
      const dx = Math.abs(e.clientX - pressStartXY[0]);
      const dy = Math.abs(e.clientY - pressStartXY[1]);
      if (dx > PRESS_TOL || dy > PRESS_TOL) cancelPress();
    });
    articleBody.addEventListener('pointerup', () => cancelPress());
    articleBody.addEventListener('pointercancel', () => cancelPress());

    // Plain click → intensive-mode lookup OR translate icon
    articleBody.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.dataset.action === 'toggle-trans') {
        const sentenceEl = t.closest('.sentence');
        if (!sentenceEl) return;
        const sid = sentenceEl.dataset.sentenceId;
        const transEl = articleBody.querySelector(`.sentence-zh[data-trans-for="${sid}"]`);
        if (transEl) transEl.classList.toggle('is-open');
        e.preventDefault();
        return;
      }
      // Token clicks are handled in pointerdown for latency. No-op here.
    });

    // Drawer close
    drawerClose.addEventListener('click', closeDrawer);
    drawerBackdrop.addEventListener('click', closeDrawer);

    // Swipe-down on drawer to close
    let touchStartY = null;
    drawer.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    drawer.addEventListener('touchmove', (e) => {
      if (touchStartY == null) return;
      const dy = e.touches[0].clientY - touchStartY;
      if (dy > 60) {
        closeDrawer();
        touchStartY = null;
      }
    }, { passive: true });
    drawer.addEventListener('touchend', () => { touchStartY = null; });

    // Escape closes drawer
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawerOpen) closeDrawer();
    });

    // Toast
    toastTry.addEventListener('click', () => { setMode('intensive'); hideToast(); });
    toastDismiss.addEventListener('click', hideToast);

    // Sticky header underline + progress
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const top = readerScreen.querySelector('.reader__top');
        if (top) top.classList.toggle('is-sticky', window.scrollY > 4);
        updateProgress();
        ticking = false;
      });
    }, { passive: true });
  }

  // ---------- public test API ----------
  // Used by /tests/test.html and verification scripts.
  window.SlowRead = {
    state,
    setMode,
    openDrawerForToken,
    closeDrawer,
    goReader,
    goHome,
    findTokenByText(text) {
      const all = articleBody.querySelectorAll('.tok');
      for (const t of all) if (t.textContent === text) return t;
      return null;
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
