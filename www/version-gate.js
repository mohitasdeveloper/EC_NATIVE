// version-gate.js — forced-update gate.
//
// Blocks the app with a full-screen, undismissable "Update Required" screen
// whenever the installed build's Android versionCode is below whatever
// min_version_code is currently set in the `app_version_control` Supabase
// table. Runs from BOTH main.js (logged-in boot) and auth/auth.js (the
// login screen), since a device on an old build might not have a session.
//
// HOW TO ACTUALLY FORCE AN UPDATE:
// After you publish a new build to the Play Store, that build has a
// versionCode (an integer, set in the native project's app/build.gradle —
// not part of this www/ repo). Set `min_version_code` in the
// app_version_control table to that versionCode (see
// supabase/app_version_control.sql). From that moment, every device whose
// installed versionCode is lower gets locked out with this screen on next
// launch — you do NOT need to wait for Play Store propagation, this check
// runs app-side against your own database, not against Play Store itself.
// Raise the number again for the next release; never lower it.
//
// IMPORTANT CAVEAT: a build can only enforce this check if it already
// contains this file. A user stuck on a build from BEFORE this feature
// shipped has no code that phones home to ask — it will never see this
// screen. This gate protects everyone from this build onward, not devices
// on ancient installs that predate it.
//
// Fails OPEN on purpose: if the network check itself fails (offline, RLS
// misconfigured, row missing, timeout), users are let through rather than
// locked out — this matches the rest of the app's offline-first design and
// avoids a bad row/outage bricking everyone's app.

import { supabase } from './supabase.js';

const PLAY_STORE_PACKAGE = 'com.mohit.ecampus';
const PLAY_STORE_MARKET_URL = `market://details?id=${PLAY_STORE_PACKAGE}`;
const PLAY_STORE_WEB_URL = `https://play.google.com/store/apps/details?id=${PLAY_STORE_PACKAGE}`;

function openPlayStore() {
    // Same fallback chain main.js already uses for "always open externally,
    // regardless of domain": the native AndroidLinkHandler.openExternal
    // bridge (real ACTION_VIEW intent) added in MainActivity.java, falling
    // back to window.open('_system') only if that bridge is missing.
    if (window.AndroidLinkHandler && window.AndroidLinkHandler.openExternal) {
        window.AndroidLinkHandler.openExternal(PLAY_STORE_MARKET_URL);
    } else {
        window.open(PLAY_STORE_WEB_URL, '_system');
    }
}

function renderBlockOverlay(message) {
    if (document.getElementById('force-update-overlay')) return; // already showing

    const dark = document.documentElement.classList.contains('dark');
    const bg = dark ? '#121212' : '#ffffff';
    const textColor = dark ? '#f5f5f5' : '#171717';
    const subColor = dark ? '#a3a3a3' : '#525252';

    const overlay = document.createElement('div');
    overlay.id = 'force-update-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
        padding: 24px;
        padding-top: calc(24px + env(safe-area-inset-top, 0px));
        padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
        background: ${bg};
    `;

    overlay.innerHTML = `
        <div style="max-width:360px; width:100%; text-align:center; display:flex; flex-direction:column; align-items:center; gap:16px;">
            <div style="width:72px; height:72px; border-radius:20px; background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045); display:flex; align-items:center; justify-content:center; font-size:32px;">⬆️</div>
            <h1 style="margin:0; font-size:20px; font-weight:700; color:${textColor};">Update Required</h1>
            <p style="margin:0; font-size:14px; line-height:1.5; color:${subColor};"></p>
            <button id="force-update-btn" type="button" style="width:100%; padding:14px; border:none; border-radius:14px; background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045); color:#fff; font-size:15px; font-weight:600; margin-top:8px; cursor:pointer;">Update Now</button>
        </div>
    `;
    // Set the message via textContent (not innerHTML) so an admin-edited
    // message in the DB can never inject markup into the app.
    overlay.querySelector('p').textContent = message;

    document.body.appendChild(overlay);
    document.getElementById('force-update-btn').addEventListener('click', openPlayStore);

    // Swallow the hardware back button so it can't be used to escape the
    // gate (Capacitor's App plugin lets a listener take over the event —
    // by adding one and never calling any exit/navigation logic, the
    // default "go back" behavior simply never happens while this is up).
    try {
        window.Capacitor?.Plugins?.App?.addListener('backButton', () => {});
    } catch (e) { /* not running natively */ }
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
}

// Resolves true if the update screen was shown (caller should stop booting
// anything else), false if the app is clear to continue as normal.
export async function checkForcedUpdate() {
    if (!(window.Capacitor && window.Capacitor.isNativePlatform())) return false;

    let build;
    try {
        const info = await window.Capacitor.Plugins.App.getInfo();
        build = parseInt(info.build, 10);
        if (!Number.isFinite(build)) return false;
    } catch (e) {
        console.error('version-gate: could not read installed app version', e);
        return false;
    }

    try {
        const result = await withTimeout(
            supabase
                .from('app_version_control')
                .select('min_version_code, update_message')
                .eq('platform', 'android')
                .maybeSingle(),
            4000
        );

        if (!result) return false; // timed out — fail open
        const { data, error } = result;
        if (error || !data) return false; // missing row / RLS issue — fail open

        if (build >= data.min_version_code) return false;

        renderBlockOverlay(
            data.update_message ||
            'A new version of ECampus is available. Please update to keep using the app.'
        );
        return true;
    } catch (e) {
        console.error('version-gate: check failed', e);
        return false;
    }
}
