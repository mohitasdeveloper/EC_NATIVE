// Behavioural test for Page Mini Apps: www/page-mini-apps.js (data + manager) and the tray in www/mini-apps.js.
// Real modules, a small fake DOM, stubbed supabase.rpc.   node tests/page-mini-apps.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const www = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www');

// ── fake DOM ──
let registry = new Map();
const toasts = [];
class El {
  constructor(id) { this.id = id; this.value = ''; this.checked = false; this.textContent = ''; this.innerHTML = ''; this.dataset = {}; this.style = {}; this.disabled = false; this._c = new Set(); this.listeners = {}; this.parentNode = { replaceChild: (n, o) => registry.set(o.id, n) }; }
  get classList() {
    const c = this._c;
    return { add: (x) => c.add(x), remove: (x) => c.delete(x), contains: (x) => c.has(x), toggle: (x, f) => { (f ?? !c.has(x)) ? c.add(x) : c.delete(x); },
      replace: (a, b) => { if (c.has(a)) { c.delete(a); c.add(b); } } };
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  cloneNode() { return new El(this.id); }
  set outerHTML(v) { this.outer = v; }
  querySelectorAll() { return []; }
}
function reset() {
  registry = new Map();
  const mk = (id, classes = []) => { const e = new El(id); classes.forEach((c) => e._c.add(c)); registry.set(id, e); return e; };
  mk('modal-manage-mini-apps', ['hidden', 'flex-col', 'translate-x-full']);
  mk('modal-mini-app-form', ['hidden', 'opacity-0']);
  mk('mini-app-form-card', ['translate-y-full']);
  mk('modal-confirm-action', ['hidden']);
  mk('mini-app-delete-btn', ['hidden']);
  mk('mini-app-save-btn').textContent = 'Save';
  for (const id of ['mini-apps-tray', 'mini-apps-manage-list', 'mini-apps-manage-count', 'mini-app-form-title', 'mini-app-edit-id', 'mini-app-name-input', 'mini-app-url-input',
    'mini-app-icon-input', 'mini-app-inapp-toggle', 'mini-app-active-toggle', 'mini-app-form-error', 'mini-app-icon-preview', 'confirm-action-title', 'confirm-action-message',
    'confirm-action-yes', 'confirm-action-no']) mk(id);
  toasts.length = 0;
}
globalThis.document = { getElementById: (id) => registry.get(id) || null };
globalThis.window = globalThis;
globalThis.localStorage = { m: new Map(), getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
const opened = [];
globalThis.openServiceLink = (...a) => opened.push(a);

// ── fresh module instances per case (module state: bound listeners, lists, cache) ──
const rpcCalls = [];
let rpcImpl = async () => ({ data: [], error: null });
globalThis.__rpc = (n, p) => { rpcCalls.push({ n, p }); return rpcImpl(n, p); };
globalThis.__toast = (m, ty) => toasts.push([m, ty]);
let caseN = 0;
async function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pma-${++caseN}-`));
  for (const f of ['page-mini-apps.js', 'mini-apps.js', 'app-settings.js']) fs.copyFileSync(path.join(www, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'supabase.js'), 'export const supabase = { rpc: (n, p) => globalThis.__rpc(n, p) };');
  fs.writeFileSync(path.join(dir, 'ui.js'), 'export function showToast(m, t) { globalThis.__toast(m, t); }');
  fs.writeFileSync(path.join(dir, 'bafs.js'), 'export async function mountBafs() {} export function unmountBafs() {} export const bafsIsAtHome = () => true; export function bafsGoBack() {}');
  const href = (f) => pathToFileURL(path.join(dir, f)).href;
  return { pm: await import(href('page-mini-apps.js')), mini: await import(href('mini-apps.js')) };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

const PAGE = { id: 'page-1', role: 'page' };
const STUDENT = { id: 's-1', role: 'student' };
const row = (o = {}) => ({ id: 'a1', page_id: 'p1', page_name: 'Fee Cell', name: 'Fee Portal', icon_url: 'https://cdn.test/i.png', url: 'https://fees.test/', open_in_app: true, ...o });

let passed = 0;
async function t(name, fn) {
  reset(); rpcCalls.length = 0; opened.length = 0; localStorage.m.clear();
  rpcImpl = async () => ({ data: [], error: null });
  const realWarn = console.warn, realErr = console.error; console.warn = () => {}; console.error = () => {};
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { realErr('FAIL  ' + name + '\n' + (e.stack || e.message)); process.exitCode = 1; }
  finally { console.warn = realWarn; console.error = realErr; }
}
const trayHtml = () => registry.get('mini-apps-tray').innerHTML;
const clickOn = (id, matches) => registry.get(id).listeners.click[0]({ target: { closest: (sel) => (sel in matches ? matches[sel] : null) } });

// ───────────────────────── data ─────────────────────────
await t('only well-formed rows are kept: https URL + id + name; http / missing name / no id are dropped; http icon is ignored', async () => {
  const { pm } = await fresh();
  rpcImpl = async () => ({ data: [
    row(),
    row({ id: 'a2', url: 'http://insecure.test/' }),
    row({ id: 'a3', name: '   ' }),
    row({ id: null }),
    row({ id: 'a5', url: 'javascript:alert(1)' }),
    row({ id: 'a6', name: 'No Icon', icon_url: 'http://x.test/i.png' }),
  ], error: null });
  pm.initPageMiniApps(STUDENT);
  const list = await pm.loadPageMiniApps();
  assert.deepEqual(list.map((a) => a.id), ['a1', 'a6']);
  assert.equal(list[1].icon_url, null);
  assert.equal(rpcCalls[0].n, 'mini_apps_list');
});

await t('names are cut to 20 characters', async () => {
  const { pm } = await fresh();
  rpcImpl = async () => ({ data: [row({ name: 'X'.repeat(40) })], error: null });
  pm.initPageMiniApps(STUDENT);
  assert.equal((await pm.loadPageMiniApps())[0].name.length, 20);
});

await t('the saved list shows instantly (and offline); a failed refresh keeps it', async () => {
  localStorage.setItem('ecampus_page_mini_apps_v1', JSON.stringify([row({ name: 'Cached App' })]));
  const { pm } = await fresh();
  pm.initPageMiniApps(STUDENT);
  assert.deepEqual(pm.getPageMiniApps().map((a) => a.name), ['Cached App']);
  rpcImpl = async () => ({ data: null, error: { message: 'offline' } });
  await pm.loadPageMiniApps();
  assert.deepEqual(pm.getPageMiniApps().map((a) => a.name), ['Cached App']);
});

await t('a fresh list replaces the saved one and is saved for next time', async () => {
  const { pm } = await fresh();
  rpcImpl = async () => ({ data: [row({ name: 'Fresh' })], error: null });
  pm.initPageMiniApps(STUDENT);
  await pm.loadPageMiniApps();
  assert.equal(JSON.parse(localStorage.getItem('ecampus_page_mini_apps_v1'))[0].name, 'Fresh');
});

// ───────────────────────── tray ─────────────────────────
await t('tray: BAFs App first, then Pages\' apps oldest-first; students get no Manage circle', async () => {
  const { mini, pm } = await fresh();
  rpcImpl = async () => ({ data: [row({ id: 'a1', name: 'First' }), row({ id: 'a2', name: 'Second' })], error: null });
  mini.initMiniApps(STUDENT);
  await settle();
  const html = trayHtml();
  const order = [...html.matchAll(/data-mini-app="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['bafs', 'page:a1', 'page:a2']);
  assert.doesNotMatch(html, /data-mini-manage/);
});

await t('tray: a Page account gets the dashed Manage circle FIRST (so it never scrolls out of sight)', async () => {
  const { mini } = await fresh();
  rpcImpl = async () => ({ data: [row({ id: 'a1' }), row({ id: 'a2' }), row({ id: 'a3' })], error: null });
  mini.initMiniApps(PAGE);
  await settle();
  const html = trayHtml();
  assert.match(html, /data-mini-manage/);
  assert.ok(html.indexOf('data-mini-manage') < html.indexOf('data-mini-app='));
});

await t('SECURITY: names and icon URLs from other users are HTML-escaped in the tray', async () => {
  const { mini } = await fresh();
  rpcImpl = async () => ({ data: [row({ name: '<img src=x onerror=alert(1)>', icon_url: 'https://cdn.test/a.png"onerror="alert(1)' })], error: null });
  mini.initMiniApps(STUDENT);
  await settle();
  const html = trayHtml();
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /"onerror="alert/);
  assert.match(html, /&lt;img src=x onerror=a/, 'shown as text (and cut to 20 chars)');
});

await t('tray: an app without an icon shows its first letter (no broken image)', async () => {
  const { mini } = await fresh();
  rpcImpl = async () => ({ data: [row({ name: 'zeta', icon_url: null })], error: null });
  mini.initMiniApps(STUDENT);
  await settle();
  const item = trayHtml().split('data-mini-app="page:a1"')[1];
  assert.match(item, /mini-app-circle is-broken/);
  assert.match(item, /mini-app-initial">Z</);
});

await t('tapping a Page\'s circle opens its URL through the link router with the FULL param set and its open-in-app choice', async () => {
  const { mini } = await fresh();
  rpcImpl = async () => ({ data: [row({ id: 'a1', open_in_app: true }), row({ id: 'a2', name: 'Ext', url: 'https://ext.test/', open_in_app: false })], error: null });
  mini.initMiniApps(STUDENT);
  await settle();
  await clickOn('mini-apps-tray', { '[data-mini-app]': { dataset: { miniApp: 'page:a1' } } });
  await clickOn('mini-apps-tray', { '[data-mini-app]': { dataset: { miniApp: 'page:a2' } } });
  assert.deepEqual(opened, [
    ['https://fees.test/', true, 'Fee Portal', { full: true }],
    ['https://ext.test/', false, 'Ext', { full: true }],
  ]);
});

await t('tapping Manage opens the manager for a Page', async () => {
  const { mini } = await fresh();
  mini.initMiniApps(PAGE);
  await settle();
  await clickOn('mini-apps-tray', { '[data-mini-manage]': {} });
  assert.ok(!registry.get('modal-manage-mini-apps').classList.contains('hidden'));
  assert.equal(rpcCalls.filter((c) => c.n === 'mini_apps_mine').length, 1);
});

await t('a student cannot open the manager (even by calling it directly)', async () => {
  const { pm } = await fresh();
  pm.initPageMiniApps(STUDENT);
  pm.openMiniAppsManager();
  assert.ok(registry.get('modal-manage-mini-apps').classList.contains('hidden'));
  assert.equal(rpcCalls.length, 0);
});

// ───────────────────────── validation ─────────────────────────
await t('validateMiniApp: name 1–20, https URL, optional https icon', async () => {
  const { pm } = await fresh();
  const ok = { name: 'Fees', url: 'https://a.test/', icon_url: '' };
  assert.equal(pm.validateMiniApp(ok), '');
  assert.match(pm.validateMiniApp({ ...ok, name: '' }), /Name/);
  assert.match(pm.validateMiniApp({ ...ok, name: 'x'.repeat(21) }), /Name/);
  assert.match(pm.validateMiniApp({ ...ok, url: 'http://a.test/' }), /https/);
  assert.match(pm.validateMiniApp({ ...ok, url: 'ftp://a.test/' }), /https/);
  assert.match(pm.validateMiniApp({ ...ok, url: 'https://' + 'a'.repeat(500) }), /https/);
  assert.match(pm.validateMiniApp({ ...ok, icon_url: 'http://a.test/i.png' }), /Icon/);
  assert.equal(pm.validateMiniApp({ ...ok, icon_url: 'https://a.test/i.png' }), '');
});

// ───────────────────────── manager ─────────────────────────
const MINE = [
  { id: 'm1', name: 'Fee Portal', icon_url: null, url: 'https://fees.test/', open_in_app: true, is_active: true },
  { id: 'm2', name: 'Old Quiz', icon_url: null, url: 'https://quiz.test/', open_in_app: false, is_active: false },
];
async function openManager() {
  const f = await fresh();
  rpcImpl = async (n) => ({ data: n === 'mini_apps_mine' ? MINE : [], error: null });
  f.pm.initPageMiniApps(PAGE);
  f.pm.openMiniAppsManager();
  await settle();
  rpcCalls.length = 0;
  return f;
}
const fillForm = (v) => {
  const set = (id, key, val) => { registry.get(id)[key] = val; };
  set('mini-app-name-input', 'value', v.name ?? ''); set('mini-app-url-input', 'value', v.url ?? ''); set('mini-app-icon-input', 'value', v.icon ?? '');
  set('mini-app-inapp-toggle', 'checked', v.inApp ?? true); set('mini-app-active-toggle', 'checked', v.active ?? true);
};

await t('manager lists the Page\'s own apps — hidden ones too — with a count and each one\'s state', async () => {
  await openManager();
  const html = registry.get('mini-apps-manage-list').innerHTML;
  assert.match(html, /Fee Portal/); assert.match(html, /Old Quiz/);
  assert.match(html, /Visible on Home/); assert.match(html, /Hidden/);
  assert.match(html, /Opens in app/); assert.match(html, /Opens in browser/);
  assert.equal(registry.get('mini-apps-manage-count').textContent, '2 of 10');
  assert.match(html, /data-ma-toggle="m1" checked/);
  assert.doesNotMatch(html, /data-ma-toggle="m2" checked/);
});

await t('adding: URL without a scheme gets https://, and the RPC gets exactly the form\'s values', async () => {
  await openManager();
  await clickOn('modal-manage-mini-apps', { '[data-ma-add]': {} });
  assert.equal(registry.get('mini-app-form-title').textContent, 'New Mini App');
  assert.ok(registry.get('mini-app-delete-btn').classList.contains('hidden'), 'no delete for a new app');
  await settle();                       // let the sheet finish sliding in (a real user can't tap Save within 10 ms)
  fillForm({ name: ' Hostel ', url: 'hostel.example.com/app', icon: '', inApp: false, active: true });
  await clickOn('modal-mini-app-form', { '[data-ma-save]': {} });
  await settle();
  const save = rpcCalls.find((c) => c.n === 'mini_app_save');
  assert.deepEqual(save.p, { p_id: null, p_name: 'Hostel', p_url: 'https://hostel.example.com/app', p_icon_url: null, p_open_in_app: false, p_is_active: true });
  assert.deepEqual(toasts.at(-1), ['Mini app added.', 'success']);
  assert.ok(rpcCalls.some((c) => c.n === 'mini_apps_mine') && rpcCalls.some((c) => c.n === 'mini_apps_list'), 'both lists refetched');
  assert.ok(registry.get('modal-mini-app-form').classList.contains('opacity-0'), 'sheet closing');
});

await t('adding: an http:// URL or a blank name is refused on the spot — no request is sent', async () => {
  await openManager();
  await clickOn('modal-manage-mini-apps', { '[data-ma-add]': {} });
  fillForm({ name: 'X', url: 'http://insecure.test' });
  await clickOn('modal-mini-app-form', { '[data-ma-save]': {} });
  assert.match(registry.get('mini-app-form-error').textContent, /https/);
  fillForm({ name: '', url: 'https://ok.test' });
  await clickOn('modal-mini-app-form', { '[data-ma-save]': {} });
  assert.match(registry.get('mini-app-form-error').textContent, /Name/);
  assert.equal(rpcCalls.filter((c) => c.n === 'mini_app_save').length, 0);
});

await t('a server error is shown in the form and the Save button comes back', async () => {
  await openManager();
  await clickOn('modal-manage-mini-apps', { '[data-ma-add]': {} });
  fillForm({ name: 'X', url: 'https://ok.test' });
  rpcImpl = async (n) => (n === 'mini_app_save' ? { data: null, error: { message: 'You can have up to 10 Mini Apps' } } : { data: [], error: null });
  await clickOn('modal-mini-app-form', { '[data-ma-save]': {} });
  await settle();
  assert.equal(registry.get('mini-app-form-error').textContent, 'You can have up to 10 Mini Apps');
  assert.equal(registry.get('mini-app-save-btn').disabled, false);
  assert.equal(registry.get('mini-app-save-btn').textContent, 'Save');
});

await t('editing: the form is filled from the app, shows Delete, and saving sends its id', async () => {
  await openManager();
  await clickOn('modal-manage-mini-apps', { '[data-ma-edit]': { dataset: { maEdit: 'm2' } } });
  assert.equal(registry.get('mini-app-form-title').textContent, 'Edit Mini App');
  assert.equal(registry.get('mini-app-name-input').value, 'Old Quiz');
  assert.equal(registry.get('mini-app-inapp-toggle').checked, false);
  assert.equal(registry.get('mini-app-active-toggle').checked, false);
  assert.ok(!registry.get('mini-app-delete-btn').classList.contains('hidden'));
  fillForm({ name: 'Old Quiz 2', url: 'https://quiz.test/', inApp: true, active: true });
  await clickOn('modal-mini-app-form', { '[data-ma-save]': {} });
  await settle();
  assert.equal(rpcCalls.find((c) => c.n === 'mini_app_save').p.p_id, 'm2');
  assert.deepEqual(toasts.at(-1), ['Mini app updated.', 'success']);
});

await t('visibility switch: hides / shows via mini_app_set_active, refreshes the tray list, and reverts on failure', async () => {
  await openManager();
  const change = (id, checked) => registry.get('modal-manage-mini-apps').listeners.change[0]({ target: { closest: (s) => (s === '[data-ma-toggle]' ? { dataset: { maToggle: id }, checked } : null) } });
  await change('m1', false);
  await settle();
  assert.deepEqual(rpcCalls.find((c) => c.n === 'mini_app_set_active').p, { p_id: 'm1', p_active: false });
  assert.match(registry.get('mini-apps-manage-list').innerHTML, /Hidden/);
  assert.ok(rpcCalls.some((c) => c.n === 'mini_apps_list'), 'Home tray refreshed');

  rpcImpl = async (n) => (n === 'mini_app_set_active' ? { data: null, error: { message: 'nope' } } : { data: [], error: null });
  await change('m2', true);
  await settle();
  assert.doesNotMatch(registry.get('mini-apps-manage-list').innerHTML, /data-ma-toggle="m2" checked/, 'switch put back');
  assert.deepEqual(toasts.at(-1), ['nope', 'error']);
});

await t('delete: asks first; Cancel does nothing, Delete calls mini_app_delete and refreshes', async () => {
  await openManager();
  await clickOn('modal-manage-mini-apps', { '[data-ma-edit]': { dataset: { maEdit: 'm1' } } });
  await clickOn('modal-mini-app-form', { '[data-ma-delete]': {} });
  assert.ok(!registry.get('modal-confirm-action').classList.contains('hidden'), 'confirm dialog shown');
  assert.match(registry.get('confirm-action-message').textContent, /Fee Portal/);
  registry.get('confirm-action-no').listeners.click[0]();
  assert.equal(rpcCalls.filter((c) => c.n === 'mini_app_delete').length, 0);

  await clickOn('modal-mini-app-form', { '[data-ma-delete]': {} });
  await registry.get('confirm-action-yes').listeners.click[0]();
  await settle();
  assert.deepEqual(rpcCalls.find((c) => c.n === 'mini_app_delete').p, { p_id: 'm1' });
  assert.deepEqual(toasts.at(-1), ['Mini app deleted.', 'success']);
});

await t('limit: at 10 apps the New button explains instead of opening the form', async () => {
  const f = await fresh();
  const ten = Array.from({ length: 10 }, (_, i) => ({ ...MINE[0], id: 'x' + i, name: 'App ' + i }));
  rpcImpl = async (n) => ({ data: n === 'mini_apps_mine' ? ten : [], error: null });
  f.pm.initPageMiniApps(PAGE);
  f.pm.openMiniAppsManager();
  await settle();
  await clickOn('modal-manage-mini-apps', { '[data-ma-add]': {} });
  assert.match(toasts.at(-1)[0], /up to 10/);
  assert.ok(registry.get('modal-mini-app-form').classList.contains('hidden'));
});

await t('SECURITY: names in the manager list are HTML-escaped too', async () => {
  const f = await fresh();
  rpcImpl = async (n) => ({ data: n === 'mini_apps_mine' ? [{ ...MINE[0], name: '<b onclick=x>Hi</b>' }] : [], error: null });
  f.pm.initPageMiniApps(PAGE);
  f.pm.openMiniAppsManager();
  await settle();
  assert.doesNotMatch(registry.get('mini-apps-manage-list').innerHTML, /<b onclick/);
});

console.log(`\n${passed} passed`);
