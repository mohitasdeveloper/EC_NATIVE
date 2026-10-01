// Static contract check between the study-time / leaderboard client code and
// supabase/study_time.sql.   node tests/study-time-contract.test.mjs
//
// There is no Postgres in CI, so this proves what can be proven without one:
// the JS and the SQL agree on function names, parameter names, periods, caps,
// the IST day boundary and the JSON keys the UI reads — and that the security
// and privacy properties the design relies on (nothing granted to anon, helpers
// not callable by clients, identity from auth.uid(), a hidden user's identity
// only ever emitted inside the masking CASE) haven't been edited away. It does
// NOT prove the SQL is valid Postgres: run supabase/study_time.sql once in the
// SQL editor for that.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sql = read('supabase/study_time.sql');
const tracker = read('www/study-time.js');
const search = read('www/search.js');
const viewer = read('www/pdf-viewer.js');
const indexHtml = read('www/index.html');
const mainJs = read('www/main.js');
const sw = read('www/sw.js');
const icons = read('www/fonts/icons-used.txt').split('\n').map((s) => s.trim());
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'); // comments may mention auth.uid() etc.

// ---- parse SQL functions: name -> { params, body, header } ----
const funcs = {};
const fnRe = /CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\)\s*RETURNS\s+([\s\S]*?)\s+LANGUAGE[\s\S]*?\$function\$([\s\S]*?)\$function\$;/g;
for (const m of sql.matchAll(fnRe)) {
  const [, name, args, ret, body] = m;
  const at = sql.indexOf(`public.${name}(`);
  funcs[name] = { params: [...args.matchAll(/\b(p_\w+)\b/g)].map((x) => x[1]), ret: ret.trim(), body, header: sql.slice(at, sql.indexOf('$function$', at)) };
}
const names = Object.keys(funcs);
const helpers = names.filter((n) => n.startsWith('_'));
const publicFns = names.filter((n) => !n.startsWith('_'));

let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.message); process.exitCode = 1; } }
console.log('study-time contract');

// ============ SQL: structure + access model ============
t('SQL parsed: found the expected functions', () => {
  for (const n of ['record_study_time', 'study_leaderboard', 'study_set_name_hidden', '_study_me', '_study_today', '_study_ranked']) {
    assert.ok(funcs[n], 'missing function ' + n);
  }
});

t('both tables have RLS on, NO policies, and every privilege revoked from clients', () => {
  for (const tbl of ['study_time_daily', 'study_leaderboard_prefs']) {
    assert.ok(new RegExp(`ALTER TABLE public\\.${tbl}\\s+ENABLE ROW LEVEL SECURITY`).test(sql), tbl + ' has no RLS');
    assert.ok(new RegExp(`REVOKE ALL ON public\\.${tbl}\\s+FROM PUBLIC, anon, authenticated;`).test(sql), tbl + ' is still readable/writable by clients');
  }
  assert.ok(!/CREATE POLICY/i.test(code), 'a policy would open a direct-table path around the functions');
});

t('internal helpers (_study_me, _study_ranked) are REVOKEd from PUBLIC, anon and authenticated and never granted', () => {
  for (const n of ['_study_me', '_study_ranked']) {
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${n}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated;`).test(sql),
      n + ' can still be executed by clients (_study_ranked would list every user\'s time, ignoring name hiding)');
    assert.ok(!new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${n}\\(`).test(sql), n + ' must never be granted to clients');
  }
});

t('every client-facing function is revoked from PUBLIC/anon and granted to authenticated only', () => {
  assert.deepEqual(publicFns.sort(), ['record_study_time', 'study_leaderboard', 'study_set_name_hidden']);
  for (const n of publicFns) {
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${n}\\([^)]*\\)\\s+FROM PUBLIC, anon;`).test(sql), n + ' not revoked from anon');
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${n}\\([^)]*\\)\\s+TO authenticated;`).test(sql), n + ' has no GRANT to authenticated');
  }
  assert.ok(!/GRANT[^;]*\banon\b/i.test(code), 'nothing may be granted to anon');
});

t('every function has a pinned search_path; all but the plain date helper are SECURITY DEFINER', () => {
  for (const n of names) {
    assert.ok(/SET search_path TO 'public'/.test(funcs[n].header), n + ' has no pinned search_path');
    if (n !== '_study_today') assert.ok(/SECURITY DEFINER/.test(funcs[n].header), n + ' is not SECURITY DEFINER');
  }
});

t('identity comes from auth.uid() via users.auth_user_id only, exactly once (inside _study_me)', () => {
  const uses = [...code.matchAll(/auth\.uid\(\)/g)];
  const ok = [...code.matchAll(/auth_user_id = auth\.uid\(\)/g)];
  assert.equal(uses.length, ok.length);
  assert.equal(uses.length, 1);
  assert.ok(/auth_user_id = auth\.uid\(\)/.test(funcs._study_me.body));
});

