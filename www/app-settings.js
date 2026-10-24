// app-settings.js — the admin-controlled on/off switches in the `app_settings` table, read ONCE
// for the whole app.
//
// Two features read from that table: Full Privacy (screen-privacy.js) and "hide the BAFs App"
// (mini-apps.js). They share this module so a launch / foreground check is a single tiny request
// no matter how many switches exist (the table has a handful of rows).
//
//   refreshAppSettings()        fetch every row; returns true if the server answered, false if not
//                               (offline / error / SQL not run -> the last known values stay)
//   refreshAppSettings({ maxAgeMs })  same, but reuses an answer that is at most that old
//   getSetting(key)             last known value from this device's cache; a key the server has no
//                               row for (or that was never fetched) is false
//   onSettingsChange(fn)        fn(map) runs when a fetched or locally applied value changed
//   setSettingLocal(key, on)    apply a value right now (the admin panel calls it after a toggle
//                               so the admin's own device reacts instantly; also on window as
//                               window.__applyAppSetting)
//
// "Fails open": a failed fetch never changes anything. Setting names are chosen so that "no row"
// means the normal, everything-visible behaviour (e.g. `bafs_app_hidden`, not `bafs_app_visible`).
import { supabase } from './supabase.js';

const CACHE_KEY = 'ecampus_app_settings';

const listeners = new Set();
let inflight = null;
let lastOkAt = 0;

function readCache() {
    try {
        const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) { return {}; }
}

function writeCache(map) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
}

function emit(map) {
    for (const fn of [...listeners]) {
        try { fn(map); } catch (e) { /* one bad listener must not stop the others */ }
    }
}

const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export function getSetting(key) {
    return readCache()[key] === true;
}

export function onSettingsChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function setSettingLocal(key, enabled) {
    const before = readCache();
    const next = { ...before, [key]: !!enabled };
    writeCache(next);
    if (!same(before, next)) emit(next);
}
if (typeof window !== 'undefined') window.__applyAppSetting = setSettingLocal;

export function refreshAppSettings({ maxAgeMs = 0 } = {}) {
    if (maxAgeMs > 0 && lastOkAt && Date.now() - lastOkAt < maxAgeMs) return Promise.resolve(true);
    if (inflight) return inflight; // several callers at launch share one request

    inflight = (async () => {
        try {
            const { data, error } = await supabase.from('app_settings').select('key, enabled');
            if (error || !Array.isArray(data)) return false; // keep last known values
            const next = {};
            for (const row of data) if (row && typeof row.key === 'string') next[row.key] = row.enabled === true;
            const before = readCache();
            writeCache(next);
            lastOkAt = Date.now();
            if (!same(before, next)) emit(next);
            return true;
        } catch (e) {
            return false; // offline etc. — keep last known values
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}
