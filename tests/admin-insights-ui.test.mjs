// Behavioural test for the "Activity & Insights" additions to www/admin.js
// (supabase/admin_insights.sql's client side). No browser, no Supabase.
//   node tests/admin-insights-ui.test.mjs
//
// Harness mirrors tests/admin-panel.test.mjs exactly (same fake DOM, same
// "call window.__admin* directly, inspect rendered HTML" approach) since this
// exercises the same module. Drives the multi-level drill-down this feature
// added (user -> activity hub -> profile visitors / content -> per-item
// viewers, and -> full feed), which tests/admin-panel.test.mjs's single-level
// `detail` didn't need to cover.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wwwDir = path.join(here, '..', 'www');

// ---------- fake DOM (same shape as admin-panel.test.mjs) ----------
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const registry = new Map();
class El {
  constructor(id = '') {
    this.id = id; this._html = ''; this.value = ''; this.style = {}; this.parentNode = null;
    this.listeners = {}; this._classes = new Set(); this._text = '';
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      contains: (c) => self._classes.has(c),
      toggle: (c, f) => { (f ?? !self._classes.has(c)) ? self._classes.add(c) : self._classes.delete(c); },
      replace: (a, b) => { if (!self._classes.has(a)) return false; self._classes.delete(a); self._classes.add(b); return true; },
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ''); this._html = esc(this._text); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  async click() { for (const fn of this.listeners.click || []) await fn(); }
  cloneNode() { const c = new El(this.id); c.className = this.className; c._text = this._text; c._html = this._html; c.parentNode = this.parentNode; return c; }
}
const document = {
  createElement: () => new El(),
  getElementById(id) {
    if (!registry.has(id)) {
      const el = new El(id);
      el.parentNode = { replaceChild: (n, o) => registry.set(o.id, n) };
      registry.set(id, el);
    }
    return registry.get(id);
  },
};
globalThis.document = document;
globalThis.window = globalThis;
globalThis.window.optimizeImageUrl = (u) => u;

// ---------- stub imports + load the real module ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-insights-test-'));
fs.copyFileSync(path.join(wwwDir, 'admin.js'), path.join(tmp, 'admin.js'));
fs.writeFileSync(path.join(tmp, 'ui.js'), `export function showToast(m,t){ (globalThis.__toasts ||= []).push([m,t]); }`);
fs.writeFileSync(path.join(tmp, 'utils.js'), `export function timeAgo(){ return '1h ago'; }`);
fs.writeFileSync(path.join(tmp, 'supabase.js'), `export const supabase = { rpc: async (n,p) => globalThis.__rpc(n, p||{}) };`);

const calls = [];
let failNext = null; // { name, message }
const SAM = { id: 'u5', full_name: 'Sam', email: 'sam@x.com', student_id: '2', course: 'Y', college: 'C', role: 'student', tick_type: 'none', is_admin: false, is_volunteer: false, special_post: false, is_private: false, is_deactivated: true, is_suspended: false, is_deleted: false, verification_status: 'unverified', connection_count: 0, profile_img_url: '' };
const RIYA = { id: 'u6', full_name: 'Riya <script>', email: 'riya@x.com', student_id: '3', course: 'Z', college: 'C', role: 'student', tick_type: 'none', is_admin: false, is_volunteer: false, special_post: false, is_private: false, is_deactivated: false, is_suspended: false, is_deleted: false, verification_status: 'verified', connection_count: 2, profile_img_url: '' };

