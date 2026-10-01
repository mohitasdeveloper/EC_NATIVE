// ============================================================
// ADMIN PANEL
// ============================================================
// Dynamically imported from main.js the same way verification.js is —
// zero cost for the 99% of users who aren't admins. Everything here talks
// to Postgres exclusively through the admin_* RPCs defined in
// supabase/admin_panel.sql (all SECURITY DEFINER, all check is_admin()
// server-side), never through direct table reads/writes — so this file
// carries no RLS assumptions of its own.
//
// Renders into the #settings-admin-panel shell already in index.html,
// reusing the app's existing primitives: openSettingsSubPanel/
// closeSettingsSubPanel for the panel itself, #modal-confirm-action for
// destructive confirmations, and window.openActionSheet for action menus —
// so this looks like a native part of the app, not a bolted-on screen.
// ============================================================

import { supabase } from './supabase.js';
import { showToast } from './ui.js';
import { timeAgo } from './utils.js';

let currentAdmin = null;
let activeTab = 'dashboard';
let detail = null; // { kind, item } of the CURRENT drilled-in view, else null
let detailStack = []; // ancestor frames beneath `detail`, for multi-level drill-down (see admin_insights.sql views)

const cache = {
    verifications: [], verificationsFilter: 'pending',
    reports: [], reportsFilter: 'pending_review',
    feedback: [], feedbackFilter: null,
    users: [], usersQuery: '',
    appVersions: [],
};

const TABS = [
    { id: 'dashboard', label: 'Overview', icon: 'space_dashboard' },
    { id: 'verifications', label: 'Verify', icon: 'verified_user' },
    { id: 'reports', label: 'Reports', icon: 'flag' },
    { id: 'feedback', label: 'Tickets', icon: 'support_agent' },
    { id: 'users', label: 'Users', icon: 'group' },
    { id: 'config', label: 'App Config', icon: 'tune' },
];

