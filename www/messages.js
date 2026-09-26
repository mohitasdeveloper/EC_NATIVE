// messages.js
// Direct messages — text only, restricted to accepted connections.
// Native-feel chat: delivery/read ticks, typing + online presence,
// replies, reactions, swipe/long-press gestures, unsend/delete,
// pagination, drafts, retry-on-fail, pin/mute/archive/delete chat,
// anchored popup menus (chat rows + message bubbles).

import { supabase } from './supabase.js';
import { showToast, popupMenuItem } from './ui.js';
import { getAcceptedConnections, invalidateConnectionsCache, createNotification } from './data-layer.js';

let myProfile = null;
let threadsCache = [];          // visible (non-archived) threads: [{ user, lastMessage, unreadCount }]
let archivedThreadsCache = [];  // archived threads, shown in the Archived Chats panel
let rawMessagesCache = [];      // last fetched raw message rows, used to re-derive threads locally
let chatSettingsMap = new Map();// partnerId -> { pinned, pinned_at, muted_until, archived, archived_at, deleted_at }
let acceptedConnections = [];   // full connections list, used by the "New Message" picker + quick rail
let pagePartnersCache = new Map(); // id -> user info, for message partners who are Page accounts — pages can message (and be messaged by) anyone, not just connections, so those threads need to resolve even when absent from acceptedConnections
let inboxFilter = 'all';        // 'all' | 'unread'
let inboxSearchQuery = '';      // free-text filter over thread partner names
let openChatMenuPartnerId = null; // which chat row's popup menu is currently open (for the mute submenu's back button)

let activeChat = null;        // { userId, name, lastActiveAt }
let chatMessages = [];        // messages in the currently open conversation
let reactionsMap = new Map(); // messageId -> [{message_id,user_id,emoji}]
let hotpostPreviewCache = new Map(); // hotpostId -> {id, media_url, media_type, user_id} | null (unavailable)
let sharedPostPreviewCache = new Map(); // postId -> {id, post_type, content, media_url, users:{id,full_name,profile_img_url}} | null (unavailable)
const SHARED_POST_FALLBACK_TEXT = 'Shared a post'; // messages.content is NOT NULL, so a shared-post message still needs *some* text in it
let replyingTo = null;        // message currently being replied to

let inboxChannel = null;
let chatChannel = null;
let onlineChannel = null;
let onlineUsers = new Set();
let heartbeatInterval = null;

let sendInFlight = false;
let inboxRefetchTimer = null;

// Pagination
const CHAT_PAGE_SIZE = 40;
let hasMoreOlder = true;
let isLoadingOlder = false;
let newMessagesWhileScrolledUp = 0;

// Typing
let typingStopTimer = null;
let partnerTypingTimeout = null;
let partnerIsTypingNow = false;

// Gestures (message bubbles)
let msgSwipeRow = null;
let msgPressTimer = null;
let msgPressStartX = 0;
let msgPressStartY = 0;
let msgPressMoved = false;

// Gestures (inbox rows)
let inboxPressRow = null;
let inboxPressTimer = null;
let inboxPressMoved = false;
let inboxSuppressNextClick = false;

const QUICK_EMOJIS = ['❤️', '😂', '😮', '😢', '🙏', '👍'];

const THREAD_SKELETON = `
    <div class="flex items-center gap-3.5 p-2.5 mb-1 animate-pulse">
        <div class="w-14 h-14 rounded-full shimmer-bg shrink-0"></div>
        <div class="flex-1">
            <div class="h-3.5 shimmer-bg rounded-md w-1/3 mb-2.5"></div>
            <div class="h-3 shimmer-bg rounded-md w-2/3"></div>
        </div>
    </div>
`.repeat(6);

export function initMessages(profile) {
    myProfile = profile;
    if (!myProfile) return;

    setupComposer();
    subscribeInbox();
    subscribeOnlinePresence();
    setupViewportHandling();

    // Broadcast composer entry point is Page-only.
    const broadcastBtn = document.getElementById('broadcast-message-btn');
    if (broadcastBtn) broadcastBtn.classList.toggle('hidden', myProfile.role !== 'page');

    // Load the inbox immediately (not just on first tab open) so the nav badge
    // reflects unread messages right away, Instagram-style.
    fetchInbox();
}

