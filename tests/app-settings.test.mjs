// Behavioural test for www/app-settings.js — the shared, cached read of the admin switches in
// app_settings (Full Privacy, "hide the BAFs App").
//   node tests/app-settings.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wwwDir = path.join(here, '..', 'www');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-settings-test-'));
fs.copyFileSync(path.join(wwwDir, 'app-settings.js'), path.join(tmp, 'app-settings.js'));
fs.writeFileSync(path.join(tmp, 'supabase.js'), 'export const supabase = globalThis.__sb;');

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = globalThis;

let rows = [], failWith = null, queries = 0, hold = null;
globalThis.__sb = {
  from: (table) => ({
    select: (cols) => {
      queries++;
      assert.equal(table, 'app_settings'); assert.equal(cols, 'key, enabled');
      const answer = () => (failWith ? (failWith === 'throw' ? Promise.reject(new Error('offline')) : { data: null, error: new Error(failWith) }) : { data: rows, error: null });
      return hold ? hold.then(answer) : Promise.resolve(answer());
    },
  }),
};

const m = await import(pathToFileURL(path.join(tmp, 'app-settings.js')).href);
const reset = () => { store.clear(); rows = []; failWith = null; queries = 0; hold = null; };

let passed = 0;
async function t(name, fn) { try { reset(); await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

console.log('app-settings.js');

await t('nothing cached and no row = off (so "hidden" switches default to visible)', () => {
  assert.equal(m.getSetting('bafs_app_hidden'), false);
  assert.equal(m.getSetting('screen_privacy'), false);
});

await t('one request reads every switch and caches them', async () => {
  rows = [{ key: 'screen_privacy', enabled: true }, { key: 'bafs_app_hidden', enabled: true }, { key: 'other', enabled: false }];
  assert.equal(await m.refreshAppSettings(), true);
  assert.equal(queries, 1);
  assert.equal(m.getSetting('screen_privacy'), true); assert.equal(m.getSetting('bafs_app_hidden'), true); assert.equal(m.getSetting('other'), false);
});

await t('a switch the server no longer has a row for goes back to off', async () => {
  rows = [{ key: 'bafs_app_hidden', enabled: true }];
  await m.refreshAppSettings();
  rows = [];
  await m.refreshAppSettings();
  assert.equal(m.getSetting('bafs_app_hidden'), false);
});

await t('a failed check (error, thrown, malformed) keeps the last known values and reports false', async () => {
  rows = [{ key: 'bafs_app_hidden', enabled: true }];
  await m.refreshAppSettings();
  for (const f of ['network', 'throw']) { failWith = f; assert.equal(await m.refreshAppSettings(), false); assert.equal(m.getSetting('bafs_app_hidden'), true, f); }
  failWith = null; rows = null;
  assert.equal(await m.refreshAppSettings(), false); assert.equal(m.getSetting('bafs_app_hidden'), true, 'non-array data');
});

await t('listeners hear about changes only — not about an identical re-fetch', async () => {
  const seen = []; const off = m.onSettingsChange((map) => seen.push({ ...map }));
  rows = [{ key: 'bafs_app_hidden', enabled: true }];
  await m.refreshAppSettings(); assert.equal(seen.length, 1);
  await m.refreshAppSettings(); assert.equal(seen.length, 1, 'same values: no re-render');
  rows = [{ key: 'bafs_app_hidden', enabled: false }];
  await m.refreshAppSettings(); assert.equal(seen.length, 2); assert.equal(seen[1].bafs_app_hidden, false);
  off(); rows = [{ key: 'bafs_app_hidden', enabled: true }]; await m.refreshAppSettings(); assert.equal(seen.length, 2, 'unsubscribed');
});

await t('a throwing listener does not stop the others', async () => {
  let ok = 0; const a = m.onSettingsChange(() => { throw new Error('bad'); }); const b = m.onSettingsChange(() => ok++);
  m.setSettingLocal('bafs_app_hidden', true); assert.equal(ok, 1); a(); b();
});

await t('callers at launch share ONE in-flight request', async () => {
  let release; hold = new Promise((r) => { release = r; });
  rows = [{ key: 'screen_privacy', enabled: true }];
  const p1 = m.refreshAppSettings(), p2 = m.refreshAppSettings({ maxAgeMs: 5000 });
  release(); assert.deepEqual(await Promise.all([p1, p2]), [true, true]);
  assert.equal(queries, 1);
});

await t('maxAgeMs reuses a recent answer instead of asking again', async () => {
  rows = [{ key: 'screen_privacy', enabled: false }];
  await m.refreshAppSettings();
  assert.equal(await m.refreshAppSettings({ maxAgeMs: 60000 }), true);
  assert.equal(queries, 1);
  await m.refreshAppSettings(); assert.equal(queries, 2, 'no maxAgeMs = always asks');
});

await t('setSettingLocal applies at once (the admin\'s own device) and is exposed as window.__applyAppSetting', () => {
  assert.equal(window.__applyAppSetting, m.setSettingLocal);
  window.__applyAppSetting('bafs_app_hidden', true); assert.equal(m.getSetting('bafs_app_hidden'), true);
  window.__applyAppSetting('bafs_app_hidden', false); assert.equal(m.getSetting('bafs_app_hidden'), false);
});

await t('a corrupt cache is ignored, not fatal', () => {
  store.set('ecampus_app_settings', '{not json'); assert.equal(m.getSetting('bafs_app_hidden'), false);
  store.set('ecampus_app_settings', '[1,2]'); assert.equal(m.getSetting('bafs_app_hidden'), false);
});

console.log(`\n${passed} passed`);
