// ============================================================
// PAGE MINI APPS — Pages (official accounts) publish their own Mini Apps.
// ============================================================
// Data:    supabase/page_mini_apps.sql (table + SECURITY DEFINER functions; run it once).
// Shown:   as circles in the Home tray (mini-apps.js asks getPageMiniApps()).
// Opened:  through window.openServiceLink(url, openInApp, name, { full: true }) — the same in-app
//          WebView / system-browser router every other link uses. `full` adds the whole parameter
//          set (student_id, name, course, dp_url, theme — see link-params.js) to the Page's URL.
// Managed: by Page accounts only, from the "Manage" circle at the end of the tray:
//          a screen listing their apps (show/hide switch, edit) + an add/edit sheet whose
//          "Open inside ECampus" switch is the open-in-app choice.
//
// The list is cached in localStorage so the tray is there instantly (and offline).

import { supabase } from './supabase.js';
import { showToast } from './ui.js';

export const MAX_APPS_PER_PAGE = 10;   // keep in sync with mini_app_save() in page_mini_apps.sql
export const NAME_MAX = 20;
const CACHE_KEY = 'ecampus_page_mini_apps_v1';

const $ = (id) => document.getElementById(id);

export const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));
const isHttps = (u) => typeof u === 'string' && /^https:\/\/\S+$/i.test(u);
const hostOf = (u) => { try { return new URL(u).host; } catch (e) { return ''; } };
const initialOf = (name) => (String(name || '?').trim().charAt(0) || '?').toUpperCase();

let profile = null;     // the viewer's users row
let trayApps = [];      // active mini apps of every live Page — what the Home tray shows
let mine = [];          // this Page's own apps (active + hidden) — the manager screen
let bound = false;
const listeners = new Set();

// ── list for the Home tray ───────────────────────────────────
// Rows come from other users, so each is validated before it is ever rendered or opened.
function cleanApp(a) {
    if (!a || typeof a !== 'object' || !a.id || !isHttps(a.url)) return null;
    const name = String(a.name || '').trim().slice(0, NAME_MAX);
    if (!name) return null;
    return {
        id: String(a.id),
        name,
        url: a.url,
        icon_url: isHttps(a.icon_url) ? a.icon_url : null,
        open_in_app: a.open_in_app !== false,
        page_name: String(a.page_name || '')
    };
}

function readCache() {
    try {
        const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
        return Array.isArray(raw) ? raw.map(cleanApp).filter(Boolean) : [];
    } catch (e) { return []; }
}

export function getPageMiniApps() { return trayApps; }
export function onPageMiniAppsChange(fn) { listeners.add(fn); }
function emit() { listeners.forEach((fn) => { try { fn(trayApps); } catch (e) { console.error(e); } }); }

export function isPageAccount() { return profile?.role === 'page'; }

export async function loadPageMiniApps() {
    try {
        const { data, error } = await supabase.rpc('mini_apps_list');
        if (error) throw error;
        trayApps = (Array.isArray(data) ? data : []).map(cleanApp).filter(Boolean);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(trayApps)); } catch (e) { /* storage full / private mode */ }
        emit();
    } catch (e) {
        console.warn('Mini apps list failed (showing the saved list):', e);
    }
    return trayApps;
}

export function openPageMiniApp(app) {
    if (!app || !isHttps(app.url)) return;
    if (typeof window.openServiceLink !== 'function') return;
    window.openServiceLink(app.url, app.open_in_app !== false, app.name, { full: true });
}

// ── validation (mirrors mini_app_save in the SQL) ────────────
export function validateMiniApp({ name, url, icon_url }) {
    if (!name || name.length > NAME_MAX) return `Name must be 1 to ${NAME_MAX} characters`;
    if (!isHttps(url) || url.length > 500) return 'App URL must start with https://';
    try { new URL(url); } catch (e) { return 'That App URL is not valid'; }
    if (icon_url && (!isHttps(icon_url) || icon_url.length > 500)) return 'Icon URL must start with https://';
    return '';
}

// "app.example.com" -> "https://app.example.com"; anything that already has a scheme is left for validation
const withScheme = (u) => (u && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? 'https://' + u : u);

// ── manager screen ───────────────────────────────────────────
function faceHtml(a, size = 48) {
    const img = a.icon_url
        ? `<img src="${escapeHtml(a.icon_url)}" alt="" class="absolute inset-0 w-full h-full object-cover" onerror="this.remove()">`
        : '';
    return `<div class="relative shrink-0 rounded-full overflow-hidden bg-primary/10 text-primary flex items-center justify-center font-extrabold border border-primary/20" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${escapeHtml(initialOf(a.name))}${img}</div>`;
}

