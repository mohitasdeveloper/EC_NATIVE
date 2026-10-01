// Static contract check for anonymous comments.   node tests/anonymous-comments-contract.test.mjs
//
// There is no Postgres or browser in CI, so this proves the client and the SQL agree about the
// column name, that every surface that can show a commenter's name masks it, and that the deploy
// order is safe (a new build must not break the feed or the bell before the migration is run).
// It does NOT prove the SQL is valid Postgres — run supabase/anonymous_comments.sql once in the
// Supabase SQL editor for that.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const feed = read('www/feed.js');
const main = read('www/main.js');
const postCard = read('www/post-card.js');
const notifications = read('www/notifications.js');
const html = read('www/index.html');
const migration = read('supabase/anonymous_comments.sql');
const schema = read('supabase/schema.sql');

let passed = 0;
const pending = [];
function t(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n' + e.message); process.exitCode = 1; }
  })());
}
console.log('anonymous comments contract');

// ---- 1. database -----------------------------------------------------------
t('anonymous comments send no notification at all (migration and schema.sql): early return before every insert', () => {
  for (const [name, sql] of [['migration', migration], ['schema.sql', schema]]) {
    const m = sql.match(/FUNCTION public\.handle_post_comment_notification\(\)[\s\S]*?\$function\$([\s\S]*?)\$function\$;/);
    assert.ok(m, `${name}: handle_post_comment_notification not found`);
    const body = m[1];
    const guard = body.search(/IF COALESCE\(NEW\.is_anonymous, false\) THEN\s*RETURN NEW;\s*END IF;/);
    const firstInsert = body.indexOf('INSERT INTO public.notifications');
    assert.ok(guard >= 0, `${name}: no early return for anonymous comments`);
    assert.ok(guard < firstInsert, `${name}: the anonymous check must come before the first notification insert`);
  }
});

t('migration adds is_anonymous to post_comments and notifications, idempotently', () => {
  assert.match(migration, /ALTER TABLE public\.post_comments\s+ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false/);
  assert.match(migration, /ALTER TABLE public\.notifications\s+ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false/);
});

t('comment trigger passes the flag to all three notification kinds (migration and schema.sql)', () => {
  for (const [name, sql] of [['migration', migration], ['schema.sql', schema]]) {
    const m = sql.match(/FUNCTION public\.handle_post_comment_notification\(\)[\s\S]*?\$function\$([\s\S]*?)\$function\$;/);
    assert.ok(m, `${name}: handle_post_comment_notification not found`);
    for (const type of ['post_comment', 'comment_reply', 'comment_mention']) {
      assert.ok(new RegExp(`'${type}', NEW\\.content, NEW\\.post_id, NEW\\.is_anonymous`).test(m[1]), `${name}: ${type} notification drops is_anonymous`);
    }
    assert.equal((m[1].match(/INSERT INTO public\.notifications \(user_id, sender_id, type, message, target_id, is_anonymous\)/g) || []).length, 3, `${name}: every notification insert must name is_anonymous`);
  }
});

t('schema.sql declares the new columns on both tables', () => {
  assert.match(schema, /CREATE TABLE public\.post_comments \([\s\S]*?is_anonymous boolean NOT NULL DEFAULT false[\s\S]*?\);/);
  assert.match(schema, /CREATE TABLE public\.notifications \([\s\S]*?is_anonymous boolean NOT NULL DEFAULT false[\s\S]*?\);/);
});

// ---- 2. posting ------------------------------------------------------------
t('is_anonymous is only sent when true, so normal comments work before the migration', () => {
  assert.match(feed, /if \(commentAnonymous\) payload\.is_anonymous = true;/);
  assert.ok(!/is_anonymous:\s*commentAnonymous/.test(feed), 'sending is_anonymous:false would break comments on a DB without the column');
});

t('a missing column gives a clear toast instead of a generic failure', () => {
  assert.match(feed, /Anonymous comments need the latest database update\./);
});

t('works for any post type: nothing in the comment path gates on post_type, and there is no expiry', () => {
  const submit = feed.match(/async function submitComment[\s\S]*?\n}\n/);
  assert.ok(submit, 'submitComment not found');
  assert.ok(!/post_type/.test(submit[0]), 'submitComment must not branch on post type');
  assert.ok(!/expires_at|expiry/i.test(submit[0]), 'comments must not expire');
  assert.ok(!/expires_at|expiry/i.test(migration.replace(/--.*$/gm, '')), 'migration must not add comment expiry');
});

