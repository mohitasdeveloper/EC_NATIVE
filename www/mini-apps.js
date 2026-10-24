// ============================================================
// MINI APPS — the circle tray at the top of Home + the full-screen host they open in.
// ============================================================
// Replaces the old Hotposts (stories) tray. Each mini app is one entry in MINI_APPS:
// a circle with its icon + name on Home; tapping it slides a full-screen overlay
// (#modal-mini-app, markup in index.html) up over the whole app and mounts the app into
// #mini-app-body. The overlay closes through the normal back navigation (hardware back /
// gesture / the app's own back arrow): main.js's back router calls window.miniAppHandleBack(),
// which first lets the mini app step back inside itself and only then closes the overlay.
//
// To add another mini app: add an entry below. It needs
//   id / name / icon (+ iconRemote: tried if `icon` fails; fallbackIcon: a Material Symbol shown if neither loads),
//   load():            () => import('./your-app.js')
//   mount(mod, el):    render into `el` (the scroll container, already full screen)
//   unmount(mod):      stop timers / listeners, remove what mount() added
//   handleBack(mod):   optional — return true if the app stepped back by itself,
//                      false when it is already at its home screen (=> overlay closes)
//
// The id starts with "modal-" on purpose: the pull-to-refresh engine in main.js ignores
// touches that start inside any visible [id^="modal-"], so dragging down inside a mini app
// never refreshes the Home feed behind it.

import {
    initPageMiniApps, loadPageMiniApps, getPageMiniApps, onPageMiniAppsChange,
    openPageMiniApp, openMiniAppsManager, isPageAccount, escapeHtml
} from './page-mini-apps.js';
import { getSetting, onSettingsChange, refreshAppSettings } from './app-settings.js';

// A built-in app can carry `hideSetting`: the app_settings key an admin switches on (Admin -> App Config)
// to hide it from everyone. No row / key off = visible, so a failed or missing check never hides anything.
// Built-in mini apps (code in this repo). Page accounts add their own at runtime — those live in the
// database and are managed by page-mini-apps.js; they open through the link router, not this overlay.
export const MINI_APPS = [
    {
        id: 'bafs',
        name: 'BAFs App',
        hideSetting: 'bafs_app_hidden',                          // Admin -> App Config -> "Show BAFs App"
        icon: 'img/study-icon.png',                                // bundled in the app (www/img/) — works offline
        iconRemote: 'https://i.ibb.co/0jDkVxfB/study-icon.png',    // only used if the bundled file is missing
        fallbackIcon: 'school',
        load: () => import('./bafs.js'),
        mount: (mod, el) => mod.mountBafs(el),
        unmount: (mod) => mod.unmountBafs(),
        handleBack: (mod) => {
            if (mod.bafsIsAtHome()) return false;
            mod.bafsGoBack();
            return true;
        }
    }
];

const CLOSE_ANIM_MS = 260;

const isHidden = (app) => !!app.hideSetting && getSetting(app.hideSetting);

let current = null;   // { app, mod } while a mini app is open (or loading)
let closing = false;  // true during the slide-out animation
let openToken = 0;    // invalidates an in-flight open() if the user backs out while it loads

const overlayEl = () => document.getElementById('modal-mini-app');
const bodyEl = () => document.getElementById('mini-app-body');

const LOADING_HTML = `
    <div class="mini-app-loading" aria-hidden="true">
        <div class="h-14 shimmer-bg rounded-2xl"></div>
        <div class="h-28 shimmer-bg rounded-2xl"></div>
        <div class="h-16 shimmer-bg rounded-2xl"></div>
        <div class="h-16 shimmer-bg rounded-2xl"></div>
    </div>`;

function errorHtml(name) {
    return `
        <div class="mini-app-error">
            <span class="material-symbols-outlined">error</span>
            <p>Couldn't open ${name}.</p>
            <button type="button" data-mini-close>Go back</button>
        </div>`;
}

