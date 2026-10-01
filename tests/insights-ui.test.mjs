// Behavioural test for www/insights.js and www/insights-track.js — no browser,
// no Supabase, no npm deps.   node tests/insights-ui.test.mjs
// Loads the REAL modules next to stub imports, feeds canned RPC responses, and
// drives every tab / detail screen / failure path. Can't check pixels or SQL.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const www = path.join(here, '..', 'www');

// ---------- fake DOM ----------
const registry = new Map();
class El {
  constructor(id = '') { this.id = id; this.innerHTML = ''; this.textContent = ''; this._c = new Set(); this.classList = {
    toggle: (c, f) => { (f ?? !this._c.has(c)) ? this._c.add(c) : this._c.delete(c); }, add: (c) => this._c.add(c), remove: (c) => this._c.delete(c), contains: (c) => this._c.has(c) }; }
  scrollTo() {}
}
globalThis.document = {
  getElementById: (id) => { if (!registry.has(id)) registry.set(id, new El(id)); return registry.get(id); },
  addEventListener: () => {},
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
globalThis.optimizeImageUrl = (u) => u;

// ---------- stubs + load real modules ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'insights-test-'));
for (const f of ['insights.js', 'insights-track.js']) fs.copyFileSync(path.join(www, f), path.join(tmp, f));
fs.writeFileSync(path.join(tmp, 'ui.js'), `export function showToast(m,t){ (globalThis.__toasts ||= []).push([m,t]); }`);
fs.writeFileSync(path.join(tmp, 'supabase.js'), `export const supabase = { rpc: async (n,p) => globalThis.__rpc(n,p||{}) };`);

const calls = [];
let failWith = null;
const overview = {
  days: 30, from: '2026-08-30T00:00:00Z',
  current: { accounts_reached: 120, post_reach: 90, story_reach: 60, profile_reach: 20, impressions: 400, post_impressions: 300, story_impressions: 100,
    profile_visits: 25, interactions: 80, likes: 40, comments: 15, saves: 10, shares: 5, story_likes: 6, story_replies: 4, new_audience: 7 },
  previous: { accounts_reached: 100, post_reach: 0, story_reach: 0, profile_reach: 0, impressions: 500, profile_visits: 0, interactions: 0, new_audience: 7 },
  series: Array.from({ length: 30 }, (_, i) => ({ d: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, reach: i, impressions: i * 2, interactions: 1 })),
  reach_split: { connections: 70, others: 50 }, content_counts: { posts: 5, stories: 3 },
  top_posts: [{ post_id: 'p1', post_type: 'text', content: '<img src=x onerror=alert(1)>', media_url: null, created_at: '2026-09-20T10:00:00Z', expires_at: '2026-09-21T10:00:00Z',
    is_archived: false, is_anonymous: false, reach: 50, impressions: 70, likes: 9, comments: 2, saves: 1, shares: 0, link_clicks: 0, profile_visits: 3 }],
  top_stories: [{ story_id: 's1', media_url: 'http://x/a.jpg', media_type: 'image', created_at: '2026-09-20T10:00:00Z', reach: 30, impressions: 33, likes: 4, replies: 1, profile_visits: 1, forward: 0, back: 0, next_account: 0, exits: 0 }],
};
const fixtures = {
  insights_account_overview: overview,
  insights_content_list: [overview.top_posts[0]],
  insights_audience: { kind: 'connections', total: 12, gained: 3, gained_previous: 1, growth: Array.from({ length: 30 }, (_, i) => ({ d: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, new: i % 3 })),
    gender: [{ label: 'Female', count: 6 }, { label: 'Male', count: 4 }, { label: 'Other', count: 2 }], course: [{ label: 'BAF', count: 8 }],
    demographics_hidden: false, activity: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d === 2 && h === 19 ? 9 : 1))), activity_days: 30 },
  insights_post_detail: { ...overview.top_posts[0], reach_split: { connections: 30, others: 20 }, sources: { feed: 40, profile: 10, weird: 2 },
    timeline: Array.from({ length: 48 }, (_, h) => ({ h, impressions: h < 5 ? 10 : 0, interactions: 0 })), extra: {} },
  insights_story_detail: { ...overview.top_stories[0], reach_split: { connections: 20, others: 10 }, forward: 12, back: 3, next_account: 4, exits: 2,
    timeline: Array.from({ length: 24 }, (_, h) => ({ h, views: h })) },
};
globalThis.__rpc = async (name, params) => {
  calls.push([name, params]);
  if (failWith) return { data: null, error: failWith };
  return { data: structuredClone(fixtures[name] ?? null), error: null };
};

const ins = await import(pathToFileURL(path.join(tmp, 'insights.js')).href);
const track = await import(pathToFileURL(path.join(tmp, 'insights-track.js')).href);