// ------------------------------------------------------------
// Small shared helpers
// ------------------------------------------------------------
function esc(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
function optAvatar(url) { return (typeof window.optimizeImageUrl === 'function') ? window.optimizeImageUrl(url, 'avatar') : url; }
function optImg(url) { return (typeof window.optimizeImageUrl === 'function') ? window.optimizeImageUrl(url, 'feed') : url; }
function fmtWhen(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · ${timeAgo(ts)}`;
}

const SKELETON = `
    <div class="flex items-center gap-4 p-3 mb-3 bg-surface-variant/10 dark:bg-neutral-900/40 rounded-2xl border border-surface-variant/30 dark:border-neutral-800">
        <div class="w-11 h-11 rounded-full shimmer-bg shrink-0"></div>
        <div class="flex-1">
            <div class="h-3.5 shimmer-bg rounded-md w-1/2 mb-2.5"></div>
            <div class="h-2.5 shimmer-bg rounded-md w-1/3"></div>
        </div>
    </div>
`.repeat(4);

function statusPill(status) {
    const map = {
        pending: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
        pending_review: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
        in_progress: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
        approved: 'bg-primary/10 text-primary',
        resolved: 'bg-primary/10 text-primary',
        rejected: 'bg-error/10 text-error',
        dismissed: 'bg-surface-variant/30 text-on-surface-variant dark:text-gray-400',
    };
    const cls = map[status] || 'bg-surface-variant/30 text-on-surface-variant dark:text-gray-400';
    return `<span class="text-[11px] font-bold px-2 py-1 rounded-md capitalize ${cls}">${esc((status || '').replace(/_/g, ' '))}</span>`;
}

function emptyState(icon, text) {
    return `
    <div class="flex flex-col items-center justify-center text-center py-16 text-on-surface-variant dark:text-gray-500">
        <span class="material-symbols-outlined text-[42px] mb-2 opacity-60">${icon}</span>
        <p class="text-[13.5px] font-semibold">${esc(text)}</p>
    </div>`;
}

function filterChip(label, value, current, onclick) {
    const active = value === current;
    return `<button onclick="${onclick}" class="shrink-0 px-3.5 py-1.5 rounded-full text-[12.5px] font-bold transition-colors ${active ? 'bg-primary text-white' : 'bg-surface-variant/30 dark:bg-neutral-800 text-on-surface-variant dark:text-gray-300'}">${esc(label)}</button>`;
}

function backRow(title) {
    return `
    <button onclick="window.__adminBackToList()" class="flex items-center gap-2 text-primary font-bold text-[13.5px] mb-3">
        <span class="material-symbols-outlined text-[20px]">arrow_back</span> Back
    </button>
    <h3 class="text-[17px] font-extrabold text-on-surface dark:text-gray-100 mb-4">${esc(title)}</h3>`;
}

// Confirmation modal — reuses #modal-confirm-action exactly the way
// feed.js's deletePost / hotposts.js / messages.js already do (clone the
// buttons to strip old listeners rather than stacking new ones on top).
// The modal is SHARED with those flows, whose Confirm button is red and says
// "Delete" and which never set the label themselves — so this always puts the
// button back the way it found it when the dialog closes (confirm, cancel or
// hardware back, which clicks Cancel). Without that, a later "delete post"
// confirm elsewhere in the app would inherit this dialog's label and colour.
const CONFIRM_DEFAULT_LABEL = 'Delete';
const CONFIRM_DANGER_CLASS = 'flex-1 bg-error text-white py-3.5 rounded-xl font-bold active:scale-95 transition-transform shadow-md shadow-error/20';
const CONFIRM_SAFE_CLASS = 'flex-1 bg-primary text-white py-3.5 rounded-xl font-bold active:scale-95 transition-transform shadow-md shadow-primary/20';

function confirmAction(title, message, onConfirm, confirmLabel = 'Confirm', danger = false) {
    const modal = document.getElementById('modal-confirm-action');
    if (!modal) return;

    document.getElementById('confirm-action-title').textContent = title;
    document.getElementById('confirm-action-message').textContent = message;

    const oldYes = document.getElementById('confirm-action-yes');
    const oldNo = document.getElementById('confirm-action-no');
    const yesBtn = oldYes.cloneNode(true);
    const noBtn = oldNo.cloneNode(true);
    yesBtn.textContent = confirmLabel;
    yesBtn.className = danger ? CONFIRM_DANGER_CLASS : CONFIRM_SAFE_CLASS;
    oldYes.parentNode.replaceChild(yesBtn, oldYes);
    oldNo.parentNode.replaceChild(noBtn, oldNo);

    const close = () => {
        modal.classList.replace('flex', 'hidden');
        yesBtn.textContent = CONFIRM_DEFAULT_LABEL;
        yesBtn.className = CONFIRM_DANGER_CLASS;
    };
    noBtn.addEventListener('click', close);
    yesBtn.addEventListener('click', async () => {
        close();
        await onConfirm();
    });

    modal.classList.replace('hidden', 'flex');
}

async function rpc(name, params = {}) {
    const { data, error } = await supabase.rpc(name, params);
    if (error) throw error;
    return data;
}

// ------------------------------------------------------------
// Boot
// ------------------------------------------------------------
export async function initAdmin(profile) {
    currentAdmin = profile;
    renderTabStrip();
    await switchTab('dashboard');
}

function renderTabStrip() {
    const strip = document.getElementById('admin-tab-strip');
    if (!strip) return;
    strip.innerHTML = TABS.map(t => `
        <button onclick="window.__adminSwitchTab('${t.id}')" class="shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[12.5px] font-bold transition-colors ${activeTab === t.id ? 'bg-primary/10 text-primary' : 'text-on-surface-variant dark:text-gray-400 hover:bg-surface-variant/20 dark:hover:bg-neutral-800'}">
            <span class="material-symbols-outlined text-[18px]">${t.icon}</span>${t.label}
        </button>
    `).join('');
}

window.__adminSwitchTab = async function (tabId) {
    activeTab = tabId;
    detail = null;
    detailStack = [];
    renderTabStrip();
    await switchTab(tabId);
};

// Pops one level: back to the previous drilled-in view if there is an
// ancestor on the stack (e.g. story-viewers -> that user's content list),
// otherwise all the way back to the tab's list. Existing top-level "Back"
// links (backRow()) call this unchanged — for those, the stack is always
// empty, so it behaves exactly as it did before this file grew multi-level
// drill-down.
window.__adminBackToList = function () {
    detail = detailStack.length ? detailStack.pop() : null;
    renderActiveTab();
};

// Hooked from main.js's hardware back-button router: returns true if it
// handled the back-press internally (drilled-in detail -> list), false if
// there's nothing to unwind so the caller should close the whole panel.
window.__adminHandleBack = function () {
    if (detail) { window.__adminBackToList(); return true; }
    return false;
};

// Drills one level deeper than the current view (user -> activity hub ->
// content list -> per-viewer list, etc). window.__adminOpenDetail (below)
// is for opening a fresh top-level row from a list tab and always resets the
// stack; this is for going further from wherever the admin already is.
window.__adminPushDetail = function (kind, item) {
    const nextItem = item !== undefined ? item : (detail ? detail.item : null);
    if (detail) detailStack.push(detail);
    detail = { kind, item: nextItem };
    renderActiveTab();
};

// A viewer/visitor/recipient row inside any of the new activity views links
// to that person's own admin User detail — fetched fresh (these rows only
// carry a few fields, not the full admin_search_users shape).
window.__adminOpenUserById = async function (userId) {
    try {
        const rows = await rpc('admin_get_user', { p_user_id: userId });
        if (!rows || !rows[0]) { showToast('User not found.', 'error'); return; }
        window.__adminPushDetail('user', rows[0]);
    } catch (e) { showToast(e.message || 'Failed to open user.', 'error'); }
};

async function switchTab(tabId) {
    const body = document.getElementById('admin-panel-body');
    if (body) body.innerHTML = SKELETON;
    await renderActiveTab();
}

async function renderActiveTab() {
    const body = document.getElementById('admin-panel-body');
    if (!body) return;
    try {
        // `return await` (not bare `return`) so a rejected render is caught by
        // this try/catch and shown as an error, instead of escaping it and
        // leaving the loading skeleton on screen forever.
        if (detail) {
            if (detail.kind === 'verification') return await renderVerificationDetail(body);
            if (detail.kind === 'report') return await renderReportDetail(body);
            if (detail.kind === 'feedback') return await renderFeedbackDetail(body);
            if (detail.kind === 'user') return await renderUserDetail(body);
            if (detail.kind === 'user_password') return await renderUserPassword(body);
            if (detail.kind === 'user_activity') return await renderUserActivityHub(body);
            if (detail.kind === 'user_content') return await renderUserContentList(body);
            if (detail.kind === 'post_viewers') return await renderPostViewers(body);
            if (detail.kind === 'story_viewers') return await renderStoryViewers(body);
            if (detail.kind === 'profile_visitors') return await renderProfileVisitors(body);
            if (detail.kind === 'user_feed') return await renderUserFeed(body);
        }
        if (activeTab === 'dashboard') return await renderDashboard(body);
        if (activeTab === 'verifications') return await renderVerificationsList(body);
        if (activeTab === 'reports') return await renderReportsList(body);
        if (activeTab === 'feedback') return await renderFeedbackList(body);
        if (activeTab === 'users') return await renderUsersTab(body);
        if (activeTab === 'config') return await renderConfigTab(body);
    } catch (err) {
        console.error('[admin]', err);
        body.innerHTML = `<div class="text-center py-16"><p class="text-error font-bold text-[13.5px] mb-1">Something went wrong</p><p class="text-on-surface-variant dark:text-gray-500 text-[12.5px]">${esc(err.message || String(err))}</p></div>`;
    }
}

// ------------------------------------------------------------
// 1. Dashboard
// ------------------------------------------------------------
async function renderDashboard(body) {
    const stats = await rpc('admin_get_dashboard_stats');
    const cards = [
        { key: 'pending_verifications', label: 'Pending Verifications', icon: 'badge', color: 'text-orange-500', tab: 'verifications' },
        { key: 'pending_reports', label: 'Pending Reports', icon: 'flag', color: 'text-error', tab: 'reports' },
        { key: 'open_tickets', label: 'Open Tickets', icon: 'support_agent', color: 'text-blue-500', tab: 'feedback' },
        { key: 'reported_posts', label: 'Reported Posts', icon: 'report', color: 'text-error', tab: 'reports' },
        { key: 'total_users', label: 'Total Users', icon: 'group', color: 'text-primary', tab: 'users' },
        { key: 'suspended_users', label: 'Suspended', icon: 'block', color: 'text-on-surface-variant', tab: 'users' },
    ];
    body.innerHTML = `
        <div class="grid grid-cols-2 gap-3">
            ${cards.map(c => `
                <button onclick="window.__adminSwitchTab('${c.tab}')" class="text-left bg-surface-variant/10 dark:bg-neutral-900/40 border border-surface-variant/30 dark:border-neutral-800 rounded-2xl p-4 hover:bg-surface-variant/20 dark:hover:bg-neutral-800/60 transition-colors">
                    <span class="material-symbols-outlined text-[24px] ${c.color}">${c.icon}</span>
                    <p class="text-2xl font-extrabold text-on-surface dark:text-gray-100 mt-2">${stats[c.key] ?? 0}</p>
                    <p class="text-[12px] font-semibold text-on-surface-variant dark:text-gray-400">${c.label}</p>
                </button>
            `).join('')}
        </div>
        <p class="text-[11.5px] text-on-surface-variant dark:text-gray-500 mt-5 text-center">Signed in as admin: ${esc(currentAdmin?.full_name || '')}</p>
    `;
}

// ------------------------------------------------------------
// 2. Verifications
// ------------------------------------------------------------
async function renderVerificationsList(body) {
    // No 'Approved' filter on purpose: the existing auto_delete_verification_data trigger deletes a
    // student's verification row the moment they become verified, so approved rows never exist to list.
    const filters = [['pending', 'Pending'], ['rejected', 'Rejected'], [null, 'All']];
    cache.verifications = await rpc('admin_list_verifications', { p_status: cache.verificationsFilter });

    body.innerHTML = `
        <div class="flex gap-2 overflow-x-auto hide-scrollbar pb-1 mb-4">
            ${filters.map(([val, label]) => filterChip(label, val, cache.verificationsFilter, `window.__adminSetFilter('verifications','${val}')`)).join('')}
        </div>
        <div id="admin-list-container" class="space-y-2.5"></div>
    `;
    const list = document.getElementById('admin-list-container');
    if (!cache.verifications.length) { list.innerHTML = emptyState('badge', 'No verification requests here.'); return; }

    list.innerHTML = cache.verifications.map((v, i) => `
        <button onclick="window.__adminOpenDetail('verification', ${i})" class="w-full text-left flex items-center gap-3 p-3 bg-surface-variant/10 dark:bg-neutral-900/40 border border-surface-variant/30 dark:border-neutral-800 rounded-2xl hover:bg-surface-variant/20 dark:hover:bg-neutral-800/60 transition-colors">
            <img src="${optAvatar(v.profile_img_url)}" class="w-11 h-11 rounded-full object-cover shrink-0 bg-surface-variant" onerror="this.style.visibility='hidden'">
            <div class="flex-1 min-w-0">
                <p class="font-bold text-[14px] text-on-surface dark:text-gray-100 truncate">${esc(v.legal_name)}</p>
                <p class="text-[12px] text-on-surface-variant dark:text-gray-400 truncate">${esc(v.student_id)} · ${esc(v.course || '')}</p>
            </div>
            ${statusPill(v.status)}
        </button>
    `).join('');
}

function renderVerificationDetail(body) {
    const v = detail.item;
    const isPending = v.status === 'pending';
    body.innerHTML = `
        ${backRow('Verification Request')}
        <div class="space-y-4">
            <div class="flex items-center gap-3">
                <img src="${optAvatar(v.profile_img_url)}" class="w-14 h-14 rounded-full object-cover bg-surface-variant">
                <div class="min-w-0">
                    <p class="font-extrabold text-[15px] text-on-surface dark:text-gray-100 truncate">${esc(v.legal_name)}</p>
                    <p class="text-[12.5px] text-on-surface-variant dark:text-gray-400 truncate">${esc(v.email)}</p>
                </div>
                <div class="ml-auto">${statusPill(v.status)}</div>
            </div>

            <div class="grid grid-cols-2 gap-3 text-[13px]">
                <div class="bg-surface-variant/10 dark:bg-neutral-900/40 rounded-xl p-3"><p class="text-on-surface-variant dark:text-gray-400 text-[11px] font-bold uppercase mb-1">Student ID</p><p class="font-bold text-on-surface dark:text-gray-100">${esc(v.student_id)}</p></div>
                <div class="bg-surface-variant/10 dark:bg-neutral-900/40 rounded-xl p-3"><p class="text-on-surface-variant dark:text-gray-400 text-[11px] font-bold uppercase mb-1">Course</p><p class="font-bold text-on-surface dark:text-gray-100">${esc(v.course || '—')}</p></div>
            </div>

            <div>
                <p class="text-[11px] font-bold uppercase text-on-surface-variant dark:text-gray-400 mb-2">ID Card</p>
                <img src="${optImg(v.id_card_url)}" class="w-full rounded-xl border border-surface-variant/30 dark:border-neutral-800 object-cover">
            </div>
            ${v.selfie_url ? `
            <div>
                <p class="text-[11px] font-bold uppercase text-on-surface-variant dark:text-gray-400 mb-2">Selfie</p>
                <img src="${optImg(v.selfie_url)}" class="w-full rounded-xl border border-surface-variant/30 dark:border-neutral-800 object-cover">
            </div>` : ''}

            ${v.rejection_reason ? `<div class="bg-error/10 text-error rounded-xl p-3 text-[13px]"><span class="font-bold">Rejection reason:</span> ${esc(v.rejection_reason)}</div>` : ''}

            ${isPending ? `
            <div class="space-y-2 pt-2">
                <textarea id="admin-verify-reject-reason" placeholder="Reason (required to reject)..." class="w-full bg-surface-variant/30 dark:bg-neutral-900/50 border border-surface-variant/50 dark:border-neutral-700 rounded-xl p-3 text-[13.5px] outline-none focus:border-primary text-on-surface dark:text-white h-20 resize-none"></textarea>
                <div class="flex gap-3">
                    <button onclick="window.__adminRejectVerification()" class="flex-1 bg-error/10 text-error font-bold py-3 rounded-xl active:scale-95 transition-transform">Reject</button>
                    <button onclick="window.__adminApproveVerification()" class="flex-1 bg-primary text-white font-bold py-3 rounded-xl active:scale-95 transition-transform">Approve</button>
                </div>
            </div>` : ''}
        </div>
    `;
}

window.__adminOpenDetail = function (kind, index) {
    const item = kind === 'verification' ? cache.verifications[index]
        : kind === 'report' ? cache.reports[index]
        : kind === 'feedback' ? cache.feedback[index]
        : kind === 'user' ? cache.users[index]
        : null;
    if (!item) return;
    detail = { kind, item };
    detailStack = []; // opening a fresh row from a list always starts a new drill-down
    renderActiveTab();
};

window.__adminApproveVerification = function () {
    const v = detail.item;
    confirmAction('Approve verification?', `${v.legal_name} will be marked as a verified student.`, async () => {
        try {
            await rpc('admin_review_verification', { p_verification_id: v.id, p_approve: true });
            showToast('Verification approved.', 'success');
            detail = null;
            detailStack = [];
            cache.verificationsFilter = 'pending';
            await renderActiveTab();
        } catch (e) { showToast(e.message || 'Failed to approve.', 'error'); }
    }, 'Approve');
};

window.__adminRejectVerification = function () {
    const v = detail.item;
    const reason = document.getElementById('admin-verify-reject-reason')?.value.trim();
    if (!reason) { showToast('Please enter a rejection reason.', 'warning'); return; }
    confirmAction('Reject verification?', `${v.legal_name} will be asked to resubmit.`, async () => {
        try {
            await rpc('admin_review_verification', { p_verification_id: v.id, p_approve: false, p_rejection_reason: reason });
            showToast('Verification rejected.', 'success');
            detail = null;
            detailStack = [];
            await renderActiveTab();
        } catch (e) { showToast(e.message || 'Failed to reject.', 'error'); }
    }, 'Reject', true);
};

// ------------------------------------------------------------
// 3. Reports
// ------------------------------------------------------------
async function renderReportsList(body) {
    const filters = [['pending_review', 'Pending'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed'], [null, 'All']];
    cache.reports = await rpc('admin_list_reports', { p_status: cache.reportsFilter });

    body.innerHTML = `
        <div class="flex gap-2 overflow-x-auto hide-scrollbar pb-1 mb-4">
            ${filters.map(([val, label]) => filterChip(label, val, cache.reportsFilter, `window.__adminSetFilter('reports','${val}')`)).join('')}
        </div>
        <div id="admin-list-container" class="space-y-2.5"></div>
    `;
    const list = document.getElementById('admin-list-container');
    if (!cache.reports.length) { list.innerHTML = emptyState('flag', 'No reports here.'); return; }

    list.innerHTML = cache.reports.map((r, i) => {
        const target = r.reported_post_id
            ? `Post by ${esc(r.reported_post_author_name || 'Unknown')}${r.reported_post_deleted ? ' (deleted)' : ''}`
            : `${esc(r.reported_user_name || 'Unknown user')}${r.reported_user_suspended ? ' (suspended)' : ''}`;
        return `
        <button onclick="window.__adminOpenDetail('report', ${i})" class="w-full text-left p-3 bg-surface-variant/10 dark:bg-neutral-900/40 border border-surface-variant/30 dark:border-neutral-800 rounded-2xl hover:bg-surface-variant/20 dark:hover:bg-neutral-800/60 transition-colors">
            <div class="flex items-center justify-between mb-1">
                <p class="font-bold text-[13.5px] text-on-surface dark:text-gray-100 truncate">${target}</p>
                ${statusPill(r.status)}
            </div>
            <p class="text-[12px] text-on-surface-variant dark:text-gray-400">Reported by ${esc(r.reporter_name || 'Unknown')} · ${esc(r.reason)}</p>
        </button>`;
    }).join('');
}

function renderReportDetail(body) {
    const r = detail.item;
    const isPost = !!r.reported_post_id;
    const isPending = r.status === 'pending_review';
    body.innerHTML = `
        ${backRow('Report')}
        <div class="space-y-4">
            <div class="flex items-center justify-between">
                <p class="text-[12.5px] text-on-surface-variant dark:text-gray-400">${fmtWhen(r.created_at)}</p>
                ${statusPill(r.status)}
            </div>

            <div class="bg-surface-variant/10 dark:bg-neutral-900/40 rounded-xl p-3 text-[13px] space-y-1">
                <p><span class="font-bold text-on-surface-variant dark:text-gray-400">Reported by:</span> ${esc(r.reporter_name)}</p>
                <p><span class="font-bold text-on-surface-variant dark:text-gray-400">Reason:</span> ${esc(r.reason)}</p>
                ${r.description ? `<p><span class="font-bold text-on-surface-variant dark:text-gray-400">Details:</span> ${esc(r.description)}</p>` : ''}
            </div>

            ${isPost ? `
            <div class="bg-surface-variant/10 dark:bg-neutral-900/40 rounded-xl p-3">
                <p class="text-[11px] font-bold uppercase text-on-surface-variant dark:text-gray-400 mb-1">Reported Post ${r.reported_post_deleted ? '(already deleted)' : ''}</p>
                <p class="text-[13.5px] text-on-surface dark:text-gray-100 whitespace-pre-wrap">${esc(r.reported_post_content || '')}</p>
                <p class="text-[12px] text-on-surface-variant dark:text-gray-400 mt-1">by ${esc(r.reported_post_author_name || 'Unknown')}</p>
            </div>` : `
            <div class="bg-surface-variant/10 dark:bg-neutral-900/40 rounded-xl p-3">
                <p class="text-[11px] font-bold uppercase text-on-surface-variant dark:text-gray-400 mb-1">Reported User ${r.reported_user_suspended ? '(suspended)' : ''}</p>
                <p class="text-[13.5px] font-bold text-on-surface dark:text-gray-100">${esc(r.reported_user_name || 'Unknown')}</p>
            </div>`}

            ${isPending ? `
            <div class="space-y-2 pt-2">
                ${isPost ? `
                <button onclick="window.__adminModeratePost(false, true)" class="w-full flex items-center justify-center gap-2 bg-primary/10 text-primary font-bold py-3 rounded-xl active:scale-95 transition-transform"><span class="material-symbols-outlined text-[18px]">verified</span>Mark post as fine & protect</button>
                <button onclick="window.__adminModeratePost(true, false)" class="w-full flex items-center justify-center gap-2 bg-error/10 text-error font-bold py-3 rounded-xl active:scale-95 transition-transform"><span class="material-symbols-outlined text-[18px]">delete</span>Delete post</button>
                ` : `
                <button onclick="window.__adminSuspendReportedUser(${r.reported_user_suspended ? 'false' : 'true'})" class="w-full flex items-center justify-center gap-2 bg-orange-500/10 text-orange-600 dark:text-orange-500 font-bold py-3 rounded-xl active:scale-95 transition-transform"><span class="material-symbols-outlined text-[18px]">block</span>${r.reported_user_suspended ? 'Unsuspend user' : 'Suspend user'}</button>
                `}
                <button onclick="window.__adminSetReportStatus('dismissed')" class="w-full bg-surface-variant/30 dark:bg-neutral-800 text-on-surface dark:text-gray-200 font-bold py-3 rounded-xl active:scale-95 transition-transform">Dismiss report</button>
                <button onclick="window.__adminSetReportStatus('resolved')" class="w-full bg-surface-variant/30 dark:bg-neutral-800 text-on-surface dark:text-gray-200 font-bold py-3 rounded-xl active:scale-95 transition-transform">Mark resolved (no action)</button>
            </div>` : ''}
        </div>
    `;
}

window.__adminSetReportStatus = function (status) {
    const r = detail.item;
    confirmAction('Update report?', `This report will be marked as ${status}.`, async () => {
        try {
            await rpc('admin_set_report_status', { p_report_id: r.id, p_status: status });
            showToast('Report updated.', 'success');
            detail = null;
            detailStack = [];
            await renderActiveTab();
        } catch (e) { showToast(e.message || 'Failed to update report.', 'error'); }
    }, 'Confirm');
};

window.__adminModeratePost = function (del, verify) {
    const r = detail.item;
    const title = del ? 'Delete this post?' : 'Protect this post?';
    const msg = del ? 'This will permanently remove the post.' : 'This clears the report and blocks future reports on this post.';
    confirmAction(title, msg, async () => {
        try {
            await rpc('admin_moderate_post', { p_post_id: r.reported_post_id, p_delete: del, p_verify: verify });
            await rpc('admin_set_report_status', { p_report_id: r.id, p_status: 'resolved' });
            showToast('Done.', 'success');
            detail = null;
            detailStack = [];
            await renderActiveTab();
        } catch (e) { showToast(e.message || 'Failed to moderate post.', 'error'); }
    }, del ? 'Delete' : 'Protect', del);
};

window.__adminSuspendReportedUser = function (suspend) {
    const r = detail.item;
    confirmAction(suspend ? 'Suspend user?' : 'Unsuspend user?', `${r.reported_user_name || 'This user'} will ${suspend ? 'be signed out and unable to log back in' : 'be able to log in again'}.`, async () => {
        try {
            await rpc('admin_update_user', { p_user_id: r.reported_user_id, p_is_suspended: suspend });
            await rpc('admin_set_report_status', { p_report_id: r.id, p_status: 'resolved' });
            showToast('Done.', 'success');
            detail = null;
            detailStack = [];
            await renderActiveTab();
        } catch (e) { showToast(e.message || 'Failed to update user.', 'error'); }
    }, suspend ? 'Suspend' : 'Unsuspend', suspend);
};

// ------------------------------------------------------------
// 4. Feedback / tickets
// ------------------------------------------------------------
async function renderFeedbackList(body) {
    const filters = [[null, 'All'], ['pending', 'Pending'], ['in_progress', 'In Progress'], ['resolved', 'Resolved']];
    cache.feedback = await rpc('admin_list_feedback', { p_status: cache.feedbackFilter });

    body.innerHTML = `
        <div class="flex gap-2 overflow-x-auto hide-scrollbar pb-1 mb-4">
            ${filters.map(([val, label]) => filterChip(label, val, cache.feedbackFilter, `window.__adminSetFilter('feedback','${val}')`)).join('')}
        </div>
        <div id="admin-list-container" class="space-y-2.5"></div>
    `;
    const list = document.getElementById('admin-list-container');
    if (!cache.feedback.length) { list.innerHTML = emptyState('support_agent', 'No tickets here.'); return; }

    list.innerHTML = cache.feedback.map((f, i) => `
        <button onclick="window.__adminOpenDetail('feedback', ${i})" class="w-full text-left p-3 bg-surface-variant/10 dark:bg-neutral-900/40 border border-surface-variant/30 dark:border-neutral-800 rounded-2xl hover:bg-surface-variant/20 dark:hover:bg-neutral-800/60 transition-colors">
            <div class="flex items-center justify-between mb-1">
                <p class="font-bold text-[13.5px] text-on-surface dark:text-gray-100 truncate">${esc(f.full_name || 'Unknown')} <span class="font-medium text-on-surface-variant dark:text-gray-500 capitalize">· ${esc(f.type)}</span></p>
                ${statusPill(f.status)}
            </div>
            <p class="text-[12px] text-on-surface-variant dark:text-gray-400 truncate">${esc(f.description)}</p>
        </button>
    `).join('');
}

function renderFeedbackDetail(body) {
    const f = detail.item;
    body.innerHTML = `
        ${backRow('Support Ticket')}
        <div class="space-y-4">
            <div class="flex items-center justify-between">
                <p class="font-bold text-[14px] text-on-surface dark:text-gray-100">${esc(f.full_name || 'Unknown')}</p>
                ${statusPill(f.status)}
            </div>
            <p class="text-[12px] text-on-surface-variant dark:text-gray-400 -mt-3">${esc(f.email || '')} · ${fmtWhen(f.created_at)}</p>

            <div class="bg-surface-variant/10 dark:bg-neutral-900/40 rounded-xl p-3">
                <p class="text-[11px] font-bold uppercase text-on-surface-variant dark:text-gray-400 mb-1 capitalize">${esc(f.type)}</p>
                <p class="text-[13.5px] text-on-surface dark:text-gray-100 whitespace-pre-wrap">${esc(f.description)}</p>
            </div>
            ${f.media_url ? `<img src="${optImg(f.media_url)}" class="w-full rounded-xl border border-surface-variant/30 dark:border-neutral-800 object-cover">` : ''}

            ${f.admin_reply ? `<div class="bg-primary/10 text-on-surface dark:text-gray-100 rounded-xl p-3 text-[13px]"><span class="font-bold text-primary">Previous reply:</span> ${esc(f.admin_reply)}</div>` : ''}

            <div class="space-y-2 pt-2">
                <textarea id="admin-feedback-reply" placeholder="Write a reply..." class="w-full bg-surface-variant/30 dark:bg-neutral-900/50 border border-surface-variant/50 dark:border-neutral-700 rounded-xl p-3 text-[13.5px] outline-none focus:border-primary text-on-surface dark:text-white h-24 resize-none">${esc(f.admin_reply || '')}</textarea>
                <select id="admin-feedback-status" class="w-full bg-surface-variant/30 dark:bg-neutral-900/50 border border-surface-variant/50 dark:border-neutral-700 rounded-xl p-3 text-[13.5px] outline-none text-on-surface dark:text-white">
                    <option value="in_progress" ${f.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
                    <option value="resolved" ${f.status === 'resolved' ? 'selected' : ''}>Resolved</option>
                    <option value="pending" ${f.status === 'pending' ? 'selected' : ''}>Pending</option>
                </select>
                <button onclick="window.__adminSendFeedbackReply()" class="w-full bg-primary text-white font-bold py-3 rounded-xl active:scale-95 transition-transform">Send Reply</button>
            </div>
        </div>
    `;
}

window.__adminSendFeedbackReply = async function () {
    const f = detail.item;
    const reply = document.getElementById('admin-feedback-reply')?.value.trim();
    const status = document.getElementById('admin-feedback-status')?.value;
    if (!reply) { showToast('Reply cannot be empty.', 'warning'); return; }
    try {
        await rpc('admin_reply_feedback', { p_feedback_id: f.id, p_reply: reply, p_status: status });
        showToast('Reply sent.', 'success');
        detail = null;
        detailStack = [];
        await renderActiveTab();
    } catch (e) { showToast(e.message || 'Failed to send reply.', 'error'); }
};

// ------------------------------------------------------------
// 5. Users
// ------------------------------------------------------------
async function renderUsersTab(body) {
    body.innerHTML = `
        <div class="relative mb-4">
            <div class="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-on-surface-variant"><span class="material-symbols-outlined text-[20px]">search</span></div>
            <input type="text" id="admin-user-search" value="${esc(cache.usersQuery)}" placeholder="Search name, email or student ID..." class="w-full bg-surface-variant/30 dark:bg-neutral-900/50 border border-surface-variant/50 dark:border-neutral-700 text-on-surface dark:text-gray-100 text-[14px] rounded-xl focus:ring-primary focus:border-primary block pl-10 p-3 outline-none transition-colors">
        </div>
        <div id="admin-list-container" class="space-y-2.5"></div>
    `;
    const input = document.getElementById('admin-user-search');
    let debounceTimer;
    input.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => { cache.usersQuery = e.target.value.trim(); loadUsers(); }, 350);
    });
    await loadUsers();
}

async function loadUsers() {
    const list = document.getElementById('admin-list-container');
    if (!list) return;
    list.innerHTML = SKELETON;
    // Also reached from the search box's debounce timer, where nothing else
    // would catch a failure — so handle it here rather than leave the skeleton up.
    try {
        cache.users = await rpc('admin_search_users', { p_query: cache.usersQuery || null });
    } catch (err) {
        console.error('[admin]', err);
        list.innerHTML = emptyState('error', err.message || 'Search failed.');
        return;
    }
    if (!cache.users.length) { list.innerHTML = emptyState('person_search', 'No users found.'); return; }

    list.innerHTML = cache.users.map((u, i) => `
        <button onclick="window.__adminOpenDetail('user', ${i})" class="w-full text-left flex items-center gap-3 p-3 bg-surface-variant/10 dark:bg-neutral-900/40 border border-surface-variant/30 dark:border-neutral-800 rounded-2xl hover:bg-surface-variant/20 dark:hover:bg-neutral-800/60 transition-colors">
            <img src="${optAvatar(u.profile_img_url)}" class="w-11 h-11 rounded-full object-cover shrink-0 bg-surface-variant" onerror="this.style.visibility='hidden'">
            <div class="flex-1 min-w-0">
                <p class="font-bold text-[14px] text-on-surface dark:text-gray-100 truncate flex items-center gap-1">
                    ${esc(u.full_name)}
                    ${u.is_admin ? '<span class="material-symbols-outlined text-[15px] text-primary">shield_person</span>' : ''}
                    ${u.role === 'page' ? '<span class="text-[10px] font-bold bg-blue-500/10 text-blue-500 px-1.5 py-0.5 rounded">PAGE</span>' : ''}
                </p>
                <p class="text-[12px] text-on-surface-variant dark:text-gray-400 truncate">${esc(u.email)}</p>
            </div>
            ${u.is_suspended ? '<span class="text-[10px] font-bold bg-orange-500/10 text-orange-500 px-1.5 py-0.5 rounded shrink-0">SUSPENDED</span>' : ''}
            ${u.is_deactivated ? '<span class="text-[10px] font-bold bg-surface-variant/40 text-on-surface-variant px-1.5 py-0.5 rounded shrink-0">PAUSED</span>' : ''}
            ${u.is_deleted ? '<span class="text-[10px] font-bold bg-error/10 text-error px-1.5 py-0.5 rounded shrink-0">DEL</span>' : ''}
        </button>
    `).join('');
}

const TICK_PRESETS = [
    { label: 'None', value: 'none' },
    { label: 'Blue', value: '#1877F2' },
    { label: 'Gold', value: '#F2B705' },
    { label: 'Green', value: '#10b981' },
];

function renderUserDetail(body) {
    const u = detail.item;
    const isSelf = currentAdmin && u.id === currentAdmin.id;
    tickDraft = hexToHsl(u.tick_type) || { h: 214, l: 52 };
    body.innerHTML = `
        ${backRow('User')}
        <div class="space-y-4">
            <div class="flex items-center gap-3">
                <img src="${optAvatar(u.profile_img_url)}" class="w-14 h-14 rounded-full object-cover bg-surface-variant">
                <div class="min-w-0">
                    <p class="font-extrabold text-[15px] text-on-surface dark:text-gray-100 truncate">${esc(u.full_name)}</p>
                    <p class="text-[12.5px] text-on-surface-variant dark:text-gray-400 truncate">${esc(u.email)}</p>
                </div>
            </div>

            <button onclick="window.__adminPushDetail('user_activity')" class="w-full flex items-center justify-between p-3.5 bg-primary/10 text-primary rounded-2xl font-bold text-[14px] active:scale-[0.98] transition-transform">
                <span class="flex items-center gap-2"><span class="material-symbols-outlined text-[20px]">history</span> Activity &amp; Insights</span>
                <span class="material-symbols-outlined text-[20px]">chevron_right</span>
            </button>

            <div class="grid grid-cols-2 gap-3 text-[13px]">
                <div class="bg-surface-variant/10 dark:bg-neutral-900/40 rounded-xl p-3"><p class="text-on-surface-variant dark:text-gray-400 text-[11px] font-bold uppercase mb-1">Student ID</p><p class="font-bold text-on-surface dark:text-gray-100">${esc(u.student_id || '—')}</p></div>
                <div class="bg-surface-variant/10 dark:bg-neutral-900/40 rounded-xl p-3"><p class="text-on-surface-variant dark:text-gray-400 text-[11px] font-bold uppercase mb-1">Connections</p><p class="font-bold text-on-surface dark:text-gray-100">${u.connection_count ?? 0}</p></div>
                <div class="bg-surface-variant/10 dark:bg-neutral-900/40 rounded-xl p-3"><p class="text-on-surface-variant dark:text-gray-400 text-[11px] font-bold uppercase mb-1">Course</p><p class="font-bold text-on-surface dark:text-gray-100">${esc(u.course || '—')}</p></div>
                <div class="bg-surface-variant/10 dark:bg-neutral-900/40 rounded-xl p-3"><p class="text-on-surface-variant dark:text-gray-400 text-[11px] font-bold uppercase mb-1">College</p><p class="font-bold text-on-surface dark:text-gray-100">${esc(u.college || '—')}</p></div>
            </div>

            <!-- Role -->
            <div>
                <p class="text-[11px] font-bold uppercase text-on-surface-variant dark:text-gray-400 mb-2">Account Type</p>
                <div class="flex gap-2">
                    ${['student', 'page'].map(role => `
                        <button onclick="window.__adminSetRole('${role}')" class="flex-1 py-2.5 rounded-xl text-[13px] font-bold transition-colors ${u.role === role ? 'bg-primary text-white' : 'bg-surface-variant/30 dark:bg-neutral-800 text-on-surface dark:text-gray-200'}">${role === 'page' ? 'Page' : 'Student'}</button>
                    `).join('')}
                </div>
            </div>

            <!-- Verification status -->
            <div>
                <p class="text-[11px] font-bold uppercase text-on-surface-variant dark:text-gray-400 mb-2">Verification Status</p>
                <div class="grid grid-cols-2 gap-2">
                    ${['unverified', 'pending', 'verified', 'rejected'].map(st => `
                        <button onclick="window.__adminSetVerificationStatus('${st}')" class="py-2 rounded-xl text-[12.5px] font-bold capitalize transition-colors ${u.verification_status === st ? 'bg-primary text-white' : 'bg-surface-variant/30 dark:bg-neutral-800 text-on-surface dark:text-gray-200'}">${st}</button>
                    `).join('')}
                </div>
            </div>

            <!-- Verified tick badge -->
            <div>
                <p class="text-[11px] font-bold uppercase text-on-surface-variant dark:text-gray-400 mb-2">Verified Tick Badge</p>
                <div class="flex gap-2 flex-wrap">
                    ${TICK_PRESETS.map(p => `
                        <button onclick="window.__adminSetTick('${p.value}')" class="px-3 py-2 rounded-xl text-[12.5px] font-bold transition-colors flex items-center gap-1.5 ${u.tick_type === p.value ? 'bg-primary text-white' : 'bg-surface-variant/30 dark:bg-neutral-800 text-on-surface dark:text-gray-200'}">
                            ${p.value !== 'none' ? `<span class="material-symbols-outlined text-[15px]" style="color:${p.value === u.tick_type ? '#fff' : p.value}">verified</span>` : ''}${p.label}
                        </button>
                    `).join('')}
                </div>
                ${tickRingHtml()}
            </div>

            <!-- Toggles -->
            <div class="space-y-1">
                ${toggleRow('special_post', 'Can post Polls / Events', u.special_post)}
                ${toggleRow('is_volunteer', 'Volunteer', u.is_volunteer)}
                ${toggleRow('is_admin', 'Admin Access', u.is_admin, isSelf)}
            </div>

            ${!u.is_admin ? `
            <button onclick="window.__adminPushDetail('user_password')" class="w-full flex items-center justify-between p-3.5 bg-surface-variant/20 dark:bg-neutral-800 text-on-surface dark:text-gray-100 rounded-2xl font-bold text-[14px] active:scale-[0.98] transition-transform">
                <span class="flex items-center gap-2"><span class="material-symbols-outlined text-[20px]">key</span> Reset Password</span>
                <span class="material-symbols-outlined text-[20px]">chevron_right</span>
            </button>` : ''}

            <!-- Danger zone -->
            <div class="border-t border-surface-variant/30 dark:border-neutral-800 pt-4 space-y-2">
                ${!isSelf ? `
                <button onclick="window.__adminToggleSuspend()" class="w-full flex items-center justify-between p-3 bg-orange-500/10 text-orange-600 dark:text-orange-500 rounded-xl font-bold text-[14px]">
                    <span>${u.is_suspended ? 'Unsuspend Account' : 'Suspend Account'}</span>
                    <span class="material-symbols-outlined text-[20px]">block</span>
                </button>
                <button onclick="window.__adminToggleDelete()" class="w-full flex items-center justify-between p-3 bg-error/10 text-error rounded-xl font-bold text-[14px]">
                    <span>${u.is_deleted ? 'Restore Account' : 'Delete Account'}</span>
                    <span class="material-symbols-outlined text-[20px]">delete_forever</span>
                </button>` : ''}
            </div>
        </div>
    `;
    bindTickRing();
}

function toggleRow(field, label, checked, disabled = false) {
    return `
    <div class="flex items-center justify-between p-3 hover:bg-surface-variant/20 dark:hover:bg-neutral-800 rounded-xl transition-colors ${disabled ? 'opacity-50' : ''}">
        <span class="text-[13.5px] font-bold text-on-surface dark:text-gray-200">${esc(label)}</span>
        <label class="relative inline-flex items-center ${disabled ? '' : 'cursor-pointer'}">
            <input type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} onchange="window.__adminToggleField('${field}', this.checked)" class="sr-only peer">
            <div class="w-9 h-5 bg-surface-variant dark:bg-neutral-700 rounded-full peer peer-checked:bg-primary peer-checked:after:translate-x-full after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all"></div>
        </label>
    </div>`;
}

// ---- Tick colour ring -------------------------------------------------
// A hue ring you drag around, plus a brightness slider, for any badge colour.
// The ring is a conic-gradient masked into a donut; dragging maps the pointer
// angle (0deg = top, clockwise — the same as conic-gradient) to a hue. Saturation
// is fixed so every pick looks like a proper badge colour. Nothing is saved until
// "Apply colour"; the value sent is always #RRGGBB (the SQL validates that too).
const RING_SIZE = 168;
const RING_THICK = 24;
const RING_SAT = 88;
let tickDraft = { h: 214, l: 52 };

function hslToHex(h, sat, light) {
    const s = sat / 100, l = light / 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const hex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
    return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`.toUpperCase();
}

// Returns { h, l } (hue degrees, lightness 30-75) for a #RRGGBB string, else null.
function hexToHsl(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h = (h * 60 + 360) % 360;
    }
    const l = ((max + min) / 2) * 100;
    return { h: Math.round(h), l: Math.min(75, Math.max(30, Math.round(l))) };
}

