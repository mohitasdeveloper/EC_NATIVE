// Static guards for Page Mini Apps: SQL <-> JS contract, SQL access model, markup hooks, wiring.
// No browser, no deps.   node tests/page-mini-apps-contract.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sql = read('supabase/page_mini_apps.sql');
const pm = read('www/page-mini-apps.js'), mini = read('www/mini-apps.js'), html = read('www/index.html');
const main = read('www/main.js'), sw = read('www/sw.js'), style = read('www/style.css');

let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.message); process.exitCode = 1; } }

// functions defined in the SQL: name -> { params, body }
const funcs = {};
for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\)\s*RETURNS[\s\S]*?\$function\$([\s\S]*?)\$function\$/g)) {
  funcs[m[1]] = { params: [...m[2].matchAll(/\b(p_\w+)\b/g)].map((x) => x[1]), body: m[3], full: m[0] };
}
const clientFuncs = Object.keys(funcs).filter((n) => !n.startsWith('_'));

t('every supabase.rpc() the client makes exists in the SQL with matching parameter names, and every public function is used', () => {
  const used = new Map();
  for (const src of [pm, mini]) {
    for (const m of src.matchAll(/supabase\.rpc\('(\w+)'(?:,\s*\{([^}]*)\})?/g)) {
      used.set(m[1], m[2] ? [...m[2].matchAll(/\b(p_\w+)\s*:/g)].map((x) => x[1]) : []);
    }
  }
  assert.ok(used.size >= 5, 'expected the five mini-app RPCs');
  for (const [fn, ps] of used) {
    assert.ok(funcs[fn], `${fn} is called but not defined in page_mini_apps.sql`);
    assert.deepEqual(ps.slice().sort(), funcs[fn].params.slice().sort(), `${fn} parameter names differ`);
  }
  for (const fn of clientFuncs) assert.ok(used.has(fn), `${fn} is defined but never called`);
});

t('access model: RLS on, no policies, table privileges revoked, every function SECURITY DEFINER with a fixed search_path', () => {
  assert.match(sql, /ALTER TABLE public\.page_mini_apps ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /CREATE POLICY/i);
  assert.match(sql, /REVOKE ALL ON public\.page_mini_apps FROM PUBLIC, anon, authenticated/);
  for (const [name, f] of Object.entries(funcs)) {
    assert.match(f.full, /SECURITY DEFINER/, `${name} must be SECURITY DEFINER`);
    assert.match(f.full, /SET search_path TO 'public'/, `${name} must pin search_path`);
  }
});

t('who is asking always comes from auth.uid(); no function takes a page id; writes are scoped to the caller\'s own rows', () => {
  assert.match(funcs._mini_app_page.body, /auth_user_id = auth\.uid\(\)/);
  assert.match(funcs._mini_app_page.body, /role = 'page'/);
  for (const [name, f] of Object.entries(funcs)) assert.ok(!f.params.includes('p_page_id') && !f.params.includes('p_user_id'), `${name} must not accept a page/user id`);
  for (const w of ['mini_app_save', 'mini_app_set_active', 'mini_app_delete', 'mini_apps_mine']) assert.match(funcs[w].body, /_mini_app_page\(\)/, `${w} must resolve the caller via _mini_app_page()`);
  assert.match(funcs.mini_app_save.body, /WHERE id = p_id AND page_id = v_page/);
  assert.match(funcs.mini_app_set_active.body, /WHERE id = p_id AND page_id = v_page/);
  assert.match(funcs.mini_app_delete.body, /WHERE id = p_id AND page_id = v_page/);
});

t('grants: the helper is private; client functions are for signed-in users only', () => {
  assert.match(sql, /REVOKE ALL ON FUNCTION public\._mini_app_page\(\) FROM PUBLIC, anon, authenticated/);
  for (const n of clientFuncs) {
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${n}\\([^)]*\\)\\s+TO authenticated`), `${n} grant`);
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${n}\\([^)]*\\)\\s+FROM PUBLIC, anon`), `${n} revoke`);
  }
});

t('the Home tray only shows ACTIVE apps of LIVE Pages, and skips blocked relationships', () => {
  const b = funcs.mini_apps_list.body;
  assert.match(b, /WHERE m\.is_active/);
  assert.match(b, /p\.role = 'page'/);
  assert.match(b, /is_deleted/); assert.match(b, /is_deactivated/);
  assert.match(b, /is_blocked\(v_me, m\.page_id\)/);
});

