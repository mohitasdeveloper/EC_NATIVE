// Behavioural test for the Leaderboard pill in www/search.js — no browser, no
// Supabase, no npm deps.   node tests/study-time-ui.test.mjs
// Loads the REAL search.js (+ study-time.js for the formatter) against a small
// fake DOM (bafs.js is stubbed — it needs a real DOM; see the BAFs pill cases) and canned study_leaderboard / study_set_name_hidden responses, and
// drives the delegated click/change handlers the way a tap would.
// Can't check pixels, dark mode, or the SQL.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const www = path.join(here, '..', 'www');

// ---------- fake DOM ----------
let registry = new Map();
const handlers = {}; // container event handlers, keyed by type
const toasts = [];
class El {
  constructor(id = '') { this.id = id; this._html = ''; this.textContent = ''; this.value = ''; this.dataset = {}; this._c = new Set();
    this.classList = { toggle: (c, f) => { (f ?? !this._c.has(c)) ? this._c.add(c) : this._c.delete(c); }, add: (c) => this._c.add(c), remove: (c) => this._c.delete(c), contains: (c) => this._c.has(c) }; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; }
  addEventListener(type, fn) { if (this.id === 'discover-list-container') (handlers[type] ||= []).push(fn); }
  focus() {}
}
// Assigning the container's innerHTML re-creates the lb-* children it contains (like a real DOM would).
function containerEl() {
  const el = new El('discover-list-container');
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) {
      this._html = v;
      for (const id of ['lb-summary', 'lb-periods', 'lb-body', 'lb-privacy']) registry.delete(id);
      for (const m of String(v).matchAll(/id="(lb-[a-z]+)"/g)) registry.set(m[1], new El(m[1]));
    },
  });
  return el;
}
function reset() {
  registry = new Map([['discover-list-container', containerEl()]]);
  for (const k of Object.keys(handlers)) delete handlers[k];
  toasts.length = 0;
}
globalThis.document = {
  getElementById: (id) => { if (registry.has(id)) return registry.get(id); if (id.startsWith('lb-')) return null; const e = new El(id); registry.set(id, e); return e; },
  querySelectorAll: () => [],
  documentElement: { classList: { contains: () => false } },
  addEventListener: () => {},
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
globalThis.optimizeImageUrl = (u) => u;
globalThis.getTickHtml = (t) => (t && t !== 'none' ? `<i class="tick-${t}"></i>` : '');
const viewed = [];
globalThis.viewUserProfile = (id) => viewed.push(id);

// ---------- stubs + load the real modules ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'study-ui-test-'));
for (const f of ['search.js', 'study-time.js']) fs.copyFileSync(path.join(www, f), path.join(tmp, f));
fs.writeFileSync(path.join(tmp, 'supabase.js'), `export const supabase = { rpc: (n, p) => globalThis.__rpc(n, p || {}) };`);
fs.writeFileSync(path.join(tmp, 'ui.js'), `export function showToast(m, t) { globalThis.__toast(m, t); }`);
fs.writeFileSync(path.join(tmp, 'data-layer.js'), `
export const getUserSuggestions = (...a) => globalThis.__suggested(...a);
export const getTopConnectedUsers = (...a) => globalThis.__popular(...a);`);
globalThis.__toast = (m, t) => toasts.push([m, t]);
// bafs.js (the native BAFs App) needs a real DOM, so search.js gets a recording stand-in.
const bafsCalls = [];
globalThis.__bafs = bafsCalls;
fs.writeFileSync(path.join(tmp, 'bafs.js'), `
export async function mountBafs(c) { globalThis.__bafs.push('mount'); c.innerHTML = '<div id="bafs-root">BAFS APP</div>'; }
export function unmountBafs() { globalThis.__bafs.push('unmount'); }`);

const rpcCalls = [];
let rpcImpl = null;
globalThis.__rpc = (name, params) => { rpcCalls.push({ name, ...params }); return rpcImpl(name, params); };
globalThis.__popular = async () => [];
globalThis.__suggested = async () => [];

// Expected failure paths log via console.error in search.js; keep the test output readable.
const realError = console.error;
console.error = () => {};
let search = null;
let loadN = 0;
const settle = () => new Promise((r) => setTimeout(r, 10));
const lb = (id) => registry.get(id)?.innerHTML ?? '';
const allLb = () => ['lb-summary', 'lb-periods', 'lb-body', 'lb-privacy'].map(lb).join('\n');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

const ME = { id: 'me-id', full_name: 'Meera Shah', profile_img_url: 'http://x/me.jpg', tick_type: 'none', course: 'TY B.Com (Accounting & Finance)' };
const entry = (o) => ({ rank: 1, seconds: 3600, is_me: false, hidden: false, user_id: 'u-' + o.rank, full_name: 'Student ' + o.rank, profile_img_url: 'http://x/' + o.rank + '.jpg', tick_type: 'none', ...o });
const payload = (o = {}) => ({
  period: 'daily', participants: 3,
  entries: [entry({ rank: 1, seconds: 7500, full_name: 'Aarav Mehta', tick_type: 'blue' }),
            entry({ rank: 2, seconds: 5400, hidden: true, user_id: null, full_name: null, profile_img_url: null, tick_type: null }),
            entry({ rank: 3, seconds: 900, is_me: true, user_id: 'me-id', full_name: 'Meera Shah' })],
  me: { rank: 3, seconds: 900, hidden: false },
  totals: { today: 900, week: 8000, alltime: 90000 },
  prefs: { daily: false, weekly: false, alltime: false },
  ...o,
});

let passed = 0;
// A fresh search.js instance per case: its module state (selected period, the
// once-only handler binding, request tokens) must not leak between cases.
async function t(name, fn) {
  reset();
  rpcCalls.length = 0; viewed.length = 0;
  rpcImpl = async () => ({ data: payload(), error: null });
  globalThis.__popular = async () => [];
  globalThis.__suggested = async () => [];
  try {
    search = await import(pathToFileURL(path.join(tmp, 'search.js')).href + '?n=' + (++loadN));
    search.initSearch({ ...ME }); // BAF student -> starts on the BAFs pill, like the real app
    await settle();
    rpcCalls.length = 0;
    await fn();
    passed++; console.log('  ok  ' + name);
  } catch (e) { realError('FAIL  ' + name + '\n' + (e.stack || e.message)); process.exitCode = 1; }
}
// The rendered HTML of the single row whose text contains `text` (up to the next row's opening tag).
function rowContaining(body, text) {
  const mark = 'class="flex items-center gap-3 py-2.5 px-2';
  const at = body.indexOf(text);
  assert.ok(at >= 0, `no row contains "${text}"`);
  const start = body.lastIndexOf('<div', body.lastIndexOf(mark, at));
  const nextMark = body.indexOf(mark, body.lastIndexOf(mark, at) + mark.length);
  const end = nextMark === -1 ? body.length : body.lastIndexOf('<div', nextMark);
  return body.slice(start, end);
}
const openBoard = async () => { window.setDiscoverTab('leaderboard'); await settle(); };
const click = async (dataset, selector) => {
  const node = { dataset };
  await handlers.click[0]({ target: { closest: (sel) => (sel === selector ? node : null) } });
  await settle();
};
const toggle = async (period, checked) => {
  const input = { dataset: { lbHide: period }, checked, disabled: false };
  await handlers.change[0]({ target: { closest: (sel) => (sel === '[data-lb-hide]' ? input : null) } });
  await settle();
  return input;
};

console.log('search.js — Leaderboard pill');

await t('opening the pill loads today\'s board with p_period=daily and p_limit=50', async () => {
  await openBoard();
  const c = rpcCalls.filter((x) => x.name === 'study_leaderboard');
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].p_period, c[0].p_limit], ['daily', 50]);
  assert.match(lb('lb-summary'), /Your study time/);
  assert.match(lb('lb-summary'), /15m/);       // today 900s
  assert.match(lb('lb-summary'), /2h 13m/);    // week 8000s
  assert.match(lb('lb-summary'), /25h/);       // all-time 90000s
});