t('no client-facing function accepts a user id — callers can only ever act as themselves', () => {
  const allowed = new Set(['p_day', 'p_seconds', 'p_period', 'p_limit', 'p_hidden']);
  for (const n of publicFns) for (const p of funcs[n].params) assert.ok(allowed.has(p), `${n} takes ${p}`);
  for (const n of publicFns) assert.ok(funcs[n].body.includes('_study_me()'), n + ' does not resolve the caller via _study_me()');
});

// ============ SQL: name hiding (the privacy guarantee) ============
t('PRIVACY: user_id, full_name, profile_img_url and tick_type are only emitted inside the mask CASE', () => {
  const body = funcs.study_leaderboard.body;
  for (const k of ['user_id', 'full_name', 'profile_img_url', 'tick_type']) {
    assert.ok(new RegExp(`'${k}',\\s*CASE WHEN r\\.user_id = v_me OR NOT x\\.masked THEN [\\w.]+\\s+END`).test(body),
      `'${k}' is not gated by the mask — a hidden user's identity would reach other clients`);
  }
  for (const col of ['u.full_name', 'u.profile_img_url', 'u.tick_type']) {
    assert.equal(body.split(col).length - 1, 1, `${col} is referenced outside the masking CASE`);
  }
  assert.ok(!/SELECT[^;]*\bu\.\*/.test(body) && !/SELECT[^;]*\br\.\*/.test(body), 'SELECT * would bypass the mask');
});

t('PRIVACY: masked = the owner\'s switch for THIS period OR a block in either direction', () => {
  const body = funcs.study_leaderboard.body;
  for (const col of ['hide_daily', 'hide_weekly', 'hide_alltime']) assert.ok(body.includes(`p.${col}`), col + ' not consulted');
  assert.ok(/c\.status = 'blocked'/.test(body));
  assert.ok(/c\.user_one_id = v_me AND c\.user_two_id = r\.user_id/.test(body) && /c\.user_two_id = v_me AND c\.user_one_id = r\.user_id/.test(body), 'block check must cover both directions');
});

t('the leaderboard only lists active students: not deleted, deactivated, suspended, or Pages', () => {
  const b = funcs._study_ranked.body;
  for (const f of ['is_deleted', 'is_deactivated', 'is_suspended']) assert.ok(new RegExp(`COALESCE\\(u\\.${f}, false\\)\\s*=\\s*false`).test(b), f + ' not filtered');
  assert.ok(/COALESCE\(u\.role, 'student'\) <> 'page'/.test(b));
  assert.ok(/HAVING sum\(s\.seconds\) > 0/.test(b), 'zero-second users must not appear');
});

t('study_leaderboard caps the page size and validates the period; set_name_hidden validates too', () => {
  assert.ok(/least\(greatest\(COALESCE\(p_limit, 50\), 1\), 100\)/.test(funcs.study_leaderboard.body));
  for (const n of ['study_leaderboard', 'study_set_name_hidden']) assert.ok(/NOT IN \('daily', 'weekly', 'alltime'\)/.test(funcs[n].body), n + ' does not validate p_period');
  assert.ok(/p_hidden IS NULL/.test(funcs.study_set_name_hidden.body));
});

t('set_name_hidden updates ONE period per call (so two quick taps can\'t overwrite each other)', () => {
  const b = funcs.study_set_name_hidden.body;
  for (const [col, per] of [['hide_daily', 'daily'], ['hide_weekly', 'weekly'], ['hide_alltime', 'alltime']]) {
    assert.ok(new RegExp(`${col}\\s*=\\s*CASE WHEN p_period = '${per}'\\s+THEN p_hidden ELSE s\\.${col}\\s+END`).test(b), col);
  }
});

// ============ SQL: recording ============
t('record_study_time never raises — stale/invalid input is dropped (returns 0) so the client can safely discard it', () => {
  assert.ok(!/RAISE/.test(funcs.record_study_time.body));
  assert.ok(/p_day > v_today OR p_day < v_today - 2/.test(funcs.record_study_time.body));
});

t('JS and SQL agree on caps, the IST day boundary and how long a day stays writable', () => {
  const jsCall = Number(tracker.match(/MAX_CALL_SECONDS = (\d+)/)[1]);
  assert.ok(new RegExp(`least\\(p_seconds, ${jsCall},`).test(funcs.record_study_time.body), 'per-call cap differs between study-time.js and the SQL');
  const keep = Number(tracker.match(/KEEP_DAYS = (\d+)/)[1]);
  assert.ok(new RegExp(`p_day < v_today - ${keep}\\b`).test(funcs.record_study_time.body), 'the client keeps days the server would drop (or vice versa)');
  assert.ok(/IST_OFFSET_MS = 330 \* 60 \* 1000/.test(tracker));
  assert.ok(/AT TIME ZONE 'Asia\/Kolkata'/.test(funcs._study_today.body));
  assert.ok(/43200/.test(funcs.record_study_time.body), '12h/day ceiling missing');
});