function tickRingHtml() {
    const hex = hslToHex(tickDraft.h, RING_SAT, tickDraft.l);
    const stops = [0, 60, 120, 180, 240, 300, 360].map((d) => `hsl(${d},${RING_SAT}%,50%)`).join(',');
    const mask = `radial-gradient(farthest-side, transparent calc(100% - ${RING_THICK}px), #000 calc(100% - ${RING_THICK - 1}px))`;
    return `
        <div class="mt-3 rounded-2xl bg-surface-variant/10 dark:bg-neutral-900/40 border border-surface-variant/30 dark:border-neutral-800 p-4">
            <p class="text-[11px] font-bold uppercase text-on-surface-variant dark:text-gray-400 mb-3">Custom colour</p>
            <div class="flex justify-center">
                <div id="admin-tick-ring" style="position:relative;width:${RING_SIZE}px;height:${RING_SIZE}px;touch-action:none;cursor:pointer;">
                    <div style="position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,${stops});-webkit-mask:${mask};mask:${mask};"></div>
                    <div id="admin-tick-thumb" style="position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.25),0 2px 6px rgba(0,0,0,.35);background:${hex};pointer-events:none;${thumbPos()}"></div>
                    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;">
                        <span id="admin-tick-preview" class="material-symbols-outlined" style="font-size:56px;color:${hex};font-variation-settings:'FILL' 1, 'wght' 400;">verified</span>
                    </div>
                </div>
            </div>
            <div class="mt-4">
                <div class="flex items-center justify-between mb-1">
                    <label for="admin-tick-light" class="text-[11px] font-bold uppercase text-on-surface-variant dark:text-gray-400">Brightness</label>
                    <span id="admin-tick-hex" class="text-[12.5px] font-bold text-on-surface dark:text-gray-100 tracking-wide">${hex}</span>
                </div>
                <input type="range" id="admin-tick-light" min="30" max="75" value="${tickDraft.l}" oninput="window.__adminTickLight(this.value)" style="width:100%;accent-color:${hex};">
            </div>
            <button onclick="window.__adminApplyTickColor()" class="w-full mt-3 bg-primary text-white font-bold py-2.5 rounded-xl active:scale-95 transition-transform">Apply colour</button>
        </div>`;
}