const body = () => document.getElementById('insights-body').innerHTML;
const strip = () => document.getElementById('insights-tab-strip').innerHTML;
const title = () => document.getElementById('insights-title').textContent;
const flush = () => new Promise((r) => setTimeout(r, 0));
const last = (n) => [...calls].reverse().find((c) => c[0] === n);
let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

console.log('insights.js');
await ins.initInsights({ id: 'me', role: 'student' });

await t('opening shows the overview with real numbers, the right tabs, and the tz offset is sent', async () => {
  ins.showInsights(null); await flush();
  for (const l of ['Overview', 'Content', 'Audience']) assert.ok(strip().includes(l), l);
  assert.match(body(), /Accounts reached/); assert.match(body(), />120</);
  assert.match(body(), /Who you reached/); assert.match(body(), /Top posts/); assert.match(body(), /Top stories/);
  const c = last('insights_account_overview')[1];
  assert.equal(c.p_days, 30); assert.equal(typeof c.p_tz, 'number');
  assert.equal(title(), 'Insights');
});

await t('percentage change vs previous period renders (up arrow, and "New" when previous was zero)', async () => {
  assert.match(body(), /arrow_upward/);           // reach 100 -> 120 = +20%
  assert.match(body(), />20%</);
  assert.match(body(), />New</);                  // profile visits 0 -> 25
  assert.match(body(), /arrow_downward/);         // impressions 500 -> 400
});

await t('user-controlled text is HTML-escaped (post content with markup)', async () => {
  assert.ok(!body().includes('<img src=x'), 'raw markup leaked into the DOM');
  assert.match(body(), /&lt;img src=x/);
});

await t('range chips refetch with the chosen window', async () => {
  window.__insightsSetDays(7); await flush();
  assert.equal(last('insights_account_overview')[1].p_days, 7);
  window.__insightsSetDays(30); await flush();
});

await t('empty account shows an empty state, not a wall of zeros', async () => {
  const saved = fixtures.insights_account_overview;
  fixtures.insights_account_overview = { days: 30, current: {}, previous: {}, series: [], reach_split: {}, content_counts: { posts: 0, stories: 0 }, top_posts: [], top_stories: [] };
  window.__insightsRefresh(); await flush();
  assert.match(body(), /Nothing to show yet/);
  fixtures.insights_account_overview = saved;
});

await t('content tab: posts list, sort + kind switch send the right params', async () => {
  window.__insightsSetTab('content'); await flush();
  assert.deepEqual(last('insights_content_list')[1], { p_kind: 'posts', p_days: 30, p_sort: 'reach', p_limit: 100, p_offset: 0 });
  window.__insightsSetSort('likes'); await flush();
  assert.equal(last('insights_content_list')[1].p_sort, 'likes');
  window.__insightsSetKind('stories'); await flush();
  assert.equal(last('insights_content_list')[1].p_kind, 'stories');
  assert.equal(last('insights_content_list')[1].p_sort, 'reach', 'sort resets when switching kind (stories have no "comments" sort)');
  window.__insightsSetKind('posts'); await flush();
  window.__insightsSetDays(0); await flush();      // "All time" is only offered here
  assert.equal(last('insights_content_list')[1].p_days, 0);
  window.__insightsSetDays(30); await flush();
});

await t('post detail: opens from a row, shows interactions/sources, back returns to the list', async () => {
  window.__insightsOpenDetail('post', 'p1'); await flush();
  assert.deepEqual(last('insights_post_detail')[1], { p_post_id: 'p1' });
  assert.equal(title(), 'Post insights');
  assert.ok(strip().length === 0 || document.getElementById('insights-tab-strip').classList.contains('hidden'), 'tab strip hidden in detail');
  assert.match(body(), /Interaction rate/); assert.match(body(), /Home feed/); assert.match(body(), /Profiles/);
  assert.match(body(), />Other</, 'unknown source keys fall back to "Other" instead of undefined');
  assert.ok(!body().includes('undefined') && !body().includes('NaN'));
  assert.equal(window.__insightsHandleBack(), true, 'back from detail is consumed');
  await flush(); assert.equal(title(), 'Insights');
  assert.equal(window.__insightsHandleBack(), false, 'back from a list falls through to closing the panel');
});

await t('story detail shows navigation metrics', async () => {
  window.__insightsOpenDetail('story', 's1'); await flush();
  assert.deepEqual(last('insights_story_detail')[1], { p_story_id: 's1' });
  assert.equal(title(), 'Story insights');
  for (const l of ['Forward taps', 'Back taps', 'Next account', 'Exited']) assert.match(body(), new RegExp(l));
  window.__insightsHandleBack(); await flush();
});

await t('deep link from a post menu opens detail directly, and back lands on the Content tab', async () => {
  ins.showInsights({ kind: 'post', id: 'p1' }); await flush();
  assert.equal(title(), 'Post insights');
  window.__insightsHandleBack(); await flush();
  assert.match(strip(), /bg-primary text-white[^>]*>Content/);
});