// ── Tray ────────────────────────────────────────────────────
// Circle order: "Manage" (Page accounts only — first, so it never scrolls out of sight) → built-in apps
// (BAFs App) → Pages' mini apps (oldest first).
function itemHtml({ key, name, icon, fallback }) {
    const img = icon ? `<img src="${escapeHtml(icon)}" alt="" draggable="false">` : '';
    return `
        <button type="button" class="mini-app-item" data-mini-app="${escapeHtml(key)}" aria-label="Open ${escapeHtml(name)}">
            <span class="mini-app-circle${icon ? '' : ' is-broken'}">
                <span class="mini-app-face">
                    ${img}
                    ${fallback}
                </span>
            </span>
            <span class="mini-app-label">${escapeHtml(name)}</span>
        </button>`;
}

export function renderMiniAppsTray() {
    const tray = document.getElementById('mini-apps-tray');
    if (!tray) return;

    const builtIn = MINI_APPS.filter(a => !isHidden(a)).map(a => itemHtml({
        key: a.id, name: a.name, icon: a.icon,
        fallback: `<span class="material-symbols-outlined mini-app-fallback">${a.fallbackIcon || 'widgets'}</span>`
    }));
    const pages = getPageMiniApps().map(a => itemHtml({
        key: 'page:' + a.id, name: a.name, icon: a.icon_url,
        fallback: `<span class="mini-app-fallback mini-app-initial">${escapeHtml((a.name.trim().charAt(0) || '?').toUpperCase())}</span>`
    }));
    const manage = isPageAccount() ? [`
        <button type="button" class="mini-app-item" data-mini-manage aria-label="Manage your mini apps">
            <span class="mini-app-circle is-manage"><span class="mini-app-face"><span class="material-symbols-outlined">add</span></span></span>
            <span class="mini-app-label">Manage</span>
        </button>`] : [];

    const items = [...manage, ...builtIn, ...pages];
    tray.innerHTML = items.join('');
    // Nothing to show (e.g. the BAFs App is hidden and there are no Page apps): drop the empty strip too.
    tray.parentElement?.classList?.toggle('hidden', items.length === 0);

    tray.querySelectorAll('.mini-app-item[data-mini-app]').forEach(item => {
        const app = MINI_APPS.find(a => a.id === item.dataset.miniApp);   // undefined for Pages' apps
        const img = item.querySelector('img');
        const circle = item.querySelector('.mini-app-circle');
        if (!img || !circle) return;

        const markBroken = () => circle.classList.add('is-broken');
        const onError = () => {
            // bundled file missing → try the hosted one once → otherwise show the fallback (icon / initial)
            if (app?.iconRemote && !img.dataset.triedRemote) { img.dataset.triedRemote = '1'; img.src = app.iconRemote; }
            else markBroken();
        };
        // A (near-)square icon fills the circle edge to edge; any other shape is fitted whole inside it,
        // so nothing is ever cropped by the round mask.
        const onLoad = () => {
            circle.classList.remove('is-broken');
            const r = img.naturalWidth / (img.naturalHeight || 1);
            const square = Math.abs(r - 1) < 0.12;
            circle.classList.toggle('is-square', square);
            if (square) { img.style.width = img.style.height = ''; return; }
            // largest w×h of this aspect ratio that fits inside the circle: its diagonal = the diameter
            const k = 100 / Math.hypot(1, r);
            img.style.width = (k * r).toFixed(1) + '%';
            img.style.height = k.toFixed(1) + '%';
        };
        img.addEventListener('error', onError);
        img.addEventListener('load', onLoad);
        if (img.complete) { if (img.naturalWidth === 0) onError(); else onLoad(); }
    });
}