function thumbPos() {
    const half = RING_SIZE / 2, r = half - RING_THICK / 2;
    const rad = (tickDraft.h * Math.PI) / 180;
    return `left:${(half + r * Math.sin(rad)).toFixed(1)}px;top:${(half - r * Math.cos(rad)).toFixed(1)}px;`;
}

function updateTickRingUi() {
    const hex = hslToHex(tickDraft.h, RING_SAT, tickDraft.l);
    const half = RING_SIZE / 2, r = half - RING_THICK / 2;
    const rad = (tickDraft.h * Math.PI) / 180;
    const thumb = document.getElementById('admin-tick-thumb');
    if (thumb) {
        thumb.style.left = `${(half + r * Math.sin(rad)).toFixed(1)}px`;
        thumb.style.top = `${(half - r * Math.cos(rad)).toFixed(1)}px`;
        thumb.style.background = hex;
    }
    const preview = document.getElementById('admin-tick-preview');
    if (preview) preview.style.color = hex;
    const label = document.getElementById('admin-tick-hex');
    if (label) label.textContent = hex;
    const slider = document.getElementById('admin-tick-light');
    if (slider) slider.style.accentColor = hex;
}

function bindTickRing() {
    const ring = document.getElementById('admin-tick-ring');
    if (!ring || typeof ring.addEventListener !== 'function') return;
    let dragging = false;
    const setFromPointer = (e) => {
        const rect = ring.getBoundingClientRect();
        const dx = e.clientX - (rect.left + rect.width / 2);
        const dy = e.clientY - (rect.top + rect.height / 2);
        return { dx, dy };
    };
    const setHue = ({ dx, dy }) => {
        tickDraft.h = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360);
        updateTickRingUi();
    };
    ring.addEventListener('pointerdown', (e) => {
        const p = setFromPointer(e);
        // The hole in the middle is just the preview, not part of the ring.
        if (Math.hypot(p.dx, p.dy) < RING_SIZE / 2 - RING_THICK - 6) return;
        dragging = true;
        try { ring.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        setHue(p);
        if (typeof e.preventDefault === 'function') e.preventDefault();
    });
    ring.addEventListener('pointermove', (e) => { if (dragging) setHue(setFromPointer(e)); });
    const end = () => { dragging = false; };
    ring.addEventListener('pointerup', end);
    ring.addEventListener('pointercancel', end);
}

