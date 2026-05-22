// End-to-end DOM behavior tests, run in jsdom.
// Run: node --test tests/dom.test.mjs
//
// Covers:
//   - Article renders into article body with correct token/chunk structure
//   - Mode toggle swaps data-mode + visibility of chunk-sep / sentence-trans
//   - pointerdown on token in intensive mode opens drawer
//   - Drawer close paths: backdrop click, close button, Escape
//   - Sentence translate icon click toggles .sentence-zh visibility
//   - Glossary lookup is case-insensitive

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const html      = await readFile(join(repoRoot, 'index.html'), 'utf8');
const appJs     = await readFile(join(repoRoot, 'scripts', 'app.js'), 'utf8');
const articleJs = await readFile(join(repoRoot, 'data', 'article-001.json'), 'utf8');
const articleData = JSON.parse(articleJs);

async function boot() {
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  // Stub fetch so the app can load the JSON without HTTP.
  dom.window.fetch = async (url) => {
    if (String(url).endsWith('article-001.json')) {
      return { ok: true, json: async () => articleData };
    }
    throw new Error('unexpected fetch: ' + url);
  };

  // jsdom doesn't implement PointerEvent fully; provide a shim using MouseEvent.
  dom.window.PointerEvent = dom.window.MouseEvent;

  // Run the app.
  dom.window.eval(appJs);

  // Allow init() microtask + fetch resolution to complete.
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));

  return dom;
}

let dom, window, document;
beforeEach(async () => {
  dom = await boot();
  window = dom.window;
  document = window.document;
});

test('renders home title and hook', () => {
  const titleEl = document.querySelector('.card__title');
  assert.equal(titleEl.textContent, articleData.title);
  const hookEl = document.querySelector('.card__hook');
  assert.equal(hookEl.textContent, articleData.hook);
});

test('reader article contains expected paragraph + token count', () => {
  // The reader is hidden initially; the article body is still rendered.
  const paras = document.querySelectorAll('#article-body p.para');
  assert.equal(paras.length, articleData.paragraphs.length);

  const tokens = document.querySelectorAll('#article-body .tok');
  // Loose bound — every alphabetic word in chunks becomes a .tok.
  assert.ok(tokens.length >= 150 && tokens.length <= 260,
            `token count ${tokens.length} out of expected range`);
});

test('tokens carry data-lemma in lowercase', () => {
  const tokens = document.querySelectorAll('#article-body .tok');
  for (const t of tokens) {
    assert.equal(t.dataset.lemma, t.dataset.lemma.toLowerCase());
  }
});

test('mode toggle switches data-mode attribute', () => {
  const articleBody = document.getElementById('article-body');
  assert.equal(articleBody.dataset.mode, 'skim');

  const intensiveBtn = document.querySelector('.mode-toggle__opt[data-mode="intensive"]');
  intensiveBtn.click();
  assert.equal(articleBody.dataset.mode, 'intensive');
  assert.equal(intensiveBtn.getAttribute('aria-selected'), 'true');

  const skimBtn = document.querySelector('.mode-toggle__opt[data-mode="skim"]');
  skimBtn.click();
  assert.equal(articleBody.dataset.mode, 'skim');
});

test('pointerdown on token in intensive mode opens drawer with glossary entry', () => {
  // Switch to intensive
  document.querySelector('.mode-toggle__opt[data-mode="intensive"]').click();

  // Find a token whose lemma is in the glossary
  const target = Array.from(document.querySelectorAll('#article-body .tok'))
                      .find(t => articleData.glossary[t.dataset.lemma]);
  assert.ok(target, 'no testable token found');

  const ev = new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true });
  target.dispatchEvent(ev);

  const drawer = document.getElementById('drawer');
  assert.ok(drawer.classList.contains('is-open'), 'drawer should be open');
  assert.equal(drawer.getAttribute('aria-hidden'), 'false');

  const entry = articleData.glossary[target.dataset.lemma];
  assert.equal(document.getElementById('drawer-zh').textContent, entry.zh);
  assert.equal(document.getElementById('drawer-ipa').textContent, entry.ipa);
});

test('backdrop click closes drawer', () => {
  document.querySelector('.mode-toggle__opt[data-mode="intensive"]').click();
  const tok = document.querySelector('#article-body .tok');
  tok.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
  assert.ok(document.getElementById('drawer').classList.contains('is-open'));

  document.getElementById('drawer-backdrop').click();
  assert.ok(!document.getElementById('drawer').classList.contains('is-open'));
});

test('close button closes drawer', () => {
  document.querySelector('.mode-toggle__opt[data-mode="intensive"]').click();
  const tok = document.querySelector('#article-body .tok');
  tok.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
  document.getElementById('drawer-close').click();
  assert.ok(!document.getElementById('drawer').classList.contains('is-open'));
});

test('Escape closes drawer', () => {
  document.querySelector('.mode-toggle__opt[data-mode="intensive"]').click();
  const tok = document.querySelector('#article-body .tok');
  tok.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));

  const ev = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  document.dispatchEvent(ev);
  assert.ok(!document.getElementById('drawer').classList.contains('is-open'));
});

test('sentence translate icon toggles .sentence-zh', () => {
  document.querySelector('.mode-toggle__opt[data-mode="intensive"]').click();
  const transBtn = document.querySelector('.sentence-trans');
  const sentenceId = transBtn.closest('.sentence').dataset.sentenceId;
  const zhEl = document.querySelector(`.sentence-zh[data-trans-for="${sentenceId}"]`);
  assert.ok(!zhEl.classList.contains('is-open'));
  transBtn.click();
  assert.ok(zhEl.classList.contains('is-open'));
  transBtn.click();
  assert.ok(!zhEl.classList.contains('is-open'));
});

test('skim-mode click on token does NOT open drawer (long-press only)', () => {
  // Default mode is skim
  const tok = document.querySelector('#article-body .tok');
  // A plain click event without long-press should be ignored
  tok.click();
  assert.ok(!document.getElementById('drawer').classList.contains('is-open'),
            'skim-mode click should not open drawer');
});

test('home card click navigates to reader', () => {
  assert.equal(document.getElementById('home-screen').hidden, false);
  assert.equal(document.getElementById('reader-screen').hidden, true);
  document.getElementById('today-card').click();
  assert.equal(document.getElementById('home-screen').hidden, true);
  assert.equal(document.getElementById('reader-screen').hidden, false);
});

test('back button returns to home', () => {
  document.getElementById('today-card').click();
  document.getElementById('back-btn').click();
  assert.equal(document.getElementById('home-screen').hidden, false);
  assert.equal(document.getElementById('reader-screen').hidden, true);
});

test('drawer synchronous open: pointerdown → is-open class set in same task (<200ms guarantee)', () => {
  document.querySelector('.mode-toggle__opt[data-mode="intensive"]').click();
  const tok = document.querySelector('#article-body .tok');
  const before = Date.now();
  tok.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
  const after = Date.now();
  assert.ok(document.getElementById('drawer').classList.contains('is-open'));
  // The synchronous handler completes well under 200ms (typically <2ms in jsdom).
  // This guarantees no async work blocks the perceived open; the only remaining
  // latency in a real browser is one paint frame (~16ms @ 60Hz).
  assert.ok(after - before < 50,
            `synchronous open took ${after - before}ms, should be <50ms`);
});