const fixtures = {
  admin_get_dashboard_stats: { pending_verifications: 0, pending_reports: 0, open_tickets: 0, reported_posts: 0, total_users: 2, suspended_users: 0 },
  admin_search_users: [SAM],
  admin_get_user: [RIYA],
  admin_user_activity_summary: {
    posts: 4, stories: 2, comments_made: 9, likes_given: 15, saves_made: 3, messages_sent: 22, connections: 6,
    joined_at: '2026-01-10T10:00:00Z', last_active_at: '2026-09-28T10:00:00Z', insights_ready: true,
    profile_visits_made: 30, profile_visits_received: 12, story_watches_given: 40,
  },
  admin_profile_visitors: [
    { visitor_id: 'u6', full_name: 'Riya <script>', profile_img_url: '', role: 'student', visit_count: 3, first_visited_at: '2026-09-01T00:00:00Z', last_visited_at: '2026-09-28T00:00:00Z', last_source: 'post' },
    { visitor_id: 'u7', full_name: 'Alex', profile_img_url: '', role: 'student', visit_count: 1, first_visited_at: '2026-09-20T00:00:00Z', last_visited_at: '2026-09-20T00:00:00Z', last_source: 'feed' },
  ],
  admin_content_rows: [
    { post_id: 'p1', story_id: 'p1', post_type: 'image', content: 'hello <b>world</b>', media_url: null, created_at: '2026-09-20T10:00:00Z', expires_at: null, is_archived: false, is_anonymous: false, reach: 12, media_type: 'image' },
  ],
  admin_post_viewers: [
    { viewer_id: 'u6', full_name: 'Riya <script>', profile_img_url: '', role: 'student', impression_count: 3, first_seen_at: '2026-09-20T10:00:00Z', last_seen_at: '2026-09-21T10:00:00Z', liked: true, commented: false, saved: false, shared: false },
    { viewer_id: 'u7', full_name: 'Alex', profile_img_url: '', role: 'student', impression_count: 1, first_seen_at: '2026-09-20T10:00:00Z', last_seen_at: '2026-09-20T10:00:00Z', liked: false, commented: true, saved: false, shared: false },
  ],
  admin_story_viewers: [
    { viewer_id: 'u6', full_name: 'Riya <script>', profile_img_url: '', role: 'student', view_count: 4, first_viewed_at: '2026-09-20T10:00:00Z', last_viewed_at: '2026-09-22T10:00:00Z', liked: true, replied: true },
    { viewer_id: 'u7', full_name: 'Alex', profile_img_url: '', role: 'student', view_count: 1, first_viewed_at: '2026-09-20T10:00:00Z', last_viewed_at: '2026-09-20T10:00:00Z', liked: false, replied: false },
  ],
};

function feedPage(n, offset) {
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(2026, 8, 28 - offset - i, 10).toISOString(),
    kind: i % 2 === 0 ? 'post_created' : 'message_sent',
    other_id: i % 2 === 0 ? null : 'u6',
    other_name: i % 2 === 0 ? null : 'Riya <script>',
    other_avatar: null,
    target_id: i % 2 === 0 ? 'p' + i : null,
    preview: i % 2 === 0 ? 'a post about <script>' : null,
    // 'content' here simulates a hypothetical future SQL bug leaking a message
    // body into meta — the UI must never render this key under any label.
    meta: i % 2 === 0 ? {} : { content: 'THIS IS THE SECRET DM BODY' },
  }));
}

globalThis.__rpc = async (name, params) => {
  calls.push([name, params]);
  if (failNext?.name === name) { const m = failNext.message; failNext = null; return { data: null, error: new Error(m) }; }
  if (name === 'admin_user_activity_feed') {
    const offset = params.p_before ? 40 : 0;
    return { data: feedPage(offset === 0 ? 40 : 5, offset), error: null };
  }
  return { data: name in fixtures ? structuredClone(fixtures[name]) : null, error: null };
};

const admin = await import(pathToFileURL(path.join(tmp, 'admin.js')).href);

// ---------- helpers ----------
const flush = () => new Promise((r) => setTimeout(r, 0));
const body = () => document.getElementById('admin-panel-body').innerHTML;
// This fake DOM (deliberately, matching tests/admin-panel.test.mjs) doesn't
// build a real tree from an innerHTML string, so a sub-element that admin.js
// updates independently (via its OWN getElementById + innerHTML, for a list
// that loads after the surrounding view renders) needs its own accessor —
// body() only reflects whatever was assigned to #admin-panel-body directly.
const contentRows = () => document.getElementById('admin-content-rows').innerHTML;
const feedList = () => document.getElementById('admin-feed-list').innerHTML;
const feedMore = () => document.getElementById('admin-feed-more').innerHTML;
const lastCall = (name) => [...calls].reverse().find((c) => c[0] === name);
const callCount = (name) => calls.filter((c) => c[0] === name).length;
let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

