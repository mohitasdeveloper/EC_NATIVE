// Static contract check for (a) Page post notifications — delivered exactly once —
// and (b) the removal of the Hotposts and Messages features.
//   node tests/page-fanout-contract.test.mjs
//
// There is no Postgres in CI, so this proves the client, the SQL and the edge
// function agree, and that nothing still points at the removed features. It does
// NOT prove the SQL is valid Postgres — run it once in the Supabase SQL editor
// for that.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(root, f));

const feed = read('www/feed.js');
const html = read('www/index.html');
const main = read('www/main.js');
const sw = read('www/sw.js');
const migration = read('supabase/migration_page_v14_channel_course_dedupe.sql');
const schema = read('supabase/schema.sql');
const cleanup = read('supabase/cleanup_hotposts_messages.sql');
const edge = read('supabase/functions/send-push-notification/index.ts');

const REMOVED_TYPES = ['hotpost_like', 'hotpost_reply', 'page_new_hotpost', 'new_message', 'page_message'];
const wwwJs = fs.readdirSync(path.join(root, 'www')).filter((f) => f.endsWith('.js'));

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + e.message); process.exitCode = 1; }
}
console.log('page fan-out + removed features contract');

// ---- 1. Page post notifications: once per follower ------------------------
t('client never fans out Page notifications itself (the trigger does)', () => {
  assert.ok(!/rpc\(\s*['"]notify_page_followers['"]/.test(feed), 'feed.js calls notify_page_followers — followers would be notified twice');
});

t('fan-out is idempotent: unique index + ON CONFLICT in migration, schema.sql and the cleanup script', () => {
  for (const [name, sql] of [['migration', migration], ['schema.sql', schema], ['cleanup', cleanup]]) {
    assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_page_fanout[\s\S]*?WHERE type = 'page_new_post'/.test(sql), `${name}: missing unique index on page_new_post only`);
    assert.ok(/ON CONFLICT \(user_id, sender_id, type, target_id\)[\s\S]*?WHERE type = 'page_new_post'[\s\S]*?DO NOTHING/.test(sql), `${name}: trigger lacks ON CONFLICT ... DO NOTHING`);
    // the cleanup script legitimately names it (DELETE + final check); the others must not
    if (name !== 'cleanup') assert.ok(!/page_new_hotpost/.test(sql.replace(/--[^\n]*/g, '')), `${name}: still handles page_new_hotpost`);
  }
});

t('the 4-arg notify_page_followers overload is a no-op', () => {
  for (const [name, sql] of [['migration', migration], ['schema.sql', schema]]) {
    const m = sql.match(/FUNCTION public\.notify_page_followers\(p_page_id uuid[\s\S]*?\$function\$([\s\S]*?)\$function\$;/);
    assert.ok(m, `${name}: overload not found`);
    assert.ok(!/INSERT\s+INTO/i.test(m[1]), `${name}: overload still inserts notifications`);
  }
});

// ---- 2. Hotposts / Messages are gone from the app -------------------------
t('the Hotposts and Messages modules are deleted and not precached', () => {
  assert.ok(!exists('www/hotposts.js') && !exists('www/messages.js'));
  assert.ok(!/hotposts\.js|messages\.js/.test(sw), 'sw.js still precaches a removed module');
  assert.ok(!/hotposts\.js|messages\.js/.test(main), 'main.js still imports a removed module');
});

t('no www script references the removed features', () => {
  const bad = /hotpost|openConversation|fetchInbox|openNewMessage|conversation_settings|message_reactions|broadcast_page_message|count_page_broadcast_recipients|refreshMessages/i;
  for (const f of wwwJs) {
    const src = read('www/' + f).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    // notifications.js and utils.js intentionally name the removed types / the dropped IndexedDB store
    if (f === 'notifications.js' || f === 'utils.js') continue;
    assert.ok(!bad.test(src), `www/${f} still references a removed feature`);
  }
});

t('index.html has no Messages tab, chat modals, Hotpost tray or broadcast composer', () => {
  for (const id of ['nav-messages', 'view-messages', 'modal-chat-conversation', 'modal-new-message', 'modal-archived-chats',
    'modal-hotpost-camera', 'modal-view-hotpost', 'modal-story-details', 'push-toggle-messages', 'notification-muted-chats-list']) {
    assert.ok(!html.includes(`id="${id}"`), `index.html still has #${id}`);
  }
  assert.ok(!/hotpost/i.test(html), 'index.html still mentions hotposts');
  assert.equal((html.match(/id="nav-(dashboard|search|profile)"/g) || []).length, 3, 'bottom nav should have exactly 3 tabs');
});

t('the bell never renders a removed notification type', () => {
  const n = read('www/notifications.js');
  for (const type of REMOVED_TYPES) assert.ok(n.includes(`'${type}'`), `notifications.js does not filter ${type}`);
  assert.ok(!/hotpost_like'\s*:|page_new_hotpost'\s*:/.test(n), 'a removed type still has an icon/colour entry');
});

// ---- 3. Database + edge function ------------------------------------------
t('schema.sql no longer defines the removed tables, policies or functions', () => {
  assert.ok(!/CREATE TABLE public\.(hotposts?|hotpost_\w+|messages|message_reactions|conversation_settings)\b/.test(schema));
  assert.ok(!/ON public\.messages|broadcast_page_message|count_page_broadcast_recipients|trg_hotpost|enforce_unsend_window|dm_is_blocked|dm_is_connected/.test(schema));
});

t('cleanup script drops every removed table and function, deletes the notification rows, and ends with a zero-rows check', () => {
  for (const tbl of ['messages', 'message_reactions', 'conversation_settings', 'hotposts', 'hotpost_views', 'hotpost_likes', 'hotpost_replies']) {
    assert.ok(new RegExp(`DROP TABLE IF EXISTS public\\.${tbl}\\s+CASCADE`).test(cleanup), `cleanup does not drop ${tbl}`);
  }
  for (const fn of ['trg_hotpost_like()', 'trg_hotpost_reply()', 'enforce_unsend_window()', 'broadcast_page_message(text, text[])',
    'broadcast_page_message(text)', 'count_page_broadcast_recipients(text[])', 'dm_is_blocked(uuid, uuid)', 'dm_is_connected(uuid, uuid)',
    'dm_current_user_id()', '_insights_story_rows(uuid, timestamptz, timestamptz)', 'insights_story_detail(uuid)', 'admin_story_viewers(uuid, integer, integer)']) {
    assert.ok(cleanup.includes(`drop_fn_safe('public.${fn}')`), `cleanup does not drop ${fn}`);
  }
  for (const type of REMOVED_TYPES) assert.ok(cleanup.includes(`'${type}'`), `cleanup does not delete ${type} notifications`);
  assert.ok(/story\\_%/.test(cleanup) && /insight_events_event_type_check/.test(cleanup), 'cleanup does not tighten the insight_events CHECK');
  // children before parents, so no FK blocks a drop even without CASCADE
  const order = ['message_reactions', 'conversation_settings', 'messages', 'hotpost_views', 'hotpost_likes', 'hotpost_replies', 'hotposts']
    .map((n) => cleanup.search(new RegExp(`DROP TABLE IF EXISTS public\\.${n}\\s`)));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'tables must be dropped children-first');
  assert.ok(/BEGIN;[\s\S]*COMMIT;[\s\S]*FINAL CHECK[\s\S]*SELECT/.test(cleanup), 'cleanup must be one transaction followed by the final check query');
});

t('edge function: removed types are skipped, never mapped to a title/body/category, and conversation_settings is not queried', () => {
  const sansGuard = edge.replace(/const REMOVED_TYPES = \[[^\]]*\];/, '');
  assert.ok(/REMOVED_TYPES\.includes\(type\)/.test(edge), 'no early return for removed types');
  for (const type of REMOVED_TYPES) {
    assert.ok(edge.includes(`'${type}'`), `edge function does not list ${type} in its skip guard`);
    assert.ok(!sansGuard.includes(`'${type}'`), `edge function still maps ${type} outside the skip guard`);
  }
  assert.ok(!/conversation_settings|hotpost|'messages'/.test(sansGuard.replace(/\/\/[^\n]*/g, '')), 'edge function still references a removed feature');
  for (const type of ['post_like', 'post_comment', 'comment_like', 'comment_reply', 'post_mention', 'comment_mention',
    'connection_request', 'connection_accepted', 'new_follower', 'page_new_post']) {
    assert.ok(edge.includes(`'${type}'`), `edge function lost the ${type} notification`);
  }
});

console.log(`\n${passed} passed`);
