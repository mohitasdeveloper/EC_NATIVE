// Static contract check for supabase/admin_insights.sql — mirrors the approach
// in tests/insights-contract.test.mjs. No live Postgres here, so this proves
// what's provable from the text: admin-gating is present on every function,
// grants are correct, the UNION ALL in admin_user_activity_feed has matching
// columns in every branch, and message bodies are never selected anywhere.
//   node tests/admin-insights-contract.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sql = read('supabase/admin_insights.sql');
const adminJs = read('www/admin.js');

const fnRe = /CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\)\s*RETURNS\s+([\s\S]*?)\s+LANGUAGE[\s\S]*?\$function\$([\s\S]*?)\$function\$;/g;
const funcs = {};
for (const m of sql.matchAll(fnRe)) {
  const [, name, args, ret, body] = m;
  funcs[name] = { params: [...args.matchAll(/\b(p_\w+)\b/g)].map((x) => x[1]), ret: ret.trim(), body };
}
const names = Object.keys(funcs);

let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.message); process.exitCode = 1; } }
console.log('admin_insights contract');

t('found the expected functions', () => {
  for (const n of ['admin_get_user', 'admin_user_activity_summary', 'admin_profile_visitors',
    'admin_content_rows', 'admin_post_viewers', 'admin_story_viewers', 'admin_user_activity_feed']) {
    assert.ok(funcs[n], 'missing ' + n);
  }
});

t('every function checks admin access before touching data', () => {
  for (const n of names) {
    const idx = funcs[n].body.search(/PERFORM public\._require_admin\(\);/);
    assert.ok(idx >= 0, n + ' never calls _require_admin()');
    // must be at (or very near) the top: no SELECT/UPDATE/INSERT/RETURN QUERY before it
    const before = funcs[n].body.slice(0, idx);
    assert.ok(!/RETURN QUERY|SELECT .* INTO|WITH /i.test(before), n + ' does real work before checking admin access');
  }
});

t('every function is SECURITY DEFINER with a pinned search_path', () => {
  for (const n of names) {
    const header = sql.slice(sql.indexOf(`public.${n}(`), sql.indexOf('$function$', sql.indexOf(`public.${n}(`)));
    assert.ok(/SECURITY DEFINER/.test(header), n + ' is not SECURITY DEFINER');
    assert.ok(/SET search_path TO 'public'/.test(header), n + ' has no pinned search_path');
  }
});