t('limits agree: 10 apps per Page, names 1–20 characters, https-only URLs (table CHECKs, the function and the client)', () => {
  assert.match(sql, /BETWEEN 1 AND 20/);
  assert.match(funcs.mini_app_save.body, /> 20/);
  assert.match(funcs.mini_app_save.body, />= 10/);
  assert.match(pm, /MAX_APPS_PER_PAGE = 10/);
  assert.match(pm, /NAME_MAX = 20/);
  assert.ok((sql.match(/\^https:\/\//g) || []).length >= 4, 'url + icon_url checked in the table and in mini_app_save');
});

t('markup: every id the manager looks up, and every data-ma-* hook it listens for, exists in index.html', () => {
  const ids = new Set([...pm.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  ids.delete('mini-apps-tray');
  for (const id of ids) {
    if (['confirm-action-title', 'confirm-action-message', 'confirm-action-yes', 'confirm-action-no', 'modal-confirm-action'].includes(id)) { assert.ok(html.includes(`id="${id}"`), id); continue; }
    assert.ok(html.includes(`id="${id}"`), `index.html is missing #${id}`);
  }
  for (const hook of ['data-ma-close', 'data-ma-add', 'data-ma-form-close', 'data-ma-save', 'data-ma-delete']) assert.ok(html.includes(hook), `${hook} not in index.html`);
  assert.ok(pm.includes('data-ma-toggle') && pm.includes('data-ma-edit'), 'row hooks are rendered by the module');
  assert.ok(html.includes('id="mini-apps-tray"'));
});

t('the open-in-app choice and the visibility switch are on the form (defaults: both on)', () => {
  assert.match(html, /id="mini-app-inapp-toggle" checked/);
  assert.match(html, /id="mini-app-active-toggle" checked/);
  assert.match(html, /Open inside ECampus/);
  assert.match(html, /student_id=…&amp;name=…&amp;course=…&amp;dp_url=…&amp;theme=dark/, 'the form tells the Page what its app receives');
});

t('back navigation: the add/edit sheet closes first, then the manager, then the Mini Apps overlay (last)', () => {
  const hier = main.slice(main.indexOf('const modalHierarchy'), main.indexOf('// Remember to change the check loop'));
  const ids = [...hier.matchAll(/id: '([\w-]+)'/g)].map((m) => m[1]);
  assert.ok(ids.indexOf('modal-confirm-action') < ids.indexOf('modal-mini-app-form'), 'confirm dialog is above everything');
  assert.ok(ids.indexOf('modal-mini-app-form') < ids.indexOf('modal-manage-mini-apps'));
  assert.equal(ids[ids.length - 1], 'modal-mini-app');
  assert.ok(ids.includes('modal-manage-mini-apps') && ids.indexOf('modal-manage-mini-apps') < ids.indexOf('modal-mini-app'));
});

t('opening goes through the link router with { full: true } and the app\'s own open-in-app flag; main.js uses link-params.js', () => {
  assert.match(pm, /window\.openServiceLink\(app\.url, app\.open_in_app !== false, app\.name, \{ full: true \}\)/);
  assert.match(main, /import \{ withUserParams \} from '\.\/link-params\.js'/);
  assert.match(main, /withUserParams\(url, currentUserProfile, \{\s*full: !!\(opts && opts\.full\)/);
  assert.ok(!/searchParams\.set\('student_id'/.test(main), 'param building must live in link-params.js only');
});

t('the tray refreshes with pull-to-refresh, escapes everything from other users, and shows Manage only to Pages', () => {
  assert.match(main, /executeContextualRefresh[\s\S]*?window\.refreshMiniApps/);
  assert.match(mini, /escapeHtml\(name\)/);
  assert.match(mini, /isPageAccount\(\) \? \[`/);
  assert.match(mini, /data-mini-manage/);
});

t('styles: Manage circle is dashed with no ring; the initial fallback is styled; overlay ids keep the modal- prefix', () => {
  assert.match(style, /\.mini-app-circle\.is-manage \.mini-app-face \{ border: 2px dashed/);
  assert.match(style, /\.mini-app-fallback\.mini-app-initial/);
  assert.ok(html.includes('id="modal-manage-mini-apps"') && html.includes('id="modal-mini-app-form"'), 'pull-to-refresh ignores [id^="modal-"]');
});

t('service worker precaches the new modules; cache bumped', () => {
  assert.ok(sw.includes("'./page-mini-apps.js'") && sw.includes("'./link-params.js'"));
  assert.ok(Number(sw.match(/ecampus-cache-v(\d+)/)[1]) >= 21);
});

console.log(`\n${passed} passed`);