window.__adminTickLight = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    tickDraft.l = Math.min(75, Math.max(30, n));
    updateTickRingUi();
};
window.__adminApplyTickColor = () => patchUser({ p_tick_type: hslToHex(tickDraft.h, RING_SAT, tickDraft.l) }, 'Badge colour updated.');

// ---- Reset password ---------------------------------------------------
// Sub-view of a user (detail.kind 'user_password'). The admin types or
// generates a new password; admin_reset_user_password writes it and signs the
// user out everywhere. The password is only ever shown on this screen.
function generatePassword(len = 12) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // no look-alikes (0/O, 1/l/I)
    const buf = new Uint32Array(len);
    globalThis.crypto.getRandomValues(buf);
    return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

function passwordFormHtml() {
    return `
        <p class="text-[12.5px] text-on-surface-variant dark:text-gray-400">Set a new password for this account. They will be signed out on every device and need this password to log back in. Share it with them privately and ask them to change it from Settings afterwards.</p>
        <div>
            <label for="admin-pw-input" class="text-[11px] font-bold uppercase text-on-surface-variant dark:text-gray-400">New password</label>
            <div class="flex gap-2 mt-1">
                <input type="text" id="admin-pw-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="At least 8 characters" class="flex-1 min-w-0 bg-surface-variant/30 dark:bg-neutral-900/50 border border-surface-variant/50 dark:border-neutral-700 text-on-surface dark:text-gray-100 text-[14px] rounded-xl p-3 outline-none focus:border-primary">
                <button onclick="window.__adminGeneratePassword()" aria-label="Generate a password" class="shrink-0 px-3 rounded-xl bg-surface-variant/30 dark:bg-neutral-800 text-on-surface dark:text-gray-100 active:scale-95 transition-transform">
                    <span class="material-symbols-outlined text-[20px]">refresh</span>
                </button>
            </div>
        </div>
        <button onclick="window.__adminSubmitPasswordReset()" class="w-full bg-primary text-white font-bold py-3 rounded-xl active:scale-95 transition-transform">Set New Password</button>`;
}

function passwordDoneHtml(name, password) {
    return `
        <div class="rounded-2xl bg-green-500/10 p-4 text-center">
            <span class="material-symbols-outlined text-[32px] text-green-600 dark:text-green-500">check_circle</span>
            <p class="font-extrabold text-[14px] text-on-surface dark:text-gray-100 mt-1">Password updated for ${esc(name)}</p>
            <p class="text-[12px] text-on-surface-variant dark:text-gray-400 mt-1">They've been signed out everywhere. Share this with them privately — it won't be shown again once you leave this screen.</p>
            <p id="admin-pw-final" class="mt-3 select-all font-mono text-[16px] font-bold tracking-wider text-on-surface dark:text-gray-100 break-all">${esc(password)}</p>
            <button onclick="window.__adminCopyPassword()" class="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-white font-bold text-[13px] active:scale-95 transition-transform">
                <span class="material-symbols-outlined text-[18px]">content_copy</span> Copy
            </button>
        </div>`;
}

