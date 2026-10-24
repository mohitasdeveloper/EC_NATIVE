// Static guards for Mini Apps (www/mini-apps.js + the tray/overlay markup + styles).
// No browser, no deps.   node tests/mini-apps-contract.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const mini = read('www/mini-apps.js'), html = read('www/index.html'), style = read('www/style.css');
const main = read('www/main.js'), sw = read('www/sw.js'), bafs = read('www/bafs.js'), bafsCss = read('www/bafs.css');
const ci = read('.github/workflows/android-build.yml');

let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.message); process.exitCode = 1; } }

t('registry: BAFs App uses the bundled study icon, the hosted URL as a fallback, then a Material icon', () => {
  assert.ok(mini.includes("id: 'bafs'") && mini.includes("name: 'BAFs App'"));
  assert.ok(mini.includes("icon: 'img/study-icon.png'"));
  assert.ok(mini.includes("iconRemote: 'https://i.ibb.co/0jDkVxfB/study-icon.png'"));
  assert.ok(/fallbackIcon: 'school'/.test(mini));
  const fn = mini.slice(mini.indexOf('export function renderMiniAppsTray'), mini.indexOf('// ── Open / close'));
  assert.ok(/triedRemote/.test(fn) && /img\.src = app\.iconRemote/.test(fn) && /markBroken\(\)/.test(fn), 'bundled → remote (once) → Material icon');
});

t('circle: bigger (88px), icon fitted whole inside it (never cropped), fallback icon hidden with enough specificity', () => {
  assert.ok(/\.mini-app-circle \{[^}]*width: 88px;[^}]*height: 88px;/.test(style));
  assert.ok(/\.mini-app-face img \{ width: 70\.7%; height: 70\.7%; object-fit: contain; \}/.test(style));
  assert.ok(/\.mini-app-circle\.is-square \.mini-app-face img \{[^}]*object-fit: cover;/.test(style));
  // Tailwind's .material-symbols-outlined { display: inline-block } loads after style.css: a bare
  // .mini-app-fallback { display: none } would lose and show the icon next to the image
  assert.ok(/\.mini-app-face \.mini-app-fallback \{ display: none;/.test(style));
  assert.ok(/Math\.hypot\(1, r\)/.test(mini), 'non-square icons are sized to the largest box of their aspect ratio that fits the circle');
});

t('icon bundling: precached by the service worker; CI downloads it into www/img if it is not committed', () => {
  assert.ok(sw.includes("'./img/study-icon.png'") && sw.includes("'./leaderboard.js'"));
  assert.ok(/name: Bundle Mini Apps icon/.test(ci) && /www\/img\/study-icon\.png/.test(ci));
  assert.ok(ci.indexOf('Bundle Mini Apps icon') < ci.indexOf('Install Dependencies & Plugins'), 'must land before Capacitor copies www into the APK');
  assert.ok(fs.existsSync(path.join(root, 'www/img/README.md')));
});

t('BAFs bottom bar: Home + Leaderboard, only on top-level views, Leaderboard reset-exclusion keeps its Tailwind styles', () => {
  assert.ok(/id="bafs-bottom-nav"/.test(bafs) && /data-bn="home"/.test(bafs) && /data-bn="leaderboard"/.test(bafs));
  assert.ok(/TOP_LEVEL_VIEWS = \['home', 'leaderboard'\]/.test(bafs));
  assert.ok(/#bafs-root\.at-top #bafs-bottom-nav \{ display: flex; \}/.test(bafsCss));
  assert.ok(/#bafs-root \*:where\(:not\(#bafs-lb-host \*\)\)/.test(bafsCss), 'universal reset must skip the Leaderboard host');
  assert.ok(/#bafs-root button:where\(:not\(#bafs-lb-host \*\)\)/.test(bafsCss));
});

t('Home: tray container is in the dashboard (before the feed); old Hotposts tray stays gone', () => {
  const dash = html.slice(html.indexOf('id="view-dashboard"'), html.indexOf('id="view-search"'));
  assert.ok(dash.includes('id="mini-apps-tray"'));
  assert.ok(dash.indexOf('id="mini-apps-tray"') < dash.indexOf('id="feed-posts-container"'));
  assert.ok(!/hotpost/i.test(dash));
});

t('overlay: #modal-mini-app exists (so pull-to-refresh ignores it) and is a full-screen layer below modals', () => {
  assert.ok(/id="modal-mini-app"[^>]*class="hidden"/.test(html) && html.includes('id="mini-app-body"'));
  assert.ok(/#modal-mini-app \{[^}]*position: fixed;[^}]*inset: 0;[^}]*z-index: 120;/.test(style));
  assert.ok(/#modal-mini-app\.hidden \{ display: none; \}/.test(style), 'id rule would otherwise beat .hidden');
  assert.ok(/padding-top: var\(--sat-raw/.test(style.slice(style.indexOf('#modal-mini-app {'))));
  assert.ok(/\[id\^="modal-"\]:not\(\.hidden\)/.test(main), 'pull-to-refresh guard this relies on');
});

t('back navigation: handler first lets the app step back, then closes; verification screen closes first', () => {
  const fn = mini.slice(mini.indexOf('export function miniAppHandleBack'), mini.indexOf('// ── Init'));
  assert.ok(fn.indexOf('view-verification') < fn.indexOf('app.handleBack') && fn.indexOf('app.handleBack') < fn.indexOf('closeMiniApp()'));
  assert.ok(/handleBack: \(mod\) => \{\s*if \(mod\.bafsIsAtHome\(\)\) return false;\s*mod\.bafsGoBack\(\);\s*return true;/.test(mini));
});

t('close: unmounts the app, clears the host, and double-taps are ignored while opening/closing', () => {
  const fn = mini.slice(mini.indexOf('export function closeMiniApp'), mini.indexOf('// Called by main.js'));
  assert.ok(/app\.unmount\(mod\)/.test(fn) && /body\.innerHTML = ''/.test(fn));
  assert.ok(/current \|\| closing\) return; \/\/ ignore double taps/.test(mini));
});

t('BAFs inside the overlay: home back arrow closes the overlay, scrolls #mini-app-body, CSS overrides are scoped', () => {
  assert.ok(/bafsIsAtHome\(\)\) \{ if \(window\.closeMiniApp\) window\.closeMiniApp\(\); \} else bafsGoBack\(\)/.test(bafs));
  assert.ok(/closest\('#mini-app-body'\)/.test(bafs));
  assert.ok(/#mini-app-body #bafs-root \{ margin: 0;/.test(bafsCss));
});

t('main.js initialises Mini Apps; sw.js precaches the module and caches the icon host', () => {
  assert.ok(/import \{ initMiniApps \} from '\.\/mini-apps\.js'/.test(main) && /initMiniApps\(profile\)/.test(main));
  assert.ok(sw.includes("'./mini-apps.js'") && sw.includes("'i.ibb.co'"));
  assert.ok(sw.includes('MINI_APP_ICON') && mini.includes(sw.match(/MINI_APP_ICON = '([^']+)'/)[1]), 'icon URL must match in sw.js and mini-apps.js');
  assert.ok(Number(sw.match(/ecampus-cache-v(\d+)/)[1]) >= 18, 'cache bumped so devices pick up the new shell');
});

console.log(`\n${passed} passed`);