await t('audience tab: growth, demographics, weekday chips re-render without refetching', async () => {
  window.__insightsSetTab('audience'); await flush();
  assert.match(body(), /Total connections/); assert.match(body(), /Gender/); assert.match(body(), /Top courses/); assert.match(body(), /Most active times/);
  assert.match(body(), /Busiest day: <b[^>]*>Tues/); assert.match(body(), /7 PM/);
  const n = calls.length;
  window.__insightsSetActivityDay(2);
  assert.equal(calls.length, n, 'weekday chip must not hit the network');
  assert.match(document.getElementById('insights-body').innerHTML, /Peak hour: <b[^>]*>7 PM/);
});

await t('audience privacy: small audiences show a notice instead of demographics', async () => {
  const saved = fixtures.insights_audience;
  fixtures.insights_audience = { ...saved, total: 3, demographics_hidden: true, gender: [], course: [] };
  window.__insightsRefresh(); await flush();
  assert.match(body(), /5 or more/); assert.ok(!body().includes('Top courses'));
  fixtures.insights_audience = saved;
});

await t('pages see "followers" wording', async () => {
  await ins.initInsights({ id: 'pg', role: 'page' });
  fixtures.insights_audience = { ...fixtures.insights_audience, kind: 'followers' };
  ins.showInsights(null); window.__insightsSetTab('audience'); await flush();
  assert.match(body(), /Total followers/);
  await ins.initInsights({ id: 'me', role: 'student' });
});

await t('a failing request shows an error card with retry (missing SQL gets a specific hint)', async () => {
  ins.showInsights(null); await flush();
  failWith = { code: 'PGRST202', message: 'Could not find the function public.insights_account_overview' };
  window.__insightsRefresh(); await flush();
  assert.match(body(), /Something went wrong/); assert.match(body(), /insights\.sql/); assert.match(body(), /Try again/);
  failWith = new Error('network down');
  window.__insightsRefresh(); await flush();
  assert.match(body(), /Check your connection/);
  failWith = null;
  window.__insightsRefresh(); await flush();
  assert.match(body(), /Accounts reached/, 'recovers after a retry');
});

await t('a slow response for a screen the user already left does not overwrite the current one', async () => {
  let release; const gate = new Promise((r) => (release = r));
  const orig = globalThis.__rpc;
  globalThis.__rpc = async (n, p) => { if (n === 'insights_audience') await gate; return orig(n, p); };
  window.__insightsRefresh();
  window.__insightsSetTab('audience');           // slow
  window.__insightsSetTab('overview');           // fast, the one the user ended on
  await flush(); release(); await flush(); await flush();
  assert.match(body(), /Accounts reached/); assert.ok(!body().includes('Total connections'));
  globalThis.__rpc = orig;
});

console.log('insights-track.js');
const events = [];
globalThis.__rpc = async (name, params) => { calls.push([name, params]); if (name === 'record_insight_events') { events.push(...params.p_events); return { data: params.p_events.length, error: null }; } return { data: null, error: null }; };
global.IntersectionObserver = undefined; // skip the DOM observer part; it needs a real browser

await t('events are ignored before init, then batched and sent on flush', async () => {
  track.trackEvent('post_share', 'p9', { source: 'chat' });
  await track.flush();
  assert.equal(events.length, 0, 'nothing may be queued before init');
  track.initInsightsTracking({ id: 'me' });
  track.trackEvent('post_share', 'p9', { source: 'chat' });
  track.trackEvent('story_exit', 's9', { source: 'story' });
  await track.flush();
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { type: 'post_share', subject_id: 'p9', source: 'chat', from_id: null });
});

await t('profile visits: skipped for yourself, deduped, and credited to the post that led there', async () => {
  events.length = 0;
  track.trackProfileVisit('me');                       // yourself
  track.markProfileSource('post', 'p7');
  track.trackProfileVisit('u2');
  track.trackProfileVisit('u2');                       // dedupe
  await track.flush();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'profile_visit', subject_id: 'u2', source: 'post', from_id: 'p7' });
});

await t('a network failure re-queues the batch instead of dropping it', async () => {
  events.length = 0;
  globalThis.__rpc = async () => ({ data: null, error: { code: '', message: 'Failed to fetch' } });
  track.trackEvent('post_share', 'p1', {});
  await track.flush();
  globalThis.__rpc = async (n, p) => { events.push(...p.p_events); return { data: 1, error: null }; };
  await track.flush();
  assert.equal(events.length, 1, 'the event survived the failed attempt');
});

await t('if the SQL was never run, tracking switches itself off quietly (no retry storm)', async () => {
  let n = 0;
  globalThis.__rpc = async () => { n++; return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.record_insight_events' } }; };
  track.trackEvent('post_share', 'p2', {});
  await track.flush();
  track.trackEvent('post_share', 'p3', {});
  await track.flush();
  assert.equal(n, 1, 'must stop calling after the first "function missing"');
});

console.log(`\n${passed} passed`);
