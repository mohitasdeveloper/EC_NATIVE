// Static contract check between www/admin.js and supabase/admin_panel.sql.
//   node tests/rpc-contract.test.mjs
//
// There is no Postgres in CI, so this is the next best thing: it proves the
// JavaScript and the SQL agree about function names, parameter names, and the
// column names each list RPC returns. A typo on either side (the most likely
// bug when the two are written separately) fails here instead of at runtime.
// It does NOT prove the SQL is valid Postgres — run it once in the Supabase
// SQL editor for that.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(root, 'www/admin.js'), 'utf8');
// admin_insights.sql (see tests/admin-insights-contract.test.mjs for its own,
// more detailed checks) defines more admin.js RPCs — concatenated here so this
// file's "every function the JS calls exists in the SQL" check covers all of
// them, not just the original admin_panel.sql set.
const sql = fs.readFileSync(path.join(root, 'supabase/admin_panel.sql'), 'utf8')
  + '\n' + fs.readFileSync(path.join(root, 'supabase/admin_insights.sql'), 'utf8');

// ---- parse SQL functions: name -> { params, columns, body } ----
const funcs = {};
const fnRe = /CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\)\s*RETURNS\s+([\s\S]*?)\s+LANGUAGE[\s\S]*?\$function\$([\s\S]*?)\$function\$;/g;
for (const m of sql.matchAll(fnRe)) {
  const [, name, args, ret, body] = m;
  const params = [...args.matchAll(/\b(p_\w+)\b/g)].map((x) => x[1]);
  let columns = [];
  const tbl = ret.match(/^TABLE\s*\(([\s\S]*)\)$/);
  if (tbl) columns = tbl[1].split(',').map((c) => c.trim().split(/\s+/)[0]);
  funcs[name] = { params, columns, body };
}
const adminFns = Object.keys(funcs).filter((n) => n.startsWith('admin_'));

let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.message); process.exitCode = 1; } }
console.log('rpc contract');

t('SQL parsed: found the expected admin functions', () => {
  assert.ok(adminFns.length >= 11, 'parsed only: ' + adminFns.join(', '));
});