function renderUserPassword(body) {
    const u = detail.item;
    body.innerHTML = `
        ${backRow('Reset Password')}
        <div class="space-y-4">
            <div class="flex items-center gap-3">
                <img src="${optAvatar(u.profile_img_url)}" class="w-12 h-12 rounded-full object-cover bg-surface-variant">
                <div class="min-w-0">
                    <p class="font-extrabold text-[14.5px] text-on-surface dark:text-gray-100 truncate">${esc(u.full_name)}</p>
                    <p class="text-[12.5px] text-on-surface-variant dark:text-gray-400 truncate">${esc(u.email)}</p>
                </div>
            </div>
            <div id="admin-pw-area" class="space-y-3">${passwordFormHtml()}</div>
        </div>`;
}

window.__adminGeneratePassword = function () {
    const input = document.getElementById('admin-pw-input');
    if (input) input.value = generatePassword();
};

window.__adminSubmitPasswordReset = function () {
    const u = detail.item;
    const pw = (document.getElementById('admin-pw-input')?.value || '').trim();
    if (pw.length < 8) { showToast('Password must be at least 8 characters.', 'warning'); return; }
    confirmAction('Reset password?', `${u.full_name} will be signed out on every device and must log in with the new password.`, async () => {
        try {
            await rpc('admin_reset_user_password', { p_user_id: u.id, p_new_password: pw });
            showToast('Password updated.', 'success');
            const area = document.getElementById('admin-pw-area');
            if (area) area.innerHTML = passwordDoneHtml(u.full_name, pw);
        } catch (e) { showToast(e.message || 'Failed to reset password.', 'error'); }
    }, 'Reset', true);
};

window.__adminCopyPassword = async function () {
    const text = document.getElementById('admin-pw-final')?.textContent || '';
    try {
        await navigator.clipboard.writeText(text);
        showToast('Copied.', 'success');
    } catch (e) { showToast('Could not copy — select the password and copy it manually.', 'warning'); }
};

async function patchUser(patch, successMsg) {
    const u = detail.item;
    try {
        await rpc('admin_update_user', { p_user_id: u.id, ...patch });
        Object.assign(u, mapPatchToLocal(patch));
        showToast(successMsg || 'Updated.', 'success');
        renderActiveTab();
    } catch (e) { showToast(e.message || 'Update failed.', 'error'); }
}
// RPC params are p_-prefixed; keep the local cached row's field names plain.
function mapPatchToLocal(patch) {
    const out = {};
    for (const [k, v] of Object.entries(patch)) out[k.replace(/^p_/, '')] = v;
    return out;
}

window.__adminSetRole = (role) => patchUser({ p_role: role }, `Account type set to ${role}.`);
window.__adminSetVerificationStatus = (st) => patchUser({ p_verification_status: st }, `Verification status set to ${st}.`);
window.__adminSetTick = (tick) => patchUser({ p_tick_type: tick }, 'Badge updated.');
window.__adminToggleField = (field, val) => patchUser({ [`p_${field}`]: val }, 'Updated.');

window.__adminToggleSuspend = function () {
    const u = detail.item;
    const next = !u.is_suspended;
    confirmAction(next ? 'Suspend account?' : 'Unsuspend account?', `${u.full_name} will ${next ? 'be signed out and unable to log back in until you unsuspend them' : 'be able to log in again'}. This is separate from the pause users can do on their own.`, () => patchUser({ p_is_suspended: next }, next ? 'Account suspended.' : 'Account unsuspended.'), next ? 'Suspend' : 'Unsuspend', next);
};

window.__adminToggleDelete = function () {
    const u = detail.item;
    const next = !u.is_deleted;
    confirmAction(next ? 'Delete account?' : 'Restore account?', next ? `${u.full_name}'s account will be soft-deleted (recoverable from here).` : `${u.full_name}'s account will be restored.`, () => patchUser({ p_is_deleted: next }, next ? 'Account deleted.' : 'Account restored.'), next ? 'Delete' : 'Restore', next);
};

// ------------------------------------------------------------
// 6. User Activity & Insights (supabase/admin_insights.sql)
// ------------------------------------------------------------
// Identity-level views that regular Insights (www/insights.js) deliberately
// never shows a post/story owner — who visited this profile, who rewatched
// this story, one user's complete activity. Every RPC here re-checks
// is_admin() itself; see the file header in admin_insights.sql for what's
// deliberately excluded (message bodies) and why.
const activityCache = {
    days: 30, contentKind: 'posts', contentRows: [],
    feedItems: [], feedBefore: null, feedDone: false, feedIncludeViews: false,
};

// Inline onclick="..." attributes execute against `window`, not this module's
// closure, so they can never reference `activityCache` or a function-local
// variable directly (same reason window.__adminOpenDetail below looks values
// up by index instead). These two wrappers are the lookup point for that.
window.__adminOpenUserContent = function (kind) {
    activityCache.contentKind = kind === 'stories' ? 'stories' : 'posts';
    window.__adminPushDetail('user_content');
};
window.__adminOpenContentViewer = function (i) {
    const row = activityCache.contentRows[i];
    if (!row) return;
    window.__adminPushDetail(activityCache.contentKind === 'stories' ? 'story_viewers' : 'post_viewers', row);
};

function personRow(id, name, avatarUrl, sub, right = '') {
    return `
    <button onclick="window.__adminOpenUserById('${id}')" class="w-full flex items-center gap-3 p-2.5 -mx-2.5 rounded-2xl text-left active:scale-[0.98] transition-transform hover:bg-surface-variant/20 dark:hover:bg-neutral-800/40">
        <img src="${optAvatar(avatarUrl)}" class="w-10 h-10 rounded-full object-cover shrink-0 bg-surface-variant" onerror="this.style.visibility='hidden'">
        <div class="flex-1 min-w-0">
            <p class="font-bold text-[13.5px] text-on-surface dark:text-gray-100 truncate">${esc(name)}</p>
            ${sub ? `<p class="text-[11.5px] text-on-surface-variant dark:text-gray-400 truncate">${sub}</p>` : ''}
        </div>
        ${right}
    </button>`;
}
function countPill(n, label, tone = 'default') {
    const cls = tone === 'accent' ? 'bg-primary/10 text-primary' : 'bg-surface-variant/40 dark:bg-neutral-800 text-on-surface-variant dark:text-gray-300';
    return `<span class="shrink-0 text-[11px] font-bold px-2 py-1 rounded-md ${cls}">${n}${label ? ' ' + label : ''}</span>`;
}
function statTile(icon, value, label) {
    return `
    <div class="bg-surface-variant/10 dark:bg-neutral-900/40 border border-surface-variant/30 dark:border-neutral-800 rounded-2xl p-3">
        <span class="material-symbols-outlined text-[18px] text-on-surface-variant dark:text-gray-400">${icon}</span>
        <p class="text-[19px] leading-tight font-extrabold text-on-surface dark:text-gray-100 mt-1">${value ?? 0}</p>
        <p class="text-[11px] font-semibold text-on-surface-variant dark:text-gray-400">${label}</p>
    </div>`;
}
function insightsSetupNotice(err) {
    const msg = String(err?.message || err || '');
    if (!/insights\.sql/i.test(msg)) return null;
    return `<div class="text-center py-14"><span class="material-symbols-outlined text-[40px] text-on-surface-variant dark:text-gray-500 mb-2">cloud_off</span><p class="text-[13.5px] font-semibold text-on-surface dark:text-gray-100">Not set up yet</p><p class="text-[12.5px] text-on-surface-variant dark:text-gray-400 mt-1">${esc(msg)}</p></div>`;
}

// ---- 6a. Activity hub: quick stats + nav into the three detail views ----
async function renderUserActivityHub(body) {
    const u = detail.item;
    body.innerHTML = `${backRow('Activity & Insights')}<div class="mb-4 -mt-2"><p class="text-[13.5px] font-bold text-on-surface dark:text-gray-100">${esc(u.full_name)}</p></div>${SKELETON}`;
    let s;
    try { s = await rpc('admin_user_activity_summary', { p_user_id: u.id }); }
    catch (e) { body.innerHTML = `${backRow('Activity & Insights')}` + (insightsSetupNotice(e) || `<p class="text-error text-[13px] text-center py-10">${esc(e.message || 'Failed to load.')}</p>`); return; }

    body.innerHTML = `
        ${backRow('Activity & Insights')}
        <div class="mb-4 -mt-2"><p class="text-[13.5px] font-bold text-on-surface dark:text-gray-100">${esc(u.full_name)}</p><p class="text-[11.5px] text-on-surface-variant dark:text-gray-400">Joined ${fmtWhen(s.joined_at)}${s.last_active_at ? ` · Active ${timeAgo(s.last_active_at)}` : ''}</p></div>

        <div class="grid grid-cols-3 gap-2.5 mb-5">
            ${statTile('grid_view', s.posts, 'Posts')}
            ${statTile('motion_photos_on', s.stories, 'Stories')}
            ${statTile('chat_bubble', s.comments_made, 'Comments')}
            ${statTile('favorite', s.likes_given, 'Likes given')}
            ${statTile('bookmark', s.saves_made, 'Saves')}
            ${statTile('group', s.connections, 'Connections')}
        </div>

        ${!s.insights_ready ? `<div class="bg-orange-500/10 text-orange-600 dark:text-orange-400 rounded-xl p-3 text-[12.5px] font-semibold mb-4">Run supabase/insights.sql to enable profile-visit and rewatch tracking below.</div>` : `
        <div class="grid grid-cols-3 gap-2.5 mb-5">
            ${statTile('person_search', s.profile_visits_received, 'Profile visits')}
            ${statTile('visibility', s.profile_visits_made, 'Profiles visited')}
            ${statTile('replay', s.story_watches_given, 'Stories watched')}
        </div>`}

        <div class="space-y-2">
            <button onclick="window.__adminPushDetail('profile_visitors')" class="w-full flex items-center justify-between p-3.5 bg-surface-variant/10 dark:bg-neutral-900/40 border border-surface-variant/30 dark:border-neutral-800 rounded-2xl font-bold text-[13.5px] text-on-surface dark:text-gray-100 active:scale-[0.98] transition-transform">
                <span class="flex items-center gap-2"><span class="material-symbols-outlined text-[20px] text-on-surface-variant dark:text-gray-400">person_search</span> Who visited this profile</span>
                <span class="material-symbols-outlined text-[20px] text-on-surface-variant dark:text-gray-400">chevron_right</span>
            </button>
            <button onclick="window.__adminOpenUserContent('posts')" class="w-full flex items-center justify-between p-3.5 bg-surface-variant/10 dark:bg-neutral-900/40 border border-surface-variant/30 dark:border-neutral-800 rounded-2xl font-bold text-[13.5px] text-on-surface dark:text-gray-100 active:scale-[0.98] transition-transform">
                <span class="flex items-center gap-2"><span class="material-symbols-outlined text-[20px] text-on-surface-variant dark:text-gray-400">grid_view</span> Posts &amp; stories, with viewers</span>
                <span class="material-symbols-outlined text-[20px] text-on-surface-variant dark:text-gray-400">chevron_right</span>
            </button>
            <button onclick="window.__adminPushDetail('user_feed')" class="w-full flex items-center justify-between p-3.5 bg-surface-variant/10 dark:bg-neutral-900/40 border border-surface-variant/30 dark:border-neutral-800 rounded-2xl font-bold text-[13.5px] text-on-surface dark:text-gray-100 active:scale-[0.98] transition-transform">
                <span class="flex items-center gap-2"><span class="material-symbols-outlined text-[20px] text-on-surface-variant dark:text-gray-400">history</span> Full activity timeline</span>
                <span class="material-symbols-outlined text-[20px] text-on-surface-variant dark:text-gray-400">chevron_right</span>
            </button>
        </div>
        <p class="text-[11px] text-on-surface-variant dark:text-gray-500 text-center mt-4 px-4">Profile visits, shares and view counts are recorded from when Insights was deployed onward. Message rows below show who and when only — never message content.</p>
    `;
}