t('anonymous state resets when the modal opens/closes and survives a post via keepAnonymous', () => {
  assert.match(feed, /window\.openCommentsModal = async function\(postId, opts = \{\}\)/);
  assert.match(feed, /openCommentsModal\(postId, \{ keepAnonymous \}\)/);
  assert.match(feed, /currentMentionIds = \[\];\s*setCommentAnonymous\(false\);/, 'closeCommentsModal must reset the toggle');
});

t("the author of an Anonymous post is forced anonymous on that post's comments", () => {
  assert.match(feed, /data\.post_type === 'anonymous' && data\.user_id === currentUser\.id/);
  assert.match(feed, /setCommentAnonymous\(true, true\)/);
});

t('composer has the toggle wired to window.toggleCommentAnonymous', () => {
  assert.match(html, /id="comment-anon-toggle"[^>]*onclick="window\.toggleCommentAnonymous\(\)"/);
  assert.match(feed, /window\.toggleCommentAnonymous = function/);
});

// ---- 3. nothing renders the real commenter --------------------------------
t('comment list masks name, avatar, tick and profile links for anonymous comments', () => {
  const fn = feed.match(/function renderSingleComment[\s\S]*?\n}\n/);
  assert.ok(fn, 'renderSingleComment not found');
  const src = fn[0];
  assert.match(src, /const isAnon = !!comment\.is_anonymous;/);
  assert.match(src, /const displayName = isAnon \? ANONYMOUS_NAME/);
  assert.match(src, /const avatarUrl = isAnon \? ANONYMOUS_AVATAR/);
  assert.match(src, /const profileClick = isAnon \? ''/);
  assert.match(src, /const nameClick = isAnon \? ''/);
  // The raw fields may only appear inside the non-anonymous branches above, never in the markup.
  const markup = src.slice(src.indexOf('return `'));
  assert.ok(!/comment\.users\.full_name/.test(markup), 'markup renders the real name directly');
  assert.ok(!/comment\.users\.profile_img_url/.test(markup), 'markup renders the real avatar directly');
  assert.ok(!/viewUserProfile\('\$\{comment\.users\.id\}'\)/.test(markup), 'markup links to the real profile directly');
});

t('replying to an anonymous comment does not prefill an @mention of "Anonymous"', () => {
  assert.match(feed, /window\.prepareReply = function\(commentId, userName, isAnonymousTarget = false\)/);
  assert.match(feed, /input\.value = isAnonymousTarget \? '' : `@\$\{userName\} `/);
  assert.match(feed, /window\.prepareReply\('\$\{isReply \? comment\.parent_comment_id : comment\.id\}', '\$\{replyName\}', \$\{isAnon\}\)/);
});

t('the "latest comment" preview on every post card masks anonymous commenters', () => {
  assert.match(postCard, /latestComment\.is_anonymous \? ANONYMOUS_NAME/);
});

t('notification bell shows anonymous commenters as Anonymous', () => {
  assert.match(notifications, /const senderName = isAnon \? ANONYMOUS_NAME : sender\.full_name;/);
  assert.match(notifications, /const rawAvatarUrl = isAnon \? ANONYMOUS_AVATAR/);
  assert.ok(!/\$\{sender\.full_name\}<\/span>/.test(notifications), 'bell still prints sender.full_name directly');
});

// ---- 4. deploy order -------------------------------------------------------
t('feed queries use post_comments(*) so they cannot break on a DB without is_anonymous', () => {
  for (const [name, src] of [['feed.js', feed], ['main.js', main]]) {
    assert.ok(!/post_comments\s*\(\s*id, content/.test(src), `${name}: an explicit column list is back — add is_anonymous only via *`);
    assert.ok(/post_comments\(\*, users\(/.test(src), `${name}: expected post_comments(*, users(...))`);
  }
});

t('notifications query uses * so the bell loads before the migration', () => {
  assert.match(notifications, /\.select\('\*, sender:sender_id\(id, full_name, profile_img_url\)'\)/);
});

await Promise.all(pending);
console.log(`\n${passed} passed`);