t('revoked from PUBLIC/anon and granted to authenticated only — no exceptions', () => {
  for (const n of names) {
    const sig = new RegExp(`public\\.${n}\\([^)]*\\)`);
    const revokeSig = sql.match(new RegExp(`REVOKE ALL ON FUNCTION ${sig.source}`));
    const grantSig = sql.match(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig.source}`));
    assert.ok(revokeSig, n + ' missing REVOKE');
    assert.ok(grantSig, n + ' missing GRANT');
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION ${sig.source}\\s+FROM PUBLIC, anon;`).test(sql), n + ' revoke must list exactly PUBLIC, anon');
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig.source}\\s+TO authenticated;`).test(sql), n + ' grant must be to authenticated only');
  }
});

t('message content is never selected or exposed — metadata only', () => {
  // The only touch of public.messages must be in admin_user_activity_feed's
  // message_sent branch, and it must not select m.content anywhere in the file.
  assert.ok(!/m\.content/.test(sql), 'a message body column (m.content) is referenced somewhere in this file');
  assert.ok(!/messages\.content/.test(sql));
  const feedBody = funcs.admin_user_activity_feed.body;
  const messagesRefs = [...feedBody.matchAll(/public\.messages\s+(\w+)/g)];
  assert.equal(messagesRefs.length, 1, 'expected exactly one join to public.messages (the message_sent branch)');
});

t('admin_user_activity_feed: every UNION ALL branch has the same 8 columns, in the same order', () => {
  const body = funcs.admin_user_activity_feed.body;
  const withBlock = body.slice(body.indexOf('WITH events AS ('), body.lastIndexOf(')\n  SELECT COALESCE(jsonb_agg'));
  const branches = withBlock.split(/\bUNION ALL\b/).map((s) => s.trim()).filter(Boolean);
  assert.ok(branches.length >= 10, 'expected at least 10 event kinds, found ' + branches.length);
  const expectedKinds = ['account_created', 'post_created', 'story_created', 'comment_made', 'like_given',
    'story_like_given', 'save_made', 'poll_voted', 'event_rsvp', 'connection_accepted', 'message_sent',
    'share_made', 'profile_visit_made', 'profile_visit_received', 'post_viewed', 'story_watched'];
  const seenKinds = new Set();
  for (const b of branches) {
    // First SELECT's column list up to "FROM" (each branch is one SELECT ... FROM ...)
    const selectMatch = b.match(/SELECT\s+([\s\S]*?)\s+FROM\b/);
    assert.ok(selectMatch, 'branch has no SELECT ... FROM: ' + b.slice(0, 60));
    // Split top-level commas (none of these branches nest commas inside function calls
    // deep enough to confuse a simple paren-depth split).
    const cols = [];
    let depth = 0, cur = '';
    for (const ch of selectMatch[1]) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { cols.push(cur.trim()); cur = ''; } else cur += ch;
    }
    cols.push(cur.trim());
    assert.equal(cols.length, 8, `branch has ${cols.length} columns, expected 8: ${b.slice(0, 50)}...`);
    const kindLit = cols[1].match(/'(\w+)'/);
    assert.ok(kindLit, 'second column must be a literal event kind: ' + cols[1]);
    seenKinds.add(kindLit[1]);
  }
  for (const k of expectedKinds) assert.ok(seenKinds.has(k), 'missing event kind in feed: ' + k);
});

t('post_viewed/story_watched branches are gated by p_include_views (off by default)', () => {
  const body = funcs.admin_user_activity_feed.body;
  for (const kind of ['post_viewed', 'story_watched']) {
    const branchStart = body.indexOf(`'${kind}'`);
    const branchEnd = body.indexOf('UNION ALL', branchStart);
    const branch = body.slice(branchStart, branchEnd === -1 ? undefined : branchEnd);
    assert.ok(/p_include_views/.test(branch), kind + ' branch does not check p_include_views');
  }
  assert.match(funcs.admin_user_activity_feed.params.join(','), /p_include_views/);
  const sig = sql.match(/admin_user_activity_feed\(([^)]*)\)/)[1];
  assert.match(sig, /p_include_views boolean DEFAULT false/, 'p_include_views must default to false');
});

t('viewer/visitor functions guard the insight_events dependency with a clear error', () => {
  for (const n of ['admin_profile_visitors', 'admin_content_rows']) {
    assert.match(funcs[n].body, /to_regclass\('public\.insight_events'\) IS NULL/, n + ' does not check insights.sql was run');
    assert.match(funcs[n].body, /insights\.sql/, n + ' error message does not point at insights.sql');
  }
});

t('admin_story_viewers falls back to hotpost_views for pre-insights views (matches insights.sql reasoning)', () => {
  assert.match(funcs.admin_story_viewers.body, /hotpost_views/);
  assert.match(funcs.admin_story_viewers.body, /NOT EXISTS[\s\S]*?story_impression/);
});

t('admin_get_user takes an id and returns the same shape admin_search_users uses (so admin.js can reuse one row renderer)', () => {
  assert.match(funcs.admin_get_user.ret, /TABLE\s*\(/);
  for (const col of ['full_name', 'email', 'student_id', 'is_admin', 'is_suspended', 'profile_img_url']) {
    assert.ok(funcs.admin_get_user.ret.includes(col), 'admin_get_user missing column ' + col);
  }
});

t('admin.js calls only RPCs this file defines, and uses every one of them', () => {
  const calls = new Set([...adminJs.matchAll(/rpc\('(\w+)'/g)].map((m) => m[1]));
  for (const n of names) assert.ok(calls.has(n), n + ' is defined in SQL but never called from admin.js');
});

console.log(`\n${passed} passed`);