// ---- 6b. Who visited this profile ----
async function renderProfileVisitors(body) {
    const u = detail.item;
    body.innerHTML = backRow('Profile visitors') + SKELETON;
    let rows;
    try { rows = await rpc('admin_profile_visitors', { p_user_id: u.id, p_limit: 100 }); }
    catch (e) { body.innerHTML = backRow('Profile visitors') + (insightsSetupNotice(e) || `<p class="text-error text-[13px] text-center py-10">${esc(e.message || 'Failed to load.')}</p>`); return; }

    if (!rows.length) { body.innerHTML = backRow('Profile visitors') + emptyState('person_search', 'No recorded visits yet.'); return; }
    body.innerHTML = backRow(`Profile visitors · ${esc(u.full_name)}`) + `<div class="space-y-0.5">` + rows.map((r) => personRow(
        r.visitor_id, r.full_name, r.profile_img_url,
        `Last visit ${timeAgo(r.last_visited_at)}${r.last_source ? ` · via ${esc(r.last_source)}` : ''}`,
        countPill(r.visit_count, r.visit_count === 1 ? 'visit' : 'visits', r.visit_count > 1 ? 'accent' : 'default')
    )).join('') + `</div>`;
}

// ---- 6c. This user's posts/stories, each with a reach number that opens the viewer list ----
async function renderUserContentList(body) {
    const u = detail.item;
    body.innerHTML = backRow(`Content · ${esc(u.full_name)}`) + `
        <div class="flex p-1 rounded-xl bg-surface-variant/30 dark:bg-neutral-800 mb-4">
            ${[['posts', 'Posts'], ['stories', 'Stories']].map(([k, l]) => `<button onclick="window.__adminSetContentKind('${k}')" class="flex-1 py-2 rounded-lg text-[13px] font-bold transition-colors ${activityCache.contentKind === k ? 'bg-surface dark:bg-[#121212] text-on-surface dark:text-gray-100 shadow-sm' : 'text-on-surface-variant dark:text-gray-400'}">${l}</button>`).join('')}
        </div>
        <div id="admin-content-rows">${SKELETON}</div>
    `;
    await loadUserContent();
}
window.__adminSetContentKind = function (k) { activityCache.contentKind = k; renderActiveTab(); };

async function loadUserContent() {
    const u = detail.item;
    const container = document.getElementById('admin-content-rows');
    if (!container) return;
    const isStories = activityCache.contentKind === 'stories';
    try {
        activityCache.contentRows = await rpc('admin_content_rows', { p_user_id: u.id, p_kind: activityCache.contentKind, p_days: 0 });
    } catch (e) {
        container.innerHTML = insightsSetupNotice(e) || `<p class="text-error text-[13px] text-center py-10">${esc(e.message || 'Failed to load.')}</p>`;
        return;
    }
    if (!activityCache.contentRows.length) { container.innerHTML = emptyState(isStories ? 'motion_photos_on' : 'grid_view', `No ${isStories ? 'stories' : 'posts'} yet.`); return; }

    container.innerHTML = `<div class="space-y-0.5">` + activityCache.contentRows.map((it, i) => {
        const id = isStories ? it.story_id : it.post_id;
        const title = isStories ? `${it.media_type === 'video' ? 'Video' : 'Photo'} story` : (it.is_anonymous ? 'Anonymous post' : (String(it.content || '').trim().slice(0, 60) || it.post_type));
        return `
        <button onclick="window.__adminOpenContentViewer(${i})" class="w-full flex items-center gap-3 p-2.5 -mx-2.5 rounded-2xl text-left active:scale-[0.98] transition-transform hover:bg-surface-variant/20 dark:hover:bg-neutral-800/40">
            <div class="w-11 h-11 rounded-xl bg-surface-variant/40 dark:bg-neutral-800 overflow-hidden shrink-0 flex items-center justify-center">
                ${it.media_url ? `<img src="${optImg(it.media_url)}" class="w-full h-full object-cover">` : `<span class="material-symbols-outlined text-[20px] text-on-surface-variant dark:text-gray-400">${isStories ? 'motion_photos_on' : 'notes'}</span>`}
            </div>
            <div class="flex-1 min-w-0">
                <p class="font-bold text-[13px] text-on-surface dark:text-gray-100 truncate">${esc(title)}</p>
                <p class="text-[11.5px] text-on-surface-variant dark:text-gray-400">${fmtWhen(it.created_at)}</p>
            </div>
            ${countPill(it.reach, 'reach', it.reach > 0 ? 'accent' : 'default')}
        </button>`;
    }).join('') + `</div>`;
}

// ---- 6d. Per-post viewers ----
async function renderPostViewers(body) {
    const row = detail.item;
    body.innerHTML = backRow('Post viewers') + SKELETON;
    let rows;
    try { rows = await rpc('admin_post_viewers', { p_post_id: row.post_id, p_limit: 200 }); }
    catch (e) { body.innerHTML = backRow('Post viewers') + `<p class="text-error text-[13px] text-center py-10">${esc(e.message || 'Failed to load.')}</p>`; return; }
    if (!rows.length) { body.innerHTML = backRow('Post viewers') + emptyState('visibility_off', 'No recorded views yet.'); return; }

    body.innerHTML = backRow(`Viewers · ${rows.length} ${rows.length === 1 ? 'person' : 'people'}`) + `<div class="space-y-0.5">` + rows.map((r) => {
        const badges = [r.liked && '❤️', r.commented && '💬', r.saved && '🔖', r.shared && '↗️'].filter(Boolean).join(' ');
        const sub = r.impression_count > 0 ? `${r.impression_count === 1 ? 'Viewed once' : `Viewed ${r.impression_count}×`} · last ${timeAgo(r.last_seen_at)}` : 'Interacted (no recorded view)';
        return personRow(r.viewer_id, r.full_name, r.profile_img_url, sub + (badges ? ` · ${badges}` : ''),
            r.impression_count > 1 ? countPill(r.impression_count, '×', 'accent') : '');
    }).join('') + `</div>`;
}

// ---- 6e. Per-story viewers — the rewatch view ----
async function renderStoryViewers(body) {
    const row = detail.item;
    body.innerHTML = backRow('Story viewers') + SKELETON;
    let rows;
    try { rows = await rpc('admin_story_viewers', { p_story_id: row.story_id, p_limit: 300 }); }
    catch (e) { body.innerHTML = backRow('Story viewers') + `<p class="text-error text-[13px] text-center py-10">${esc(e.message || 'Failed to load.')}</p>`; return; }
    if (!rows.length) { body.innerHTML = backRow('Story viewers') + emptyState('visibility_off', 'No recorded views yet.'); return; }

    const rewatched = rows.filter((r) => r.view_count > 1).length;
    body.innerHTML = backRow(`Viewers · ${rows.length} ${rows.length === 1 ? 'person' : 'people'}`)
        + (rewatched ? `<p class="text-[12px] font-semibold text-primary mb-3">${rewatched} rewatched this story</p>` : '')
        + `<div class="space-y-0.5">` + rows.map((r) => {
            const badges = [r.liked && '❤️', r.replied && '💬'].filter(Boolean).join(' ');
            const sub = `${r.view_count === 1 ? 'Watched once' : `Watched ${r.view_count}× (rewatched)`} · last ${timeAgo(r.last_viewed_at)}` + (badges ? ` · ${badges}` : '');
            return personRow(r.viewer_id, r.full_name, r.profile_img_url, sub, r.view_count > 1 ? countPill(r.view_count, '×', 'accent') : '');
        }).join('') + `</div>`;
}

// ---- 6f. Full activity timeline, paginated ----
const FEED_ICON = {
    account_created: 'person_add', post_created: 'grid_view', story_created: 'motion_photos_on',
    comment_made: 'chat_bubble', like_given: 'favorite', story_like_given: 'favorite',
    save_made: 'bookmark', poll_voted: 'poll', event_rsvp: 'event_available',
    connection_accepted: 'group', message_sent: 'send', share_made: 'ios_share',
    profile_visit_made: 'visibility', profile_visit_received: 'person_search',
    post_viewed: 'visibility', story_watched: 'replay',
};
function feedLine(e) {
    const who = e.other_name ? `<button onclick="window.__adminOpenUserById('${e.other_id}')" class="font-bold text-primary">${esc(e.other_name)}</button>` : '';
    const map = {
        account_created: 'Account created',
        post_created: 'Created a post' + (e.preview ? `: “${esc(e.preview)}”` : ''),
        story_created: 'Posted a story',
        comment_made: 'Commented' + (e.preview ? `: “${esc(e.preview)}”` : ''),
        like_given: `Liked ${who}'s post`,
        story_like_given: `Liked ${who}'s story`,
        save_made: 'Saved a post',
        poll_voted: 'Voted in a poll',
        event_rsvp: `RSVP'd ${esc(e.meta?.status || '')} to an event`,
        connection_accepted: `Connected with ${who}`,
        message_sent: `Messaged ${who}`,
        share_made: 'Shared a post',
        profile_visit_made: `Visited ${who}'s profile`,
        profile_visit_received: `${who} visited this profile`,
        post_viewed: `Viewed ${who}'s post`,
        story_watched: `Watched ${who}'s story`,
    };
    return map[e.kind] || e.kind;
}
async function renderUserFeed(body) {
    const u = detail.item;
    activityCache.feedItems = []; activityCache.feedBefore = null; activityCache.feedDone = false;
    body.innerHTML = backRow(`Activity · ${esc(u.full_name)}`) + `
        <label class="flex items-center justify-between p-3 mb-3 bg-surface-variant/10 dark:bg-neutral-900/40 rounded-xl">
            <span class="text-[12.5px] font-semibold text-on-surface dark:text-gray-200">Include every post/story view</span>
            <input type="checkbox" onchange="window.__adminToggleFeedViews(this.checked)" class="w-4 h-4 accent-primary">
        </label>
        <div id="admin-feed-list"></div>
        <div id="admin-feed-more"></div>
    `;
    await loadMoreFeed();
}
window.__adminToggleFeedViews = function (checked) {
    activityCache.feedIncludeViews = checked;
    activityCache.feedItems = []; activityCache.feedBefore = null; activityCache.feedDone = false;
    document.getElementById('admin-feed-list').innerHTML = '';
    loadMoreFeed();
};
window.__adminLoadMoreFeed = () => loadMoreFeed();

