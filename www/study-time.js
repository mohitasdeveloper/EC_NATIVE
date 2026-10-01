// ============================================================
// STUDY TIME TRACKER — counts time spent reading in the in-app PDF viewer
// ============================================================
// Statically imported by main.js. It only WRITES (plus one small formatter the
// leaderboard reuses). The leaderboard UI lives in search.js.
//
// How it knows a PDF is being read: pdf-viewer.js dispatches three events on
// `window` from its single top-level overlay (the BAFs App is mounted natively in
// the Search tab, so its notes / question banks / past papers go through that same
// overlay, as does any other PDF the app opens):
//   ecampus:pdf-open    a PDF was requested (or the previous one is being replaced)
//   ecampus:pdf-ready   its pages are built and on screen
//   ecampus:pdf-close   the overlay was closed
//
// The clock runs only while ALL of these hold:
//   * a PDF is on screen (ready, not the loading spinner or the error card)
//   * the app is in the foreground (document not hidden)
//   * the user touched / scrolled / zoomed within the last IDLE_MS
// The idle window is generous on purpose: reading a dense page means minutes
// without a touch. When it lapses the clock pauses and resumes on the next
// touch; the idle window itself is credited (they were plausibly reading), the
// time after it is not.
//
// Delivery: seconds accumulate per IST day in localStorage (keyed by user), so
// a session in the offline PDF cache, or an app killed mid-read, is not lost.
// They are sent to record_study_time() (supabase/study_time.sql) every
// FLUSH_AT_SECONDS, when the viewer closes, when the app is backgrounded, and
// at next launch. The server owns the caps; nothing here is trusted.
//
// Failure policy: analytics must never break the app or spam the console.
//   * Network failure  -> keep the seconds, retry later.
//   * RPC missing (study_time.sql not run) -> stop trying for this session but
//     KEEP the seconds, so they are credited once the SQL is deployed.
// ============================================================

import { supabase } from './supabase.js';

const TICK_MS = 5000;
const MAX_TICK_CREDIT_MS = TICK_MS * 3;   // a starved timer must not credit a huge gap
const IDLE_MS = 5 * 60 * 1000;
const FLUSH_AT_SECONDS = 30;
const RETRY_MS = 30 * 1000;
const RETRY_DENIED_MS = 5 * 60 * 1000;
const MAX_CALL_SECONDS = 14400;           // record_study_time() clamps at the same value
const KEEP_DAYS = 2;                      // record_study_time() drops anything older
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;    // India has no DST
const STORAGE_PREFIX = 'ecampus_study_pending_v1:';
const ACTIVITY_EVENTS = ['touchstart', 'touchmove', 'pointerdown', 'scroll', 'wheel', 'keydown'];

let me = null;            // users.id — used only to key local storage
let pending = {};         // { 'YYYY-MM-DD': seconds } earned, not yet sent
let open = false;         // a PDF is loaded and on screen
let running = false;      // ...and the clock is ticking right now
let lastActivity = 0;
let lastCommitAt = 0;
let carryMs = 0;          // sub-second remainder, so short reads aren't rounded away
let tickTimer = null;
let flushing = false;
let disabled = false;
let nextFlushAt = 0;
let listenersInstalled = false;