function rowHtml(a) {
    const id = escapeHtml(a.id);
    return `
    <div class="flex items-center gap-3 p-3 bg-surface-container-lowest dark:bg-neutral-900/50 rounded-2xl border border-surface-variant/40 dark:border-neutral-800 ${a.is_active ? '' : 'opacity-60'}">
        ${faceHtml(a)}
        <div class="flex-1 min-w-0">
            <p class="font-extrabold text-[15px] text-on-surface dark:text-gray-100 truncate">${escapeHtml(a.name)}</p>
            <p class="text-[12px] text-on-surface-variant dark:text-gray-500 truncate">${escapeHtml(hostOf(a.url))} · ${a.open_in_app ? 'Opens in app' : 'Opens in browser'}</p>
            <p class="text-[11px] font-bold mt-0.5 ${a.is_active ? 'text-primary' : 'text-on-surface-variant dark:text-gray-500'}">${a.is_active ? 'Visible on Home' : 'Hidden'}</p>
        </div>
        <label class="relative inline-flex items-center cursor-pointer shrink-0" aria-label="Show ${escapeHtml(a.name)} on Home">
            <input type="checkbox" data-ma-toggle="${id}" ${a.is_active ? 'checked' : ''} class="sr-only peer">
            <div class="w-11 h-6 bg-surface-variant dark:bg-neutral-700 rounded-full peer peer-checked:bg-primary peer-checked:after:translate-x-full after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
        </label>
        <button type="button" data-ma-edit="${id}" aria-label="Edit ${escapeHtml(a.name)}" class="w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant active:bg-surface-variant/50 shrink-0">
            <span class="material-symbols-outlined text-[20px]">edit</span>
        </button>
    </div>`;
}

function renderManagerList() {
    const list = $('mini-apps-manage-list');
    if (!list) return;
    const count = $('mini-apps-manage-count');
    if (count) count.textContent = `${mine.length} of ${MAX_APPS_PER_PAGE}`;
    list.innerHTML = mine.length
        ? mine.map(rowHtml).join('')
        : `<div class="py-16 flex flex-col items-center justify-center text-center opacity-50 text-on-surface-variant">
               <span class="material-symbols-outlined text-[44px] mb-2">widgets</span>
               <p class="text-[14px] font-bold">No mini apps yet</p>
               <p class="text-[12px] mt-1">Tap New to add your app.</p>
           </div>`;
}

async function loadMine() {
    const list = $('mini-apps-manage-list');
    try {
        const { data, error } = await supabase.rpc('mini_apps_mine');
        if (error) throw error;
        mine = (Array.isArray(data) ? data : []).map((a) => ({ ...cleanApp(a), is_active: a.is_active !== false })).filter((a) => a.id);
        renderManagerList();
    } catch (e) {
        console.error('Error loading your mini apps:', e);
        if (list) list.innerHTML = '<p class="text-sm italic text-center py-8 text-error">Could not load your mini apps.</p>';
    }
}

export function openMiniAppsManager() {
    const m = $('modal-manage-mini-apps');
    if (!m || !isPageAccount()) return;
    m.classList.replace('hidden', 'flex');
    setTimeout(() => m.classList.remove('translate-x-full'), 10);
    renderManagerList();      // whatever we already have, instantly
    loadMine();
}

export function closeMiniAppsManager() {
    const m = $('modal-manage-mini-apps');
    if (!m) return;
    m.classList.add('translate-x-full');
    setTimeout(() => m.classList.replace('flex', 'hidden'), 300);
}

// ── add / edit sheet ─────────────────────────────────────────
function updatePreview() {
    const box = $('mini-app-icon-preview');
    if (!box) return;
    const icon = $('mini-app-icon-input').value.trim();
    box.outerHTML = `<div id="mini-app-icon-preview">${faceHtml({ name: $('mini-app-name-input').value, icon_url: isHttps(icon) ? icon : null }, 64)}</div>`;
}

function openForm(app) {
    const modal = $('modal-mini-app-form'), card = $('mini-app-form-card');
    if (!modal || !card) return;
    const a = app || { id: '', name: '', url: '', icon_url: '', open_in_app: true, is_active: true };

    $('mini-app-form-title').textContent = a.id ? 'Edit Mini App' : 'New Mini App';
    $('mini-app-edit-id').value = a.id;
    $('mini-app-name-input').value = a.name;
    $('mini-app-url-input').value = a.url;
    $('mini-app-icon-input').value = a.icon_url || '';
    $('mini-app-inapp-toggle').checked = a.open_in_app !== false;
    $('mini-app-active-toggle').checked = a.is_active !== false;
    $('mini-app-delete-btn').classList.toggle('hidden', !a.id);
    $('mini-app-form-error').textContent = '';
    updatePreview();

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.pointerEvents = 'auto';
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        card.style.transform = '';
        card.classList.remove('translate-y-full');
    }, 10);
}

export function closeMiniAppForm() {
    const modal = $('modal-mini-app-form'), card = $('mini-app-form-card');
    if (!modal || !card) return;
    modal.style.pointerEvents = 'none';
    modal.classList.add('opacity-0');
    card.style.transform = '';
    card.classList.add('translate-y-full');
    setTimeout(() => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }, 300);
}

async function refreshAfterChange() {
    await Promise.all([loadMine(), loadPageMiniApps()]);
}

