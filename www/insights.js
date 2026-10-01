// ============================================================
// INSIGHTS — Instagram-style analytics for your own posts, stories & audience
// ============================================================
// Dynamically imported from main.js (window.openInsights) the same way
// admin.js is, so it costs nothing until someone opens it.
//
// Talks to Postgres only through the insights_* RPCs in supabase/insights.sql.
// Those derive "who is asking" from auth.uid() and only ever return the
// caller's OWN content, so nothing in this file carries an access-control
// assumption.
//
// Renders into the #settings-insights-panel shell in index.html. Charts are
// hand-built inline SVG (no chart library: the app is bundled/offline and Tailwind
// is precompiled, so every class below is a literal string on purpose).
//
// Screens:   Overview | Content | Audience   (+ Post detail, Story detail)
// Deep link: window.openInsights({ kind: 'post' | 'story', id })
// ============================================================

import { supabase } from './supabase.js';
import { showToast } from './ui.js';

const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'content', label: 'Content' },
    { id: 'audience', label: 'Audience' },
];
const RANGES = [7, 14, 30, 90];
const POST_SORTS = [
    ['reach', 'Reach'], ['impressions', 'Impressions'], ['likes', 'Likes'], ['comments', 'Comments'],
    ['saves', 'Saves'], ['shares', 'Shares'], ['recent', 'Newest'],
];
const STORY_SORTS = [['reach', 'Reach'], ['impressions', 'Impressions'], ['likes', 'Likes'], ['replies', 'Replies'], ['recent', 'Newest']];
const SOURCE_LABELS = {
    feed: 'Home feed', profile: 'Profiles', detail: 'Direct link / notification',
    library: 'Saved & liked lists', other: 'Other',
};
const TYPE_ICONS = { text: 'notes', image: 'image', event: 'event', poll: 'poll', anonymous: 'visibility_off' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let me = null;
let tab = 'overview';
let days = 30;
let contentKind = 'posts';
let contentSort = 'reach';
let activityDay = 'all';
let detail = null;          // { kind: 'post' | 'story', id } while drilled in
let token = 0;              // discards a slow response if the user has already moved on
const cache = new Map();    // short-lived, so flipping between tabs doesn't refetch
let lastAudience = null;    // kept so the weekday chips can re-render without a refetch
const CACHE_MS = 45 * 1000;

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function esc(t) {
    return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmt(v) {
    const n = num(v);
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'K';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(n));
}
function tzOffsetMinutes() { return -new Date().getTimezoneOffset(); }
function shortDay(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y) return '';
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function fullDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function optThumb(url) {
    return (typeof window.optimizeImageUrl === 'function') ? window.optimizeImageUrl(url, 'avatar') : url;
}
function audienceWord() { return me?.role === 'page' ? 'followers' : 'connections'; }
function rangeLabel(n) { return n === 0 ? 'All time' : `Last ${n} days`; }

async function rpc(name, params) {
    const { data, error } = await supabase.rpc(name, params);
    if (error) throw error;
    return data;
}
async function cachedRpc(name, params) {
    const key = name + JSON.stringify(params);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_MS) return hit.data;
    const data = await rpc(name, params);
    cache.set(key, { t: Date.now(), data });
    return data;
}

// ------------------------------------------------------------
// Presentational pieces (all return HTML strings)
// ------------------------------------------------------------
function skeleton() {
    const block = (h) => `<div class="w-full ${h} rounded-2xl shimmer-bg"></div>`;
    return `<div class="space-y-4">${block('h-9')}${block('h-40')}${block('h-24')}<div class="grid grid-cols-2 gap-3">${block('h-20')}${block('h-20')}${block('h-20')}${block('h-20')}</div></div>`;
}

function errorCard(err) {
    const msg = String(err?.message || err || '');
    const missing = err?.code === 'PGRST202' || err?.code === '42883' || /could not find the function/i.test(msg);
    const text = missing
        ? "Insights isn't set up on the server yet. (An admin needs to run supabase/insights.sql once.)"
        : "Couldn't load insights. Check your connection and try again.";
    return `
    <div class="flex flex-col items-center text-center py-14 px-6">
        <span class="material-symbols-outlined text-[44px] text-on-surface-variant dark:text-gray-500 mb-3">cloud_off</span>
        <p class="text-[14px] font-semibold text-on-surface dark:text-gray-100 mb-1">Something went wrong</p>
        <p class="text-[13px] text-on-surface-variant dark:text-gray-400 mb-5">${esc(text)}</p>
        <button onclick="window.__insightsRefresh()" class="px-5 py-2.5 rounded-xl bg-primary text-white text-[13px] font-bold active:scale-95 transition-transform">Try again</button>
    </div>`;
}

