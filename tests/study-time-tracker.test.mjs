// Behavioural test for www/study-time.js — no browser, no Supabase, no npm deps.
//   node tests/study-time-tracker.test.mjs
// Loads the REAL module next to a stub supabase client and drives it with a fake
// clock, fake timers and fake window/document events: what counts as study time,
// what doesn't (idle, backgrounded, loading spinner), and what happens to the
// seconds when the network is down or study_time.sql hasn't been run yet.
// Can't check a real WebView's timers/visibility events or the SQL.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const www = path.join(here, '..', 'www');

// ---------- fake environment ----------
let now = 0;
Date.now = () => now;

let winListeners = {};
let docListeners = {};
const store = new Map();
let intervalFn = null;
let intervalOn = false;
const calls = [];
let rpcImpl = async () => ({ data: 0, error: null });

globalThis.window = globalThis;
globalThis.addEventListener = (t, fn) => { (winListeners[t] ||= []).push(fn); };
globalThis.document = { hidden: false, addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); } };
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
globalThis.setInterval = (fn) => { intervalFn = fn; intervalOn = true; return 1; };
globalThis.clearInterval = () => { intervalOn = false; };
globalThis.__rpc = async (name, params) => { calls.push({ name, ...params }); return rpcImpl(name, params); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'study-track-test-'));
fs.copyFileSync(path.join(www, 'study-time.js'), path.join(tmp, 'study-time.js'));
fs.writeFileSync(path.join(tmp, 'supabase.js'), `export const supabase = { rpc: (n, p) => globalThis.__rpc(n, p || {}) };`);

let loadN = 0;
// A fresh module instance (its own state) per scenario, with all listeners cleared so old instances go quiet.
async function fresh({ startIso = '2026-09-30T06:00:00Z', user = 'u1', init = true } = {}) {
  winListeners = {}; docListeners = {};
  intervalFn = null; intervalOn = false;
  calls.length = 0;
  rpcImpl = async () => ({ data: 0, error: null });
  document.hidden = false;
  navigator.onLine = true;
  now = Date.parse(startIso);
  const m = await import(pathToFileURL(path.join(tmp, 'study-time.js')).href + '?n=' + (++loadN));
  if (init) m.initStudyTracking({ id: user });
  return m;
}
const fire = (t) => (winListeners[t] || []).forEach((fn) => fn({}));
const fireDoc = (t) => (docListeners[t] || []).forEach((fn) => fn({}));
const settle = () => new Promise((r) => setImmediate(r));
// Simulates the 5s interval firing while `ms` of wall time passes.
function advance(ms) {
  for (let t = 0; t < ms; t += 5000) { now += Math.min(5000, ms - t); if (intervalOn) intervalFn(); }
}
const sent = () => calls.filter((c) => c.name === 'record_study_time').reduce((a, c) => a + c.p_seconds, 0);
const sentDays = () => [...new Set(calls.filter((c) => c.name === 'record_study_time').map((c) => c.p_day))];
const pendingKey = (u = 'u1') => 'ecampus_study_pending_v1:' + u;
const pendingLeft = (u = 'u1') => Object.values(JSON.parse(store.get(pendingKey(u)) || '{}')).reduce((a, b) => a + b, 0);

let passed = 0;
async function t(name, fn) {
  store.clear();
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e.stack || e.message)); process.exitCode = 1; }
}
console.log('study-time.js — tracker');

// ---------- formatting / day helpers ----------
await t('formatStudyDuration: 0m, <1m, minutes, hours', async () => {
  const m = await fresh({ init: false });
  assert.equal(m.formatStudyDuration(0), '0m');
  assert.equal(m.formatStudyDuration(5), '<1m');
  assert.equal(m.formatStudyDuration(60), '1m');
  assert.equal(m.formatStudyDuration(3599), '59m');
  assert.equal(m.formatStudyDuration(3600), '1h');
  assert.equal(m.formatStudyDuration(7500), '2h 05m');
  assert.equal(m.formatStudyDuration(undefined), '0m');
  assert.equal(m.formatStudyDuration(-5), '0m');
});