console.log('admin.js — Activity & Insights');
await admin.initAdmin({ id: 'admin-1', full_name: 'Boss' });

await t('user detail shows the Activity & Insights entry point', async () => {
  await window.__adminSwitchTab('users');
  await flush();
  window.__adminOpenDetail('user', 0); // SAM, from admin_search_users fixture
  await flush();
  assert.match(body(), /Activity &amp; Insights|Activity & Insights/);
  assert.match(body(), /Sam/);
});

await t('activity hub shows summary stats and the three nav buttons', async () => {
  window.__adminPushDetail('user_activity');
  await flush();
  assert.deepEqual(lastCall('admin_user_activity_summary')[1], { p_user_id: 'u5' });
  for (const n of [4, 2, 9, 15, 3, 6]) assert.match(body(), new RegExp(`>${n}<`));
  assert.match(body(), /Who visited this profile/);
  assert.match(body(), /Posts &amp; stories, with viewers|Posts & stories, with viewers/);
  assert.match(body(), /Full activity timeline/);
  assert.match(body(), />30<[\s\S]*?Profiles visited|Profiles visited/);
});

await t('hub omits the insights-dependent tiles and shows a setup hint when insights_ready is false', async () => {
  const saved = fixtures.admin_user_activity_summary;
  fixtures.admin_user_activity_summary = { ...saved, insights_ready: false };
  window.__adminPushDetail('user_activity'); // re-push (defaults to same item) to force a refetch
  await flush();
  assert.match(body(), /Run supabase\/insights\.sql/);
  assert.ok(!body().includes('Profiles visited'));
  fixtures.admin_user_activity_summary = saved;
  window.__adminBackToList(); await flush(); // pop the extra re-push frame back to the hub
});

await t('profile visitors: identity-level list with visit counts, HTML-escaped', async () => {
  window.__adminPushDetail('profile_visitors');
  await flush();
  assert.deepEqual(lastCall('admin_profile_visitors')[1], { p_user_id: 'u5', p_limit: 100 });
  assert.ok(!body().includes('<script>alert') && !body().includes('Riya <script>'), 'raw markup in a visitor name leaked into the DOM');
  assert.match(body(), /Riya &lt;script&gt;/);
  assert.match(body(), />3 visits</); // visit_count for Riya
  assert.match(body(), /Alex/);
});

await t('back from profile visitors returns to the hub, not all the way to the Users list', async () => {
  window.__adminBackToList();
  await flush();
  assert.match(body(), /Who visited this profile/, 'expected the hub, landed somewhere else');
});

await t('content list -> post viewers: shows per-viewer rewatch-style counts and interaction badges', async () => {
  window.__adminOpenUserContent('posts');
  await flush();
  assert.deepEqual(lastCall('admin_content_rows')[1], { p_user_id: 'u5', p_kind: 'posts', p_days: 0 });
  assert.match(contentRows(), /hello &lt;b&gt;world&lt;\/b&gt;/, 'post content must be escaped');
  assert.ok(!contentRows().includes('<b>world</b>'));

  window.__adminOpenContentViewer(0);
  await flush();
  assert.deepEqual(lastCall('admin_post_viewers')[1], { p_post_id: 'p1', p_limit: 200 });
  assert.match(body(), /Viewed 3×/, 'expected a rewatch-style ×N count for the post viewer');
  assert.match(body(), /Alex/);
  assert.ok(!body().includes('Riya <script>'));
});

await t('back twice returns to the hub (multi-level pop works)', async () => {
  window.__adminBackToList(); await flush(); // -> content list
  assert.match(body(), /Content · Sam/, 'expected the content list');
  window.__adminBackToList(); await flush(); // -> hub
  assert.match(body(), /Who visited this profile/, 'expected the hub');
});