function chips(options, activeValue, handler, { pill = true } = {}) {
    return `<div class="flex gap-2 overflow-x-auto hide-scrollbar ${pill ? '' : 'flex-wrap'}">` + options.map(([value, label]) => {
        const on = String(value) === String(activeValue);
        return `<button onclick="${handler}(${typeof value === 'number' ? value : `'${value}'`})" class="shrink-0 px-3.5 py-1.5 rounded-full text-[12.5px] font-bold active:scale-95 transition-transform ${on ? 'bg-primary text-white' : 'bg-surface-variant/40 dark:bg-neutral-800 text-on-surface dark:text-gray-200'}">${esc(label)}</button>`;
    }).join('') + `</div>`;
}
function rangeChips(includeAll = false) {
    const opts = RANGES.map((n) => [n, `${n} days`]);
    if (includeAll) opts.push([0, 'All time']);
    return chips(opts, days, 'window.__insightsSetDays');
}

function delta(cur, prev) {
    cur = num(cur); prev = num(prev);
    if (cur === 0 && prev === 0) return '';
    if (prev === 0) return `<span class="inline-flex items-center gap-0.5 text-[11.5px] font-bold text-green-600"><span class="material-symbols-outlined text-[14px]">arrow_upward</span>New</span>`;
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (pct === 0) return `<span class="text-[11.5px] font-bold text-on-surface-variant dark:text-gray-400">No change</span>`;
    const up = pct > 0;
    return `<span class="inline-flex items-center gap-0.5 text-[11.5px] font-bold ${up ? 'text-green-600' : 'text-error'}"><span class="material-symbols-outlined text-[14px]">${up ? 'arrow_upward' : 'arrow_downward'}</span>${Math.abs(pct)}%</span>`;
}

function statCard(label, value, deltaHtml = '', icon = '') {
    return `
    <div class="bg-surface-variant/15 dark:bg-neutral-900/50 border border-surface-variant/30 dark:border-neutral-800 rounded-2xl p-3.5">
        <div class="flex items-center gap-1.5 text-on-surface-variant dark:text-gray-400 mb-1">
            ${icon ? `<span class="material-symbols-outlined text-[16px]">${icon}</span>` : ''}
            <span class="text-[12px] font-semibold">${esc(label)}</span>
        </div>
        <div class="flex items-end justify-between gap-2">
            <span class="text-[24px] leading-none font-extrabold tracking-tight text-on-surface dark:text-gray-100">${fmt(value)}</span>
            ${deltaHtml}
        </div>
    </div>`;
}

function section(title, inner, sub = '') {
    return `
    <section class="mb-6">
        <div class="mb-2.5 px-0.5">
            <h3 class="text-[15px] font-extrabold tracking-tight text-on-surface dark:text-gray-100">${esc(title)}</h3>
            ${sub ? `<p class="text-[12px] text-on-surface-variant dark:text-gray-400 mt-0.5">${esc(sub)}</p>` : ''}
        </div>
        ${inner}
    </section>`;
}

function hbarRow(label, value, max, { icon = '', suffix = '' } = {}) {
    const pct = max > 0 ? Math.max(value > 0 ? 3 : 0, Math.round((value / max) * 100)) : 0;
    return `
    <div class="py-1.5">
        <div class="flex items-center justify-between mb-1">
            <span class="flex items-center gap-1.5 text-[13px] font-semibold text-on-surface dark:text-gray-200">${icon ? `<span class="material-symbols-outlined text-[16px] text-on-surface-variant dark:text-gray-400">${icon}</span>` : ''}${esc(label)}</span>
            <span class="text-[13px] font-bold text-on-surface dark:text-gray-100">${fmt(value)}${suffix}</span>
        </div>
        <div class="h-2 rounded-full bg-surface-variant/40 dark:bg-neutral-800 overflow-hidden"><div class="h-full rounded-full bg-primary" style="width:${pct}%"></div></div>
    </div>`;
}

function card(inner, extra = '') {
    return `<div class="bg-surface-variant/10 dark:bg-neutral-900/40 border border-surface-variant/30 dark:border-neutral-800 rounded-2xl p-4 ${extra}">${inner}</div>`;
}

// ---- SVG charts ----
function axisLabels(labels, W, H) {
    return `<g class="text-on-surface-variant" fill="currentColor" opacity="0.7" font-size="9" font-weight="600">` +
        labels.map(({ x, text, anchor }) => `<text x="${x.toFixed(1)}" y="${H - 3}" text-anchor="${anchor || 'middle'}">${esc(text)}</text>`).join('') + `</g>`;
}