t('study_time.sql is idempotent: every CREATE is IF NOT EXISTS / OR REPLACE', () => {
  for (const m of code.matchAll(/^CREATE (\w+(?: \w+)?)/gm)) {
    assert.ok(/^(TABLE|INDEX|OR REPLACE)/.test(m[1]), 'non-idempotent statement: CREATE ' + m[1]);
  }
  for (const m of code.matchAll(/^CREATE (TABLE|INDEX) (.*)$/gm)) assert.ok(/IF NOT EXISTS/.test(m[2]), 'CREATE ' + m[1] + ' without IF NOT EXISTS');
});

// ============ JS <-> SQL ============
t('every supabase.rpc() the client makes exists in the SQL with matching parameter names, and every public function is used', () => {
  const used = new Map();
  for (const src of [tracker, search]) {
    for (const m of src.matchAll(/supabase\.rpc\('(\w+)',\s*\{([^}]*)\}/g)) {
      used.set(m[1], [...m[2].matchAll(/\b(p_\w+)\s*:/g)].map((x) => x[1]));
    }
  }
  assert.deepEqual([...used.keys()].sort(), publicFns.slice().sort());
  for (const [fn, ps] of used) assert.deepEqual(ps.slice().sort(), funcs[fn].params.slice().sort(), fn + ' parameter names differ');
});

t('periods agree: the pills, the SQL validation and the prefs keys are the same three strings', () => {
  const block = search.slice(search.indexOf('const LB_PERIODS'), search.indexOf('];', search.indexOf('const LB_PERIODS')));
  const jsKeys = [...block.matchAll(/key: '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(jsKeys, ['daily', 'weekly', 'alltime']);
  const sqlKeys = [...funcs.study_leaderboard.body.match(/NOT IN \(([^)]*)\)/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(sqlKeys, jsKeys);
  for (const k of jsKeys) assert.ok(new RegExp(`'${k}',\\s*COALESCE\\(hide_${k}`).test(funcs.study_leaderboard.body), `prefs.${k} not returned`);
});

t('every JSON key the UI reads is emitted by study_leaderboard', () => {
  const body = funcs.study_leaderboard.body;
  const emitted = (k) => new RegExp(`'${k}'`).test(body);
  for (const k of ['entries', 'me', 'totals', 'prefs', 'participants', 'period', 'rank', 'seconds', 'is_me', 'hidden', 'user_id', 'full_name', 'profile_img_url', 'tick_type', 'today', 'week', 'alltime']) {
    assert.ok(emitted(k), `SQL never emits '${k}'`);
  }
  for (const k of ['entries', 'me', 'totals', 'prefs', 'participants', 'rank', 'seconds', 'is_me', 'hidden', 'user_id', 'full_name', 'profile_img_url', 'tick_type', 'today', 'week', 'alltime']) {
    assert.ok(new RegExp(`\\.${k}\\b`).test(search), `search.js never reads .${k}`);
  }
});

// ============ wiring ============
t('the Leaderboard pill sits immediately after the BAFs App pill and is handled by setDiscoverTab', () => {
  assert.ok(/data-discover-tab="bafs"[^\n]*<\/button>\s*<button data-discover-tab="leaderboard" onclick="window\.setDiscoverTab\('leaderboard'\)"/.test(indexHtml));
  assert.ok(/tab === 'leaderboard'/.test(search));
  const order = [...indexHtml.matchAll(/data-discover-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['popular', 'suggested', 'bafs', 'leaderboard']);
});

t('the PDF viewer emits open/ready/close with NO detail (the URL is never handed out) and the tracker listens to all three', () => {
  for (const e of ['open', 'ready', 'close']) {
    assert.ok(viewer.includes(`emit('${e}')`), `pdf-viewer.js never emits ${e}`);
    assert.ok(tracker.includes(`'ecampus:pdf-${e}'`), `study-time.js never listens for ${e}`);
  }
  assert.ok(/new CustomEvent\('ecampus:pdf-' \+ name\)\)/.test(viewer), 'the event must carry no detail');
});

t('main.js starts the tracker with the profile; sw.js precaches it (and the cache name was bumped past v11)', () => {
  assert.ok(/import \{ initStudyTracking \} from '\.\/study-time\.js';/.test(mainJs));
  assert.ok(/initStudyTracking\(profile\);/.test(mainJs));
  assert.ok(sw.includes("'./study-time.js'"));
  assert.ok(Number(sw.match(/ecampus-cache-v(\d+)/)[1]) >= 12, 'shipping a new precached file without bumping the cache name serves stale assets');
});

t('every icon the leaderboard draws is in fonts/icons-used.txt (so a --subset font build keeps them)', () => {
  for (const i of ['emoji_events', 'visibility_off', 'person', 'more_horiz', 'cloud_off', 'info']) assert.ok(icons.includes(i), i + ' missing from icons-used.txt');
});

console.log(`\n${passed} passed`);
