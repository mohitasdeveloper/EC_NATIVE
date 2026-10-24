// Behavioural test for www/mini-apps.js against a tiny fake DOM: open → back steps inside the app →
// back at home closes + unmounts; verification screen closes first; double taps; close-while-loading.
//   node tests/mini-apps-flow.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e.stack || e.message)); process.exitCode = 1; } }

// ── fake DOM ──
class El {
  constructor(id) { this.id = id; this._c = new Set(['hidden']); this.innerHTML = ''; this.dataset = {}; this.scrollTop = 0; this.listeners = {}; }
  get classList() {
    const c = this._c, self = this;
    return { add: (x) => c.add(x), remove: (x) => c.delete(x), contains: (x) => c.has(x),
      replace: (a, b) => { if (c.has(a)) { c.delete(a); c.add(b); } }, toggle: (x) => (c.has(x) ? c.delete(x) : c.add(x)) };
  }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  querySelectorAll() { return []; }
}
const els = Object.fromEntries(['modal-mini-app', 'mini-app-body', 'mini-apps-tray', 'view-verification'].map((id) => [id, new El(id)]));
els['view-verification']._c = new Set(['hidden']);
globalThis.document = { getElementById: (id) => els[id] || null };
globalThis.window = globalThis;
const lsStore = new Map();
globalThis.localStorage = { getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: (k) => lsStore.delete(k) };
globalThis.getComputedStyle = (el) => ({ display: el.classList.contains('hidden') ? 'none' : 'flex' });
globalThis.requestAnimationFrame = (fn) => fn();

// Manual timers so the 260ms close animation is under test control
const timers = [];
globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
const flushTimers = () => { while (timers.length) timers.shift()(); };

// recording stand-in for bafs.js (the real one needs a real DOM)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-apps-'));
fs.copyFileSync(path.join(root, 'www/mini-apps.js'), path.join(tmp, 'mini-apps.js'));
fs.copyFileSync(path.join(root, 'www/page-mini-apps.js'), path.join(tmp, 'page-mini-apps.js'));   // imported by mini-apps.js
fs.copyFileSync(path.join(root, 'www/app-settings.js'), path.join(tmp, 'app-settings.js'));         // imported by mini-apps.js
fs.writeFileSync(path.join(tmp, 'supabase.js'), `export const supabase = { rpc: async () => ({ data: [], error: null }) };`);
fs.writeFileSync(path.join(tmp, 'ui.js'), `export function showToast() {}`);
globalThis.__bafs = { calls: [], stack: ['home'], };
fs.writeFileSync(path.join(tmp, 'bafs.js'), `
export async function mountBafs(c) { globalThis.__bafs.calls.push('mount'); c.innerHTML = '<div id="bafs-root"></div>'; }
export function unmountBafs() { globalThis.__bafs.calls.push('unmount'); }
export function bafsIsAtHome() { return globalThis.__bafs.stack.length <= 1; }
export function bafsGoBack() { globalThis.__bafs.stack.pop(); globalThis.__bafs.calls.push('back'); }`);
const mini = await import(path.join(tmp, 'mini-apps.js'));
const B = globalThis.__bafs;
const reset = () => { B.calls.length = 0; B.stack = ['home']; };
const overlay = els['modal-mini-app'], body = els['mini-app-body'];

mini.initMiniApps();

await t('tray renders one circle button per mini app, with the study icon', () => {
  const html = els['mini-apps-tray'].innerHTML;
  assert.equal((html.match(/data-mini-app=/g) || []).length, mini.MINI_APPS.length);
  assert.match(html, /src="img\/study-icon\.png"/, 'bundled icon first');
  assert.match(html, /BAFs App/);
});

await t('opening shows the overlay, slides it in and mounts the app into #mini-app-body', async () => {
  reset();
  await mini.openMiniApp('bafs');
  assert.ok(!overlay.classList.contains('hidden') && overlay.classList.contains('is-open'));
  assert.deepEqual(B.calls, ['mount']);
  assert.match(body.innerHTML, /bafs-root/);
});

await t('a second tap while it is open is ignored (no double mount)', async () => {
  await mini.openMiniApp('bafs');
  assert.deepEqual(B.calls, ['mount']);
});

