// Static contract check for the Page fixes (duplicate notifications, broadcast by
// course, read-only channel).   node tests/page-channel-contract.test.mjs
//
// There is no Postgres in CI, so this proves the client and the SQL agree about
// names, arguments and course strings, and that the guards exist. It does NOT
// prove the SQL is valid Postgres — run the migration once in the Supabase SQL
// editor for that.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const feed = read('www/feed.js');
const hotposts = read('www/hotposts.js');
const messages = read('www/messages.js');
const auth = read('www/auth/auth.js');
const html = read('www/index.html');
const migration = read('supabase/migration_page_v14_channel_course_dedupe.sql');
const schema = read('supabase/schema.sql');

let passed = 0;
const pending = [];
function t(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n' + e.message); process.exitCode = 1; }
  })());
}
console.log('page channel contract');

// ---- 1. duplicate notifications ------------------------------------------
t('client never fans out Page notifications itself (the trigger does)', () => {
  for (const [name, src] of [['feed.js', feed], ['hotposts.js', hotposts], ['messages.js', messages]]) {
    assert.ok(!/rpc\(\s*['"]notify_page_followers['"]/.test(src), `${name} calls notify_page_followers — followers would be notified twice`);
  }
});

t('fan-out is idempotent: unique index + ON CONFLICT in migration and schema.sql', () => {
  for (const [name, sql] of [['migration', migration], ['schema.sql', schema]]) {
    assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_page_fanout[\s\S]*?WHERE type IN \('page_new_post', 'page_new_hotpost'\)/.test(sql), `${name}: missing unique index`);
    assert.ok(/ON CONFLICT \(user_id, sender_id, type, target_id\)[\s\S]*?DO NOTHING/.test(sql), `${name}: trigger lacks ON CONFLICT DO NOTHING`);
  }
});

t('the 4-arg notify_page_followers overload is a no-op', () => {
  for (const [name, sql] of [['migration', migration], ['schema.sql', schema]]) {
    const m = sql.match(/FUNCTION public\.notify_page_followers\(p_page_id uuid[\s\S]*?\$function\$([\s\S]*?)\$function\$;/);
    assert.ok(m, `${name}: overload not found`);
    assert.ok(!/INSERT\s+INTO/i.test(m[1]), `${name}: overload still inserts notifications`);
  }
});

// ---- 2. broadcast by course ----------------------------------------------
t('broadcast RPCs: client args match the SQL signatures', () => {
  assert.match(migration, /FUNCTION public\.broadcast_page_message\(p_content text, p_courses text\[\] DEFAULT NULL\)/);
  assert.match(migration, /FUNCTION public\.count_page_broadcast_recipients\(p_courses text\[\] DEFAULT NULL\)/);
  assert.match(migration, /DROP FUNCTION IF EXISTS public\.broadcast_page_message\(text\);/, 'old 1-arg overload must be dropped (ambiguous call otherwise)');
  assert.match(messages, /rpc\('broadcast_page_message', args\)/);
  assert.match(messages, /args\.p_courses = \[\.\.\.broadcastCourses\]/);
  assert.match(messages, /rpc\('count_page_broadcast_recipients'/);
});

t('"Everyone" still works against the old 1-arg function (p_courses only sent when selected)', () => {
  assert.match(messages, /const args = \{ p_content: content \};\s*\n\s*if \(broadcastCourses\.size\) args\.p_courses/);
});

t('broadcast writes messages and notifications from one recipient set', () => {
  const m = migration.match(/FUNCTION public\.broadcast_page_message[\s\S]*?\$\$ LANGUAGE plpgsql SECURITY DEFINER/);
  assert.ok(m);
  assert.ok(/WITH recipients AS/.test(m[0]) && /ins_messages AS/.test(m[0]) && /ins_notifications AS/.test(m[0]));
  assert.ok(/IF v_sender_role != 'page'/.test(m[0]), 'broadcast must stay Page-only');
});

t('BROADCAST_COURSE_GROUPS matches auth.js COURSE_GROUPS exactly (stored verbatim in users.course)', () => {
  const grab = (src, varName) => {
    const m = src.match(new RegExp(`const ${varName} = \\[([\\s\\S]*?)\\n\\];`));
    assert.ok(m, `${varName} not found`);
    return [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]).filter((x) => !/^(First|Second|Third) Year/.test(x));
  };
  const a = grab(auth, 'COURSE_GROUPS');
  const b = grab(messages, 'BROADCAST_COURSE_GROUPS');
  assert.ok(a.length >= 21, 'parsed only ' + a.length + ' courses from auth.js');
  assert.deepEqual(b, a);
  assert.ok(b.includes('SY B.A.') && b.includes('FY B.A'), 'trailing-dot quirk lost');
});

t('composer UI has the audience picker hooks the JS renders into', () => {
  for (const id of ['broadcast-course-groups', 'broadcast-recipient-count', 'broadcast-audience-label', 'broadcast-send-btn']) {
    assert.ok(html.includes(`id="${id}"`), `index.html missing #${id}`);
  }
});

// ---- 3. read-only channel ------------------------------------------------
t('DB: only a Page may send via the bypass policy, and a restrictive policy blocks user -> Page', () => {
  for (const [name, sql] of [['migration', migration], ['schema.sql', schema]]) {
    const bypass = sql.match(/CREATE POLICY "messages_insert_page_bypass"[\s\S]*?\);\n/);
    assert.ok(bypass, `${name}: bypass policy missing`);
    assert.ok(!/receiver_id\) = 'page'/.test(bypass[0]), `${name}: bypass policy still lets users message a Page`);
    assert.ok(/CREATE POLICY "messages_no_user_to_page"[\s\S]*?AS RESTRICTIVE[\s\S]*?FOR INSERT/.test(sql), `${name}: restrictive policy missing`);
  }
});

t('client: channel mode hides composer, blocks reply entry points and sending', () => {
  assert.match(messages, /function isChannelForMe\(/);
  assert.match(messages, /myProfile\.role !== 'page'/);
  assert.match(messages, /applyChatMode\(\);/, 'openConversation must apply channel mode');
  assert.match(messages, /if \(isChannelForMe\(\)\) return; \/\/ channels are read-only/, 'startReplyTo not guarded');
  assert.match(messages, /if \(!isChannelForMe\(\)\) html \+= popupMenuItem\('reply'/, 'Reply menu item not hidden');
  assert.match(messages, /if \(isChannelForMe\(\)\) return; \/\/ no swipe-to-reply/, 'swipe-to-reply not disabled');
  assert.match(messages, /sendChatMessage = async function \(\) \{[\s\S]{0,200}if \(isChannelForMe\(\)\) return;/, 'sendChatMessage not guarded');
  assert.ok(html.includes('id="chat-composer-bar"') && html.includes('id="chat-channel-notice"'), 'index.html channel hooks missing');
});

// The two tests below run the REAL code out of messages.js (not a copy of it)
// against minimal stubs.
function extract(startMarker, endMarker) {
  const a = messages.indexOf(startMarker);
  const b = messages.indexOf(endMarker, a);
  assert.ok(a !== -1 && b !== -1, `could not extract ${startMarker}`);
  return messages.slice(a, b);
}

t('isChannelForMe (real code): channel for non-Pages only; a Page still gets a composer', () => {
  const src = extract('function isChannelForMe(', 'function applyChatMode(');
  const make = (myProfile) => new Function('myProfile', 'activeChat', src + '\nreturn isChannelForMe;')(myProfile, null);
  const asStudent = make({ role: 'student' });
  const asPage = make({ role: 'page' });
  assert.equal(asStudent({ isPage: true }), true);
  assert.equal(asStudent({ isPage: false }), false);
  assert.equal(asStudent(null), false);
  assert.equal(asPage({ isPage: true }), false);
});

t('broadcast composer (real code): Everyone by default, year select-all, args sent to the RPC', async () => {
  const src = extract('const BROADCAST_COURSE_GROUPS', 'window.sendChatMessage = async function');
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', value: '', disabled: false, classList: { replace() {}, toggle() {}, add() {}, remove() {} } });
  const calls = [];
  const supabase = { rpc: async (name, args) => { calls.push({ name, args }); return { data: name === 'broadcast_page_message' ? 7 : 7, error: null }; } };
  const toasts = [];
  const win = {};
  const factory = new Function('window', 'document', 'supabase', 'escapeHtml', 'showToast', 'fetchInbox',
    src + '\nreturn { state: () => [...broadcastCourses] };');
  const api = factory(win, { getElementById: el }, supabase, (x) => String(x), (m, k) => toasts.push([m, k]), () => {});

  el('broadcast-send-btn').textContent = 'Send';
  win.openBroadcastComposer(); // opening clears the textarea, so type after it
  el('broadcast-composer-input').value = 'Exam moved to Friday';
  assert.deepEqual(api.state(), [], 'opens with Everyone');
  assert.match(els['broadcast-course-groups'].innerHTML, /Everyone/);
  assert.match(els['broadcast-audience-label'].textContent, /every user/);

  // Everyone -> RPC gets p_content only (works against the old 1-arg function too)
  await win.sendBroadcast();
  const first = calls.find((c) => c.name === 'broadcast_page_message');
  assert.deepEqual(first.args, { p_content: 'Exam moved to Friday' });

  // Select all of Second Year -> 7 courses, sent as p_courses
  calls.length = 0;
  win.openBroadcastComposer();
  win.toggleBroadcastYear(1);
  assert.equal(api.state().length, 7);
  assert.ok(api.state().every((c) => c.startsWith('SY ')));
  assert.match(els['broadcast-audience-label'].textContent, /7 selected courses/);
  el('broadcast-composer-input').value = 'SY lab timing changed';
  await win.sendBroadcast();
  const second = calls.find((c) => c.name === 'broadcast_page_message');
  assert.equal(second.args.p_content, 'SY lab timing changed');
  assert.equal(second.args.p_courses.length, 7);
  assert.ok(second.args.p_courses.includes('SY B.A.'));

  // Toggle one course off, then "Everyone" clears everything
  win.toggleBroadcastCourse(1, 0);
  assert.equal(api.state().length, 6);
  win.clearBroadcastCourses();
  assert.deepEqual(api.state(), []);
});

await Promise.all(pending);
console.log(`\n${passed} passed`);
