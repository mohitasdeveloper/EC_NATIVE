// Static contract check between the insights client code and supabase/insights.sql.
//   node tests/insights-contract.test.mjs
//
// There is no Postgres in CI, so this proves what can be proven without one:
// the JS and the SQL agree on function names, parameter names, event types and
// the JSON keys the UI reads — and the security properties the design relies on
// (helpers not callable by clients, nothing granted to anon, identity always
// derived from auth.uid()) haven't been edited away. It does NOT prove the SQL
// is valid Postgres: run supabase/insights.sql once in the SQL editor for that.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sql = read('supabase/insights.sql');
const ui = read('www/insights.js');
const tracker = read('www/insights-track.js');
const allClient = ['main.js', 'hotposts.js', 'post-card.js', 'feed.js', 'insights.js', 'insights-track.js']
  .map((f) => read('www/' + f)).join('\n');

// ---- parse SQL functions: name -> { params, body, header } ----
const funcs = {};
const fnRe = /CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\)\s*RETURNS\s+([\s\S]*?)\s+LANGUAGE[\s\S]*?\$function\$([\s\S]*?)\$function\$;/g;
for (const m of sql.matchAll(fnRe)) {
  const [, name, args, ret, body] = m;
  funcs[name] = { params: [...args.matchAll(/\b(p_\w+)\b/g)].map((x) => x[1]), ret: ret.trim(), body };
}
const names = Object.keys(funcs);
const helpers = names.filter((n) => n.startsWith('_insights_'));
const publicFns = names.filter((n) => !n.startsWith('_'));

let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.message); process.exitCode = 1; } }
console.log('insights contract');

t('SQL parsed: found the expected functions', () => {
  for (const n of ['record_insight_events', 'insights_account_overview', 'insights_content_list', 'insights_post_detail',
    'insights_story_detail', 'insights_audience', '_insights_me', '_insights_audience', '_insights_exposures',
    '_insights_interactions', '_insights_post_rows', '_insights_story_rows', '_insights_totals']) {
    assert.ok(funcs[n], 'missing function ' + n);
  }
});