// Must agree with public._study_today() in study_time.sql (Asia/Kolkata).
export function istDay(ms = Date.now()) {
    return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function formatStudyDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    if (s === 0) return '0m';
    if (s < 60) return '<1m';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h}h ${String(rem).padStart(2, '0')}m` : `${h}h`;
}

// ------------------------------------------------------------
// Local persistence
// ------------------------------------------------------------
function storageKey() { return STORAGE_PREFIX + me; }

function loadPending() {
    try {
        const raw = JSON.parse(localStorage.getItem(storageKey()) || '{}');
        const out = {};
        const cutoff = istDay(Date.now() - KEEP_DAYS * DAY_MS);
        for (const [day, secs] of Object.entries(raw || {})) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day >= cutoff && Number.isFinite(secs) && secs > 0) out[day] = Math.floor(secs);
        }
        return out;
    } catch (e) { return {}; }
}

function persist() {
    try { localStorage.setItem(storageKey(), JSON.stringify(pending)); } catch (e) { /* storage full/unavailable — in-memory copy still works */ }
}

function totalPending() {
    return Object.values(pending).reduce((a, b) => a + b, 0);
}

// ------------------------------------------------------------
// The clock
// ------------------------------------------------------------
// Moves time from "running since lastCommitAt" into the pending buckets.
function commit(t) {
    if (!running) return;
    const elapsed = Math.min(Math.max(t - lastCommitAt, 0), MAX_TICK_CREDIT_MS);
    lastCommitAt = Math.max(t, lastCommitAt);
    if (!elapsed) return;
    carryMs += elapsed;
    const whole = Math.floor(carryMs / 1000);
    if (!whole) return;
    carryMs -= whole * 1000;
    const day = istDay(t);
    pending[day] = (pending[day] || 0) + whole;
    persist();
}

function tick() {
    if (!open) return;
    const now = Date.now();
    if (running) {
        const idleAt = lastActivity + IDLE_MS;
        if (now >= idleAt) {
            commit(Math.max(idleAt, lastCommitAt)); // credit the reading grace, nothing beyond it
            running = false;
        } else {
            commit(now);
        }
    }
    if (totalPending() >= FLUSH_AT_SECONDS && now >= nextFlushAt) flush();
}

function startTick() {
    if (tickTimer) return;
    tickTimer = setInterval(tick, TICK_MS);
}

function stopTick() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

function endSession(now) {
    if (open) commit(now);
    open = false;
    running = false;
    stopTick();
}

// ------------------------------------------------------------
// Events
// ------------------------------------------------------------
function onPdfOpen() {
    endSession(Date.now());
    flush();
}

function onPdfReady() {
    if (!me) return;
    const now = Date.now();
    endSession(now); // a second 'ready' without a 'close' must not double-count
    open = true;
    lastActivity = now;
    lastCommitAt = now;
    running = !document.hidden;
    startTick();
}

function onPdfClose() {
    endSession(Date.now());
    flush();
}

function onActivity() {
    if (!open) return;
    const now = Date.now();
    lastActivity = now;
    if (!running && !document.hidden) { running = true; lastCommitAt = now; }
}

function onLeaveForeground() {
    if (!open) return;
    commit(Date.now());
    running = false;
    flush();
}

function onVisibilityChange() {
    if (document.hidden) { onLeaveForeground(); return; }
    if (!open) return;
    const now = Date.now();
    lastActivity = now;
    lastCommitAt = now;
    running = true;
}

function installListeners() {
    if (listenersInstalled) return;
    listenersInstalled = true;
    window.addEventListener('ecampus:pdf-open', onPdfOpen);
    window.addEventListener('ecampus:pdf-ready', onPdfReady);
    window.addEventListener('ecampus:pdf-close', onPdfClose);
    window.addEventListener('pagehide', onLeaveForeground);
    window.addEventListener('online', () => { flush(); });
    document.addEventListener('visibilitychange', onVisibilityChange);
    // Capture on window so scrolls inside the PDF body (which don't bubble) still count.
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true, capture: true });
}

// ------------------------------------------------------------
// Delivery
// ------------------------------------------------------------
async function flush() {
    if (flushing || disabled || !me) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const days = Object.keys(pending).filter(d => pending[d] > 0).sort();
    if (!days.length) return;

    flushing = true;
    try {
        for (const day of days) {
            while (pending[day] > 0) {
                const chunk = Math.min(pending[day], MAX_CALL_SECONDS);
                const { error } = await supabase.rpc('record_study_time', { p_day: day, p_seconds: chunk });
                if (error) throw error;
                // Subtract only what was sent — more may have been earned while awaiting.
                pending[day] -= chunk;
                if (pending[day] <= 0) delete pending[day];
                persist();
            }
        }
        nextFlushAt = 0;
    } catch (err) {
        const msg = String(err?.message || err || '');
        if (err?.code === 'PGRST202' || err?.code === '42883' || /could not find the function/i.test(msg)) {
            disabled = true; // SQL not deployed: stop for this session, but keep the seconds
            console.info('[study-time] tracking paused for this session (run supabase/study_time.sql):', msg);
        } else if (err?.code === '42501') {
            nextFlushAt = Date.now() + RETRY_DENIED_MS; // signed out / not granted — don't hammer
        } else {
            nextFlushAt = Date.now() + RETRY_MS;        // probably the network
        }
    } finally {
        flushing = false;
    }
}

// For the leaderboard: make sure the seconds just earned are on the server
// before it is fetched, so "your time" is not one flush behind.
export async function flushStudyTime() {
    if (open) commit(Date.now());
    await flush();
}

export function initStudyTracking(profile) {
    if (!profile?.id) return;
    if (me && me !== profile.id) endSession(Date.now()); // different account on the same device
    me = profile.id;
    disabled = false;
    nextFlushAt = 0;
    pending = loadPending();
    installListeners();
    flush(); // anything left by an offline session or a killed app
}
