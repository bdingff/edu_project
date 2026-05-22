// Validates data/article-001.json against the MVP schema contract.
// Run: node --test tests/article.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const articlePath = join(__dirname, '..', 'data', 'article-001.json');

const article = JSON.parse(await readFile(articlePath, 'utf8'));

test('article: required top-level fields', () => {
  for (const k of ['id', 'title', 'hook', 'level', 'estimated_minutes',
                   'word_count', 'paragraphs', 'sentences', 'glossary']) {
    assert.ok(k in article, `missing field: ${k}`);
  }
  assert.equal(typeof article.title, 'string');
  assert.ok(article.estimated_minutes > 0);
  assert.ok(article.word_count >= 150 && article.word_count <= 260,
            `word_count ${article.word_count} should be 150-260 per PM spec`);
  // Cross-check declared word_count against actual tokenizable words
  const wordRe = /[A-Za-z][A-Za-z'-]*/g;
  let actual = 0;
  for (const s of article.sentences) for (const c of s.chunks) actual += (c.match(wordRe) || []).length;
  assert.equal(actual, article.word_count,
               `declared word_count=${article.word_count} but actual=${actual}`);
});

test('article: every paragraph sentence_id resolves', () => {
  const known = new Set(article.sentences.map(s => s.id));
  for (const p of article.paragraphs) {
    for (const sid of p.sentence_ids) {
      assert.ok(known.has(sid), `paragraph ${p.id} references unknown sentence: ${sid}`);
    }
  }
});

test('article: every sentence has translation + at least 1 chunk', () => {
  for (const s of article.sentences) {
    assert.ok(typeof s.translation === 'string' && s.translation.length > 0,
              `sentence ${s.id} missing translation`);
    assert.ok(Array.isArray(s.chunks) && s.chunks.length >= 1,
              `sentence ${s.id} must have chunks`);
    for (const c of s.chunks) {
      assert.equal(typeof c, 'string');
      assert.ok(c.trim().length > 0, `empty chunk in ${s.id}`);
    }
  }
});

test('article: glossary entries are shaped correctly', () => {
  for (const [lemma, entry] of Object.entries(article.glossary)) {
    assert.equal(lemma, lemma.toLowerCase(), `lemma must be lowercased: ${lemma}`);
    assert.ok(entry.ipa,     `${lemma}: missing ipa`);
    assert.ok(entry.zh,      `${lemma}: missing zh`);
    assert.ok(entry.example, `${lemma}: missing example`);
  }
});

test('article: substantial glossary coverage of unique words', () => {
  // Collect all unique English words from chunks.
  const wordRe = /[A-Za-z][A-Za-z'-]*/g;
  const words = new Set();
  for (const s of article.sentences) {
    for (const c of s.chunks) {
      for (const m of c.match(wordRe) || []) words.add(m.toLowerCase());
    }
  }
  // Glossary doesn't need to cover function words, but we expect >=25 entries.
  assert.ok(Object.keys(article.glossary).length >= 25,
            `glossary too sparse: ${Object.keys(article.glossary).length} entries`);
  // Every glossary key must correspond to a word that appears in the text.
  for (const lemma of Object.keys(article.glossary)) {
    assert.ok(words.has(lemma), `glossary lemma "${lemma}" never appears in article`);
  }
});

test('article: chunk count matches sense-group expectations (1–5 per sentence)', () => {
  for (const s of article.sentences) {
    assert.ok(s.chunks.length <= 5, `sentence ${s.id} has too many chunks (max 5)`);
  }
});