t('every admin_* function checks admin server-side and is granted to authenticated', () => {
  for (const n of adminFns) {
    assert.ok(funcs[n].body.includes('_require_admin()'), n + ' does not call _require_admin()');
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${n}\\(`).test(sql), n + ' has no GRANT EXECUTE');
  }
});

t('every function the JS calls exists in the SQL, with the params it passes', () => {
  const calls = [...js.matchAll(/rpc\('(\w+)'(?:,\s*(\{[^}]*\}))?/g)];
  assert.ok(calls.length >= 12, 'found only ' + calls.length + ' rpc() calls');
  for (const [, name, obj] of calls) {
    assert.ok(funcs[name], `admin.js calls rpc('${name}') but the SQL does not define it`);
    for (const p of (obj || '').matchAll(/\b(p_\w+)\s*:/g)) {
      assert.ok(funcs[name].params.includes(p[1]), `${name}: JS passes ${p[1]} but SQL only has (${funcs[name].params.join(', ')})`);
    }
  }
});

t('admin_update_user accepts every field the JS patches (incl. dynamically-built ones)', () => {
  const direct = [...js.matchAll(/patchUser\(\{\s*(p_\w+)/g)].map((m) => m[1]);
  const dyn = [...js.matchAll(/__adminToggleField\('(\w+)'/g)].map((m) => 'p_' + m[1]);
  const toggles = [...js.matchAll(/toggleRow\('(\w+)'/g)].map((m) => 'p_' + m[1]);
  const need = new Set([...direct, ...dyn, ...toggles, 'p_is_suspended', 'p_is_deleted']);
  for (const p of need) assert.ok(funcs.admin_update_user.params.includes(p), 'admin_update_user has no ' + p);
});

// property names read off each row type must exist in the RPC's RETURNS TABLE
const sections = [
  ['admin_list_verifications', 'v', '// 2. Verifications', '// 3. Reports'],
  ['admin_list_reports', 'r', '// 3. Reports', '// 4. Feedback'],
  ['admin_list_feedback', 'f', '// 4. Feedback', '// 5. Users'],
  ['admin_search_users', 'u', '// 5. Users', '// 6. User Activity & Insights'],
];
for (const [fn, v, from, to] of sections) {
  t(`${fn}: every field admin.js reads (${v}.x) is a column it returns`, () => {
    const a = js.indexOf(from), b = js.indexOf(to);
    assert.ok(a >= 0 && b > a, 'could not locate section ' + from);
    const used = new Set([...js.slice(a, b).matchAll(new RegExp(`\\b${v}\\.([a-z_]+)\\b`, 'g'))].map((m) => m[1]));
    used.delete('length');
    const missing = [...used].filter((c) => !funcs[fn].columns.includes(c));
    assert.deepEqual(missing, [], `${fn} does not return: ${missing.join(', ')}`);
  });
}

t('dashboard JSON keys used by the cards are all produced by the SQL', () => {
  const keys = [...js.matchAll(/key: '(\w+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 6);
  for (const k of keys) assert.ok(funcs.admin_get_dashboard_stats.body.includes(`'${k}'`), 'stats RPC does not return ' + k);
});

t('password reset: admins only, refuses admin targets, bcrypt-hashes, signs the user out, audits, not callable by anon', () => {
  const f = funcs.admin_reset_user_password;
  assert.ok(f, 'admin_reset_user_password missing');
  assert.deepEqual(f.params, ['p_user_id', 'p_new_password']);
  assert.ok(/char_length\(p_new_password\)\s*<\s*8/.test(f.body), 'no minimum length');
  assert.ok(/v_target_is_admin/.test(f.body) && /RAISE EXCEPTION 'Admin passwords cannot be reset/.test(f.body), 'must refuse admin targets');
  assert.ok(/crypt\(p_new_password,\s*gen_salt\('bf'\)\)/.test(f.body), 'must store a bcrypt hash, never the plain password');
  assert.ok(/DELETE FROM auth\.sessions WHERE user_id = v_auth_id/.test(f.body), 'must sign the user out everywhere');
  assert.ok(/INSERT INTO public\.admin_audit_log/.test(f.body), 'must be audited');
  assert.ok(!/admin_audit_log[^;]*p_new_password/.test(f.body), 'the password must never be written to the audit log');
  assert.ok(/REVOKE ALL ON FUNCTION public\.admin_reset_user_password\(uuid, text\) FROM PUBLIC, anon/.test(sql));
});

t('app settings: readable by everyone (login screen), writable only through the admin RPC, whitelisted key', () => {
  assert.ok(/CREATE POLICY "app_settings_select_all"[\s\S]*?TO anon, authenticated[\s\S]*?USING \(true\)/.test(sql));
  assert.ok(/GRANT SELECT ON public\.app_settings TO anon, authenticated/.test(sql));
  assert.ok(!/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*ON public\.app_settings/.test(sql), 'clients must not be able to write app_settings');
  assert.ok(/p_key NOT IN \('screen_privacy'\)/.test(funcs.admin_set_app_setting.body), 'unknown keys must be rejected');
  assert.ok(/ALTER TABLE public\.admin_audit_log ENABLE ROW LEVEL SECURITY/.test(sql) && /REVOKE ALL ON public\.admin_audit_log FROM anon, authenticated/.test(sql));
});

t('admin_update_user only accepts #RRGGBB (or none) as a tick colour', () => {
  assert.ok(/p_tick_type !~ '\^#\[0-9A-Fa-f\]\{6\}\$'/.test(funcs.admin_update_user.body));
});

t('SQL sanity: balanced dollar-quotes, and no leftover college RPCs in JS', () => {
  assert.equal((sql.match(/\$function\$/g) || []).length % 2, 0);
  assert.ok(!/admin_(list|upsert|delete)_college/.test(js));
});

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