// ── Open / close ────────────────────────────────────────────
export async function openMiniApp(id) {
    const app = MINI_APPS.find(a => a.id === id);
    const overlay = overlayEl();
    const body = bodyEl();
    if (!app || !overlay || !body || current || closing) return; // ignore double taps
    if (isHidden(app)) return;                                   // an admin has hidden this app

    const token = ++openToken;
    current = { app, mod: null };

    body.innerHTML = LOADING_HTML;
    body.scrollTop = 0;
    overlay.classList.remove('hidden');
    // next frame, so the browser has the off-screen start position before it animates
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('is-open')));

    try {
        const mod = await app.load();
        if (token !== openToken || !current) return; // closed while the module was loading
        current.mod = mod;
        await app.mount(mod, body);
    } catch (e) {
        console.error(`Error opening mini app "${id}":`, e);
        if (token === openToken && current) body.innerHTML = errorHtml(app.name);
    }
}

export function closeMiniApp() {
    const overlay = overlayEl();
    if (!overlay || !current || closing) return;

    const { app, mod } = current;
    current = null;
    closing = true;
    openToken++;
    overlay.classList.remove('is-open');

    setTimeout(() => {
        overlay.classList.add('hidden');
        if (mod) { try { app.unmount(mod); } catch (e) { console.warn('Mini app unmount failed:', e); } }
        const body = bodyEl();
        if (body) body.innerHTML = '';
        closing = false;
    }, CLOSE_ANIM_MS);
}

// Called by main.js's back router while #modal-mini-app is showing. Always consumes the press.
export function miniAppHandleBack() {
    if (!current) return; // already closing

    // The student-ID verification screen can sit on top of a mini app (the BAFs lock screen
    // opens it). Back closes that first and leaves the mini app where it is.
    const verify = document.getElementById('view-verification');
    if (verify && !verify.classList.contains('hidden') && getComputedStyle(verify).display !== 'none') {
        verify.classList.replace('flex', 'hidden');
        return;
    }

    const { app, mod } = current;
    if (mod && typeof app.handleBack === 'function') {
        let consumed = false;
        try { consumed = app.handleBack(mod) === true; } catch (e) { /* treat as "at home" */ }
        if (consumed) return; // stepped back inside the app
    }
    closeMiniApp();
}

// ── Init ────────────────────────────────────────────────────
export function initMiniApps(profile) {
    initPageMiniApps(profile);                 // Pages' mini apps + their manager screen
    onPageMiniAppsChange(renderMiniAppsTray);  // re-draw when the list loads / changes
    onSettingsChange(() => {                   // an admin hid / showed an app
        if (current && isHidden(current.app)) closeMiniApp();   // it is open right now: close it
        renderMiniAppsTray();
    });
    renderMiniAppsTray();                      // built-ins (minus hidden ones, from the last known setting) + the saved list, instantly
    loadPageMiniApps();                        // then the fresh list
    refreshAppSettings({ maxAgeMs: 5000 });    // confirm which apps are hidden (shares the launch-time privacy request)

    const tray = document.getElementById('mini-apps-tray');
    if (tray && !tray.dataset.bound) {
        tray.dataset.bound = '1';
        tray.addEventListener('click', (e) => {
            if (e.target.closest('[data-mini-manage]')) { openMiniAppsManager(); return; }
            const btn = e.target.closest('[data-mini-app]');
            if (!btn) return;
            const key = btn.dataset.miniApp;
            if (key.startsWith('page:')) {
                openPageMiniApp(getPageMiniApps().find(a => a.id === key.slice(5)));
            } else {
                openMiniApp(key);
            }
        });
    }

    const overlay = overlayEl();
    if (overlay && !overlay.dataset.bound) {
        overlay.dataset.bound = '1';
        overlay.addEventListener('click', (e) => {
            if (e.target.closest('[data-mini-close]')) closeMiniApp();
        });
    }

    window.openMiniApp = openMiniApp;
    window.closeMiniApp = closeMiniApp;
    window.miniAppHandleBack = miniAppHandleBack;
}