// ==========================================
// Small helpers
// ==========================================
function avatarFallback(name) {
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name || 'User')}&background=e1e3e4`;
}
function optAvatar(url) {
    return (typeof window.optimizeImageUrl === 'function') ? window.optimizeImageUrl(url, 'avatar') : url;
}
function tickHtml(type) {
    return (typeof window.getTickHtml === 'function') ? window.getTickHtml(type) : '';
}
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
function linkify(html) {
    const urlRegex = /((https?:\/\/|www\.)[^\s<]+)/gi;
    return html.replace(urlRegex, (raw) => {
        let match = raw;
        let trail = '';
        while (/[.,!?;:)\]]$/.test(match)) { trail = match.slice(-1) + trail; match = match.slice(0, -1); }
        const href = match.toLowerCase().startsWith('www.') ? `https://${match}` : match;
        // href stays a real link (long-press-to-copy, accessibility) but the
        // click itself is intercepted so pasted links go through the same
        // hardened router as everywhere else, instead of a plain
        // target="_blank" — which is exactly what left PDF links (and any
        // other file link someone pastes in chat) at the mercy of the
        // WebView's native window-opening quirks.
        return `<a href="${href}" onclick="event.preventDefault(); window.openChatLink(this.href); return false;" rel="noopener noreferrer" class="underline underline-offset-2 break-all">${match}</a>${trail}`;
    });
}
// Pasted chat links are arbitrary, unowned URLs — always send them out to
// the real external browser (never assume they're safe/willing to be
// iframed in-app the way an admin-configured service link might be).
window.openChatLink = function (url) {
    if (typeof window.openServiceLink === 'function') window.openServiceLink(url, false);
    else window.open(url, '_blank');
};
function timeShort(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
function dayLabel(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString([], sameYear ? { weekday: 'long', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
function isHiddenForMe(m) {
    const mine = m.sender_id === myProfile.id;
    return (mine && m.deleted_for_sender) || (!mine && m.deleted_for_receiver);
}
function lastSeenText(iso) {
    if (!iso) return '';
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Last seen just now';
    if (mins < 60) return `Last seen ${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `Last seen ${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `Last seen ${days}d ago`;
    return `Last seen ${timeShort(iso)}`;
}
function currentPresenceStatus() {
    if (!activeChat) return '';
    return onlineUsers.has(activeChat.userId) ? 'Online' : lastSeenText(activeChat.lastActiveAt);
}
function setHeaderStatus(text) {
    const el = document.getElementById('chat-header-status');
    if (el) el.textContent = text || '';
}
function saveDraft(partnerId, text) {
    try { if (text) localStorage.setItem(`chat_draft_${partnerId}`, text); else localStorage.removeItem(`chat_draft_${partnerId}`); } catch (e) { /* ignore */ }
}
function loadDraft(partnerId) {
    try { return localStorage.getItem(`chat_draft_${partnerId}`) || ''; } catch (e) { return ''; }
}
function scheduleInboxRefetch() {
    clearTimeout(inboxRefetchTimer);
    inboxRefetchTimer = setTimeout(() => fetchInbox(), 400);
}

// ==========================================
// Connections (only people you can message)
// ==========================================
async function fetchAcceptedConnections() {
    if (!myProfile) return [];
    try {
        return await getAcceptedConnections(myProfile.id);
    } catch (error) {
        console.error('Error loading connections for messages:', error);
        return [];
    }
}

// ==========================================
// Online presence (app-wide, no DB writes except a throttled heartbeat)
// ==========================================
function subscribeOnlinePresence() {
    if (!myProfile || onlineChannel) return;
    onlineChannel = supabase.channel('presence-online', { config: { presence: { key: myProfile.id } } });
    onlineChannel
        .on('presence', { event: 'sync' }, () => {
            const state = onlineChannel.presenceState();
            onlineUsers = new Set(Object.keys(state));
            updatePartnerOnlineUI();
            renderInbox();
        })
        .subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                await onlineChannel.track({ online_at: new Date().toISOString() });
                bumpLastActive();
                if (!heartbeatInterval) heartbeatInterval = setInterval(bumpLastActive, 120000);
            }
        });
}
async function bumpLastActive() {
    if (!myProfile) return;
    try { await supabase.from('users').update({ last_active_at: new Date().toISOString() }).eq('id', myProfile.id); }
    catch (e) { console.debug('last_active_at update failed', e); }
}
function updatePartnerOnlineUI() {
    if (!activeChat || partnerIsTypingNow) return;
    setHeaderStatus(currentPresenceStatus());
}

// ==========================================
// Chat settings (pin / mute / archive / delete-chat)
// ==========================================
function getSettings(partnerId) {
    return chatSettingsMap.get(partnerId) || { pinned: false, pinned_at: null, muted_until: null, archived: false, archived_at: null, deleted_at: null };
}
function isMuted(partnerId) {
    if (pagePartnersCache.has(partnerId)) return false; // Pages can't be muted — enforced here so every isMuted() check (badges, unread-badge suppression) agrees, not just the menu below.
    const s = getSettings(partnerId);
    return !!(s.muted_until && new Date(s.muted_until) > new Date());
}

// Re-derive threadsCache / archivedThreadsCache from the already-fetched raw
// data + current settings — no network round trip, so pin/mute/archive/
// delete all feel instant.
function deriveThreads() {
    if (!myProfile) return;
    const connectionMap = new Map(acceptedConnections.map(u => [u.id, u]));
    for (const [id, u] of pagePartnersCache) connectionMap.set(id, u); // Page threads, not gated by connections
    const byPartner = new Map();

    for (const m of rawMessagesCache) {
        if (isHiddenForMe(m)) continue;
        const partnerId = m.sender_id === myProfile.id ? m.receiver_id : m.sender_id;
        const s = getSettings(partnerId);
        if (s.deleted_at && new Date(m.created_at) <= new Date(s.deleted_at)) continue; // cleared by "Delete chat"
        if (!byPartner.has(partnerId)) byPartner.set(partnerId, { lastMessage: m, unreadCount: 0 });
        if (m.receiver_id === myProfile.id && !m.is_read) byPartner.get(partnerId).unreadCount++;
    }

    const allThreads = Array.from(byPartner.entries())
        .map(([partnerId, info]) => ({ user: connectionMap.get(partnerId), ...info }))
        .filter(t => t.user) // hide threads with people who are no longer connections (or, for Pages, no longer exist)
        .sort((a, b) => new Date(b.lastMessage.created_at) - new Date(a.lastMessage.created_at));

    threadsCache = allThreads.filter(t => !getSettings(t.user.id).archived);
    archivedThreadsCache = allThreads.filter(t => getSettings(t.user.id).archived);
}

function refreshInboxUI() {
    deriveThreads();
    renderInbox();
    updateNavBadge();
    const archModal = document.getElementById('modal-archived-chats');
    if (archModal && !archModal.classList.contains('hidden')) renderArchivedChats();
}

async function upsertChatSetting(partnerId, patch, opts = {}) {
    const previous = getSettings(partnerId);
    const merged = { ...previous, ...patch, user_id: myProfile.id, partner_id: partnerId, updated_at: new Date().toISOString() };
    chatSettingsMap.set(partnerId, merged);
    refreshInboxUI(); // optimistic — instant feedback

    try {
        const { error } = await supabase.from('conversation_settings')
            .upsert(merged, { onConflict: 'user_id,partner_id' });
        if (error) throw error;
        if (opts.toast) showToast(opts.toast, 'success');
    } catch (e) {
        console.error('conversation_settings update failed:', e);
        chatSettingsMap.set(partnerId, previous);
        refreshInboxUI();
        showToast('That action failed. Please try again.', 'error');
    }
}

window.togglePinChat = function (partnerId) {
    window.closePopupMenu();
    const s = getSettings(partnerId);
    if (s.pinned) upsertChatSetting(partnerId, { pinned: false, pinned_at: null });
    else upsertChatSetting(partnerId, { pinned: true, pinned_at: new Date().toISOString() });
};

window.setChatMute = function (partnerId, mode) {
    window.closePopupMenu();
    let muted_until = null;
    if (mode === '8h') muted_until = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
    else if (mode === '1w') muted_until = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    else if (mode === 'forever') muted_until = new Date('2099-01-01T00:00:00Z').toISOString();
    upsertChatSetting(partnerId, { muted_until }, { toast: muted_until ? 'Chat muted.' : 'Chat unmuted.' });
};

window.archiveChat = function (partnerId) {
    window.closePopupMenu();
    upsertChatSetting(partnerId, { archived: true, archived_at: new Date().toISOString() }, { toast: 'Chat archived.' });
    // 🚀 This can now be triggered from inside the open conversation itself (the
    // header's "⋯"), not just the inbox row's long-press — so if that's the chat
    // you're currently looking at, back out of it instead of leaving you sitting
    // inside a thread that just vanished from your inbox with no visible change.
    if (activeChat && activeChat.userId === partnerId) window.closeConversation();
};

window.unarchiveChat = function (partnerId) {
    upsertChatSetting(partnerId, { archived: false, archived_at: null }, { toast: 'Chat restored.' });
};

window.confirmDeleteChat = function (partnerId) {
    window.closePopupMenu();
    const modal = document.getElementById('modal-confirm-action');
    if (!modal) return;

    document.getElementById('confirm-action-title').textContent = 'Delete this chat?';
    document.getElementById('confirm-action-message').textContent = "It'll be removed from your list. If they message you again, it'll come back.";
    modal.classList.replace('hidden', 'flex');

    const confirmBtn = document.getElementById('confirm-action-yes');
    const cancelBtn = document.getElementById('confirm-action-no');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    const newCancelBtn = cancelBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

    newCancelBtn.addEventListener('click', () => modal.classList.replace('flex', 'hidden'));
    newConfirmBtn.addEventListener('click', () => {
        modal.classList.replace('flex', 'hidden');
        upsertChatSetting(partnerId, { deleted_at: new Date().toISOString() }, { toast: 'Chat deleted.' });
        // Same reasoning as archiveChat above — close the thread if it's the one open.
        if (activeChat && activeChat.userId === partnerId) window.closeConversation();
    });
};

// ==========================================
// Chat-row popup menu (Pin / Mute / Archive / Delete)
// ==========================================
function buildChatRowMenu(partnerId) {
    const s = getSettings(partnerId);
    const muted = isMuted(partnerId);
    const isPage = pagePartnersCache.has(partnerId);
    let html = '';
    html += popupMenuItem('push_pin', s.pinned ? 'Unpin chat' : 'Pin chat', `window.togglePinChat('${partnerId}')`);
    // Pages can't be muted — omitting the option entirely (rather than just
    // disabling isMuted() above, which only guarantees it's never *shown* as
    // muted) so there's no dead "Mute…" button that silently does nothing.
    if (!isPage) {
        if (muted) {
            html += popupMenuItem('notifications_active', 'Unmute', `window.setChatMute('${partnerId}', 'off')`);
        } else {
            html += popupMenuItem('notifications_off', 'Mute…', `window.openMuteDurationMenu('${partnerId}')`);
        }
    }
    html += popupMenuItem('archive', 'Archive chat', `window.archiveChat('${partnerId}')`);
    html += popupMenuItem('delete', 'Delete chat', `window.confirmDeleteChat('${partnerId}')`, true);
    return html;
}

function buildMuteDurationMenu(partnerId) {
    return `
        <button onclick="window.reopenChatRowMenu()" class="w-full flex items-center gap-2 px-4 py-2.5 text-[12px] font-extrabold tracking-wide text-on-surface-variant dark:text-gray-500 hover:bg-surface-variant/30 dark:hover:bg-white/5 border-b border-surface-variant/40 dark:border-white/10 text-left">
            <span class="material-symbols-outlined text-[16px]">arrow_back</span>MUTE FOR
        </button>
        ${popupMenuItem('schedule', '8 hours', `window.setChatMute('${partnerId}', '8h')`)}
        ${popupMenuItem('date_range', '1 week', `window.setChatMute('${partnerId}', '1w')`)}
        ${popupMenuItem('do_not_disturb_on', 'Always', `window.setChatMute('${partnerId}', 'forever')`)}
    `;
}

window.openMuteDurationMenu = function (partnerId) {
    const buttonsEl = document.getElementById('popup-menu-buttons');
    if (buttonsEl) buttonsEl.innerHTML = buildMuteDurationMenu(partnerId);
};
window.reopenChatRowMenu = function () {
    if (!openChatMenuPartnerId) { window.closePopupMenu(); return; }
    const buttonsEl = document.getElementById('popup-menu-buttons');
    if (buttonsEl) buttonsEl.innerHTML = buildChatRowMenu(openChatMenuPartnerId);
};

window.openChatRowMenu = function (partnerId, anchorOrEvent) {
    openChatMenuPartnerId = partnerId;
    let anchor = anchorOrEvent;
    if (anchorOrEvent && typeof anchorOrEvent.clientX === 'number') {
        anchor = { x: anchorOrEvent.clientX, y: anchorOrEvent.clientY };
    }
    window.onPopupMenuClosed = () => { openChatMenuPartnerId = null; };
    window.openPopupMenu(anchor, buildChatRowMenu(partnerId));
};

// Same Pin/Mute/Archive/Delete menu as the inbox row's long-press, but reachable
// from the "⋯" in an already-open conversation's header — previously the only
// way to get to those actions was to back out to the inbox list first.
window.openActiveChatMenu = function (event) {
    if (!activeChat) return;
    window.openChatRowMenu(activeChat.userId, event);
};

// Long-press (mobile) / right-click (desktop) on an inbox row → popup menu.
// Delegated on the container so it works for every row without per-row listeners.
function setupInboxGestures() {
    const container = document.getElementById('messages-inbox-container');
    if (!container || container._gesturesBound) return;
    container._gesturesBound = true;

    container.addEventListener('contextmenu', (e) => {
        const row = e.target.closest('[data-partner-id]');
        if (!row) return;
        e.preventDefault();
        window.openChatRowMenu(row.dataset.partnerId, e);
    });

    container.addEventListener('touchstart', (e) => {
        const row = e.target.closest('[data-partner-id]');
        if (!row) { inboxPressRow = null; return; }
        inboxPressMoved = false;
        inboxPressRow = row;
        const touch = e.touches[0];
        const startX = touch.clientX, startY = touch.clientY;
        inboxPressTimer = setTimeout(() => {
            if (!inboxPressMoved && inboxPressRow) {
                inboxSuppressNextClick = true;
                if (navigator.vibrate) navigator.vibrate(15);
                window.openChatRowMenu(inboxPressRow.dataset.partnerId, { x: startX, y: startY });
            }
        }, 450);
    }, { passive: true });

    container.addEventListener('touchmove', () => {
        inboxPressMoved = true;
        clearTimeout(inboxPressTimer);
    }, { passive: true });

    container.addEventListener('touchend', () => { clearTimeout(inboxPressTimer); inboxPressRow = null; }, { passive: true });
    container.addEventListener('touchcancel', () => { clearTimeout(inboxPressTimer); inboxPressRow = null; }, { passive: true });

    // Swallow the synthetic click that follows a long-press tap-hold, so it
    // doesn't also open the conversation right after the menu appears.
    container.addEventListener('click', (e) => {
        if (inboxSuppressNextClick) {
            inboxSuppressNextClick = false;
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
}

// ==========================================
// Inbox (thread list)
// ==========================================
const MESSAGE_COLUMNS = 'id, sender_id, receiver_id, content, is_read, delivered_at, created_at, reply_to_id, is_unsent, deleted_for_sender, deleted_for_receiver, hotpost_reply_id, shared_post_id';

async function fetchInbox() {
    const container = document.getElementById('messages-inbox-container');
    if (!container || !myProfile) return;
    if (threadsCache.length === 0 && archivedThreadsCache.length === 0) container.innerHTML = THREAD_SKELETON;

    try {
        const [{ data: msgs, error: msgErr }, connections, { data: settingsRows, error: setErr }] = await Promise.all([
            supabase.from('messages')
                .select(MESSAGE_COLUMNS)
                .or(`sender_id.eq.${myProfile.id},receiver_id.eq.${myProfile.id}`)
                .order('created_at', { ascending: false })
                .limit(300),
            fetchAcceptedConnections(),
            supabase.from('conversation_settings').select('*').eq('user_id', myProfile.id)
        ]);
        if (msgErr) throw msgErr;
        if (setErr) throw setErr;

        rawMessagesCache = msgs || [];
        acceptedConnections = connections;
        chatSettingsMap = new Map((settingsRows || []).map(r => [r.partner_id, r]));

        // 🚀 Pages can message (and be messaged by) anyone, not just connections —
        // deriveThreads() below used to resolve every thread's user info purely
        // from acceptedConnections and silently drop anything else, which meant a
        // thread with a Page you're not connected to would just vanish from the
        // inbox entirely. Resolve any non-connection partner who IS a Page here.
        const connectionIds = new Set(connections.map(u => u.id));
        const nonConnectionPartnerIds = new Set();
        for (const m of rawMessagesCache) {
            const partnerId = m.sender_id === myProfile.id ? m.receiver_id : m.sender_id;
            if (!connectionIds.has(partnerId)) nonConnectionPartnerIds.add(partnerId);
        }
        if (nonConnectionPartnerIds.size > 0) {
            const { data: pageUsers } = await supabase.from('users')
                .select('id, full_name, profile_img_url, tick_type, role')
                .in('id', Array.from(nonConnectionPartnerIds))
                .eq('role', 'page');
            pagePartnersCache = new Map((pageUsers || []).map(u => [u.id, u]));
        } else {
            pagePartnersCache = new Map();
        }

        refreshInboxUI();
    } catch (error) {
        console.error('Error loading inbox:', error);
        container.innerHTML = `<p class="text-sm italic text-center py-8 text-error">Failed to load messages.</p>`;
    }
}

function previewText(t) {
    const m = t.lastMessage;
    const mine = m.sender_id === myProfile.id;
    if (m.is_unsent) return mine ? 'You unsent a message' : `${(t.user.full_name || '').split(' ')[0]} unsent a message`;
    if (m.shared_post_id) return `${mine ? 'You: ' : ''}📤 Shared a post`;
    const storyPrefix = m.hotpost_reply_id ? '↩ ' : '';
    return `${storyPrefix}${mine ? 'You: ' : ''}${escapeHtml(m.content).slice(0, 60)}`;
}

function threadRowHtml(t, isPinned) {
    const u = t.user;
    const fallback = `this.onerror=null; this.src='${avatarFallback(u.full_name)}';`;
    const av = optAvatar(u.profile_img_url) || avatarFallback(u.full_name);
    const preview = previewText(t);
    const unread = t.unreadCount > 0;
    const online = onlineUsers.has(u.id);
    const muted = isMuted(u.id);

    return `
    <div data-partner-id="${u.id}" onclick="window.openConversation('${u.id}')" class="flex items-center gap-3.5 p-2.5 rounded-2xl cursor-pointer active:scale-[0.98] hover:bg-surface-variant/20 dark:hover:bg-neutral-800/50 transition-all">
        <div class="relative shrink-0">
            <img loading="lazy" src="${av}" onerror="${fallback}" class="w-14 h-14 rounded-full object-cover border border-surface-variant/50">
            ${online ? `<span class="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full bg-green-500 border-2 border-surface dark:border-[#121212]"></span>` : ''}
            ${isPinned ? `<span class="absolute -bottom-0.5 -left-0.5 w-[18px] h-[18px] rounded-full bg-surface dark:bg-[#121212] flex items-center justify-center border border-surface-variant/50 dark:border-neutral-700"><span class="material-symbols-outlined text-[11px] text-on-surface-variant dark:text-gray-400">push_pin</span></span>` : ''}
        </div>
        <div class="flex-1 min-w-0">
            <p class="font-bold text-[14.5px] text-on-surface dark:text-gray-100 truncate flex items-center gap-1">${escapeHtml(u.full_name)} ${tickHtml(u.tick_type)} ${muted ? `<span class="material-symbols-outlined text-[14px] text-on-surface-variant dark:text-gray-500">notifications_off</span>` : ''}</p>
            <p class="text-[13px] ${unread ? 'text-on-surface dark:text-gray-200 font-semibold' : 'text-on-surface-variant dark:text-gray-500'} truncate mt-0.5">${preview}</p>
        </div>
        <div class="flex flex-col items-end gap-1.5 shrink-0">
            <span class="text-[11px] ${unread ? 'text-primary font-bold' : 'text-on-surface-variant dark:text-gray-500'}">${timeShort(t.lastMessage.created_at)}</span>
            ${unread ? `<span class="w-2.5 h-2.5 rounded-full bg-primary"></span>` : ''}
        </div>
    </div>`;
}

function renderInbox() {
    const container = document.getElementById('messages-inbox-container');
    if (!container) return;

    let list = threadsCache;
    if (inboxFilter === 'unread') list = list.filter(t => t.unreadCount > 0);
    const q = inboxSearchQuery.trim().toLowerCase();
    if (q) list = list.filter(t => (t.user.full_name || '').toLowerCase().includes(q));

    if (list.length === 0) {
        const hasConnections = acceptedConnections.length > 0;
        if (q) {
            container.innerHTML = `
                <div class="py-14 flex flex-col items-center justify-center text-center px-6">
                    <span class="material-symbols-outlined text-[46px] mb-3 opacity-30 text-on-surface-variant">search_off</span>
                    <p class="font-bold text-[15px] text-on-surface dark:text-gray-100 mb-1">No results</p>
                    <p class="text-[13px] text-on-surface-variant dark:text-gray-500">No chats matching "${escapeHtml(inboxSearchQuery.trim())}".</p>
                </div>`;
        } else if (inboxFilter === 'unread') {
            container.innerHTML = `
                <div class="py-14 flex flex-col items-center justify-center text-center px-6">
                    <span class="material-symbols-outlined text-[46px] mb-3 opacity-30 text-on-surface-variant">done_all</span>
                    <p class="font-bold text-[15px] text-on-surface dark:text-gray-100 mb-1">All caught up</p>
                    <p class="text-[13px] text-on-surface-variant dark:text-gray-500">No unread messages.</p>
                </div>`;
        } else {
            container.innerHTML = `
                <div class="py-14 flex flex-col items-center justify-center text-center px-6">
                    <span class="material-symbols-outlined text-[46px] mb-3 opacity-30 text-on-surface-variant">forum</span>
                    <p class="font-bold text-[15px] text-on-surface dark:text-gray-100 mb-1">No messages yet</p>
                    <p class="text-[13px] text-on-surface-variant dark:text-gray-500 mb-5 leading-relaxed max-w-[220px]">${hasConnections ? 'Start a conversation with one of your connections.' : 'Connect with people first, then start chatting with them here.'}</p>
                    ${hasConnections ? `<button onclick="window.openNewMessagePanel()" class="btn-primary px-6"><span class="material-symbols-outlined text-[18px]">edit_square</span> New Message</button>` : ''}
                </div>`;
        }
        return;
    }

    const pinned = list.filter(t => getSettings(t.user.id).pinned);
    const rest = list.filter(t => !getSettings(t.user.id).pinned);

    let html = '';
    if (pinned.length > 0) {
        html += `<p class="flex items-center gap-1.5 text-[11px] font-extrabold tracking-wide text-on-surface-variant dark:text-gray-500 px-1 mb-1.5 mt-1"><span class="material-symbols-outlined text-[14px]">push_pin</span>PINNED</p>`;
        html += pinned.map(t => threadRowHtml(t, true)).join('');
        if (rest.length > 0) html += `<p class="text-[11px] font-extrabold tracking-wide text-on-surface-variant dark:text-gray-500 px-1 mb-1.5 mt-4">ALL MESSAGES</p>`;
    }
    html += rest.map(t => threadRowHtml(t, false)).join('');

    container.innerHTML = html;
    setupInboxGestures();
}

function updateNavBadge() {
    const badge = document.getElementById('msg-nav-badge');
    if (!badge) return;
    // Muted threads don't light up the nav badge, same idea as WhatsApp/Instagram.
    const hasUnread = threadsCache.some(t => t.unreadCount > 0 && !isMuted(t.user.id));
    badge.classList.toggle('hidden', !hasUnread);
}

window.setInboxFilter = function (filter) {
    inboxFilter = filter;
    document.querySelectorAll('.inbox-filter-pill').forEach(btn => {
        const active = btn.dataset.inboxFilter === filter;
        btn.classList.toggle('bg-primary', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('border-primary', active);
        btn.classList.toggle('border-surface-variant/60', !active);
        btn.classList.toggle('dark:border-neutral-700', !active);
        btn.classList.toggle('text-on-surface-variant', !active);
        btn.classList.toggle('dark:text-gray-400', !active);
    });
    renderInbox();
};

// Live search box above the filter pills — client-side over the already-cached
// thread list, same idea as the share sheet's connection search.
window.setInboxSearch = function (value) {
    inboxSearchQuery = value;
    renderInbox();
};

// ==========================================
// Archived Chats panel
// ==========================================
window.openArchivedChats = function () {
    const modal = document.getElementById('modal-archived-chats');
    if (!modal) return;
    modal.classList.replace('hidden', 'flex');
    setTimeout(() => modal.classList.remove('translate-x-full'), 10);
    renderArchivedChats();
};
window.closeArchivedChats = function () {
    const modal = document.getElementById('modal-archived-chats');
    if (!modal) return;
    modal.classList.add('translate-x-full');
    setTimeout(() => modal.classList.replace('flex', 'hidden'), 300);
};

function renderArchivedChats() {
    const list = document.getElementById('archived-chats-list');
    if (!list) return;

    if (archivedThreadsCache.length === 0) {
        list.innerHTML = `<div class="py-16 flex flex-col items-center justify-center opacity-40 text-on-surface-variant"><span class="material-symbols-outlined text-[42px] mb-2">archive</span><p class="text-sm font-semibold">No archived chats.</p></div>`;
        return;
    }

    list.innerHTML = archivedThreadsCache.map(t => {
        const u = t.user;
        const fallback = `this.onerror=null; this.src='${avatarFallback(u.full_name)}';`;
        const av = optAvatar(u.profile_img_url) || avatarFallback(u.full_name);
        const preview = previewText(t);
        return `
        <div class="flex items-center gap-3.5 p-2.5 rounded-2xl hover:bg-surface-variant/20 dark:hover:bg-neutral-800/50 transition-all">
            <div onclick="window.closeArchivedChats(); setTimeout(() => window.openConversation('${u.id}'), 220);" class="flex items-center gap-3.5 flex-1 min-w-0 cursor-pointer">
                <img loading="lazy" src="${av}" onerror="${fallback}" class="w-12 h-12 rounded-full object-cover border border-surface-variant/50 shrink-0">
                <div class="flex-1 min-w-0">
                    <p class="font-bold text-[14px] text-on-surface dark:text-gray-100 truncate flex items-center gap-1">${escapeHtml(u.full_name)} ${tickHtml(u.tick_type)}</p>
                    <p class="text-[12.5px] text-on-surface-variant dark:text-gray-500 truncate mt-0.5">${preview}</p>
                </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                <button onclick="window.unarchiveChat('${u.id}')" class="p-2 rounded-full hover:bg-surface-variant/40 dark:hover:bg-white/5 text-on-surface-variant dark:text-gray-400 active:scale-90 transition-transform" title="Restore">
                    <span class="material-symbols-outlined text-[19px]">unarchive</span>
                </button>
                <button onclick="window.confirmDeleteChat('${u.id}')" class="p-2 rounded-full hover:bg-error/10 text-error active:scale-90 transition-transform" title="Delete">
                    <span class="material-symbols-outlined text-[19px]">delete</span>
                </button>
            </div>
        </div>`;
    }).join('');
}

// ==========================================
// "New Message" picker (connections only)
// ==========================================
window.openNewMessagePanel = async function () {
    const modal = document.getElementById('modal-new-message');
    if (!modal) return;
    modal.classList.replace('hidden', 'flex');
    setTimeout(() => modal.classList.remove('translate-x-full'), 10);

    const list = document.getElementById('new-message-list');
    const search = document.getElementById('new-message-search');
    search.value = '';
    list.innerHTML = THREAD_SKELETON;

    if (!acceptedConnections.length) acceptedConnections = await fetchAcceptedConnections();
    renderNewMessageList(acceptedConnections);

    search.oninput = (e) => {
        const q = e.target.value.toLowerCase().trim();
        const filtered = acceptedConnections.filter(u => u.full_name.toLowerCase().includes(q));
        renderNewMessageList(filtered, q !== '');
    };
};

window.closeNewMessagePanel = function () {
    const modal = document.getElementById('modal-new-message');
    if (!modal) return;
    modal.classList.add('translate-x-full');
    setTimeout(() => modal.classList.replace('flex', 'hidden'), 300);
};

function renderNewMessageList(users, isSearch = false) {
    const list = document.getElementById('new-message-list');
    if (!list) return;

    if (users.length === 0) {
        list.innerHTML = `<div class="py-16 flex flex-col items-center justify-center opacity-40 text-on-surface-variant"><span class="material-symbols-outlined text-[42px] mb-2">group_off</span><p class="text-sm font-semibold">${isSearch ? 'No connections found.' : 'No connections yet.'}</p></div>`;
        return;
    }

    list.innerHTML = users.map(u => {
        const fallback = `this.onerror=null; this.src='${avatarFallback(u.full_name)}';`;
        const av = optAvatar(u.profile_img_url) || avatarFallback(u.full_name);
        const online = onlineUsers.has(u.id);
        return `
        <div onclick="window.closeNewMessagePanel(); setTimeout(() => window.openConversation('${u.id}'), 220);" class="flex items-center gap-3.5 p-3 hover:bg-surface-variant/20 dark:hover:bg-neutral-800/50 rounded-2xl cursor-pointer active:scale-[0.98] transition-all">
            <div class="relative shrink-0">
                <img loading="lazy" src="${av}" onerror="${fallback}" class="w-12 h-12 rounded-full object-cover border border-surface-variant/50">
                ${online ? `<span class="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-green-500 border-2 border-surface dark:border-[#121212]"></span>` : ''}
            </div>
            <div class="flex-1 min-w-0">
                <p class="font-bold text-[14.5px] text-on-surface dark:text-gray-100 truncate flex items-center gap-1">${escapeHtml(u.full_name)} ${tickHtml(u.tick_type)}</p>
                <p class="text-[12px] font-medium text-on-surface-variant dark:text-gray-500 mt-0.5 truncate">${escapeHtml(u.course) || 'Student'}</p>
            </div>
        </div>`;
    }).join('');
}

// ==========================================
// Conversation panel
// ==========================================
window.openConversation = async function (userId) {
    let partner = acceptedConnections.find(u => u.id === userId)
        || (threadsCache.find(t => t.user.id === userId) || {}).user
        || (archivedThreadsCache.find(t => t.user.id === userId) || {}).user;

    if (!partner) {
        const { data } = await supabase.from('users').select('id, full_name, profile_img_url, course, tick_type, role').eq('id', userId).single();
        partner = data;
    }
    if (!partner) { showToast("Couldn't open this conversation.", 'error'); return; }

    let lastActiveAt = null;
    try {
        const { data: uRow } = await supabase.from('users').select('last_active_at').eq('id', userId).single();
        lastActiveAt = uRow?.last_active_at || null;
    } catch (e) { /* non-fatal */ }

    activeChat = { userId: partner.id, name: partner.full_name, lastActiveAt, isPage: partner.role === 'page' };

    const modal = document.getElementById('modal-chat-conversation');
    modal.classList.replace('hidden', 'flex');
    setTimeout(() => modal.classList.remove('translate-x-full'), 10);

    const headerAvatar = document.getElementById('chat-header-avatar');
    headerAvatar.src = optAvatar(partner.profile_img_url) || avatarFallback(partner.full_name);
    headerAvatar.onerror = function () { this.onerror = null; this.src = avatarFallback(partner.full_name); };
    document.getElementById('chat-header-name').innerHTML = `${escapeHtml(partner.full_name)} ${tickHtml(partner.tick_type)}`;
    setHeaderStatus(currentPresenceStatus());

    const container = document.getElementById('chat-messages-container');
    container.innerHTML = `<div class="flex-1 flex items-center justify-center py-10"><div class="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin"></div></div>`;

    clearReplyPreview();
    const input = document.getElementById('chat-composer-input');
    input.value = loadDraft(partner.id);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 112) + 'px';
    updateSendButtonState();

    await loadConversation(partner.id);
    subscribeChat(partner.id);

    setTimeout(() => input.focus({ preventScroll: true }), 350);
};

window.closeConversation = function () {
    const modal = document.getElementById('modal-chat-conversation');
    if (!modal || modal.classList.contains('translate-x-full')) return;
    modal.classList.add('translate-x-full');
    setTimeout(() => modal.classList.replace('flex', 'hidden'), 300);
    document.getElementById('chat-composer-input')?.blur();
    broadcastTyping(false);
    unsubscribeChat();
    clearReplyPreview();
    activeChat = null;
    chatMessages = [];
    reactionsMap.clear();
    hasMoreOlder = true;
    newMessagesWhileScrolledUp = 0;
    fetchInbox(); // refresh previews / unread state now that the chat was seen
};

window.viewChatPartnerProfile = function () {
    if (!activeChat) return;
    const id = activeChat.userId;
    window.closeConversation();
    setTimeout(() => { if (typeof window.viewUserProfile === 'function') window.viewUserProfile(id); }, 260);
};

async function loadConversation(partnerId) {
    hasMoreOlder = true;
    isLoadingOlder = false;
    newMessagesWhileScrolledUp = 0;
    reactionsMap.clear();

    try {
        const { data, error } = await supabase
            .from('messages')
            .select(MESSAGE_COLUMNS)
            .or(`and(sender_id.eq.${myProfile.id},receiver_id.eq.${partnerId}),and(sender_id.eq.${partnerId},receiver_id.eq.${myProfile.id})`)
            .order('created_at', { ascending: false })
            .limit(CHAT_PAGE_SIZE);
        if (error) throw error;

        let rows = (data || []).reverse().filter(m => !isHiddenForMe(m));
        hasMoreOlder = (data || []).length === CHAT_PAGE_SIZE;
        chatMessages = rows;

        await loadReactionsFor(chatMessages.map(m => m.id));
        await loadHotpostPreviewsFor(chatMessages.map(m => m.hotpost_reply_id));
        await loadSharedPostPreviewsFor(chatMessages.map(m => m.shared_post_id));
        renderChatMessages();
        scrollToBottom(true);
        markVisibleAsRead(partnerId);
        markVisibleAsDelivered(partnerId);
        setupScrollListener();
    } catch (error) {
        console.error('Error loading conversation:', error);
        document.getElementById('chat-messages-container').innerHTML = `<p class="text-sm italic text-center py-8 text-error">Failed to load conversation.</p>`;
    }
}

async function loadOlderMessages() {
    if (isLoadingOlder || !hasMoreOlder || chatMessages.length === 0 || !activeChat) return;
    isLoadingOlder = true;
    const partnerId = activeChat.userId;
    const container = document.getElementById('chat-messages-container');
    const oldest = chatMessages[0];
    const prevHeight = container ? container.scrollHeight : 0;
    const prevScrollTop = container ? container.scrollTop : 0;

    try {
        const { data, error } = await supabase
            .from('messages')
            .select(MESSAGE_COLUMNS)
            .or(`and(sender_id.eq.${myProfile.id},receiver_id.eq.${partnerId}),and(sender_id.eq.${partnerId},receiver_id.eq.${myProfile.id})`)
            .lt('created_at', oldest.created_at)
            .order('created_at', { ascending: false })
            .limit(CHAT_PAGE_SIZE);
        if (error) throw error;

        let rows = (data || []).reverse().filter(m => !isHiddenForMe(m));
        hasMoreOlder = (data || []).length === CHAT_PAGE_SIZE;
        chatMessages = [...rows, ...chatMessages];

        await loadReactionsFor(rows.map(m => m.id));
        await loadHotpostPreviewsFor(rows.map(m => m.hotpost_reply_id));
        await loadSharedPostPreviewsFor(rows.map(m => m.shared_post_id));
        renderChatMessages();

        if (container) {
            const newHeight = container.scrollHeight;
            container.scrollTop = newHeight - prevHeight + prevScrollTop;
        }
    } catch (error) {
        console.error('Error loading older messages:', error);
    } finally {
        isLoadingOlder = false;
    }
}

function setupScrollListener() {
    const container = document.getElementById('chat-messages-container');
    if (!container || container._scrollBound) return;
    container._scrollBound = true;
    container.addEventListener('scroll', () => {
        if (container.scrollTop < 80) loadOlderMessages();
        updateScrollToBottomFab();
    });
}

// ==========================================
// Reactions
// ==========================================
async function loadReactionsFor(ids) {
    if (!ids.length) return;
    try {
        const { data, error } = await supabase.from('message_reactions').select('message_id,user_id,emoji').in('message_id', ids);
        if (error) throw error;
        (data || []).forEach(r => {
            const list = reactionsMap.get(r.message_id) || [];
            list.push(r);
            reactionsMap.set(r.message_id, list);
        });
    } catch (e) { console.error('Error loading reactions:', e); }
}

// Fetches the Hotpost being referenced by hotpost_reply_id messages, so the
// bubble can show a small thumbnail (Instagram-style) instead of just text.
// Caches per-id, including negative results (null) for deleted/unavailable
// Hotposts, so we don't refetch a broken reference on every render.
async function loadHotpostPreviewsFor(ids) {
    const uniqueIds = [...new Set(ids.filter(id => id && !hotpostPreviewCache.has(id)))];
    if (uniqueIds.length === 0) return;
    try {
        const { data, error } = await supabase.from('hotposts').select('id, media_url, media_type, user_id').in('id', uniqueIds);
        if (error) throw error;
        const found = new Set();
        (data || []).forEach(h => { hotpostPreviewCache.set(h.id, h); found.add(h.id); });
        uniqueIds.forEach(id => { if (!found.has(id)) hotpostPreviewCache.set(id, null); });
    } catch (e) {
        console.error('Error loading Hotpost previews:', e);
        uniqueIds.forEach(id => { if (!hotpostPreviewCache.has(id)) hotpostPreviewCache.set(id, null); });
    }
}

// Same idea, for messages.shared_post_id (posts shared into a chat via the
// feed's "⋯" share button) — fetches just enough to show a thumbnail + snippet.
async function loadSharedPostPreviewsFor(ids) {
    const uniqueIds = [...new Set(ids.filter(id => id && !sharedPostPreviewCache.has(id)))];
    if (uniqueIds.length === 0) return;
    try {
        const { data, error } = await supabase.from('posts').select('id, post_type, content, media_url, users(id, full_name, profile_img_url)').in('id', uniqueIds);
        if (error) throw error;
        const found = new Set();
        (data || []).forEach(p => { sharedPostPreviewCache.set(p.id, p); found.add(p.id); });
        uniqueIds.forEach(id => { if (!found.has(id)) sharedPostPreviewCache.set(id, null); });
    } catch (e) {
        console.error('Error loading shared post previews:', e);
        uniqueIds.forEach(id => { if (!sharedPostPreviewCache.has(id)) sharedPostPreviewCache.set(id, null); });
    }
}

function getMyReaction(messageId) {
    const list = reactionsMap.get(messageId) || [];
    const mine = list.find(r => r.user_id === myProfile.id);
    return mine ? mine.emoji : null;
}

function reactionsPillHtml(messageId) {
    const list = reactionsMap.get(messageId) || [];
    if (list.length === 0) return '';
    const counts = {};
    list.forEach(r => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
    const mine = getMyReaction(messageId);
    return `<div class="flex flex-wrap gap-1 mt-1">${Object.entries(counts).map(([emoji, count]) => `
        <button onclick="window.toggleMessageReaction('${messageId}','${emoji}')" class="text-[11px] px-2 py-0.5 rounded-full border transition-colors active:scale-95 ${mine === emoji ? 'bg-primary/15 border-primary/40' : 'bg-surface-variant/30 dark:bg-neutral-800 border-surface-variant/50 dark:border-neutral-700'} flex items-center gap-1">
            <span>${emoji}</span>${count > 1 ? `<span class="opacity-70 font-semibold">${count}</span>` : ''}
        </button>`).join('')}</div>`;
}

window.toggleMessageReaction = async function (messageId, emoji) {
    window.closePopupMenu();
    if (!myProfile) return;
    const list = reactionsMap.get(messageId) || [];
    const mine = list.find(r => r.user_id === myProfile.id);
    if (navigator.vibrate) navigator.vibrate(10);

    if (mine && mine.emoji === emoji) {
        reactionsMap.set(messageId, list.filter(r => r.user_id !== myProfile.id));
        renderChatMessages();
        try { await supabase.from('message_reactions').delete().match({ message_id: messageId, user_id: myProfile.id }); }
        catch (e) { console.error(e); }
        return;
    }

    const newList = list.filter(r => r.user_id !== myProfile.id);
    newList.push({ message_id: messageId, user_id: myProfile.id, emoji });
    reactionsMap.set(messageId, newList);
    renderChatMessages();

    try {
        const { error } = await supabase.from('message_reactions')
            .upsert({ message_id: messageId, user_id: myProfile.id, emoji }, { onConflict: 'message_id,user_id' });
        if (error) throw error;
    } catch (e) {
        console.error(e);
        showToast('Failed to react.', 'error');
    }
};

// ==========================================
// Reply
// ==========================================
window.startReplyTo = function (messageId) {
    const m = chatMessages.find(x => x.id === messageId);
    window.closePopupMenu();
    if (!m || m.is_unsent) return;
    replyingTo = m;
    renderReplyPreview();
    document.getElementById('chat-composer-input')?.focus();
};
window.cancelReply = function () { clearReplyPreview(); };
function clearReplyPreview() { replyingTo = null; renderReplyPreview(); }

function renderReplyPreview() {
    const bar = document.getElementById('chat-reply-preview');
    if (!bar) return;
    if (!replyingTo) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    const mine = replyingTo.sender_id === myProfile.id;
    const label = mine ? 'Replying to yourself' : `Replying to ${escapeHtml(activeChat?.name || '')}`;
    bar.innerHTML = `
        <div class="flex items-center gap-2 bg-surface-variant/30 dark:bg-neutral-900/60 border border-surface-variant/50 dark:border-neutral-700 rounded-xl px-3 py-2">
            <div class="flex-1 min-w-0 border-l-2 border-primary pl-2">
                <p class="text-[11px] font-bold text-primary">${label}</p>
                <p class="text-[12.5px] truncate text-on-surface-variant dark:text-gray-400">${escapeHtml(replyingTo.content).slice(0, 80)}</p>
            </div>
            <button onclick="window.cancelReply()" class="p-1.5 rounded-full hover:bg-surface-variant/50 text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[18px]">close</span></button>
        </div>`;
    bar.classList.remove('hidden');
}

function replyQuoteHtml(m) {
    if (!m.reply_to_id) return '';
    const original = chatMessages.find(x => x.id === m.reply_to_id);
    const mine = m.sender_id === myProfile.id;
    const label = original ? (original.sender_id === myProfile.id ? 'You' : escapeHtml(activeChat?.name || '')) : 'Message';
    const snippet = original ? (original.is_unsent ? 'Message unsent' : escapeHtml(original.content).slice(0, 80)) : 'Original message unavailable';
    return `<div onclick="window.scrollToMessage('${m.reply_to_id}')" class="mb-1.5 pl-2 border-l-2 ${mine ? 'border-white/50' : 'border-primary/50'} opacity-90 cursor-pointer">
        <p class="text-[11px] font-bold ${mine ? 'text-white/90' : 'text-primary'}">${label}</p>
        <p class="text-[12px] truncate ${mine ? 'text-white/80' : 'text-on-surface-variant dark:text-gray-400'}">${snippet}</p>
    </div>`;
}

function hotpostReplyPreviewHtml(m) {
    if (!m.hotpost_reply_id) return '';
    const mine = m.sender_id === myProfile.id;
    const label = `Replied to ${mine ? 'their' : 'your'} Hotpost`;
    const preview = hotpostPreviewCache.get(m.hotpost_reply_id);

    // Not loaded yet, or no longer available (deleted) — plain label, no thumbnail
    if (!preview) {
        return `<p class="mb-1.5 text-[11px] font-bold flex items-center gap-1 ${mine ? 'text-white/85' : 'text-primary'}">
            <span class="material-symbols-outlined text-[13px]">reply</span>${label}
        </p>`;
    }

    const thumb = preview.media_type === 'video'
        ? `<div class="w-full h-full flex items-center justify-center bg-black/40"><span class="material-symbols-outlined text-white text-[18px]">play_circle</span></div>`
        : `<img src="${preview.media_url}" class="w-full h-full object-cover" loading="lazy">`;

    return `<div onclick="window.openHotpostFromReply('${preview.user_id}', '${m.hotpost_reply_id}')" class="flex items-center gap-2 mb-1.5 p-1.5 rounded-xl ${mine ? 'bg-white/10' : 'bg-black/5 dark:bg-white/5'} cursor-pointer active:opacity-80 transition-opacity">
        <div class="w-9 h-12 rounded-lg overflow-hidden shrink-0 bg-surface-variant/40 dark:bg-neutral-800">${thumb}</div>
        <p class="text-[11.5px] font-bold ${mine ? 'text-white/90' : 'text-primary'}">${label}</p>
    </div>`;
}

// Renders the little "shared post" card inside a bubble for messages.shared_post_id
// — same idea as hotpostReplyPreviewHtml above, but for a post shared via the
// feed's "⋯" share button instead of a story reply.
function sharedPostPreviewHtml(m) {
    if (!m.shared_post_id) return '';
    const mine = m.sender_id === myProfile.id;
    const preview = sharedPostPreviewCache.get(m.shared_post_id);

    // Not loaded yet, or the post is gone (deleted) — plain label, no thumbnail
    if (!preview) {
        return `<p class="flex items-center gap-1.5 text-[13.5px] ${mine ? 'text-white/85' : 'text-on-surface-variant dark:text-gray-400'}">
            <span class="material-symbols-outlined text-[16px]">${preview === null ? 'link_off' : 'image'}</span>${preview === null ? 'Post no longer available' : 'Loading post…'}
        </p>`;
    }

    const author = preview.users || {};
    // Anonymous posts must stay anonymous here too — this preview renders
    // before anyone taps through to the full (already-anonymized) card.
    const authorName = preview.post_type === 'anonymous' ? 'Anonymous' : (author.full_name || 'Post');
    const plainCaption = (preview.content || '').replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, ' ').trim();
    const thumb = preview.media_url
        ? `<img src="${preview.media_url}" class="w-full h-full object-cover" loading="lazy">`
        : `<div class="w-full h-full flex items-center justify-center bg-surface-variant/40 dark:bg-neutral-700"><span class="material-symbols-outlined text-on-surface-variant text-[20px]">article</span></div>`;

    return `<div onclick="window.openSinglePostView('${m.shared_post_id}')" class="w-[210px] rounded-xl overflow-hidden cursor-pointer active:opacity-90 transition-opacity ${mine ? 'bg-white/10' : 'bg-black/5 dark:bg-white/5'}">
        <div class="w-full h-[140px] bg-surface-variant/30 dark:bg-neutral-800">${thumb}</div>
        <div class="p-2">
            <p class="text-[11.5px] font-bold ${mine ? 'text-white/90' : 'text-on-surface dark:text-gray-100'} truncate">${escapeHtml(authorName)}</p>
            ${plainCaption ? `<p class="text-[11px] ${mine ? 'text-white/70' : 'text-on-surface-variant dark:text-gray-400'} line-clamp-2 mt-0.5">${escapeHtml(plainCaption)}</p>` : ''}
        </div>
    </div>`;
}

window.scrollToMessage = function (messageId) {
    const el = document.querySelector(`[data-message-row][data-message-id="${messageId}"]`);
    if (!el) { showToast("That message isn't loaded.", 'error'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-highlight-flash');
    setTimeout(() => el.classList.remove('msg-highlight-flash'), 900);
};

// ==========================================
// Copy / Unsend / Delete (single message)
// ==========================================
window.copyMessageText = async function (messageId) {
    const m = chatMessages.find(x => x.id === messageId);
    window.closePopupMenu();
    if (!m) return;
    try {
        await navigator.clipboard.writeText(m.content);
        showToast('Copied to clipboard', 'success');
    } catch (e) {
        showToast('Could not copy.', 'error');
    }
};

window.unsendMessage = async function (messageId) {
    window.closePopupMenu();
    const idx = chatMessages.findIndex(x => x.id === messageId);
    if (idx === -1) return;
    const original = chatMessages[idx];
    chatMessages[idx] = { ...original, is_unsent: true };
    renderChatMessages();
    try {
        const { error } = await supabase.from('messages').update({ is_unsent: true }).eq('id', messageId);
        if (error) throw error;
        scheduleInboxRefetch();
    } catch (e) {
        console.error(e);
        chatMessages[idx] = original;
        renderChatMessages();
        showToast("Couldn't unsend — the window may have expired.", 'error');
    }
};

window.deleteMessageForMe = async function (messageId) {
    window.closePopupMenu();
    const idx = chatMessages.findIndex(x => x.id === messageId);
    if (idx === -1) return;
    const m = chatMessages[idx];
    const mine = m.sender_id === myProfile.id;
    const field = mine ? 'deleted_for_sender' : 'deleted_for_receiver';
    chatMessages.splice(idx, 1);
    renderChatMessages();
    try {
        const { error } = await supabase.from('messages').update({ [field]: true }).eq('id', messageId);
        if (error) throw error;
        scheduleInboxRefetch();
    } catch (e) {
        console.error(e);
        showToast('Failed to delete message.', 'error');
        chatMessages.splice(idx, 0, m);
        renderChatMessages();
    }
};

// ==========================================
// Message-bubble popup menu (Reply / Copy / React / Unsend / Delete)
// ==========================================
function buildMessageActionMenu(m) {
    const mine = m.sender_id === myProfile.id;
    const withinUnsendWindow = mine && (Date.now() - new Date(m.created_at).getTime()) < 10 * 60 * 1000 && !m.is_unsent;
    const myReaction = getMyReaction(m.id);

    let html = `<div class="flex justify-around px-2 py-2 border-b border-surface-variant/40 dark:border-white/10">`;
    html += QUICK_EMOJIS.map(e => `
        <button onclick="window.toggleMessageReaction('${m.id}','${e}')" class="text-[22px] leading-none p-1 rounded-full transition-transform active:scale-125 ${myReaction === e ? 'bg-primary/15' : ''}">${e}</button>
    `).join('');
    html += `</div>`;

    if (!m.is_unsent) {
        html += popupMenuItem('reply', 'Reply', `window.startReplyTo('${m.id}')`);
        html += popupMenuItem('content_copy', 'Copy', `window.copyMessageText('${m.id}')`);
    }
    if (withinUnsendWindow) {
        html += popupMenuItem('undo', 'Unsend', `window.unsendMessage('${m.id}')`, true);
    }
    html += popupMenuItem('delete', 'Delete for me', `window.deleteMessageForMe('${m.id}')`, true);
    return html;
}

window.openMessageActionSheet = function (messageId, anchorOrEvent) {
    const m = chatMessages.find(x => x.id === messageId);
    if (!m) return;
    let anchor = anchorOrEvent;
    if (anchorOrEvent && typeof anchorOrEvent.clientX === 'number') anchor = { x: anchorOrEvent.clientX, y: anchorOrEvent.clientY };
    window.openPopupMenu(anchor, buildMessageActionMenu(m));
};

// ==========================================
// Gestures — long-press (mobile) / right-click (desktop) + swipe-to-reply
// ==========================================
function setupMessageGestures() {
    const container = document.getElementById('chat-messages-container');
    if (!container || container._gesturesBound) return;
    container._gesturesBound = true;

    container.addEventListener('contextmenu', (e) => {
        const row = e.target.closest('[data-message-row]');
        if (!row) return;
        e.preventDefault();
        window.openMessageActionSheet(row.dataset.messageId, e);
    });

    container.addEventListener('touchstart', (e) => {
        const row = e.target.closest('[data-message-row]');
        if (!row) { msgSwipeRow = null; return; }
        msgPressMoved = false;
        msgSwipeRow = row;
        msgPressStartX = e.touches[0].clientX;
        msgPressStartY = e.touches[0].clientY;
        msgPressTimer = setTimeout(() => {
            if (!msgPressMoved && msgSwipeRow) {
                if (navigator.vibrate) navigator.vibrate(15);
                window.openMessageActionSheet(msgSwipeRow.dataset.messageId, { x: msgPressStartX, y: msgPressStartY });
            }
        }, 450);
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
        if (!msgSwipeRow) return;
        const dx = e.touches[0].clientX - msgPressStartX;
        const dy = e.touches[0].clientY - msgPressStartY;
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) { msgPressMoved = true; clearTimeout(msgPressTimer); }

        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 12) {
            if (e.cancelable) e.preventDefault();
            const bubble = msgSwipeRow.querySelector('[data-bubble]');
            const icon = msgSwipeRow.querySelector('[data-reply-icon]');
            const clamped = Math.max(Math.min(dx, 70), -70);
            if (bubble) bubble.style.transform = `translateX(${clamped}px)`;
            if (icon) icon.style.opacity = Math.min(Math.abs(clamped) / 50, 1);
        }
    }, { passive: false });

    container.addEventListener('touchend', (e) => {
        clearTimeout(msgPressTimer);
        if (msgSwipeRow) {
            const row = msgSwipeRow;
            const bubble = row.querySelector('[data-bubble]');
            const icon = row.querySelector('[data-reply-icon]');
            const dx = e.changedTouches[0].clientX - msgPressStartX;
            if (bubble) { bubble.style.transition = 'transform 0.2s cubic-bezier(0.16,1,0.3,1)'; bubble.style.transform = ''; }
            if (icon) icon.style.opacity = 0;
            if (Math.abs(dx) > 60) {
                if (navigator.vibrate) navigator.vibrate(10);
                window.startReplyTo(row.dataset.messageId);
            }
            setTimeout(() => { if (bubble) bubble.style.transition = ''; }, 220);
        }
        msgSwipeRow = null;
    }, { passive: true });

    container.addEventListener('touchcancel', () => { clearTimeout(msgPressTimer); msgSwipeRow = null; }, { passive: true });
}

// ==========================================
// Rendering
// ==========================================
function statusTickHtml(m) {
    if (m.pending) return `<span class="material-symbols-outlined text-[13px] align-middle opacity-60">schedule</span>`;
    if (m.is_read) return `<span class="material-symbols-outlined text-[15px] align-middle text-sky-400">done_all</span>`;
    if (m.delivered_at) return `<span class="material-symbols-outlined text-[15px] align-middle opacity-60">done_all</span>`;
    return `<span class="material-symbols-outlined text-[15px] align-middle opacity-60">done</span>`;
}

function renderChatMessages() {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;

    if (chatMessages.length === 0) {
        container.innerHTML = `<div class="flex-1 flex flex-col items-center justify-center py-14 text-center px-6 opacity-50">
            <span class="material-symbols-outlined text-[42px] mb-2 text-on-surface-variant">waving_hand</span>
            <p class="text-sm font-medium text-on-surface-variant">Say hi to ${escapeHtml(activeChat?.name || '')}!</p>
        </div>`;
        updateScrollToBottomFab();
        return;
    }

    let html = '';
    if (hasMoreOlder) {
        html += `<div class="flex justify-center py-2"><div class="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin opacity-70"></div></div>`;
    }

    let lastDay = null;
    for (let i = 0; i < chatMessages.length; i++) {
        const m = chatMessages[i];
        const day = new Date(m.created_at).toDateString();
        if (day !== lastDay) {
            html += `<div class="flex justify-center my-3"><span class="text-[11px] font-bold text-on-surface-variant dark:text-gray-500 bg-surface-variant/40 dark:bg-neutral-800/60 px-3 py-1 rounded-full">${dayLabel(m.created_at)}</span></div>`;
            lastDay = day;
        }

        const mine = m.sender_id === myProfile.id;
        const next = chatMessages[i + 1];
        const isLastInGroup = !next || next.sender_id !== m.sender_id || (new Date(next.created_at) - new Date(m.created_at)) > 5 * 60 * 1000;

        let bubbleClasses, bubbleInner;
        if (m.is_unsent) {
            bubbleClasses = `bg-surface-variant/30 dark:bg-neutral-900/60 text-on-surface-variant dark:text-gray-500 rounded-2xl ${mine ? 'rounded-br-md' : 'rounded-bl-md'}`;
            bubbleInner = `<p class="italic flex items-center gap-1.5 text-[13.5px]"><span class="material-symbols-outlined text-[16px]">block</span>${mine ? 'You unsent a message' : 'This message was unsent'}</p>`;
        } else {
            bubbleClasses = mine
                ? `bg-primary text-white rounded-2xl rounded-br-md${m.pending ? ' opacity-60' : ''}${m.failed ? ' ring-2 ring-error' : ''}`
                : 'bg-surface-variant/50 dark:bg-neutral-800 text-on-surface dark:text-gray-100 rounded-2xl rounded-bl-md';
            bubbleInner = hotpostReplyPreviewHtml(m) + replyQuoteHtml(m) + sharedPostPreviewHtml(m)
                + (m.shared_post_id ? '' : `<div class="whitespace-pre-wrap break-words">${linkify(escapeHtml(m.content))}</div>`);
        }

        const retryAttr = (mine && m.failed) ? `onclick="window.retryFailedMessage('${m.id}')"` : '';

        html += `
        <div class="relative" data-message-row data-message-id="${m.id}">
            <span data-reply-icon class="material-symbols-outlined absolute top-1/2 -translate-y-1/2 ${mine ? 'left-1' : 'right-1'} text-primary text-[20px] opacity-0 pointer-events-none transition-opacity">reply</span>
            <div class="flex ${mine ? 'justify-end' : 'justify-start'} chat-bubble-anim">
                <div data-bubble ${retryAttr} class="max-w-[75%] px-4 py-2.5 text-[14.5px] leading-relaxed ${bubbleClasses} ${m.failed ? 'cursor-pointer' : ''}">${bubbleInner}</div>
            </div>
            <div class="flex ${mine ? 'justify-end' : 'justify-start'}">
                <div class="max-w-[75%]">${reactionsPillHtml(m.id)}</div>
            </div>`;

        if (isLastInGroup) {
            let meta;
            if (mine && m.failed) {
                meta = `<span class="text-error font-semibold">Failed · Tap to retry</span>`;
            } else {
                meta = timeShort(m.created_at);
                if (mine && !m.is_unsent) meta += ` ${statusTickHtml(m)}`;
            }
            html += `<div class="flex ${mine ? 'justify-end' : 'justify-start'} mb-3 mt-0.5">
                <span class="text-[10.5px] text-on-surface-variant dark:text-gray-500 px-1 flex items-center gap-1">${meta}</span>
            </div>`;
        } else {
            html += `<div class="mb-1"></div>`;
        }
        html += `</div>`;
    }

    container.innerHTML = html;
    setupMessageGestures();
    updateScrollToBottomFab();
}

function scrollToBottom(instant) {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;
    if (instant) container.scrollTop = container.scrollHeight;
    else container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    newMessagesWhileScrolledUp = 0;
    updateScrollToBottomFab();
}
window.scrollChatToBottom = function () { scrollToBottom(false); };

function updateScrollToBottomFab() {
    const container = document.getElementById('chat-messages-container');
    const fab = document.getElementById('chat-scroll-bottom-fab');
    const badge = document.getElementById('chat-scroll-bottom-badge');
    if (!container || !fab) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    fab.classList.toggle('hidden', distanceFromBottom <= 250);
    if (distanceFromBottom < 40) newMessagesWhileScrolledUp = 0;
    if (badge) {
        if (newMessagesWhileScrolledUp > 0) { badge.textContent = String(newMessagesWhileScrolledUp); badge.classList.remove('hidden'); }
        else badge.classList.add('hidden');
    }
}

async function markVisibleAsRead(partnerId) {
    const unreadIds = chatMessages.filter(m => m.receiver_id === myProfile.id && !m.is_read).map(m => m.id);
    if (!unreadIds.length) return;

    chatMessages.forEach(m => { if (unreadIds.includes(m.id)) m.is_read = true; });

    try {
        const { error } = await supabase.from('messages').update({ is_read: true }).in('id', unreadIds);
        if (error) throw error;
        updateNavBadge();
    } catch (error) {
        console.error('Error marking messages as read:', error);
    }
}

async function markVisibleAsDelivered(partnerId) {
    const ids = chatMessages.filter(m => m.receiver_id === myProfile.id && !m.delivered_at).map(m => m.id);
    if (!ids.length) return;
    const now = new Date().toISOString();
    chatMessages.forEach(m => { if (ids.includes(m.id)) m.delivered_at = now; });
    try { await supabase.from('messages').update({ delivered_at: now }).in('id', ids); }
    catch (e) { console.error('Error marking delivered:', e); }
}

async function markDeliveredSingle(messageId) {
    try { await supabase.from('messages').update({ delivered_at: new Date().toISOString() }).eq('id', messageId).is('delivered_at', null); }
    catch (e) { console.debug('mark delivered failed', e); }
}

// ==========================================
// Composer
// ==========================================
function setupComposer() {
    const input = document.getElementById('chat-composer-input');
    if (!input) return;

    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 112) + 'px';
        updateSendButtonState();

        if (activeChat) {
            saveDraft(activeChat.userId, input.value);
            broadcastTyping(input.value.trim().length > 0);
            clearTimeout(typingStopTimer);
            typingStopTimer = setTimeout(() => broadcastTyping(false), 2500);
        }
    });

    input.addEventListener('keydown', (e) => {
        // Enter sends, Shift+Enter makes a newline (desktop/keyboard users)
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            window.sendChatMessage();
        }
    });
}

function updateSendButtonState() {
    const input = document.getElementById('chat-composer-input');
    const btn = document.getElementById('chat-send-btn');
    if (!input || !btn) return;
    btn.disabled = input.value.trim().length === 0;
}

function setupViewportHandling() {
    if (!window.visualViewport) return;
    window.visualViewport.addEventListener('resize', () => {
        const modal = document.getElementById('modal-chat-conversation');
        if (!modal || modal.classList.contains('hidden')) return;
        const container = document.getElementById('chat-messages-container');
        if (!container) return;
        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        if (distanceFromBottom < 150) container.scrollTop = container.scrollHeight;
    });
}

// Pages' own messages get a distinct notification type (page_message) — real
// content in the push instead of the generic "New Chat", and (see the edge
// function) can't be muted per-conversation the way a regular chat can.
function notifyNewMessage(recipientId, content) {
    const isPage = myProfile.role === 'page';
    createNotification({
        userId: recipientId,
        senderId: myProfile.id,
        type: isPage ? 'page_message' : 'new_message',
        message: isPage ? content : null
    });
}

// ==========================================
// Page broadcast — one message to every user on the platform
// ==========================================
window.openBroadcastComposer = function () {
    const modal = document.getElementById('modal-broadcast-composer');
    const input = document.getElementById('broadcast-composer-input');
    if (input) input.value = '';
    modal.classList.replace('hidden', 'flex');
};

window.closeBroadcastComposer = function () {
    document.getElementById('modal-broadcast-composer').classList.replace('flex', 'hidden');
};

window.sendBroadcast = async function () {
    const input = document.getElementById('broadcast-composer-input');
    const btn = document.getElementById('broadcast-send-btn');
    const content = (input?.value || '').trim();
    if (!content) { showToast('Write something first.', 'warning'); return; }

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Sending...';

    try {
        // broadcast_page_message is SECURITY DEFINER and does the actual fan-out
        // server-side (one INSERT...SELECT for the messages, another for the
        // notifications) — not a client-side loop over every user, which
        // wouldn't hold up for a real user base or survive the tab closing
        // partway through.
        const { data: recipientCount, error } = await supabase.rpc('broadcast_page_message', { p_content: content });
        if (error) throw error;

        window.closeBroadcastComposer();
        showToast(`Sent to ${recipientCount} ${recipientCount === 1 ? 'person' : 'people'}.`, 'success');
        fetchInbox(); // so the page's own inbox reflects the new threads immediately
    } catch (error) {
        console.error('Broadcast failed:', error);
        showToast(error.message?.includes('Only Page accounts') ? error.message : 'Failed to send broadcast.', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
    }
};

window.sendChatMessage = async function () {
    const input = document.getElementById('chat-composer-input');
    if (!input || !activeChat || sendInFlight) return;

    const content = input.value.trim();
    if (!content) return;

    if (navigator.vibrate) navigator.vibrate(8);
    sendInFlight = true;
    const replyTo = replyingTo;
    input.value = '';
    input.style.height = 'auto';
    updateSendButtonState();
    saveDraft(activeChat.userId, '');
    broadcastTyping(false);
    clearReplyPreview();

    const tempId = `temp-${Date.now()}`;
    const optimisticMsg = {
        id: tempId,
        sender_id: myProfile.id,
        receiver_id: activeChat.userId,
        content,
        is_read: false,
        delivered_at: null,
        created_at: new Date().toISOString(),
        reply_to_id: replyTo ? replyTo.id : null,
        is_unsent: false,
        deleted_for_sender: false,
        deleted_for_receiver: false,
        pending: true
    };
    chatMessages.push(optimisticMsg);
    renderChatMessages();
    scrollToBottom(true);

    try {
        const payload = { sender_id: myProfile.id, receiver_id: activeChat.userId, content };
        if (replyTo) payload.reply_to_id = replyTo.id;
        const { data, error } = await supabase
            .from('messages')
            .insert(payload)
            .select(MESSAGE_COLUMNS)
            .single();
        if (error) throw error;

        const idx = chatMessages.findIndex(m => m.id === tempId);
        if (idx !== -1) chatMessages[idx] = data;
        renderChatMessages();

        // new_message / page_message notification — chats never notified at all
        // before this session. Regular chats stay generic ("New Chat", no
        // content); the edge function also checks the recipient's per-
        // conversation mute setting for this sender before actually pushing.
        notifyNewMessage(activeChat.userId, content);
    } catch (error) {
        console.error('Error sending message:', error);
        const idx = chatMessages.findIndex(m => m.id === tempId);
        if (idx !== -1) chatMessages[idx] = { ...chatMessages[idx], pending: false, failed: true };
        renderChatMessages();
        showToast("Couldn't send that. You may only message your connections.", 'error');
    } finally {
        sendInFlight = false;
    }
};

// Sends a post as a shared-post message — the in-app "Send to" flow triggered
// from the feed's share button (see window.shareFeedPost in main.js), as opposed
// to the OS share sheet / copy-link path. Deliberately a standalone insert rather
// than reusing sendChatMessage(), since that reads from the open composer input
// and this can be fired from the feed with no chat open at all.
window.sendPostToChat = async function (receiverId, postId) {
    try {
        const payload = { sender_id: myProfile.id, receiver_id: receiverId, content: SHARED_POST_FALLBACK_TEXT, shared_post_id: postId };
        const { data, error } = await supabase.from('messages').insert(payload).select(MESSAGE_COLUMNS).single();
        if (error) throw error;

        notifyNewMessage(receiverId, SHARED_POST_FALLBACK_TEXT);

        // If the recipient's conversation happens to already be open, drop it
        // straight into the thread instead of waiting on the realtime round-trip.
        if (activeChat && activeChat.userId === receiverId) {
            chatMessages.push(data);
            await loadSharedPostPreviewsFor([postId]);
            renderChatMessages();
            scrollToBottom(true);
        }
        if (typeof window.refreshMessages === 'function') window.refreshMessages();
        return true;
    } catch (error) {
        console.error('Error sharing post to chat:', error);
        const isRlsBlock = error.code === '42501' || /row-level security/i.test(error.message || '');
        showToast(isRlsBlock ? "You can only share posts with a connection." : 'Failed to send.', 'error');
        return false;
    }
};

window.retryFailedMessage = async function (tempId) {
    const idx = chatMessages.findIndex(m => m.id === tempId);
    if (idx === -1 || !activeChat) return;
    const original = chatMessages[idx];
    chatMessages[idx] = { ...original, pending: true, failed: false };
    renderChatMessages();

    try {
        const payload = { sender_id: myProfile.id, receiver_id: activeChat.userId, content: original.content };
        if (original.reply_to_id) payload.reply_to_id = original.reply_to_id;
        const { data, error } = await supabase
            .from('messages')
            .insert(payload)
            .select(MESSAGE_COLUMNS)
            .single();
        if (error) throw error;

        const idx2 = chatMessages.findIndex(m => m.id === tempId);
        if (idx2 !== -1) chatMessages[idx2] = data;
        renderChatMessages();
        notifyNewMessage(activeChat.userId, original.content);
    } catch (e) {
        console.error(e);
        const idx3 = chatMessages.findIndex(m => m.id === tempId);
        if (idx3 !== -1) chatMessages[idx3] = { ...chatMessages[idx3], pending: false, failed: true };
        renderChatMessages();
        showToast("Still couldn't send. Check your connection.", 'error');
    }
};

// ==========================================
// Typing broadcast
// ==========================================
function broadcastTyping(isTyping) {
    if (!chatChannel || !activeChat) return;
    chatChannel.send({ type: 'broadcast', event: 'typing', payload: { userId: myProfile.id, isTyping } });
}
function showTypingIndicator(isTyping) {
    clearTimeout(partnerTypingTimeout);
    partnerIsTypingNow = isTyping;
    if (isTyping) {
        setHeaderStatus('typing…');
        partnerTypingTimeout = setTimeout(() => { partnerIsTypingNow = false; setHeaderStatus(currentPresenceStatus()); }, 4000);
    } else {
        setHeaderStatus(currentPresenceStatus());
    }
}

// ==========================================
// Realtime
// ==========================================
function subscribeInbox() {
    if (!myProfile || inboxChannel) return;
    inboxChannel = supabase
        .channel(`inbox-${myProfile.id}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `receiver_id=eq.${myProfile.id}` }, (payload) => {
            markDeliveredSingle(payload.new.id);
            fetchInbox();
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `receiver_id=eq.${myProfile.id}` }, () => {
            scheduleInboxRefetch();
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `sender_id=eq.${myProfile.id}` }, () => {
            scheduleInboxRefetch();
        })
        .subscribe();
}

function handleChatMessageUpdate(updated) {
    if (!activeChat) return;
    const idx = chatMessages.findIndex(m => m.id === updated.id);
    if (idx === -1) return;
    if (isHiddenForMe(updated)) {
        chatMessages.splice(idx, 1);
    } else {
        chatMessages[idx] = { ...chatMessages[idx], ...updated };
    }
    renderChatMessages();
}

function subscribeChat(partnerId) {
    unsubscribeChat();
    chatChannel = supabase
        .channel(`chat-${[myProfile.id, partnerId].sort().join('-')}`)
        .on('broadcast', { event: 'typing' }, ({ payload }) => {
            if (payload && payload.userId === partnerId) showTypingIndicator(!!payload.isTyping);
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `sender_id=eq.${partnerId}` }, (payload) => {
            const m = payload.new;
            if (!activeChat || activeChat.userId !== partnerId || m.receiver_id !== myProfile.id) return;
            if (isHiddenForMe(m)) return;

            chatMessages.push(m);
            const container = document.getElementById('chat-messages-container');
            const wasNearBottom = container ? (container.scrollHeight - container.scrollTop - container.clientHeight) < 200 : true;
            renderChatMessages();
            if (wasNearBottom) {
                scrollToBottom(true);
            } else {
                newMessagesWhileScrolledUp++;
                updateScrollToBottomFab();
            }
            showTypingIndicator(false);
            markVisibleAsRead(partnerId);
            markVisibleAsDelivered(partnerId);

            if (m.hotpost_reply_id && !hotpostPreviewCache.has(m.hotpost_reply_id)) {
                loadHotpostPreviewsFor([m.hotpost_reply_id]).then(() => renderChatMessages());
            }
            if (m.shared_post_id && !sharedPostPreviewCache.has(m.shared_post_id)) {
                loadSharedPostPreviewsFor([m.shared_post_id]).then(() => renderChatMessages());
            }
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `sender_id=eq.${partnerId}` }, (payload) => {
            handleChatMessageUpdate(payload.new);
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `sender_id=eq.${myProfile.id}` }, (payload) => {
            if (payload.new.receiver_id === partnerId) handleChatMessageUpdate(payload.new);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, (payload) => {
            const row = (payload.new && Object.keys(payload.new).length) ? payload.new : payload.old;
            if (!row || !chatMessages.some(m => m.id === row.message_id)) return;
            if (row.user_id === myProfile.id) return; // already applied optimistically
            if (payload.eventType === 'DELETE') {
                const list = reactionsMap.get(row.message_id) || [];
                reactionsMap.set(row.message_id, list.filter(r => r.user_id !== row.user_id));
            } else {
                const list = (reactionsMap.get(row.message_id) || []).filter(r => r.user_id !== row.user_id);
                list.push({ message_id: row.message_id, user_id: row.user_id, emoji: row.emoji });
                reactionsMap.set(row.message_id, list);
            }
            renderChatMessages();
        })
        .subscribe();
}

function unsubscribeChat() {
    if (chatChannel) { supabase.removeChannel(chatChannel); chatChannel = null; }
    clearTimeout(typingStopTimer);
    clearTimeout(partnerTypingTimeout);
    partnerIsTypingNow = false;
}

window.refreshMessages = fetchInbox;

// CLEANUP FUNCTION FOR TAB SWITCHING
// (Online presence stays alive app-wide — only the messages-tab-specific
// channels and state are torn down here.)
window.cleanupMessagesTab = function () {
    try {
        if (inboxChannel) {
            try { inboxChannel.unsubscribe(); inboxChannel = null; }
            catch (e) { console.debug("Error unsubscribing from inbox:", e); }
        }
        if (chatChannel) {
            try { chatChannel.unsubscribe(); chatChannel = null; }
            catch (e) { console.debug("Error unsubscribing from chat:", e); }
        }

        activeChat = null;
        chatMessages = [];
        reactionsMap.clear();
        replyingTo = null;

        console.debug("Messages tab cleanup complete");
    } catch (err) {
        console.error("Messages cleanup error:", err);
    }
};
