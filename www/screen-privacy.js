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
// the server on boot and whenever the app returns to the foreground (at most once
// a minute). There is deliberately NO Realtime subscription: a flipped switch
// reaches an open app the next time it is brought back to the foreground.
//
// Fails OPEN on a failed check (keeps whatever was last known) — same
// offline-first stance as version-gate.js. Not a defence against a rooted or
// modified device, or against someone photographing the screen with another
// phone; FLAG_SECURE is what Android offers.

import { refreshAppSettings, getSetting } from './app-settings.js';

const CACHE_KEY = 'ecampus_screen_privacy';
const SETTING_KEY = 'screen_privacy';
const MIN_RECHECK_MS = 60000;

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
        // One shared request for every admin switch (see app-settings.js). A failed
        // check (offline, error) returns false and we keep the last known state.
        if (!(await refreshAppSettings())) return;
        // No row at all means the setting has never been turned on.
        setPrivacyMode(getSetting(SETTING_KEY));
    } catch (e) { /* keep last known state */ }
}

let started = false;
let lastCheck = 0;

function refreshThrottled() {
    const now = Date.now();
    if (now - lastCheck < MIN_RECHECK_MS) return;
    lastCheck = now;
    refresh();
}

export function initScreenPrivacy() {
    if (started) return;
    started = true;

    lastCheck = Date.now();
    refresh();

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshThrottled();
    });
    try {
        window.Capacitor?.Plugins?.App?.addListener('appStateChange', (state) => {
            if (state && state.isActive) refreshThrottled();
        });
    } catch (e) { /* not running natively */ }
}