await t('story viewers: rewatch is explicitly called out', async () => {
  window.__adminOpenUserContent('stories');
  await flush();
  assert.equal(lastCall('admin_content_rows')[1].p_kind, 'stories');
  window.__adminOpenContentViewer(0);
  await flush();
  assert.deepEqual(lastCall('admin_story_viewers')[1], { p_story_id: 'p1', p_limit: 300 });
  assert.match(body(), /rewatched this story/);
  assert.match(body(), /Watched 4× \(rewatched\)/);
  assert.match(body(), /Watched once/); // Alex, view_count 1
});

await t('clicking a viewer opens THEIR admin user detail via admin_get_user', async () => {
  await window.__adminOpenUserById('u6');
  await flush();
  assert.deepEqual(lastCall('admin_get_user')[1], { p_user_id: 'u6' });
  assert.match(body(), /Riya &lt;script&gt;/);
  assert.match(body(), /Activity &amp; Insights|Activity & Insights/, 'landed on a real user-detail view, not a dead end');
});

await t('full activity feed: renders kinds, escapes previews, paginates, and never leaks a message body', async () => {
  await window.__adminSwitchTab('users');
  await flush();
  window.__adminOpenDetail('user', 0); // back to Sam
  window.__adminPushDetail('user_activity');
  await flush();
  window.__adminPushDetail('user_feed');
  await flush();

  assert.deepEqual(lastCall('admin_user_activity_feed')[1], { p_user_id: 'u5', p_before: null, p_limit: 40, p_include_views: false });
  assert.match(feedList(), /a post about &lt;script&gt;/);
  assert.match(feedList(), /Messaged/);
  assert.match(feedList(), /Riya &lt;script&gt;/);
  assert.ok(!feedList().includes('THIS IS THE SECRET DM BODY'), 'a message body must never render, even if the RPC accidentally included one');
  assert.match(feedMore(), /Load more/, 'first page is exactly p_limit rows, so more should be offered');

  await window.__adminLoadMoreFeed();
  await flush();
  assert.equal(callCount('admin_user_activity_feed'), 2);
  assert.equal(lastCall('admin_user_activity_feed')[1].p_before !== null, true, 'second page must page by the oldest timestamp loaded so far');
  assert.match(feedMore(), /That's everything\./, 'second page is short, so pagination should stop');
});

await t('"include every view" toggle resets pagination and requests view events', async () => {
  const before = callCount('admin_user_activity_feed');
  await window.__adminToggleFeedViews(true);
  await flush();
  assert.equal(callCount('admin_user_activity_feed'), before + 1);
  assert.equal(lastCall('admin_user_activity_feed')[1].p_include_views, true);
  assert.equal(lastCall('admin_user_activity_feed')[1].p_before, null, 'toggling must restart from the top, not append to the old page');
});

await t('a missing insights.sql shows the setup notice instead of a generic error', async () => {
  // Deliberately fresh navigation rather than trusting leftover state from
  // earlier tests — __adminOpenDetail always resets the stack, so this is a
  // known-good starting point regardless of what ran before.
  window.__adminOpenDetail('user', 0);       // stack=[], detail=user (Sam)
  window.__adminPushDetail('user_activity'); // stack=[user], detail=hub
  await flush();
  failNext = { name: 'admin_profile_visitors', message: 'Insights is not set up yet (run supabase/insights.sql first)' };
  window.__adminPushDetail('profile_visitors'); // stack=[user, hub]
  await flush();
  assert.match(body(), /Not set up yet/);
  assert.match(body(), /insights\.sql/);
});

await t('hardware back unwinds every level before falling through to "close the whole panel"', async () => {
  window.__adminOpenDetail('user', 0);       // stack=[], detail=user (Sam) — fresh, not dependent on the previous test
  window.__adminPushDetail('user_activity'); // stack=[user], detail=hub
  await flush();
  assert.equal(window.__adminHandleBack(), true); await flush(); // hub -> user
  assert.match(body(), /Sam/);
  assert.equal(window.__adminHandleBack(), true); await flush(); // user -> Users list
  assert.equal(window.__adminHandleBack(), false, 'nothing left to unwind — caller should close the panel');
});

console.log(`\n${passed} passed`);