async function saveForm() {
    const btn = $('mini-app-save-btn');
    const err = $('mini-app-form-error');
    const id = $('mini-app-edit-id').value;
    const values = {
        name: $('mini-app-name-input').value.trim(),
        url: withScheme($('mini-app-url-input').value.trim()),
        icon_url: withScheme($('mini-app-icon-input').value.trim())
    };
    const problem = validateMiniApp(values);
    if (problem) { err.textContent = problem; return; }
    if (!id && mine.length >= MAX_APPS_PER_PAGE) { err.textContent = `You can have up to ${MAX_APPS_PER_PAGE} Mini Apps`; return; }
    err.textContent = '';

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Saving…';
    try {
        const { error } = await supabase.rpc('mini_app_save', {
            p_id: id || null,
            p_name: values.name,
            p_url: values.url,
            p_icon_url: values.icon_url || null,
            p_open_in_app: $('mini-app-inapp-toggle').checked,
            p_is_active: $('mini-app-active-toggle').checked
        });
        if (error) throw error;
        showToast(id ? 'Mini app updated.' : 'Mini app added.', 'success');
        closeMiniAppForm();
        await refreshAfterChange();
    } catch (e) {
        console.error('Error saving mini app:', e);
        err.textContent = e?.message || 'Could not save. Try again.';
    } finally {
        btn.disabled = false;
        btn.textContent = label;
    }
}

// The confirm dialog is shared with feed.js / admin.js: put its label and colour back when it closes.
function confirmDelete(name, onConfirm) {
    const modal = $('modal-confirm-action');
    if (!modal) { onConfirm(); return; }
    $('confirm-action-title').textContent = 'Delete this mini app?';
    $('confirm-action-message').textContent = `"${name}" will be removed from Home for everyone. You can hide it instead and keep it.`;
    const oldYes = $('confirm-action-yes'), oldNo = $('confirm-action-no');
    const yes = oldYes.cloneNode(true), no = oldNo.cloneNode(true);
    oldYes.parentNode.replaceChild(yes, oldYes);
    oldNo.parentNode.replaceChild(no, oldNo);
    const close = () => modal.classList.replace('flex', 'hidden');
    no.addEventListener('click', close);
    yes.addEventListener('click', async () => { close(); await onConfirm(); });
    modal.classList.replace('hidden', 'flex');
}

function deleteFromForm() {
    const id = $('mini-app-edit-id').value;
    if (!id) return;
    const app = mine.find((a) => a.id === id);
    confirmDelete(app?.name || 'This mini app', async () => {
        try {
            const { error } = await supabase.rpc('mini_app_delete', { p_id: id });
            if (error) throw error;
            showToast('Mini app deleted.', 'success');
            closeMiniAppForm();
            await refreshAfterChange();
        } catch (e) {
            console.error('Error deleting mini app:', e);
            showToast(e?.message || 'Failed to delete.', 'error');
        }
    });
}

async function toggleActive(id, active) {
    const app = mine.find((a) => a.id === id);
    if (!app) return;
    app.is_active = active;
    renderManagerList();
    try {
        const { error } = await supabase.rpc('mini_app_set_active', { p_id: id, p_active: active });
        if (error) throw error;
        showToast(active ? 'Visible on Home.' : 'Hidden from Home.', 'success');
        loadPageMiniApps();
    } catch (e) {
        console.error('Error changing mini app visibility:', e);
        app.is_active = !active;       // put the switch back
        renderManagerList();
        showToast(e?.message || 'Could not change that. Try again.', 'error');
    }
}

// ── wiring ───────────────────────────────────────────────────
export function initPageMiniApps(viewer) {
    profile = viewer || null;
    if (!trayApps.length) trayApps = readCache();   // instant tray (and offline)

    if (bound) return;
    bound = true;

    const manager = $('modal-manage-mini-apps');
    manager?.addEventListener('click', (e) => {
        if (e.target.closest('[data-ma-close]')) { closeMiniAppsManager(); return; }
        if (e.target.closest('[data-ma-add]')) {
            if (mine.length >= MAX_APPS_PER_PAGE) { showToast(`You can have up to ${MAX_APPS_PER_PAGE} Mini Apps.`, 'warning'); return; }
            openForm(null);
            return;
        }
        const edit = e.target.closest('[data-ma-edit]');
        if (edit) openForm(mine.find((a) => a.id === edit.dataset.maEdit) || null);
    });
    manager?.addEventListener('change', (e) => {
        const sw = e.target.closest('[data-ma-toggle]');
        if (sw) toggleActive(sw.dataset.maToggle, sw.checked);
    });

    const form = $('modal-mini-app-form');
    form?.addEventListener('click', (e) => {
        if (e.target.closest('[data-ma-form-close]')) closeMiniAppForm();
        else if (e.target.closest('[data-ma-save]')) saveForm();
        else if (e.target.closest('[data-ma-delete]')) deleteFromForm();
    });
    form?.addEventListener('input', (e) => {
        if (e.target.id === 'mini-app-name-input' || e.target.id === 'mini-app-icon-input') updatePreview();
    });

    window.openMiniAppsManager = openMiniAppsManager;
    window.closeMiniAppsManager = closeMiniAppsManager;
    window.closeMiniAppForm = closeMiniAppForm;
    window.refreshMiniApps = loadPageMiniApps;
}