await t('rows show rank, name, formatted time and tick; the leader is #1 with 2h 05m', async () => {
  await openBoard();
  const body = lb('lb-body');
  assert.match(body, /Aarav Mehta/);
  assert.match(body, /2h 05m/);
  assert.match(body, /tick-blue/);
  assert.match(body, /You're <span[^>]*>#3<\/span> of 3 · today/);
});

await t('PRIVACY: a hidden entry renders as Anonymous — no name, photo, id or profile link', async () => {
  await openBoard();
  const body = lb('lb-body');
  assert.match(body, /Anonymous/);
  const anonRow = rowContaining(body, 'Anonymous');
  assert.doesNotMatch(anonRow, /data-lb-user/, 'an anonymous row must not be tappable through to a profile');
  assert.doesNotMatch(anonRow, /<img/, 'no avatar for an anonymous row');
  assert.match(anonRow, /person/, 'generic person icon instead');
});

await t('my own row is highlighted, tagged "You", not tappable; hidden state is shown only to me', async () => {
  rpcImpl = async () => ({ data: payload({ entries: [entry({ rank: 1, seconds: 900, is_me: true, user_id: 'me-id', full_name: 'Meera Shah', hidden: true })], me: { rank: 1, seconds: 900, hidden: true }, participants: 1 }), error: null });
  await openBoard();
  const body = lb('lb-body');
  assert.match(body, />You</);
  assert.match(body, /Hidden from others/);
  assert.match(body, /Meera Shah/, 'I still see my own name');
  assert.doesNotMatch(body, /data-lb-user/);
});

await t('user-supplied names are HTML-escaped', async () => {
  rpcImpl = async () => ({ data: payload({ entries: [entry({ rank: 1, full_name: '<img src=x onerror=alert(1)>' })] }), error: null });
  await openBoard();
  assert.doesNotMatch(lb('lb-body'), /<img src=x/);
  assert.match(lb('lb-body'), /&lt;img src=x/);
});

await t('tapping someone else\'s row opens their profile', async () => {
  await openBoard();
  await click({ lbUser: 'u-1' }, '[data-lb-user]');
  assert.deepEqual(viewed, ['u-1']);
});

await t('outside the top 50: my row is pinned beneath the list with my own name and rank', async () => {
  rpcImpl = async () => ({ data: payload({ participants: 200, entries: [entry({ rank: 1, seconds: 9000 })], me: { rank: 120, seconds: 300, hidden: false } }), error: null });
  await openBoard();
  const body = lb('lb-body');
  assert.match(body, /#120<\/span> of 200/);
  assert.match(body, /Meera Shah/);
  assert.match(body, />You</);
});

await t('not on the board yet: explains how time is counted instead of showing a rank', async () => {
  rpcImpl = async () => ({ data: payload({ me: null, entries: [entry({ rank: 1 })], totals: { today: 0, week: 0, alltime: 0 } }), error: null });
  await openBoard();
  assert.match(lb('lb-body'), /not on the Daily board yet/);
  assert.match(lb('lb-summary'), /0m/);
});

await t('empty board: friendly empty state per period', async () => {
  rpcImpl = async () => ({ data: payload({ entries: [], me: null, participants: 0 }), error: null });
  await openBoard();
  assert.match(lb('lb-body'), /No study time recorded today/);
  await click({ lbPeriod: 'alltime' }, '[data-lb-period]');
  assert.match(lb('lb-body'), /No study time recorded yet/);
});

await t('the three hide-my-name switches reflect the saved prefs', async () => {
  rpcImpl = async () => ({ data: payload({ prefs: { daily: false, weekly: true, alltime: false } }), error: null });
  await openBoard();
  const p = lb('lb-privacy');
  assert.match(p, /data-lb-hide="daily"[^>]*aria-label="[^"]*"\s+class="sr-only peer"/);
  assert.equal((p.match(/data-lb-hide=/g) || []).length, 3);
  assert.match(p, /data-lb-hide="weekly"[^>]*checked/);
  assert.doesNotMatch(p, /data-lb-hide="daily"[^>]*checked/);
  assert.doesNotMatch(p, /data-lb-hide="alltime"[^>]*checked/);
});

// ---------- periods ----------
await t('Daily / Weekly / All-time pills each request their own period and highlight the active one', async () => {
  await openBoard();
  for (const [key, label] of [['weekly', 'Weekly'], ['alltime', 'All-time'], ['daily', 'Daily']]) {
    await click({ lbPeriod: key }, '[data-lb-period]');
    assert.equal(rpcCalls.filter((x) => x.name === 'study_leaderboard').at(-1).p_period, key);
    assert.match(lb('lb-periods'), new RegExp(`data-lb-period="${key}" class="[^"]*bg-on-surface[^"]*">${label}`));
  }
});

await t('tapping the active period again does not refetch', async () => {
  await openBoard();
  const n = rpcCalls.length;
  await click({ lbPeriod: 'daily' }, '[data-lb-period]');
  assert.equal(rpcCalls.length, n);
});

await t('RACE: a slow Weekly response that lands after All-time was chosen is discarded', async () => {
  const weekly = deferred(), alltime = deferred();
  rpcImpl = (name, p) => (p.p_period === 'weekly' ? weekly.promise : p.p_period === 'alltime' ? alltime.promise : Promise.resolve({ data: payload(), error: null }));
  await openBoard();
  await click({ lbPeriod: 'weekly' }, '[data-lb-period]');
  await click({ lbPeriod: 'alltime' }, '[data-lb-period]');
  alltime.resolve({ data: payload({ period: 'alltime', entries: [entry({ rank: 1, full_name: 'ALLTIME-LEADER' })] }), error: null });
  await settle();
  weekly.resolve({ data: payload({ period: 'weekly', entries: [entry({ rank: 1, full_name: 'WEEKLY-LEADER' })] }), error: null });
  await settle();
  assert.match(lb('lb-body'), /ALLTIME-LEADER/);
  assert.doesNotMatch(lb('lb-body'), /WEEKLY-LEADER/);
});

// ---------- hide my name ----------
await t('turning a switch on calls study_set_name_hidden for THAT period, toasts, and re-syncs the board', async () => {
  await openBoard();
  const before = rpcCalls.filter((x) => x.name === 'study_leaderboard').length;
  rpcImpl = async (name) => (name === 'study_set_name_hidden' ? { data: { daily: false, weekly: true, alltime: false }, error: null } : { data: payload(), error: null });
  const input = await toggle('weekly', true);
  const set = rpcCalls.filter((x) => x.name === 'study_set_name_hidden');
  assert.equal(set.length, 1);
  assert.deepEqual([set[0].p_period, set[0].p_hidden], ['weekly', true]);
  assert.equal(rpcCalls.filter((x) => x.name === 'study_leaderboard').length, before + 1, 'refetched so the board reflects the server');
  assert.equal(input.checked, true);
  assert.deepEqual(toasts.at(-1), ['Your name is hidden on the Weekly board', 'success']);
});

await t('turning it off says the name is visible again', async () => {
  await openBoard();
  rpcImpl = async (name) => (name === 'study_set_name_hidden' ? { data: {}, error: null } : { data: payload(), error: null });
  await toggle('alltime', false);
  assert.equal(rpcCalls.filter((x) => x.name === 'study_set_name_hidden').at(-1).p_hidden, false);
  assert.deepEqual(toasts.at(-1), ['Your name is visible on the All-time board', 'success']);
});

await t('a failed save puts the switch back and shows an error (no refetch)', async () => {
  await openBoard();
  const before = rpcCalls.filter((x) => x.name === 'study_leaderboard').length;
  rpcImpl = async (name) => (name === 'study_set_name_hidden' ? { data: null, error: { message: 'Failed to fetch' } } : { data: payload(), error: null });
  const input = await toggle('daily', true);
  assert.equal(input.checked, false, 'reverted');
  assert.equal(input.disabled, false);
  assert.equal(toasts.at(-1)[1], 'error');
  assert.equal(rpcCalls.filter((x) => x.name === 'study_leaderboard').length, before);
});

// ---------- failure + pill-switching ----------
await t('study_time.sql not run: says the leaderboard isn\'t set up (no Retry button)', async () => {
  rpcImpl = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.study_leaderboard' } });
  await openBoard();
  assert.match(lb('lb-body'), /isn't set up yet/);
  assert.doesNotMatch(lb('lb-body'), /data-lb-retry/);
});

await t('network failure: shows a Retry that reloads', async () => {
  rpcImpl = async () => ({ data: null, error: { message: 'Failed to fetch' } });
  await openBoard();
  assert.match(lb('lb-body'), /data-lb-retry/);
  rpcImpl = async () => ({ data: payload(), error: null });
  await click({}, '[data-lb-retry]');
  assert.match(lb('lb-body'), /Aarav Mehta/);
});

await t('a malformed response is treated as an error, not rendered', async () => {
  rpcImpl = async () => ({ data: { nope: true }, error: null });
  await openBoard();
  assert.match(lb('lb-body'), /Couldn't load the leaderboard/);
});

await t('RACE: leaving the Leaderboard pill while it loads — the late response does not paint over the new pill', async () => {
  const slow = deferred();
  rpcImpl = () => slow.promise;
  window.setDiscoverTab('leaderboard');
  await settle();
  window.setDiscoverTab('suggested');
  await settle();
  const after = registry.get('discover-list-container').innerHTML;
  slow.resolve({ data: payload(), error: null });
  await settle();
  assert.equal(registry.get('discover-list-container').innerHTML, after);
  assert.equal(registry.has('lb-body'), false);
});

await t('RACE: a slow Popular/Suggested list that lands after switching to the Leaderboard does not overwrite it', async () => {
  const slow = deferred();
  globalThis.__suggested = () => slow.promise;
  window.setDiscoverTab('suggested');
  await settle();
  await openBoard();
  const shell = registry.get('discover-list-container').innerHTML;
  assert.match(shell, /id="lb-body"/);
  slow.resolve([{ id: 'x', full_name: 'LATE-SUGGESTION', role: 'student', course: 'BAF' }]);
  await settle();
  assert.equal(registry.get('discover-list-container').innerHTML, shell);
  assert.doesNotMatch(registry.get('discover-list-container').innerHTML, /LATE-SUGGESTION/);
});

await t('the BAFs App pill mounts the app natively into the list container (no iframe)', async () => {
  window.setDiscoverTab('suggested'); await settle();
  bafsCalls.length = 0;
  window.setDiscoverTab('bafs'); await settle();
  assert.deepEqual(bafsCalls, ['mount']);
  const html = registry.get('discover-list-container').innerHTML;
  assert.match(html, /id="bafs-root"/);
  assert.doesNotMatch(html, /<iframe/);
});

await t('leaving the BAFs pill (for Leaderboard or Suggested) tears the app down first', async () => {
  bafsCalls.length = 0;
  window.setDiscoverTab('leaderboard'); await settle();
  assert.deepEqual(bafsCalls, ['unmount']);
  assert.match(registry.get('discover-list-container').innerHTML, /id="lb-body"/);
  window.setDiscoverTab('bafs'); await settle();
  bafsCalls.length = 0;
  window.setDiscoverTab('suggested'); await settle();
  assert.deepEqual(bafsCalls, ['unmount']);
  assert.doesNotMatch(registry.get('discover-list-container').innerHTML, /bafs-root/);
});

await t('search.js no longer references the planner iframe page', async () => {
  const src = fs.readFileSync(path.join(www, 'search.js'), 'utf8');
  assert.doesNotMatch(src, /<iframe[^>]*\bsrc=|createElement\(['"]iframe/);
  assert.ok(!fs.existsSync(path.join(www, 'bafs-study-planner.html')), 'the old iframe page should be gone');
});

console.log(`\n${passed} passed`);