await t('back inside the app steps back and does NOT close the overlay', () => {
  B.stack = ['home', 'notes', 'pdf-list'];
  mini.miniAppHandleBack();
  assert.deepEqual(B.stack, ['home', 'notes']);
  mini.miniAppHandleBack();
  assert.deepEqual(B.stack, ['home']);
  assert.ok(overlay.classList.contains('is-open') && !overlay.classList.contains('hidden'));
  assert.deepEqual(B.calls, ['mount', 'back', 'back']);
});

await t('back with the verification screen on top closes only that screen', () => {
  els['view-verification']._c = new Set(['flex']);
  mini.miniAppHandleBack();
  assert.ok(els['view-verification'].classList.contains('hidden'));
  assert.ok(overlay.classList.contains('is-open'), 'mini app must still be open');
  assert.ok(!B.calls.includes('unmount'));
});

await t('back at the app home closes: slides out, then hides, unmounts and clears the host', () => {
  mini.miniAppHandleBack();
  assert.ok(!overlay.classList.contains('is-open'));
  assert.ok(!overlay.classList.contains('hidden'), 'still on screen while it animates out');
  assert.ok(!B.calls.includes('unmount'));
  flushTimers();
  assert.ok(overlay.classList.contains('hidden'));
  assert.ok(B.calls.includes('unmount'));
  assert.equal(body.innerHTML, '');
});

await t('a back press during the slide-out animation is swallowed (no error, no second unmount)', async () => {
  reset();
  await mini.openMiniApp('bafs');
  mini.closeMiniApp();
  mini.miniAppHandleBack();
  mini.closeMiniApp();
  flushTimers();
  assert.equal(B.calls.filter((c) => c === 'unmount').length, 1);
});

await t('it can be re-opened after closing (fresh mount each time)', async () => {
  reset();
  await mini.openMiniApp('bafs');
  assert.deepEqual(B.calls, ['mount']);
  mini.closeMiniApp(); flushTimers();
});

await t('closing while the module is still loading never mounts the app afterwards', async () => {
  reset();
  const app = mini.MINI_APPS[0], realLoad = app.load;
  let release;
  app.load = () => new Promise((r) => { release = () => r(realLoad()); }); // a slow import()
  const opening = mini.openMiniApp('bafs');
  assert.ok(!overlay.classList.contains('hidden'), 'overlay is already up while loading');
  mini.closeMiniApp();                                  // user backs out before it finished loading
  release(); await opening; flushTimers();
  app.load = realLoad;
  assert.deepEqual(B.calls, [], 'late-arriving module must not mount into a closed overlay');
  assert.ok(overlay.classList.contains('hidden'));
  assert.equal(body.innerHTML, '');
});

await t('unknown ids are ignored', async () => {
  reset();
  await mini.openMiniApp('nope');
  assert.deepEqual(B.calls, []);
  assert.ok(overlay.classList.contains('hidden'));
});


// ── an admin can hide the BAFs App (app_settings.bafs_app_hidden, see app-settings.js) ──
const settings = await import(path.join(tmp, 'app-settings.js'));
const trayEl = els['mini-apps-tray'];
trayEl.parentElement = new El('tray-section'); trayEl.parentElement._c = new Set();

await t('hidden by an admin: the BAFs circle leaves the tray, and the empty strip is dropped', () => {
  settings.setSettingLocal('bafs_app_hidden', true);
  assert.ok(!/data-mini-app="bafs"/.test(trayEl.innerHTML));
  assert.ok(trayEl.parentElement.classList.contains('hidden'));
});

await t('hidden by an admin: it cannot be opened even by id', async () => {
  reset();
  await mini.openMiniApp('bafs');
  assert.deepEqual(B.calls, []);
  assert.ok(overlay.classList.contains('hidden'));
});

await t('shown again: the circle is back and the strip is restored', () => {
  settings.setSettingLocal('bafs_app_hidden', false);
  assert.match(trayEl.innerHTML, /data-mini-app="bafs"/);
  assert.ok(!trayEl.parentElement.classList.contains('hidden'));
});

await t('hidden while it is open: the overlay closes and the app is unmounted', async () => {
  reset();
  await mini.openMiniApp('bafs');
  assert.ok(overlay.classList.contains('is-open'));
  settings.setSettingLocal('bafs_app_hidden', true);
  assert.ok(!overlay.classList.contains('is-open'));
  flushTimers();
  assert.deepEqual(B.calls, ['mount', 'unmount']);
  settings.setSettingLocal('bafs_app_hidden', false);
});

console.log(`\n${passed} passed`);