async function loadMoreFeed() {
    const u = detail.item;
    const list = document.getElementById('admin-feed-list');
    const more = document.getElementById('admin-feed-more');
    if (!list || !more || activityCache.feedDone) return;
    more.innerHTML = `<div class="py-4 text-center"><span class="text-[12.5px] text-on-surface-variant dark:text-gray-400">Loading…</span></div>`;
    let rows;
    try {
        rows = await rpc('admin_user_activity_feed', { p_user_id: u.id, p_before: activityCache.feedBefore, p_limit: 40, p_include_views: activityCache.feedIncludeViews });
    } catch (e) {
        activityCache.feedDone = true;
        more.innerHTML = '';
        if (!activityCache.feedItems.length) list.innerHTML = insightsSetupNotice(e) || `<p class="text-error text-[13px] text-center py-10">${esc(e.message || 'Failed to load.')}</p>`;
        return;
    }
    if (!rows.length) {
        activityCache.feedDone = true;
        more.innerHTML = activityCache.feedItems.length ? `<p class="text-[11.5px] text-on-surface-variant dark:text-gray-500 text-center py-4">That's everything.</p>` : '';
        if (!activityCache.feedItems.length) list.innerHTML = emptyState('history', 'No activity recorded yet.');
        return;
    }
    activityCache.feedItems.push(...rows);
    activityCache.feedBefore = rows[rows.length - 1].ts;

    list.innerHTML = activityCache.feedItems.map((e) => `
        <div class="flex items-start gap-3 py-2.5 border-b border-surface-variant/20 dark:border-neutral-800/60 last:border-0">
            <span class="material-symbols-outlined text-[18px] text-on-surface-variant dark:text-gray-400 mt-0.5 shrink-0">${FEED_ICON[e.kind] || 'circle'}</span>
            <div class="flex-1 min-w-0"><p class="text-[13px] text-on-surface dark:text-gray-200 leading-snug">${feedLine(e)}</p><p class="text-[11px] text-on-surface-variant dark:text-gray-500 mt-0.5">${fmtWhen(e.ts)}</p></div>
        </div>`).join('');
    more.innerHTML = rows.length < 40
        ? `<p class="text-[11.5px] text-on-surface-variant dark:text-gray-500 text-center py-4">That's everything.</p>`
        : `<button onclick="window.__adminLoadMoreFeed()" class="w-full py-3 mt-2 rounded-xl bg-surface-variant/30 dark:bg-neutral-800 text-on-surface dark:text-gray-200 font-bold text-[13px] active:scale-95 transition-transform">Load more</button>`;
    if (rows.length < 40) activityCache.feedDone = true;
}

// ------------------------------------------------------------
// 7. App config (forced-update gate)
// ------------------------------------------------------------
async function renderConfigTab(body) {
    const { data, error } = await supabase.from('app_version_control').select('*').order('platform');
    if (error) throw error;
    cache.appVersions = data || [];

    // Fail soft: if admin_panel.sql hasn't been re-run yet, the privacy card
    // says so instead of taking the whole tab (and the version gate) down.
    let privacyRow = null, privacyErr = null;
    try {
        const rows = await rpc('admin_get_app_settings');
        privacyRow = (rows || []).find((r) => r.key === PRIVACY_SETTING) || null;
    } catch (e) { privacyErr = e; }

    body.innerHTML = `
        ${privacyCardHtml(privacyRow, privacyErr)}
        <p class="text-[12px] text-on-surface-variant dark:text-gray-500 mb-2">Users on a version below "Min Version Code" are shown a forced-update screen and can't use the app until they update.</p>
        <p class="text-[12px] text-on-surface-variant dark:text-gray-500 mb-4">After releasing a build that changes admin or suspension behaviour, raise this to that build's versionCode (GitHub run number + 100) so older installs can't skip the new checks.</p>
        <div class="space-y-4">
            ${cache.appVersions.map(v => `
                <div class="bg-surface-variant/10 dark:bg-neutral-900/40 border border-surface-variant/30 dark:border-neutral-800 rounded-2xl p-4 space-y-2">
                    <p class="font-extrabold text-[14px] text-on-surface dark:text-gray-100 capitalize">${esc(v.platform)}</p>
                    <label class="text-[11px] font-bold uppercase text-on-surface-variant dark:text-gray-400">Min Version Code</label>
                    <input type="number" id="admin-version-code-${esc(v.platform)}" value="${v.min_version_code}" class="w-full bg-surface-variant/30 dark:bg-neutral-900/50 border border-surface-variant/50 dark:border-neutral-700 text-on-surface dark:text-gray-100 text-[13.5px] rounded-xl p-3 outline-none focus:border-primary">
                    <label class="text-[11px] font-bold uppercase text-on-surface-variant dark:text-gray-400">Update Message</label>
                    <textarea id="admin-version-msg-${esc(v.platform)}" class="w-full bg-surface-variant/30 dark:bg-neutral-900/50 border border-surface-variant/50 dark:border-neutral-700 text-on-surface dark:text-gray-100 text-[13.5px] rounded-xl p-3 outline-none focus:border-primary h-20 resize-none">${esc(v.update_message || '')}</textarea>
                    <button onclick="window.__adminSaveVersion('${esc(v.platform)}')" class="w-full bg-primary text-white font-bold py-2.5 rounded-xl active:scale-95 transition-transform">Save ${esc(v.platform)}</button>
                </div>
            `).join('') || emptyState('tune', 'No platform rows found.')}
        </div>
    `;
}

// The app_settings row the Full Privacy switch controls (see supabase/admin_panel.sql).
const PRIVACY_SETTING = 'screen_privacy';

function privacyCardHtml(row, err) {
    const shell = 'bg-surface-variant/10 dark:bg-neutral-900/40 border border-surface-variant/30 dark:border-neutral-800 rounded-2xl p-4 mb-4';
    if (err) {
        return `<div class="${shell}"><p class="font-extrabold text-[14px] text-on-surface dark:text-gray-100">Full Privacy Mode</p><p class="text-[12px] text-on-surface-variant dark:text-gray-400 mt-1">Not set up yet. Run the latest supabase/admin_panel.sql in the Supabase SQL editor, then reopen this tab. (${esc(err.message || String(err))})</p></div>`;
    }
    const on = !!(row && row.enabled);
    const when = row && row.updated_at
        ? `<p class="text-[11px] text-on-surface-variant dark:text-gray-500 mt-2">${on ? 'Turned on' : 'Last changed'} ${esc(fmtWhen(row.updated_at))}${row.updated_by_name ? ` by ${esc(row.updated_by_name)}` : ''}</p>`
        : '';
    return `
        <div class="${shell}">
            <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                    <p class="font-extrabold text-[14px] text-on-surface dark:text-gray-100 flex items-center gap-1.5"><span class="material-symbols-outlined text-[18px] ${on ? 'text-primary' : ''}">privacy_tip</span> Full Privacy Mode</p>
                    <p class="text-[12px] text-on-surface-variant dark:text-gray-400 mt-1">When on, nobody can take screenshots or record the screen anywhere in the app, and the Recent Apps preview is blank. Applies to every user, including admins. Open apps pick it up within moments; closed ones the next time they open.</p>
                    ${when}
                </div>
                <button role="switch" aria-checked="${on}" aria-label="Full Privacy Mode" onclick="window.__adminTogglePrivacy(${!on})" class="relative shrink-0 mt-1 w-11 h-6 rounded-full transition-colors ${on ? 'bg-primary' : 'bg-surface-variant dark:bg-neutral-700'}">
                    <span class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}"></span>
                </button>
            </div>
        </div>`;
}

window.__adminTogglePrivacy = function (next) {
    confirmAction(
        next ? 'Turn on Full Privacy?' : 'Turn off Full Privacy?',
        next ? 'Screenshots and screen recording will be blocked for every user across the whole app, including you.' : 'Screenshots and screen recording will be allowed again for everyone.',
        async () => {
            try {
                await rpc('admin_set_app_setting', { p_key: PRIVACY_SETTING, p_enabled: next });
                if (typeof window.__applyScreenPrivacy === 'function') window.__applyScreenPrivacy(next);
                showToast(next ? 'Full Privacy is on.' : 'Full Privacy is off.', 'success');
            } catch (e) { showToast(e.message || 'Failed to update.', 'error'); }
            renderActiveTab();
        },
        next ? 'Turn on' : 'Turn off',
        false
    );
};

window.__adminSaveVersion = async function (platform) {
    const codeInput = document.getElementById(`admin-version-code-${platform}`);
    const msgInput = document.getElementById(`admin-version-msg-${platform}`);
    const code = parseInt(codeInput?.value, 10);
    if (isNaN(code)) { showToast('Enter a valid version code.', 'warning'); return; }
    confirmAction('Update forced-update gate?', `This affects every ${platform} user immediately.`, async () => {
        try {
            await rpc('admin_update_app_version', { p_platform: platform, p_min_version_code: code, p_update_message: msgInput?.value.trim() || null });
            showToast('Saved.', 'success');
        } catch (e) { showToast(e.message || 'Failed to save.', 'error'); }
    }, 'Save', true);
};

// ------------------------------------------------------------
// Shared filter setter (verifications / reports / feedback tabs)
// ------------------------------------------------------------
window.__adminSetFilter = function (tab, value) {
    const v = value === 'null' ? null : value;
    if (tab === 'verifications') cache.verificationsFilter = v;
    if (tab === 'reports') cache.reportsFilter = v;
    if (tab === 'feedback') cache.feedbackFilter = v;
    renderActiveTab();
};