await t('istDay rolls over at 18:30 UTC (midnight IST), matching _study_today() in the SQL', async () => {
  const m = await fresh({ init: false });
  assert.equal(m.istDay(Date.parse('2026-09-30T18:29:59Z')), '2026-09-30');
  assert.equal(m.istDay(Date.parse('2026-09-30T18:30:00Z')), '2026-10-01');
  assert.equal(m.istDay(Date.parse('2026-09-30T00:00:00Z')), '2026-09-30');
});

// ---------- what counts ----------
await t('counts the time a PDF is on screen and sends it to record_study_time', async () => {
  await fresh();
  fire('ecampus:pdf-open'); fire('ecampus:pdf-ready');
  advance(60000);
  fire('ecampus:pdf-close');
  await settle();
  assert.equal(sent(), 60);
  assert.deepEqual(sentDays(), ['2026-09-30']);
  assert.equal(pendingLeft(), 0, 'nothing left locally once delivered');
});

await t('the loading spinner / error card is NOT study time (open without ready)', async () => {
  await fresh();
  fire('ecampus:pdf-open');
  advance(120000);
  fire('ecampus:pdf-close');
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(pendingLeft(), 0);
});

await t('idle: keeps the 5-minute reading window, then pauses; a touch resumes it', async () => {
  await fresh();
  fire('ecampus:pdf-ready');
  advance(60000 + 600000); // 11 minutes, never touched
  assert.equal(intervalOn, true);
  fire('touchstart');      // back at the screen
  advance(30000);
  fire('ecampus:pdf-close');
  await settle();
  assert.equal(sent(), 300 + 30, '5 min idle window + 30s after the touch — not the 6 idle minutes between');
});

await t('scrolling/zooming keeps the clock alive past the idle window', async () => {
  await fresh();
  fire('ecampus:pdf-ready');
  for (let i = 0; i < 12; i++) { advance(60000); fire('scroll'); } // 12 min, scrolls every minute
  fire('ecampus:pdf-close');
  await settle();
  assert.equal(sent(), 720);
});

await t('backgrounding the app pauses the clock; returning resumes it', async () => {
  await fresh();
  fire('ecampus:pdf-ready');
  advance(20000);
  document.hidden = true; fireDoc('visibilitychange');
  advance(120000);         // app is in the background
  document.hidden = false; fireDoc('visibilitychange');
  advance(10000);
  fire('ecampus:pdf-close');
  await settle();
  assert.equal(sent(), 30);
});

await t('opening a second PDF, or a duplicate ready event, never double-counts', async () => {
  await fresh();
  fire('ecampus:pdf-ready');
  advance(10000);
  fire('ecampus:pdf-open'); fire('ecampus:pdf-ready'); fire('ecampus:pdf-ready');
  advance(10000);
  fire('ecampus:pdf-close');
  await settle();
  assert.equal(sent(), 20);
});

await t('time is bucketed by IST day, so a read across midnight lands on both days', async () => {
  await fresh({ startIso: '2026-09-30T18:29:40Z' }); // 23:59:40 IST
  fire('ecampus:pdf-ready');
  advance(60000);
  fire('ecampus:pdf-close');
  await settle();
  assert.equal(sent(), 60);
  assert.deepEqual(sentDays().sort(), ['2026-09-30', '2026-10-01']);
});

// ---------- delivery ----------
await t('offline: seconds are kept on the device and sent at next launch', async () => {
  await fresh();
  navigator.onLine = false;
  fire('ecampus:pdf-ready');
  advance(40000);
  fire('ecampus:pdf-close');
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(pendingLeft(), 40);

  const m2 = await fresh({ init: false });
  navigator.onLine = true;
  m2.initStudyTracking({ id: 'u1' }); // "app restarted", same device, same user, back online
  await settle();
  assert.equal(sent(), 40);
  assert.equal(pendingLeft(), 0);
});

await t('a killed app loses at most one tick: seconds are persisted every tick, not just on close', async () => {
  await fresh();
  navigator.onLine = false;
  fire('ecampus:pdf-ready');
  advance(25000); // ...then the process dies: no close event
  assert.equal(pendingLeft(), 25);
});