t('every internal _insights_* helper is REVOKEd from PUBLIC, anon and authenticated', () => {
  for (const n of helpers) {
    const re = new RegExp(`REVOKE ALL ON FUNCTION public\\.${n}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated;`);
    assert.ok(re.test(sql), n + ' can still be executed by clients (they take an owner id, so that would leak anyone\'s data)');
    assert.ok(!new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${n}\\(`).test(sql), n + ' must never be granted to clients');
  }
});

t('every client-facing function is revoked from PUBLIC/anon and granted to authenticated only', () => {
  for (const n of publicFns.filter((f) => f !== 'insights_purge_old_events')) {
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${n}\\([^)]*\\)\\s+FROM PUBLIC, anon;`).test(sql), n + ' not revoked from anon');
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${n}\\([^)]*\\)\\s+TO authenticated;`).test(sql), n + ' has no GRANT to authenticated');
  }
  assert.ok(/REVOKE ALL ON FUNCTION public\.insights_purge_old_events\(integer\)\s+FROM PUBLIC, anon, authenticated;/.test(sql), 'purge must not be client-callable');
});

t('all functions are SECURITY DEFINER with a pinned search_path', () => {
  for (const n of names) {
    const header = sql.slice(sql.indexOf(`public.${n}(`), sql.indexOf('$function$', sql.indexOf(`public.${n}(`)));
    assert.ok(/SECURITY DEFINER/.test(header), n + ' is not SECURITY DEFINER');
    assert.ok(/SET search_path TO 'public'/.test(header), n + ' has no pinned search_path');
  }
});

t('identity comes from auth.uid() via users.auth_user_id only (never compared to an *_id column)', () => {
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'); // comments may mention auth.uid()
  const uses = [...code.matchAll(/auth\.uid\(\)/g)];
  const okUses = [...code.matchAll(/auth_user_id = auth\.uid\(\)/g)];
  assert.equal(uses.length, okUses.length, 'auth.uid() used other than as "auth_user_id = auth.uid()"');
  assert.equal(uses.length, 1, 'expected exactly one auth.uid() use, inside _insights_me()');
  assert.ok(funcs._insights_me.body.includes('auth.uid()'));
});

t('every client-facing function resolves the caller via _insights_me() and rejects signed-out callers', () => {
  for (const n of publicFns.filter((f) => f !== 'insights_purge_old_events')) {
    assert.ok(funcs[n].body.includes('_insights_me()'), n + ' does not call _insights_me()');
    assert.ok(/v_me IS NULL/.test(funcs[n].body), n + ' does not handle a NULL caller');
  }
});

t('no client-facing function accepts an owner/user id parameter (callers can only ask about themselves)', () => {
  for (const n of publicFns.filter((f) => f !== 'insights_purge_old_events')) {
    for (const p of funcs[n].params) {
      assert.ok(!/(owner|user|viewer)/.test(p), `${n} takes ${p}: a client-supplied identity`);
    }
  }
});

t('detail functions enforce ownership', () => {
  assert.ok(/user_id = v_me/.test(funcs.insights_post_detail.body), 'post detail does not filter by owner');
  assert.ok(/user_id = v_me/.test(funcs.insights_story_detail.body), 'story detail does not filter by owner');
});

t('insight_events is locked down: RLS on, no policies, no client privileges', () => {
  assert.ok(/ALTER TABLE public\.insight_events ENABLE ROW LEVEL SECURITY/.test(sql));
  assert.ok(!/CREATE POLICY[^;]*insight_events/.test(sql), 'a policy on insight_events would open it to direct access');
  assert.ok(/REVOKE ALL ON public\.insight_events FROM PUBLIC, anon, authenticated/.test(sql));
});

t('the JS calls only RPCs that exist, with parameter names the SQL declares', () => {
  const calls = [...(ui + tracker).matchAll(/(?:rpc|cachedRpc)\('(\w+)'(?:,\s*(\{[^}]*\}))?/g)];
  assert.ok(calls.length >= 6, 'found only ' + calls.length + ' rpc calls');
  for (const [, name, obj] of calls) {
    assert.ok(funcs[name], `JS calls ${name}() but the SQL doesn't define it`);
    if (obj) {
      const used = [...obj.matchAll(/\b(p_\w+)\s*:/g)].map((x) => x[1]);
      for (const p of used) assert.ok(funcs[name].params.includes(p), `${name}: JS passes ${p}, SQL declares (${funcs[name].params.join(', ')})`);
    }
  }
  // and every read function is actually used by the UI
  for (const n of publicFns.filter((f) => f.startsWith('insights_') && f !== 'insights_purge_old_events')) {
    assert.ok(ui.includes(`'${n}'`), n + ' is never called by insights.js');
  }
});

t('event types: what the client sends == what SQL accepts == what SQL handles', () => {
  const sent = new Set([...allClient.matchAll(/(?:trackEvent|trackInsightEvent|trackStoryEvent)\(\s*'(\w+)'/g)].map((m) => m[1]));
  // trackStoryEvent(isLast ? 'story_next_account' : 'story_tap_forward', ...) and the tap helpers
  for (const m of allClient.matchAll(/'(story_(?:impression|tap_forward|tap_back|next_account|exit))'/g)) sent.add(m[1]);
  for (const m of allClient.matchAll(/'(post_impression|post_share|post_link_click|profile_visit)'/g)) sent.add(m[1]);
  const check = sql.match(/event_type\s+text NOT NULL CHECK \(event_type IN \(([\s\S]*?)\)\)/)[1];
  const allowed = new Set([...check.matchAll(/'(\w+)'/g)].map((m) => m[1]));
  for (const e of sent) assert.ok(allowed.has(e), `client sends ${e} but the table CHECK rejects it`);
  const body = funcs.record_insight_events.body;
  for (const e of allowed) assert.ok(body.includes(`'${e}'`), `record_insight_events does not handle ${e}`);
  assert.ok(sent.size >= 8, 'expected the client to send most event types, saw: ' + [...sent].join(', '));
});

t('the server drops self-events and unknown subjects, and rate-limits', () => {
  const b = funcs.record_insight_events.body;
  assert.ok(/v_owner IS NULL OR v_owner = v_me/.test(b), 'own-content events must be dropped');
  assert.ok(/> 300/.test(b), 'per-viewer rate limit missing');
  assert.ok(/LIMIT 60/.test(b), 'batch size cap missing');
});

t('demographics are privacy-thresholded server-side', () => {
  const b = funcs.insights_audience.body;
  assert.ok(/v_total >= 5/.test(b), 'audience-size threshold missing');
  assert.ok(/g\.n >= 3/.test(b), 'small-bucket folding missing');
  assert.ok(/'demographics_hidden'/.test(b));
});

t('JSON keys the UI reads exist in what the SQL returns', () => {
  // Every key SQL can emit: jsonb_build_object keys + RETURNS TABLE columns of the row helpers.
  const keys = new Set();
  for (const n of names) {
    for (const m of funcs[n].body.matchAll(/'([a-z_]+)'\s*,/g)) keys.add(m[1]);
  }
  for (const n of ['_insights_post_rows', '_insights_story_rows']) {
    const ret = funcs[n].ret.match(/^TABLE\s*\(([\s\S]*)\)$/)[1];
    ret.split(',').forEach((c) => keys.add(c.trim().split(/\s+/)[0]));
  }
  // properties the renderers read off API objects (JS-only names excluded)
  const readers = ['c', 'p', 'd', 'counts', 'split', 'extra', 'item', 'it', 'r', 'g', 't', 's'];
  const jsOnly = new Set(['length', 'map', 'filter', 'join', 'slice', 'reduce', 'indexOf', 'includes', 'some', 'every', 'forEach',
    'push', 'sort', 'trim', 'toFixed', 'replace', 'split', 'style', 'innerHTML', 'textContent', 'classList', 'dataset', 'value',
    'id', 'kind', 'role', 'label', 'count', 'text', 'anchor', 'x', 'i', 'h', 'nodeType', 'data', 'error', 'code', 'message',
    'then', 'catch', 'test', 'toLocaleDateString', 'entries', 'keys', 'values', 'concat', 'name', 'type', 'current', 'previous',
    'from', 'min', 'max', 'abs', 'round', 'floor', 'isFinite', 'now', 'stringify', 'audienceLast', 'clear', 'has', 'get', 'set',
    'scrollTo', 'toggle', 'contains', 'add', 'remove']);
  const missing = new Set();
  const re = new RegExp(`\\b(?:${readers.join('|')})\\.([a-z_]+)\\b`, 'g');
  for (const m of ui.matchAll(re)) {
    const k = m[1];
    if (jsOnly.has(k) || keys.has(k)) continue;
    missing.add(k);
  }
  assert.deepEqual([...missing], [], 'UI reads keys the SQL never returns: ' + [...missing].join(', '));
  // and the ones we know matter, explicitly
  for (const k of ['accounts_reached', 'post_reach', 'story_reach', 'profile_reach', 'impressions', 'profile_visits', 'interactions',
    'new_audience', 'series', 'reach_split', 'content_counts', 'top_posts', 'top_stories', 'timeline', 'sources', 'demographics_hidden',
    'activity', 'gained', 'gained_previous', 'growth', 'gender', 'course', 'total', 'forward', 'back', 'next_account', 'exits',
    'poll_votes', 'rsvp_attending', 'rsvp_maybe', 'link_clicks', 'activity_days']) {
    assert.ok(keys.has(k), 'SQL never returns ' + k);
  }
});

t('the panel shell, entry points and back-button wiring exist', () => {
  const html = read('www/index.html');
  const main = read('www/main.js');
  assert.ok(html.includes('id="settings-insights-panel"') && html.includes('id="insights-body"') && html.includes('id="insights-tab-strip"'));
  assert.ok(html.includes('window.openInsights()'), 'no sidebar/profile entry point');
  assert.ok(/openInsights\(\{ kind: 'post'/.test(read('www/feed.js')), 'no post-menu entry point');
  assert.ok(html.includes('openStoryInsights'), 'no story Activity-panel entry point');
  assert.ok(main.includes("id: 'settings-insights-panel'"), 'hardware back button does not know about the panel');
  assert.ok(main.includes("import('./insights.js')"));
  assert.ok(read('www/sw.js').includes('./insights-track.js'), 'tracker is statically imported so it must be precached');
});

console.log(`\n${passed} passed`);
