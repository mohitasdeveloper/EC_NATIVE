// Behavioural test for www/screen-privacy.js (admin "Full Privacy" mode).
//   node tests/screen-privacy.test.mjs
//
// Loads the REAL module against a fake native bridge (window.AndroidSecure), a
// fake localStorage and a fake Supabase client, and checks the things that
// matter: the block is on at launch from the cached setting, the PDF viewer
// closing can't switch the app-wide block off, the server setting turns it on
// and off, a failed check keeps the last known state, and live (Realtime)
// updates and foreground re-checks are applied.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wwwDir = path.join(here, '..', 'www');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-privacy-test-'));
fs.copyFileSync(path.join(wwwDir, 'screen-privacy.js'), path.join(tmp, 'screen-privacy.js'));
fs.writeFileSync(path.join(tmp, 'supabase.js'), 'export const supabase = globalThis.__sb;');

// ---------- fakes ----------
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = globalThis;
const docListeners = {};
globalThis.document = { visibilityState: 'visible', addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); } };

let bridgeCalls = [];
globalThis.AndroidSecure = { enable: () => bridgeCalls.push('enable'), disable: () => bridgeCalls.push('disable') };
const secure = () => bridgeCalls.at(-1) === 'enable';

let serverRows = [], serverError = null, queries = 0;
let realtimeHandler = null;
const appListeners = [];
globalThis.Capacitor = { Plugins: { App: { addListener: (ev, fn) => appListeners.push([ev, fn]) } } };
globalThis.__sb = {
  from: (table) => ({ select: () => ({ eq: async () => { queries++; assert.equal(table, 'app_settings'); return serverError ? { data: null, error: serverError } : { data: serverRows, error: null }; } }) }),
  channel: () => ({ on(_t, _f, cb) { realtimeHandler = cb; return this; }, subscribe() { return this; } }),
};

let n = 0;
const load = async () => import(pathToFileURL(path.join(tmp, 'screen-privacy.js')).href + '?v=' + (++n));
const flush = () => new Promise((r) => setTimeout(r, 0));
const reset = () => { bridgeCalls = []; store.clear(); serverRows = []; serverError = null; queries = 0; realtimeHandler = null; appListeners.length = 0; for (const k of Object.keys(docListeners)) delete docListeners[k]; };