function barChart(values, { labels = [], height = 104 } = {}) {
    const n = values.length;
    if (!n) return '';
    const W = 320, H = height, pad = 4, base = H - 16;
    const max = Math.max(1, ...values);
    const bw = (W - pad * 2) / n;
    const gap = Math.min(3, bw * 0.25);
    const bars = values.map((v, i) => {
        const h = v > 0 ? Math.max(2, (v / max) * (base - 8)) : 0;
        return `<rect x="${(pad + i * bw + gap / 2).toFixed(1)}" y="${(base - h).toFixed(1)}" width="${Math.max(1, bw - gap).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="currentColor" opacity="0.9"/>`;
    }).join('');
    const lab = labels.map(({ i, text }) => {
        const x = pad + i * bw + bw / 2;
        return { x, text, anchor: i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' };
    });
    lab.forEach((l) => { if (l.anchor === 'start') l.x = pad; if (l.anchor === 'end') l.x = W - pad; });
    return `<svg viewBox="0 0 ${W} ${H}" class="w-full text-primary" role="img" aria-label="Bar chart">
        <line x1="${pad}" x2="${W - pad}" y1="${base}" y2="${base}" stroke="currentColor" opacity="0.15"/>
        ${bars}${axisLabels(lab, W, H)}</svg>`;
}

function lineChart(values, { labels = [], height = 120 } = {}) {
    const n = values.length;
    if (!n) return '';
    const W = 320, H = height, pad = 6, base = H - 18, top = 10;
    const max = Math.max(1, ...values);
    const step = n > 1 ? (W - pad * 2) / (n - 1) : 0;
    const pts = values.map((v, i) => [pad + i * step, base - (v / max) * (base - top)]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${line} L${pts[n - 1][0].toFixed(1)},${base} L${pts[0][0].toFixed(1)},${base} Z`;
    const last = pts[n - 1];
    const lab = labels.map(({ i, text }) => ({
        x: i === 0 ? pad : i === n - 1 ? W - pad : pad + i * step,
        text, anchor: i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
    }));
    return `<svg viewBox="0 0 ${W} ${H}" class="w-full text-primary" role="img" aria-label="Line chart">
        <line x1="${pad}" x2="${W - pad}" y1="${base}" y2="${base}" stroke="currentColor" opacity="0.15"/>
        <path d="${area}" fill="currentColor" opacity="0.12"/>
        <path d="${line}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.2" fill="currentColor"/>
        ${axisLabels(lab, W, H)}</svg>`;
}

function daySeriesLabels(series) {
    const n = series.length;
    if (!n) return [];
    const idx = n <= 2 ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1];
    return [...new Set(idx)].map((i) => ({ i, text: shortDay(series[i].d) }));
}

function donut(a, b, labelA, labelB) {
    const total = num(a) + num(b);
    const pctA = total > 0 ? (num(a) / total) * 100 : 0;
    const pctB = total > 0 ? 100 - pctA : 0;
    return `
    <div class="flex items-center gap-5">
        <div class="relative w-[92px] h-[92px] shrink-0">
            <svg viewBox="0 0 36 36" class="w-full h-full -rotate-90 text-primary" role="img" aria-label="Split">
                <circle cx="18" cy="18" r="15.9155" fill="none" stroke="currentColor" stroke-width="4" opacity="0.18"/>
                <circle cx="18" cy="18" r="15.9155" fill="none" stroke="currentColor" stroke-width="4" stroke-dasharray="${pctA.toFixed(2)} ${(100 - pctA).toFixed(2)}" stroke-linecap="butt"/>
            </svg>
            <div class="absolute inset-0 flex flex-col items-center justify-center">
                <span class="text-[17px] font-extrabold text-on-surface dark:text-gray-100 leading-none">${fmt(total)}</span>
                <span class="text-[9.5px] font-semibold text-on-surface-variant dark:text-gray-400 mt-0.5">accounts</span>
            </div>
        </div>
        <div class="flex-1 space-y-2.5">
            <div class="flex items-center justify-between"><span class="flex items-center gap-2 text-[13px] font-semibold text-on-surface dark:text-gray-200"><span class="w-2.5 h-2.5 rounded-full bg-primary"></span>${esc(labelA)}</span><span class="text-[13px] font-bold text-on-surface dark:text-gray-100">${Math.round(pctA)}%</span></div>
            <div class="flex items-center justify-between"><span class="flex items-center gap-2 text-[13px] font-semibold text-on-surface dark:text-gray-200"><span class="w-2.5 h-2.5 rounded-full bg-primary/25"></span>${esc(labelB)}</span><span class="text-[13px] font-bold text-on-surface dark:text-gray-100">${Math.round(pctB)}%</span></div>
        </div>
    </div>`;
}

function thumb(item, kind, size = 'w-14 h-14') {
    const box = `${size} rounded-xl bg-surface-variant/40 dark:bg-neutral-800 overflow-hidden shrink-0 flex items-center justify-center`;
    if (kind === 'story') {
        if (item.media_type === 'video') {
            return `<div class="${box}"><video src="${esc(item.media_url)}#t=0.1" preload="metadata" muted playsinline class="w-full h-full object-cover"></video></div>`;
        }
        return `<div class="${box}"><img src="${esc(optThumb(item.media_url))}" loading="lazy" class="w-full h-full object-cover" alt=""></div>`;
    }
    if (item.media_url && !item.is_anonymous) {
        return `<div class="${box}"><img src="${esc(optThumb(item.media_url))}" loading="lazy" class="w-full h-full object-cover" alt=""></div>`;
    }
    const icon = item.is_anonymous ? TYPE_ICONS.anonymous : (TYPE_ICONS[item.post_type] || 'notes');
    return `<div class="${box}"><span class="material-symbols-outlined text-[24px] text-on-surface-variant dark:text-gray-400">${icon}</span></div>`;
}

function postTitle(p) {
    if (p.is_anonymous) return 'Anonymous post';
    const t = String(p.content || '').trim();
    if (t) return t.length > 70 ? t.slice(0, 70) + '…' : t;
    return { image: 'Photo post', poll: 'Poll', event: 'Event', text: 'Post' }[p.post_type] || 'Post';
}

function statusBadges(p) {
    const out = [];
    if (p.is_archived) out.push('Archived');
    else if (p.expires_at && new Date(p.expires_at) < new Date()) out.push('Expired');
    return out.map((b) => `<span class="px-1.5 py-0.5 rounded-md bg-surface-variant/50 dark:bg-neutral-800 text-[10px] font-bold text-on-surface-variant dark:text-gray-400">${b}</span>`).join('');
}

function miniMetric(icon, value) {
    return `<span class="inline-flex items-center gap-0.5 text-[12px] font-semibold text-on-surface-variant dark:text-gray-400"><span class="material-symbols-outlined text-[14px]">${icon}</span>${fmt(value)}</span>`;
}

function contentRow(item, kind, sortKey) {
    const isStory = kind === 'story';
    const id = isStory ? item.story_id : item.post_id;
    const primaryKey = ['reach', 'impressions', 'likes', 'comments', 'saves', 'shares', 'replies'].includes(sortKey) ? sortKey : 'reach';
    const primaryLabel = { reach: 'Reach', impressions: 'Impressions', likes: 'Likes', comments: 'Comments', saves: 'Saves', shares: 'Shares', replies: 'Replies' }[primaryKey];
    const title = isStory ? 'Story' : postTitle(item);
    const metrics = isStory
        ? miniMetric('favorite', item.likes) + miniMetric('reply', item.replies) + miniMetric('visibility', item.impressions)
        : miniMetric('favorite', item.likes) + miniMetric('chat_bubble', item.comments) + miniMetric('bookmark', item.saves);
    return `
    <button onclick="window.__insightsOpenDetail('${kind}', '${esc(id)}')" class="w-full flex items-center gap-3 p-2.5 -mx-2.5 rounded-2xl text-left active:scale-[0.98] transition-transform hover:bg-surface-variant/20 dark:hover:bg-neutral-800/40">
        ${thumb(item, kind)}
        <div class="flex-1 min-w-0">
            <p class="text-[13.5px] font-bold text-on-surface dark:text-gray-100 truncate">${esc(title)}</p>
            <div class="flex items-center gap-1.5 mt-0.5"><span class="text-[11.5px] text-on-surface-variant dark:text-gray-400">${esc(fullDate(item.created_at))}</span>${isStory ? '' : statusBadges(item)}</div>
            <div class="flex items-center gap-3 mt-1.5">${metrics}</div>
        </div>
        <div class="text-right shrink-0">
            <p class="text-[20px] leading-none font-extrabold text-on-surface dark:text-gray-100">${fmt(item[primaryKey])}</p>
            <p class="text-[10.5px] font-semibold text-on-surface-variant dark:text-gray-400 mt-1">${primaryLabel}</p>
        </div>
    </button>`;
}

function emptyState(icon, title, body) {
    return `
    <div class="flex flex-col items-center text-center py-12 px-6">
        <span class="material-symbols-outlined text-[46px] text-on-surface-variant/60 dark:text-gray-600 mb-3">${icon}</span>
        <p class="text-[14.5px] font-bold text-on-surface dark:text-gray-100 mb-1">${esc(title)}</p>
        <p class="text-[13px] text-on-surface-variant dark:text-gray-400 max-w-[280px]">${esc(body)}</p>
    </div>`;
}

const LAUNCH_NOTE = `<p class="text-[11.5px] leading-relaxed text-on-surface-variant dark:text-gray-500 text-center px-4 mt-2 mb-6">Post views, profile visits and story navigation are counted from the day Insights launched. Numbers count people, never who — you can't see who viewed your posts.</p>`;

// ------------------------------------------------------------
// Screens
// ------------------------------------------------------------
function renderOverview(d) {
    const c = d.current || {}, p = d.previous || {};
    const series = d.series || [];
    const counts = d.content_counts || {};
    const split = d.reach_split || { connections: 0, others: 0 };
    const nothing = num(c.accounts_reached) === 0 && num(c.interactions) === 0 && num(counts.posts) + num(counts.stories) === 0;
    const newLabel = me?.role === 'page' ? 'New followers' : 'New connections';

    let html = `<div class="mb-4">${rangeChips()}</div>`;

    if (nothing && num(p.accounts_reached) === 0) {
        html += emptyState('insights', 'Nothing to show yet',
            'Share a post or story and come back — you\'ll see who\'s reaching it, how people react, and when they\'re around.');
        return html + LAUNCH_NOTE;
    }

    html += card(`
        <div class="flex items-start justify-between mb-1">
            <div>
                <p class="text-[12.5px] font-semibold text-on-surface-variant dark:text-gray-400">Accounts reached</p>
                <p class="text-[34px] leading-tight font-extrabold tracking-tight text-on-surface dark:text-gray-100">${fmt(c.accounts_reached)}</p>
            </div>
            <div class="text-right pt-1">${delta(c.accounts_reached, p.accounts_reached)}<p class="text-[10.5px] text-on-surface-variant dark:text-gray-500 mt-0.5">vs previous ${d.days} days</p></div>
        </div>
        ${lineChart(series.map((s) => num(s.reach)), { labels: daySeriesLabels(series) })}
    `, 'mb-6');

    html += section('Who you reached',
        card(donut(split.connections, split.others, audienceWord() === 'followers' ? 'Followers' : 'Connections', 'Others')),
        'Accounts that saw your posts, stories or profile');

    const maxReach = Math.max(num(c.post_reach), num(c.story_reach), num(c.profile_reach), 1);
    html += section('Reach by content',
        card(hbarRow('Posts', c.post_reach, maxReach, { icon: 'grid_view' }) + hbarRow('Stories', c.story_reach, maxReach, { icon: 'motion_photos_on' }) + hbarRow('Profile', c.profile_reach, maxReach, { icon: 'person' })));

    html += section('At a glance', `<div class="grid grid-cols-2 gap-3">
        ${statCard('Impressions', c.impressions, delta(c.impressions, p.impressions), 'visibility')}
        ${statCard('Profile visits', c.profile_visits, delta(c.profile_visits, p.profile_visits), 'person_search')}
        ${statCard('Interactions', c.interactions, delta(c.interactions, p.interactions), 'touch_app')}
        ${statCard(newLabel, c.new_audience, delta(c.new_audience, p.new_audience), 'person_add')}
    </div>`, rangeLabel(d.days));

    const inter = [['Likes', c.likes, 'favorite'], ['Comments', c.comments, 'chat_bubble'], ['Saves', c.saves, 'bookmark'],
        ['Shares', c.shares, 'send'], ['Story likes', c.story_likes, 'favorite'], ['Story replies', c.story_replies, 'reply']];
    const maxInter = Math.max(1, ...inter.map((r) => num(r[1])));
    html += section('Interactions', card(inter.map(([l, v, i]) => hbarRow(l, v, maxInter, { icon: i })).join('')),
        `${fmt(c.interactions)} total from other people`);

    html += section('Content you shared',
        `<div class="grid grid-cols-2 gap-3">${statCard('Posts', counts.posts, '', 'grid_view')}${statCard('Stories', counts.stories, '', 'motion_photos_on')}</div>`);

    if ((d.top_posts || []).length) {
        html += section('Top posts', card((d.top_posts).map((r) => contentRow(r, 'post', 'reach')).join('<div class="h-px bg-surface-variant/30 dark:bg-neutral-800 my-0.5"></div>')),
            `Posted in the last ${d.days} days, by reach`);
    }
    if ((d.top_stories || []).length) {
        html += section('Top stories', card((d.top_stories).map((r) => contentRow(r, 'story', 'reach')).join('<div class="h-px bg-surface-variant/30 dark:bg-neutral-800 my-0.5"></div>')),
            `Posted in the last ${d.days} days, by reach`);
    }
    return html + LAUNCH_NOTE;
}

function renderContent(list) {
    const isStories = contentKind === 'stories';
    const sorts = isStories ? STORY_SORTS : POST_SORTS;
    let html = `
    <div class="flex p-1 rounded-xl bg-surface-variant/30 dark:bg-neutral-800 mb-3">
        ${[['posts', 'Posts'], ['stories', 'Stories']].map(([k, l]) => `<button onclick="window.__insightsSetKind('${k}')" class="flex-1 py-2 rounded-lg text-[13px] font-bold transition-colors ${contentKind === k ? 'bg-surface dark:bg-[#121212] text-on-surface dark:text-gray-100 shadow-sm' : 'text-on-surface-variant dark:text-gray-400'}">${l}</button>`).join('')}
    </div>
    <div class="mb-3">${rangeChips(true)}</div>
    <div class="flex items-center gap-2 mb-3"><span class="text-[12px] font-semibold text-on-surface-variant dark:text-gray-400 shrink-0">Sort by</span>${chips(sorts, contentSort, 'window.__insightsSetSort')}</div>`;

    if (!list.length) {
        html += emptyState(isStories ? 'motion_photos_on' : 'grid_view', `No ${isStories ? 'stories' : 'posts'} in this period`,
            `Try a longer range, or share something new.`);
        return html;
    }
    html += `<div class="space-y-1">${list.map((it) => contentRow(it, isStories ? 'story' : 'post', contentSort)).join('')}</div>`;
    if (list.length >= 100) html += `<p class="text-[11.5px] text-center text-on-surface-variant dark:text-gray-500 mt-4">Showing your top 100.</p>`;
    return html + LAUNCH_NOTE;
}

function renderAudience(d) {
    const word = d.kind === 'followers' ? 'followers' : 'connections';
    const total = num(d.total);
    let html = `<div class="mb-4">${rangeChips()}</div>`;

    html += card(`
        <div class="flex items-start justify-between mb-1">
            <div>
                <p class="text-[12.5px] font-semibold text-on-surface-variant dark:text-gray-400">Total ${word}</p>
                <p class="text-[34px] leading-tight font-extrabold tracking-tight text-on-surface dark:text-gray-100">${fmt(total)}</p>
            </div>
            <div class="text-right pt-1">
                <p class="text-[13px] font-bold text-on-surface dark:text-gray-100">+${fmt(d.gained)} <span class="font-semibold text-on-surface-variant dark:text-gray-400">new</span></p>
                <div class="mt-0.5">${delta(d.gained, d.gained_previous)}</div>
            </div>
        </div>
        ${barChart((d.growth || []).map((g) => num(g.new)), { labels: daySeriesLabels((d.growth || []).map((g) => ({ d: g.d }))) })}
        <p class="text-[11px] text-on-surface-variant dark:text-gray-500 mt-1">New ${word} per day · ${rangeLabel(days).toLowerCase()}. People who leave aren't tracked.</p>
    `, 'mb-6');

    // Demographics (server hides them for tiny audiences and folds small buckets into "Other")
    if (d.demographics_hidden) {
        html += section('Who they are', card(`<p class="text-[13px] text-on-surface-variant dark:text-gray-400 text-center py-2">Demographics show up once you have 5 or more ${word}. Small groups are always hidden to protect privacy.</p>`));
    } else {
        const list = (rows) => {
            const max = Math.max(1, ...rows.map((r) => num(r.count)));
            return rows.map((r) => hbarRow(r.label, num(r.count), max, { suffix: ` · ${total ? Math.round((num(r.count) / total) * 100) : 0}%` })).join('');
        };
        if ((d.gender || []).length) html += section('Gender', card(list(d.gender)));
        if ((d.course || []).length) html += section('Top courses', card(list(d.course)), `Groups under 3 people are combined into "Other"`);
    }

    html += section('Most active times', card(activityBlock(d.activity || [])),
        `When people looked at your content · last ${d.activity_days || 30} days`);
    return html + LAUNCH_NOTE;
}

function activityBlock(grid) {
    if (!grid.length) return `<p class="text-[13px] text-center text-on-surface-variant dark:text-gray-400 py-2">No activity recorded yet.</p>`;
    const dayTotals = grid.map((row) => row.reduce((a, b) => a + num(b), 0));
    const all = dayTotals.reduce((a, b) => a + b, 0);
    if (all === 0) return `<p class="text-[13px] text-center text-on-surface-variant dark:text-gray-400 py-2">Not enough activity yet. This fills in as people view your posts and stories.</p>`;

    const hours = activityDay === 'all'
        ? Array.from({ length: 24 }, (_, h) => grid.reduce((a, row) => a + num(row[h]), 0))
        : (grid[activityDay] || []).map(num);
    const peakHour = hours.indexOf(Math.max(...hours));
    const hourText = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
    const maxDay = Math.max(...dayTotals);
    const peakDay = dayTotals.indexOf(maxDay);

    const dayChips = `<div class="flex justify-between gap-1 mb-3">` +
        [['all', 'All']].concat(WEEKDAYS.map((w, i) => [i, w[0]])).map(([k, label]) => {
            const on = String(activityDay) === String(k);
            const isPeak = k !== 'all' && k === peakDay && maxDay > 0;
            return `<button onclick="window.__insightsSetActivityDay(${typeof k === 'number' ? k : `'${k}'`})" aria-label="${k === 'all' ? 'All days' : WEEKDAYS[k]}" class="flex-1 py-1.5 rounded-lg text-[12px] font-bold transition-colors ${on ? 'bg-primary text-white' : 'bg-surface-variant/40 dark:bg-neutral-800 text-on-surface dark:text-gray-200'} ${isPeak && !on ? 'ring-1 ring-primary/50' : ''}">${label}</button>`;
        }).join('') + `</div>`;

    const dayName = activityDay === 'all' ? `${WEEKDAYS[peakDay]}s` : WEEKDAYS[activityDay];
    const summary = hours.every((v) => v === 0)
        ? `<p class="text-[12.5px] text-on-surface-variant dark:text-gray-400 mb-2">No activity on ${esc(dayName)} yet.</p>`
        : `<p class="text-[12.5px] text-on-surface-variant dark:text-gray-400 mb-2">${activityDay === 'all' ? `Busiest day: <b class="text-on-surface dark:text-gray-100">${esc(dayName)}</b> · ` : ''}Peak hour: <b class="text-on-surface dark:text-gray-100">${hourText(peakHour)}</b></p>`;

    return dayChips + summary + barChart(hours, { labels: [{ i: 0, text: '12 AM' }, { i: 6, text: '6 AM' }, { i: 12, text: '12 PM' }, { i: 18, text: '6 PM' }, { i: 23, text: '11 PM' }], height: 96 });
}

function previewHeader(item, kind) {
    const isStory = kind === 'story';
    const title = isStory ? 'Story' : postTitle(item);
    return `
    <div class="flex items-center gap-3 mb-5">
        ${thumb(item, kind, 'w-16 h-16')}
        <div class="min-w-0">
            <p class="text-[15px] font-extrabold text-on-surface dark:text-gray-100 truncate">${esc(title)}</p>
            <div class="flex items-center gap-1.5 mt-1 flex-wrap"><span class="text-[12px] text-on-surface-variant dark:text-gray-400">Posted ${esc(fullDate(item.created_at))}</span>${isStory ? '' : statusBadges(item)}</div>
        </div>
    </div>`;
}

function renderPostDetail(d) {
    const interactions = num(d.likes) + num(d.comments) + num(d.saves) + num(d.shares);
    const rate = num(d.reach) > 0 ? Math.round((interactions / num(d.reach)) * 1000) / 10 : 0;
    const split = d.reach_split || { connections: 0, others: 0 };
    const sources = Object.entries(d.sources || {}).map(([k, v]) => [SOURCE_LABELS[k] || SOURCE_LABELS.other, num(v)]).sort((a, b) => b[1] - a[1]);
    const maxSrc = Math.max(1, ...sources.map((s) => s[1]));
    const timeline = d.timeline || [];
    const extra = d.extra || {};
    const noViews = num(d.reach) === 0 && interactions === 0;

    let html = previewHeader(d, 'post');
    if (noViews) {
        html += card(`<p class="text-[13px] text-on-surface-variant dark:text-gray-400 text-center">No views recorded yet. Views appear here once people scroll past this post.</p>`, 'mb-6');
    }

    html += section('Overview', `<div class="grid grid-cols-2 gap-3">${statCard('Reach', d.reach, '', 'groups')}${statCard('Impressions', d.impressions, '', 'visibility')}</div>`,
        'Reach = accounts that saw it · Impressions = total views');

    html += section('Interactions', card(`
        <div class="flex items-baseline justify-between mb-2"><span class="text-[13px] font-semibold text-on-surface-variant dark:text-gray-400">Total</span><span class="text-[24px] font-extrabold text-on-surface dark:text-gray-100">${fmt(interactions)}</span></div>
        ${[['Likes', d.likes, 'favorite'], ['Comments', d.comments, 'chat_bubble'], ['Saves', d.saves, 'bookmark'], ['Shares', d.shares, 'send']]
            .map(([l, v, i]) => hbarRow(l, num(v), Math.max(1, interactions), { icon: i })).join('')}
        <p class="text-[12px] text-on-surface-variant dark:text-gray-400 mt-2">Interaction rate: <b class="text-on-surface dark:text-gray-100">${rate}%</b> of accounts reached</p>
    `));

    const activity = [];
    activity.push(statCard('Profile visits', d.profile_visits, '', 'person_search'));
    if (num(d.link_clicks) > 0 || d.post_type === 'event') activity.push(statCard('Link taps', d.link_clicks, '', 'link'));
    if (d.post_type === 'poll') activity.push(statCard('Poll votes', extra.poll_votes, '', 'poll'));
    if (d.post_type === 'event') {
        activity.push(statCard('Going', extra.rsvp_attending, '', 'event_available'));
        activity.push(statCard('Maybe', extra.rsvp_maybe, '', 'event_upcoming'));
    }
    html += section('Activity from this post', `<div class="grid grid-cols-2 gap-3">${activity.join('')}</div>`);

    if (num(d.reach) > 0) {
        html += section('Who saw it', card(donut(split.connections, split.others, audienceWord() === 'followers' ? 'Followers' : 'Connections', 'Others')));
        if (sources.length) html += section('Impressions from', card(sources.map(([l, v]) => hbarRow(l, v, maxSrc)).join('')));
        html += section('Views over time', card(
            barChart(timeline.map((t) => num(t.impressions)), { labels: [{ i: 0, text: 'Posted' }, { i: 24, text: '24h' }, { i: 47, text: '48h' }] })),
            'First 48 hours after posting');
    }
    return html + LAUNCH_NOTE;
}

function renderStoryDetail(d) {
    const split = d.reach_split || { connections: 0, others: 0 };
    const timeline = d.timeline || [];
    const nav = [['Forward taps', d.forward, 'arrow_forward'], ['Back taps', d.back, 'arrow_back'], ['Next account', d.next_account, 'skip_next'], ['Exited', d.exits, 'logout']];
    const maxNav = Math.max(1, ...nav.map((n) => num(n[1])));
    const noViews = num(d.reach) === 0 && num(d.likes) + num(d.replies) === 0;

    let html = previewHeader(d, 'story');
    if (noViews) html += card(`<p class="text-[13px] text-on-surface-variant dark:text-gray-400 text-center">No views yet.</p>`, 'mb-6');

    html += section('Overview', `<div class="grid grid-cols-2 gap-3">${statCard('Reach', d.reach, '', 'groups')}${statCard('Impressions', d.impressions, '', 'visibility')}</div>`,
        'Reach = accounts that watched it · Impressions = total plays');
    html += section('Interactions', `<div class="grid grid-cols-2 gap-3">${statCard('Likes', d.likes, '', 'favorite')}${statCard('Replies', d.replies, '', 'reply')}${statCard('Profile visits', d.profile_visits, '', 'person_search')}</div>`);
    html += section('Navigation', card(nav.map(([l, v, i]) => hbarRow(l, num(v), maxNav, { icon: i })).join('')),
        'How people moved through this story');
    if (num(d.reach) > 0) {
        html += section('Who watched', card(donut(split.connections, split.others, audienceWord() === 'followers' ? 'Followers' : 'Connections', 'Others')));
        html += section('Views over time', card(barChart(timeline.map((t) => num(t.views)), { labels: [{ i: 0, text: 'Posted' }, { i: 12, text: '12h' }, { i: 23, text: '24h' }] })),
            'First 24 hours');
    }
    return html + LAUNCH_NOTE;
}

// ------------------------------------------------------------
// Rendering pipeline
// ------------------------------------------------------------
function paintChrome() {
    const strip = $('insights-tab-strip');
    const title = $('insights-title');
    if (strip) {
        strip.classList.toggle('hidden', !!detail);
        strip.innerHTML = TABS.map((t) => `<button onclick="window.__insightsSetTab('${t.id}')" class="shrink-0 px-4 py-2 rounded-full text-[13px] font-bold whitespace-nowrap transition-colors ${tab === t.id ? 'bg-primary text-white' : 'bg-surface-variant/40 dark:bg-neutral-800 text-on-surface dark:text-gray-200'}">${t.label}</button>`).join('');
    }
    if (title) title.textContent = detail ? (detail.kind === 'story' ? 'Story insights' : 'Post insights') : 'Insights';
}

async function renderActive() {
    const body = $('insights-body');
    if (!body) return;
    const my = ++token;
    paintChrome();
    body.innerHTML = skeleton();
    try {
        let html;
        if (detail) {
            const data = detail.kind === 'story'
                ? await cachedRpc('insights_story_detail', { p_story_id: detail.id })
                : await cachedRpc('insights_post_detail', { p_post_id: detail.id });
            if (my !== token) return;
            html = detail.kind === 'story' ? renderStoryDetail(data || {}) : renderPostDetail(data || {});
        } else if (tab === 'content') {
            const data = await cachedRpc('insights_content_list', { p_kind: contentKind, p_days: days, p_sort: contentSort, p_limit: 100, p_offset: 0 });
            if (my !== token) return;
            html = renderContent(Array.isArray(data) ? data : []);
        } else if (tab === 'audience') {
            const data = await cachedRpc('insights_audience', { p_days: days || 30, p_tz: tzOffsetMinutes() });
            if (my !== token) return;
            lastAudience = data;
            html = renderAudience(data || {});
        } else {
            const data = await cachedRpc('insights_account_overview', { p_days: days || 30, p_tz: tzOffsetMinutes() });
            if (my !== token) return;
            html = renderOverview(data || {});
        }
        body.innerHTML = html;
        if (typeof body.scrollTo === 'function') body.scrollTo({ top: 0 });
    } catch (err) {
        if (my !== token) return;
        console.error('Insights load failed', err);
        body.innerHTML = errorCard(err);
    }
}

// ------------------------------------------------------------
// Public API + window handlers (inline onclick targets)
// ------------------------------------------------------------
export async function initInsights(profile) {
    me = profile;
    tab = 'overview';
    detail = null;

    window.__insightsSetTab = (t) => { if (!TABS.some((x) => x.id === t)) return; tab = t; detail = null; if (days === 0 && t !== 'content') days = 30; renderActive(); };
    window.__insightsSetDays = (n) => { days = n; renderActive(); };
    window.__insightsSetKind = (k) => { contentKind = k === 'stories' ? 'stories' : 'posts'; contentSort = 'reach'; renderActive(); };
    window.__insightsSetSort = (s) => { contentSort = s; renderActive(); };
    window.__insightsSetActivityDay = (d) => {
        activityDay = d;
        const body = $('insights-body');
        if (body && lastAudience) body.innerHTML = renderAudience(lastAudience); // no refetch needed
    };
    window.__insightsOpenDetail = (kind, id) => { detail = { kind: kind === 'story' ? 'story' : 'post', id }; renderActive(); };
    window.__insightsRefresh = () => { cache.clear(); renderActive(); };
    window.__insightsHandleBack = () => {
        if (!detail) return false;
        detail = null;
        renderActive();
        return true;
    };
    window.__insightsBackButton = () => {
        if (!window.__insightsHandleBack()) window.closeInsights();
    };
}

// Called every time the panel opens. `target` optionally deep-links to one item.
export function showInsights(target) {
    if (target?.id && (target.kind === 'post' || target.kind === 'story')) {
        // If the user backs out of a deep-linked detail, land on the matching Content list.
        tab = 'content';
        contentKind = target.kind === 'story' ? 'stories' : 'posts';
        detail = { kind: target.kind, id: target.id };
    } else {
        detail = null;
    }
    if (days === 0 && tab !== 'content') days = 30;
    cache.clear(); // opening the panel should show fresh numbers
    renderActive();
}
