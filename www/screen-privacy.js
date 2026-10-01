// screen-privacy.js — admin-controlled "full privacy mode".
//
// When an admin switches Full Privacy on (Admin Panel -> App Config), every
// device blocks screenshots and screen recording in the WHOLE app, login screen
// included. It rides on the native FLAG_SECURE bridge that already exists in
// MainActivity (window.AndroidSecure.enable()/disable(), see android-build.yml).
// FLAG_SECURE is a window flag, so while it's on, screenshots are refused, screen
// recordings and casts record black, and the Recent Apps thumbnail is blank.
//
// TWO things want that one flag:
//   'global' -> this admin setting (stays on for as long as the setting is on)
//   'pdf'    -> the PDF viewer (on only while a document is open)
// The bridge only has enable()/disable(), so if the PDF viewer called disable()
// on close it would switch the global block off too. window.ScreenSecure keeps a
// set of reasons and only clears the flag when none are left; pdf-viewer.js goes
// through it instead of calling the bridge directly.
//
// The last known setting is cached in localStorage so the block is already on at
// launch (before any network call, and when offline). It is then confirmed from
// the server on boot, whenever the app returns to the foreground, and live over
// Realtime while signed in.
//
// Fails OPEN on a failed check (keeps whatever was last known) — same
// offline-first stance as version-gate.js. Not a defence against a rooted or
// modified device, or against someone photographing the screen with another
// phone; FLAG_SECURE is what Android offers.

import { supabase } from './supabase.js';

const CACHE_KEY = 'ecampus_screen_privacy';
const SETTING_KEY = 'screen_privacy';
const MIN_RECHECK_MS = 10000;

const reasons = new Set();

function bridge() {
    const b = window.AndroidSecure;
    return b && typeof b.enable === 'function' && typeof b.disable === 'function' ? b : null;
}

function apply() {
    const b = bridge();
    if (!b) return; // browser, or an older build without the bridge
    try {
        if (reasons.size > 0) b.enable(); else b.disable();
    } catch (e) { /* ignore */ }
}

function hold(reason) { reasons.add(reason); apply(); }
function release(reason) { reasons.delete(reason); apply(); }

window.ScreenSecure = { hold, release };

function readCache() {
    try { return localStorage.getItem(CACHE_KEY) === '1'; } catch (e) { return false; }
}
function writeCache(on) {
    try { localStorage.setItem(CACHE_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
}

// Called by the admin panel right after a successful toggle so the admin's own
// device reacts instantly instead of waiting for the next refresh.
export function setPrivacyMode(on) {
    writeCache(!!on);
    if (on) hold('global'); else release('global');
}
window.__applyScreenPrivacy = setPrivacyMode;

// Applied the moment this module loads, before any network call.
if (readCache()) hold('global');

async function refresh() {
    try {
        const { data, error } = await supabase
            .from('app_settings')
            .select('key, enabled')
            .eq('key', SETTING_KEY);
        if (error || !Array.isArray(data)) return; // keep last known state
        // No row at all means the setting has never been turned on.
        setPrivacyMode(data.some((r) => r.key === SETTING_KEY && r.enabled === true));
    } catch (e) { /* offline etc. — keep last known state */ }
}

let started = false;
let lastCheck = 0;
let channel = null;

function refreshThrottled() {
    const now = Date.now();
    if (now - lastCheck < MIN_RECHECK_MS) return;
    lastCheck = now;
    refresh();
}

function startRealtime() {
    if (channel) return;
    try {
        channel = supabase
            .channel('app-settings-screen-privacy')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, (payload) => {
                const row = payload && payload.new;
                if (row && row.key === SETTING_KEY && typeof row.enabled === 'boolean') setPrivacyMode(row.enabled);
            })
            .subscribe();
    } catch (e) { /* the foreground re-check still covers it */ }
}

// realtime: pass false on the login screen (no session there, nothing to subscribe with).
export function initScreenPrivacy({ realtime = true } = {}) {
    if (started) { if (realtime) startRealtime(); return; }
    started = true;

    lastCheck = Date.now();
    refresh();
    if (realtime) startRealtime();

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshThrottled();
    });
    try {
        window.Capacitor?.Plugins?.App?.addListener('appStateChange', (state) => {
            if (state && state.isActive) refreshThrottled();
        });
    } catch (e) { /* not running natively */ }
}