let passed = 0;
async function t(name, fn) { try { reset(); await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

console.log('screen-privacy.js');

await t('cached "on" blocks capture immediately at load, before any network call', async () => {
  store.set('ecampus_screen_privacy', '1');
  await load();
  assert.equal(secure(), true); assert.equal(queries, 0);
});

await t('nothing cached = not blocked (and no pointless native call)', async () => {
  await load();
  assert.deepEqual(bridgeCalls, []);
});

await t('closing the PDF viewer does NOT switch off the app-wide block', async () => {
  store.set('ecampus_screen_privacy', '1');
  await load();
  window.ScreenSecure.hold('pdf');
  window.ScreenSecure.release('pdf');
  assert.equal(secure(), true, 'global block must survive the viewer closing');
});

await t('PDF viewer alone still blocks while open and clears when closed (privacy off)', async () => {
  await load();
  window.ScreenSecure.hold('pdf'); assert.equal(secure(), true);
  window.ScreenSecure.release('pdf'); assert.equal(secure(), false);
});

await t('turning the setting off while a PDF is open keeps it blocked until the viewer closes', async () => {
  store.set('ecampus_screen_privacy', '1');
  const m = await load();
  window.ScreenSecure.hold('pdf');
  m.setPrivacyMode(false); assert.equal(secure(), true);
  window.ScreenSecure.release('pdf'); assert.equal(secure(), false);
  assert.equal(store.get('ecampus_screen_privacy'), '0');
});

await t('server on -> blocks and caches; server off -> unblocks and caches', async () => {
  const m = await load();
  serverRows = [{ key: 'screen_privacy', enabled: true }];
  m.initScreenPrivacy({ realtime: false }); await flush();
  assert.equal(secure(), true); assert.equal(store.get('ecampus_screen_privacy'), '1');
});

await t('no row on the server means off', async () => {
  store.set('ecampus_screen_privacy', '1');
  const m = await load();
  serverRows = [];
  m.initScreenPrivacy({ realtime: false }); await flush();
  assert.equal(secure(), false); assert.equal(store.get('ecampus_screen_privacy'), '0');
});

await t('a failed check (offline / error) keeps the last known state', async () => {
  store.set('ecampus_screen_privacy', '1');
  const m = await load();
  serverError = new Error('network'); 
  m.initScreenPrivacy({ realtime: false }); await flush();
  assert.equal(secure(), true); assert.equal(store.get('ecampus_screen_privacy'), '1');
});

await t('live update over Realtime applies instantly (signed-in app only)', async () => {
  const m = await load();
  m.initScreenPrivacy({ realtime: true }); await flush();
  assert.equal(typeof realtimeHandler, 'function');
  realtimeHandler({ new: { key: 'screen_privacy', enabled: true } }); assert.equal(secure(), true);
  realtimeHandler({ new: { key: 'something_else', enabled: false } }); assert.equal(secure(), true, 'other settings are ignored');
  realtimeHandler({ new: { key: 'screen_privacy', enabled: false } }); assert.equal(secure(), false);
});

await t('the login screen does not subscribe to Realtime', async () => {
  const m = await load();
  m.initScreenPrivacy({ realtime: false }); await flush();
  assert.equal(realtimeHandler, null);
});

await t('coming back to the foreground re-checks the server (throttled)', async () => {
  const m = await load();
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    m.initScreenPrivacy({ realtime: false }); await flush();
    assert.equal(queries, 1);
    const resume = appListeners.find(([ev]) => ev === 'appStateChange')[1];
    resume({ isActive: true }); await flush(); assert.equal(queries, 1, 'too soon: throttled');
    now += 11000; serverRows = [{ key: 'screen_privacy', enabled: true }];
    resume({ isActive: false }); await flush(); assert.equal(queries, 1, 'going to background does nothing');
    resume({ isActive: true }); await flush(); assert.equal(queries, 2); assert.equal(secure(), true);
    now += 11000; serverRows = [];
    docListeners.visibilitychange[0](); await flush(); assert.equal(queries, 3); assert.equal(secure(), false);
  } finally { Date.now = realNow; }
});

await t('no native bridge (browser / old build) never throws', async () => {
  const saved = globalThis.AndroidSecure; delete globalThis.AndroidSecure;
  try {
    store.set('ecampus_screen_privacy', '1');
    const m = await load();
    window.ScreenSecure.hold('pdf'); window.ScreenSecure.release('pdf'); m.setPrivacyMode(false);
  } finally { globalThis.AndroidSecure = saved; }
});

// ---------- wiring (static): the pieces that must be hooked up for this to work ----------
const read = (f) => fs.readFileSync(path.join(wwwDir, f), 'utf8');
await t('wiring: main.js, the login screen and the PDF viewer all go through screen-privacy', async () => {
  assert.match(read('main.js'), /import \{ initScreenPrivacy \} from '\.\/screen-privacy\.js'/);
  assert.match(read('main.js'), /initScreenPrivacy\(\);/);
  assert.match(read('auth/auth.js'), /import\('\.\.\/screen-privacy\.js'\)[\s\S]*initScreenPrivacy\(\{ realtime: false \}\)/);
  const pdf = read('pdf-viewer.js');
  assert.match(pdf, /ScreenSecure\.hold\('pdf'\)/); assert.match(pdf, /ScreenSecure\.release\('pdf'\)/);
  const sw = read('sw.js');
  assert.match(sw, /'\.\/screen-privacy\.js'/);
  assert.ok(Number(sw.match(/ecampus-cache-v(\d+)/)[1]) >= 16, 'new precached file needs a cache bump');
});

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
fs.rmSync(tmp, { recursive: true, force: true });
