// ============================================================
// INSIGHTS TRACKER — records who SAW / did something with content
// ============================================================
// Statically imported by main.js (it has to be live from the first feed
// render, so unlike admin.js it can't be lazy). Kept small on purpose.
//
// It only WRITES. Every event goes to the record_insight_events() RPC in
// supabase/insights.sql, in small batches. The server decides who owns the
// content, drops self-events and deduplicates, so nothing here is trusted
// with attribution — this file just reports "I looked at post X".
//
// What it tracks:
//   post_impression   a post card was >=50% visible (or filled half the screen)
//                     for >=1 second. Once per post per app session.
//   profile_visit     viewUserProfile() opened someone else's profile. Carries
//                     the post/story that led there when we can tell.
//   post_share        a post was sent into a chat, or shared externally.
//   post_link_click   the event "Register" button on a post was tapped.
//   story_*           story impression / tap forward / tap back / next account /
//                     exit — fired from hotposts.js via window.trackInsightEvent.
//
// Failure policy: analytics must never break the app or spam the console.
//   * A network failure re-queues the batch (capped) and retries later.
//   * If the RPC doesn't exist yet (insights.sql not run), tracking switches
//     itself off for the session after the first failure instead of retrying.
// ============================================================

import { supabase } from './supabase.js';

const FLUSH_MS = 4000;
const MAX_BATCH = 50;
const MAX_QUEUE = 200;
const PROFILE_VISIT_DEDUPE_MS = 30 * 60 * 1000;
const SOURCE_TTL_MS = 4000; // how long a "the visit came from this post/story" hint stays valid

let me = null;
let disabled = false;
let queue = [];
let flushTimer = null;
let flushing = false;

const seenPosts = new Set();
const recentProfileVisits = new Map(); // profileId -> timestamp
let profileSource = null;              // { kind: 'post' | 'story', id, t }

// ------------------------------------------------------------
// Queue + flush
// ------------------------------------------------------------
function schedule() {
    if (flushTimer || disabled) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_MS);
}

export function trackEvent(type, subjectId, opts = {}) {
    if (disabled || !me || !type || !subjectId) return;
    queue.push({ type, subject_id: subjectId, source: opts.source || null, from_id: opts.fromId || null });
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    if (queue.length >= MAX_BATCH) flush(); else schedule();
}

export async function flush() {
    if (flushing || disabled || !me || queue.length === 0) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { schedule(); return; }
    flushing = true;
    const batch = queue.splice(0, MAX_BATCH);
    try {
        const { error } = await supabase.rpc('record_insight_events', { p_events: batch });
        if (error) throw error;
    } catch (err) {
        const msg = String(err?.message || err || '');
        // Function missing (SQL not run yet) or permission denied: stop trying.
        if (err?.code === 'PGRST202' || err?.code === '42883' || err?.code === '42501' || /could not find the function/i.test(msg)) {
            disabled = true;
            queue = [];
            console.info('[insights] tracking off for this session (run supabase/insights.sql):', msg);
        } else {
            // Probably the network. Put the batch back (respecting the cap) and try later.
            queue = batch.concat(queue).slice(-MAX_QUEUE);
            schedule();
        }
    } finally {
        flushing = false;
        if (queue.length && !disabled && !flushTimer) schedule();
    }
}

// ------------------------------------------------------------
// Profile visits
// ------------------------------------------------------------
// Call right before navigating to a profile from a post/story so the visit can
// be credited to it ("profile visits from this post").
export function markProfileSource(kind, id) {
    if (!kind || !id) return;
    profileSource = { kind, id, t: Date.now() };
}

export function trackProfileVisit(profileId) {
    if (!me || disabled || !profileId || profileId === me.id) return;
    const now = Date.now();
    const last = recentProfileVisits.get(profileId);
    if (last && now - last < PROFILE_VISIT_DEDUPE_MS) return;
    recentProfileVisits.set(profileId, now);

    let source = 'other';
    let fromId = null;
    if (profileSource && now - profileSource.t < SOURCE_TTL_MS) {
        source = profileSource.kind;
        fromId = profileSource.id;
    }
    profileSource = null;
    trackEvent('profile_visit', profileId, { source, fromId });
}

// ------------------------------------------------------------
// Post impressions (IntersectionObserver over every rendered post card)
// ------------------------------------------------------------
function sourceFor(el) {
    if (el.closest('#feed-posts-container')) return 'feed';
    if (el.closest('#my-profile-feed, #public-profile-feed')) return 'profile';
    if (el.closest('#modal-single-post')) return 'detail';
    if (el.closest('#panel-saved-posts, #panel-liked-posts, #panel-archived-posts')) return 'library';
    return 'other';
}

function setupImpressionObserver() {
    if (typeof IntersectionObserver === 'undefined' || typeof MutationObserver === 'undefined') return;

    const dwell = new Map(); // element -> timeout id

    const isMostlyVisible = (entry) =>
        entry.isIntersecting &&
        (entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= window.innerHeight * 0.5);

    const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const el = entry.target;
            const postId = el.dataset.postId;
            if (!postId || seenPosts.has(postId)) { io.unobserve(el); continue; }

            if (isMostlyVisible(entry)) {
                if (dwell.has(el)) continue;
                dwell.set(el, setTimeout(() => {
                    dwell.delete(el);
                    if (seenPosts.has(postId)) return;
                    seenPosts.add(postId);
                    trackEvent('post_impression', postId, { source: sourceFor(el) });
                    io.unobserve(el);
                }, 1000));
            } else if (dwell.has(el)) {
                clearTimeout(dwell.get(el));
                dwell.delete(el);
            }
        }
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });

    const watch = (root) => {
        if (root.nodeType !== 1) return;
        if (root.hasAttribute('data-post-card')) io.observe(root);
        root.querySelectorAll?.('[data-post-card]').forEach((el) => io.observe(el));
    };

    new MutationObserver((mutations) => {
        for (const m of mutations) m.addedNodes.forEach(watch);
    }).observe(document.body, { childList: true, subtree: true });

    watch(document.body); // cards already on screen at start-up

    // Remember which post the user last touched, so a profile visit that follows
    // a tap on a post's header can be credited to that post.
    document.addEventListener('click', (e) => {
        const card = e.target?.closest?.('[data-post-card]');
        if (card?.dataset.postId) markProfileSource('post', card.dataset.postId);
    }, true);
}

// ------------------------------------------------------------
// Boot
// ------------------------------------------------------------
export function initInsightsTracking(profile) {
    if (me || !profile?.id) return; // idempotent
    me = { id: profile.id };
    setupImpressionObserver();

    // Don't lose the last few events when the app is backgrounded/closed.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', () => { flush(); });

    // Handy for the other modules' inline onclick handlers and for hotposts.js
    // (which would otherwise need its own import wiring).
    window.trackInsightEvent = trackEvent;
    window.markInsightProfileSource = markProfileSource;
}
