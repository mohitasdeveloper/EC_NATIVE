// Static guards for the native BAFs App (www/bafs.js + bafs.css) and the on-device PDF
// store (www/pdf-viewer.js). No browser, no deps.   node tests/bafs-pdf-contract.test.mjs
// Catches the regressions that would silently break either feature: an unscoped CSS rule
// leaking into the main app, an un-prefixed id colliding with it, a file missing from the
// service-worker precache, or the bundled pdf.js not being vendored.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const css = read('www/bafs.css'), bafs = read('www/bafs.js'), viewer = read('www/pdf-viewer.js');
const sw = read('www/sw.js'), search = read('www/search.js'), vendor = read('scripts/vendor.js');
const pkg = JSON.parse(read('package.json'));
const indexHtml = read('www/index.html'), styleCss = read('www/style.css'), tailwindSrc = read('www/tailwind-src.css');

let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.message); process.exitCode = 1; } }

t('bafs.css: every rule is scoped under #bafs-root (nothing can leak into the main app)', () => {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const bad = [];
  body.replace(/(^|\})\s*([^{}@]+)\{/g, (m, a, sel) => {
    for (const s of sel.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!s.includes('#bafs-root') && !/^(from|to|\d+%)(\s*,\s*\d+%)*$/.test(s)) bad.push(s);
    }
    return m;
  });
  assert.deepEqual(bad, []);
});

t('bafs.css: keyframes are bafs-* prefixed', () => {
  const names = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
  assert.ok(names.length > 0);
  assert.ok(names.every((n) => n.startsWith('bafs-')), names.join());
});

t('bafs.js: every id in the markup is bafs-* and every $(\'#…\') lookup targets one', () => {
  const tpl = bafs.slice(bafs.indexOf('const TEMPLATE = `'), bafs.indexOf('`;', bafs.indexOf('const TEMPLATE = `')));
  const ids = [...tpl.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 20);
  assert.deepEqual(ids.filter((i) => !i.startsWith('bafs-')), []);
  const lookups = [...bafs.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(lookups)].filter((i) => !ids.includes(i)), []);
  assert.ok(!/onclick=/.test(tpl), 'inline handlers would need globals — use data-* + the delegated listener');
});

t('bafs.js: no iframe/postMessage bridge, direct calls into the viewer, store tag + unmount hooks', () => {
  assert.ok(!/postMessage|window\.parent|contentWindow/.test(bafs.replace(/\/\/.*$/gm, '')));
  assert.ok(/window\.openPdfViewer\(url, title, \{ tag: PDF_TAG \}\)/.test(bafs));
  assert.ok(/window\.bafsIsAtHome\s*=/.test(bafs) && /window\.bafsGoBack\s*=/.test(bafs));
  assert.ok(/export function unmountBafs/.test(bafs) && /export async function mountBafs/.test(bafs));
});

t('search.js mounts bafs.js on demand (dynamic import) and unmounts it for other pills', () => {
  assert.ok(/import\('\.\/bafs\.js'\)/.test(search));
  assert.ok(/tab !== 'bafs' && bafsModule\) bafsModule\.unmountBafs\(\)/.test(search));
  assert.ok(!fs.existsSync(path.join(root, 'www/bafs-study-planner.html')));
});

t('main.js back handler steps back inside BAFs only while the Search tab is showing', () => {
  const main = read('www/main.js');
  assert.ok(/searchTabVisible[\s\S]{0,200}window\.bafsIsAtHome\(\)[\s\S]{0,80}window\.bafsGoBack\(\)/.test(main));
});

t('pdf-viewer.js: persistent IndexedDB store with validation, migration and the leaderboard events', () => {
  for (const needle of ["'ECampusPDFs'", 'indexedDB.open', 'looksLikePdf', 'navigator.storage.persist', "'ecampus-pdf-cache-v1'", 'window.pdfStore = {']) {
    assert.ok(viewer.includes(needle), 'missing ' + needle);
  }
  for (const e of ['open', 'ready', 'close']) assert.ok(viewer.includes(`emit('${e}')`), 'study-time event ' + e);
  assert.ok(/vendor\/pdfjs\/pdf\.min\.js/.test(viewer), 'bundled pdf.js should be tried before the CDN');
});

t('sw.js: precaches the new files, no longer writes PDFs to Cache Storage, cache name bumped', () => {
  for (const f of ['./bafs.js', './bafs.css', './vendor/pdfjs/pdf.min.js', './vendor/pdfjs/pdf.worker.min.js']) assert.ok(sw.includes(`'${f}'`), f);
  assert.ok(!/cache\.put\(request/.test(sw.slice(sw.indexOf('function pdfLegacyThenNetwork'), sw.indexOf('function pdfLegacyThenNetwork') + 600)));
  assert.ok(Number(sw.match(/ecampus-cache-v(\d+)/)[1]) >= 14);
});

t('build: pdfjs-dist is pinned and vendored (offline engine)', () => {
  assert.equal(pkg.dependencies['pdfjs-dist'], '3.11.174');
  assert.ok(vendor.includes('pdfjs-dist/build/pdf.min.js') && vendor.includes('pdfjs-dist/build/pdf.worker.min.js'));
  assert.ok(/pdfjs-dist@?|PDFJS_VERSION = '3\.11\.174'/.test(viewer));
});

t('BAFs works offline: bundled Outlined icon font, nothing fetched from Google, icons listed for subsetting', () => {
  assert.ok(!/googleapis|gstatic/.test(bafs + css.replace(/\/\*[\s\S]*?\*\//g, '')), 'bafs.js / bafs.css must not reference Google Fonts');
  assert.ok(/#bafs-root \.msr \{\s*font-family: 'Material Symbols Outlined'/.test(css));
  assert.ok(/fonts\.load\("24px 'Material Symbols Outlined'"\)/.test(bafs));
  assert.ok(read('www/fonts/fonts.css').includes("font-family: 'Material Symbols Outlined'"));
  const listed = new Set(read('www/fonts/icons-used.txt').split(/\s+/));
  const used = [...bafs.matchAll(/class="msr[^"]*"[^>]*>([a-z_0-9]+)</g)].map((m) => m[1]);
  assert.deepEqual(used.filter((n) => !listed.has(n)), [], 'BAFs icons missing from fonts/icons-used.txt');
});

t('offline strip takes space above the content: --sat includes it, banner sits under the status bar', () => {
  assert.ok(/--sat-raw:/.test(tailwindSrc) && /--offline-h:\s*0px/.test(tailwindSrc));
  assert.ok(/--sat:\s*calc\(var\(--sat-raw\) \+ var\(--offline-h\)\)/.test(tailwindSrc));
  assert.ok(/:root\.offline-strip\s*\{\s*--offline-h:/.test(styleCss));
  assert.ok(/#smart-offline-banner\s*\{[^}]*top:\s*var\(--sat-raw/.test(styleCss));
  assert.ok(/#smart-offline-banner\.hidden\s*\{\s*display:\s*none/.test(styleCss), 'id rule would otherwise beat .hidden');
  assert.ok(!/header\.style\.marginTop|header\) header\.style/.test(indexHtml), 'old header-only push hack should be gone');
  assert.ok(/classList\.add\('offline-strip'\)/.test(indexHtml) && /classList\.remove\('offline-strip'\)/.test(indexHtml));
  assert.ok(/#pdfv-overlay \{[^}]*--sat: var\(--sat-raw/.test(viewer), 'full-screen PDF viewer should not leave a gap for the strip it covers');
});

console.log(`\n${passed} passed`);