await t('network failure: keeps the seconds and backs off 30s before retrying', async () => {
  await fresh();
  rpcImpl = async () => ({ data: null, error: { message: 'Failed to fetch' } });
  fire('ecampus:pdf-ready');
  advance(30000);
  await settle();
  assert.equal(calls.length, 1, 'first attempt at 30 pending seconds');
  advance(20000);
  await settle();
  assert.equal(calls.length, 1, 'still backing off');
  rpcImpl = async () => ({ data: 0, error: null });
  advance(15000);
  await settle();
  assert.ok(calls.length >= 2, 'retried after the back-off');
  fire('ecampus:pdf-close');
  await settle();
  assert.equal(sent() - calls[0].p_seconds, 65, 'the failed attempt sent nothing — every second (30+20+15) is delivered in the retry');
  assert.equal(pendingLeft(), 0);
});

await t('study_time.sql not deployed: stops calling for the session but KEEPS the seconds', async () => {
  await fresh();
  rpcImpl = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.record_study_time' } });
  fire('ecampus:pdf-ready');
  advance(30000);
  await settle();
  advance(60000);
  fire('ecampus:pdf-close');
  await settle();
  assert.equal(calls.length, 1, 'no retry storm');
  assert.equal(pendingLeft(), 90, 'still on the device, credited once the SQL is deployed');
});

await t('permission denied (signed out): backs off 5 minutes instead of hammering', async () => {
  await fresh();
  rpcImpl = async () => ({ data: null, error: { code: '42501', message: 'permission denied' } });
  fire('ecampus:pdf-ready');
  advance(30000); await settle();
  advance(200000); await settle();
  assert.equal(calls.length, 1);
});

await t('seconds earned while a request is in flight are not lost when it completes', async () => {
  await fresh();
  const releases = [];
  rpcImpl = () => new Promise((res) => { releases.push(() => res({ data: 0, error: null })); });
  fire('ecampus:pdf-ready');
  advance(30000);          // request #1 (30s) now in flight
  advance(10000);          // 10 more seconds earned while it is
  releases.shift()(); await settle();  // #1 lands -> the 10 extra seconds go out as #2
  releases.shift()(); await settle();
  fire('ecampus:pdf-close'); await settle();
  assert.deepEqual(calls.map((c) => c.p_seconds), [30, 10]);
  assert.equal(pendingLeft(), 0);
});

await t('flushStudyTime() (used before loading the leaderboard) includes the seconds just earned', async () => {
  const m = await fresh();
  fire('ecampus:pdf-ready');
  advance(12000);
  await m.flushStudyTime();
  assert.equal(sent(), 12);
});

// ---------- isolation ----------
await t('pending seconds are per user: another account on the same device never sends them', async () => {
  const m = await fresh();
  navigator.onLine = false;
  fire('ecampus:pdf-ready'); advance(30000); fire('ecampus:pdf-close');
  assert.equal(pendingLeft('u1'), 30);
  navigator.onLine = true;
  m.initStudyTracking({ id: 'u2' });
  await settle();
  assert.equal(calls.length, 0, 'u2 must not deliver u1\'s time');
  assert.equal(pendingLeft('u1'), 30);
});

await t('stale pending days (older than the server accepts) are discarded on load', async () => {
  const m = await fresh({ init: false });
  store.set(pendingKey(), JSON.stringify({ '2026-09-01': 500, '2026-09-30': 10, 'garbage': 5, '2026-09-29': -3 }));
  m.initStudyTracking({ id: 'u1' });
  await settle();
  assert.equal(sent(), 10);
  assert.deepEqual(sentDays(), ['2026-09-30']);
});

await t('does nothing before a user is known (no crash, no calls)', async () => {
  await fresh({ init: false });
  fire('ecampus:pdf-ready'); advance(60000); fire('ecampus:pdf-close');
  await settle();
  assert.equal(calls.length, 0);
});

console.log(`\n${passed} passed`);
