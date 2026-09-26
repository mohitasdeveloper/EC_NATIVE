import { supabase } from './supabase.js';
import { showToast } from './ui.js';
import { timeAgo, saveNotificationsToCache, getNotificationsFromCache } from './utils.js'; // <-- NEW

let currentUser = null;
let allNotifications = [];

const NOTIF_SKELETON = `
    <div class="flex items-center gap-3.5 p-4 animate-pulse">
        <div class="w-12 h-12 rounded-full shimmer-bg shrink-0"></div>
        <div class="flex-1 space-y-2">
            <div class="h-3.5 shimmer-bg rounded-md w-3/4"></div>
            <div class="h-2.5 shimmer-bg rounded-md w-1/3"></div>
        </div>
    </div>
`.repeat(6);

const iconMap = {
    'post_like': { icon: 'favorite', color: 'text-red-500', bg: 'bg-red-500/10' },
    'post_comment': { icon: 'chat_bubble', color: 'text-blue-500', bg: 'bg-blue-500/10' },
    'comment_reply': { icon: 'forum', color: 'text-indigo-500', bg: 'bg-indigo-500/10' },
    'comment_like': { icon: 'favorite', color: 'text-red-500', bg: 'bg-red-500/10' },
    'post_mention': { icon: 'alternate_email', color: 'text-primary', bg: 'bg-primary/10' },
    'comment_mention': { icon: 'alternate_email', color: 'text-primary', bg: 'bg-primary/10' },
    'hotpost_like': { icon: 'local_fire_department', color: 'text-orange-500', bg: 'bg-orange-500/10' },
    'hotpost_reply': { icon: 'reply', color: 'text-purple-500', bg: 'bg-purple-500/10' },
    'connection_request': { icon: 'person_add', color: 'text-primary', bg: 'bg-primary/10' },
    'connection_accepted': { icon: 'handshake', color: 'text-green-500', bg: 'bg-green-500/10' },
    'new_follower': { icon: 'person_add', color: 'text-primary', bg: 'bg-primary/10' },
    'page_new_post': { icon: 'campaign', color: 'text-blue-500', bg: 'bg-blue-500/10' },
    'page_new_hotpost': { icon: 'local_fire_department', color: 'text-orange-500', bg: 'bg-orange-500/10' }
};

export function initNotifications(user) {
    currentUser = user;
    setupEventListeners();
    fetchNotifications();
    setupPushNotifications();
}

function setupEventListeners() {
    const notifBtn = document.getElementById('notif-btn');
    if (notifBtn) {
        const newBtn = notifBtn.cloneNode(true);
        notifBtn.parentNode.replaceChild(newBtn, notifBtn);
        newBtn.addEventListener('click', openNotifications);
    }

    document.getElementById('notif-tab-all')?.addEventListener('click', () => switchNotifTab('all'));
    document.getElementById('notif-tab-requests')?.addEventListener('click', () => switchNotifTab('requests'));

    const lists = ['notifications-list-all', 'notifications-list-requests'];
    lists.forEach(id => {
        const container = document.getElementById(id);
        if (container) {
            container.addEventListener('click', (e) => {
                const notifCard = e.target.closest('.notif-card');
                const acceptBtn = e.target.closest('.accept-request-btn');
                const declineBtn = e.target.closest('.decline-request-btn');
                
                if (acceptBtn) {
                    handleAcceptRequest(acceptBtn.dataset.userId, acceptBtn);
                    return;
                }
                if (declineBtn) {
                    handleDeclineRequest(declineBtn.dataset.userId, declineBtn);
                    return;
                }
                if (notifCard) {
                    const notifId = notifCard.dataset.notifId;
                    const notif = allNotifications.find(n => n.id === notifId);
                    if (notif) handleNotificationClick(notif, notifCard);
                }
            });
        }
    });
}
// --------------------------------------------------
// PUSH NOTIFICATIONS (Deep Linking Engine)
// --------------------------------------------------
async function setupPushNotifications() {
    const Cap = window.Capacitor;

    // 1. Basic Check: Are we in the Android app?
    // Capacitor 7 removed the old `Cap.isNative` boolean property.
    // Use the isNativePlatform() method instead.
    if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) {
        console.log("Running in browser. Native Push Notifications disabled.");
        return; 
    }

    try {
        // 🚀 Access the natively-registered plugins.
        // This site has no bundler, so we can't use the `registerPlugin()`
        // import-time helper — instead we read the plugin proxies Capacitor
        // automatically exposes on window.Capacitor.Plugins for exactly
        // this "no bundler" scenario.
        const Push = Cap.Plugins && Cap.Plugins.PushNotifications;
        const Splash = Cap.Plugins && Cap.Plugins.SplashScreen;

        if (!Push) {
            console.error("Failed to register PushNotifications plugin.");
            return;
        }

        await Push.removeAllListeners();

        // 🚀 Click Listener
        await Push.addListener('pushNotificationActionPerformed', (action) => {
            if (Splash) Splash.hide().catch(()=>{});
            
            const data = action.notification.data;
            if (!data || !data.type) {
                if (typeof window.openNotifications === 'function') window.openNotifications();
                return;
            }

            if (typeof window.openSinglePostView !== 'function') {
                localStorage.setItem('pending_notification_route', JSON.stringify(data));
                return;
            }

            if (typeof window.closeNotifications === 'function') window.closeNotifications();
            
            setTimeout(() => {
                if (data.type.startsWith('post_') && data.target_id) {
                    window.openSinglePostView(data.target_id);
                    if (['post_comment', 'comment_reply', 'comment_like', 'comment_mention'].includes(data.type)) {
                        setTimeout(() => {
                            if (typeof window.openCommentsModal === 'function') window.openCommentsModal(data.target_id);
                        }, 500);
                    }
                } 
                else if ((data.type === 'connection_accepted' || data.type === 'connection_request') && data.sender_id) {
                    if (typeof window.viewUserProfile === 'function') window.viewUserProfile(data.sender_id);
                } 
                else if (data.type.startsWith('hotpost_')) {
                    if (typeof window.showMyHotposts === 'function') window.showMyHotposts();
                    else if (typeof window.openHotpostViewer === 'function') window.openHotpostViewer(currentUser.id);
                } 
                else if (data.type === 'new_message' && data.sender_id) {
                    // 🚀 NEW: previously unhandled here too — tapping the actual OS push
                    // banner for a chat message just opened the notification bell list
                    // instead of the conversation itself.
                    if (typeof window.openConversation === 'function') window.openConversation(data.sender_id);
                }
                else {
                    if (typeof window.openNotifications === 'function') window.openNotifications();
                }
            }, 150);
        });

        // 🚀 Registration & Foreground Delivery — attach listeners BEFORE register()
        // so a fast native response can never be missed.
        await Push.addListener('registration', async (token) => {
            try {
                if (typeof saveTokenToSupabase === 'function') await saveTokenToSupabase(token.value);
            } catch (e) {
                console.error('Failed to save FCM token:', e);
            }
        });

        await Push.addListener('registrationError', (err) => {
            console.error('Push registration error:', err);
        });

        await Push.addListener('pushNotificationReceived', (notification) => {
            if (typeof showToast === 'function') showToast(`${notification.title}: ${notification.body}`, 'info');
            if (typeof fetchNotifications === 'function') fetchNotifications(); 
        });

        // 🚀 Request Permissions
        let permStatus = await Push.checkPermissions();

        if (permStatus.receive === 'prompt') {
            permStatus = await Push.requestPermissions();
        }
        
        if (permStatus.receive === 'granted') {
            await Push.register();
        } else {
            console.log("Push permissions denied by user.");
        }

    } catch (err) {
        console.error("Push Engine Crash: ", err);
    }
}
// 🚀 RESTORED MISSING FUNCTION: Required to save the token generated in Step 5
async function saveTokenToSupabase(token) {
    try {
        await supabase.from('users').update({ fcm_token: token }).eq('id', currentUser.id);
    } catch (err) {
        console.error("Could not save push token:", err);
    }
}
// -----------------------------------
// UI & FETCHING LOGIC
// -----------------------------------
export function openNotifications() {
    const modal = document.getElementById('modal-notifications');
    const bottomNav = document.querySelector('nav'); 
    
    modal.classList.replace('hidden', 'flex');
    if (bottomNav) bottomNav.classList.add('hidden'); 
    
    setTimeout(() => modal.classList.remove('translate-x-full'), 10);
    
    fetchNotifications();

    const badge = document.getElementById('notif-badge');
    if (badge) badge.classList.add('hidden');
    markAllAsReadSilent(); 
}

export function closeNotifications() {
    const modal = document.getElementById('modal-notifications');
    const bottomNav = document.querySelector('nav');
    
    modal.classList.add('translate-x-full');
    setTimeout(() => {
        modal.classList.replace('flex', 'hidden');
        if (bottomNav) bottomNav.classList.remove('hidden'); 
    }, 300);
}

function switchNotifTab(tabName) {
    document.getElementById('notif-content-all').classList.add('hidden');
    document.getElementById('notif-content-requests').classList.add('hidden');
    document.getElementById(`notif-content-${tabName}`).classList.remove('hidden');

    ['all', 'requests'].forEach(t => {
        const btn = document.getElementById(`notif-tab-${t}`);
        btn.classList.remove('border-primary', 'text-primary');
        btn.classList.add('border-transparent', 'text-on-surface-variant', 'dark:text-gray-400');
    });

    const activeBtn = document.getElementById(`notif-tab-${tabName}`);
    activeBtn.classList.add('border-primary', 'text-primary');
    activeBtn.classList.remove('border-transparent', 'text-on-surface-variant', 'dark:text-gray-400');
}

async function fetchNotifications() {
    document.getElementById('notifications-list-all').innerHTML = NOTIF_SKELETON;
    document.getElementById('notifications-list-requests').innerHTML = NOTIF_SKELETON;

    // 🚀 OFFLINE INTERCEPTOR
    if (!navigator.onLine) {
        try {
            const cachedNotifs = await getNotificationsFromCache();
            allNotifications = cachedNotifs;
            
            const requests = cachedNotifs.filter(n => n.type === 'connection_request');
            const general = cachedNotifs.filter(n => n.type !== 'connection_request');

            renderList('notifications-list-all', general, "No recent activity.");
            renderList('notifications-list-requests', requests, "No pending connection requests.");
        } catch(e) { console.error(e); }
        return;
    }

    try {
        const { data, error } = await supabase
            .from('notifications')
            .select('id, type, message, target_id, is_read, created_at, sender:sender_id(id, full_name, profile_img_url)')
            .eq('user_id', currentUser.id)
            .not('type', 'in', '("new_message","page_message")') // chats (including Page broadcasts) have their own inbox/unread badge
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;
        allNotifications = data;

        const requests = data.filter(n => n.type === 'connection_request');
        const general = data.filter(n => n.type !== 'connection_request');

        renderList('notifications-list-all', general, "No recent activity.");
        renderList('notifications-list-requests', requests, "No pending connection requests.");

        const modal = document.getElementById('modal-notifications');
        if (modal && modal.classList.contains('hidden')) {
            const unreadCount = data.filter(n => !n.is_read).length;
            const badge = document.getElementById('notif-badge');
            if (badge) badge.classList.toggle('hidden', unreadCount === 0);
        }

        const reqBadge = document.getElementById('requests-badge');
        if (requests.length > 0) {
            reqBadge.textContent = requests.length;
            reqBadge.classList.remove('hidden');
        } else {
            reqBadge.classList.add('hidden');
        }

        // 🚀 SAVE TO OFFLINE CACHE
        saveNotificationsToCache(data);

    } catch (error) {
        console.error('Error fetching notifications:', error);
    }
}

function renderList(containerId, data, emptyMessage) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (data.length === 0) {
        container.innerHTML = `<div class="flex flex-col items-center justify-center py-20 opacity-40 text-on-surface-variant"><span class="material-symbols-outlined text-[42px] mb-2">notifications_off</span><p class="text-sm font-medium">${emptyMessage}</p></div>`;
        return;
    }
    container.innerHTML = data.map(notif => renderNotificationItem(notif)).join('');
}

function renderNotificationItem(notif) {
    const sender = notif.sender;
    const ui = iconMap[notif.type] || { icon: 'notifications', color: 'text-gray-500', bg: 'bg-gray-100' };
    const isUnread = !notif.is_read ? 'bg-primary/5 dark:bg-primary/10' : 'bg-surface dark:bg-[#121212]';

    const rawAvatarUrl = sender.profile_img_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(sender.full_name)}&background=e1e3e4`;
    const optimizedAvatar = typeof window.optimizeImageUrl === 'function' ? window.optimizeImageUrl(rawAvatarUrl, 'avatar') : rawAvatarUrl;
    const fallback = `this.onerror=null; this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(sender.full_name)}&background=e1e3e4';`;

    let textContent = '';
    let actionButtons = '';

    if (notif.type === 'post_like') textContent = 'liked your post.';
    else if (notif.type === 'post_comment') textContent = `commented: "<span class="text-on-surface-variant italic">${notif.message.replace(/<[^>]*>?/gm, '').replace(/\u00A0/g, ' ')}</span>"`;
    else if (notif.type === 'comment_reply') textContent = `replied to your comment: "<span class="text-on-surface-variant italic">${notif.message.replace(/<[^>]*>?/gm, '').replace(/\u00A0/g, ' ')}</span>"`;
    else if (notif.type === 'comment_like') textContent = 'liked your comment.';
    else if (notif.type === 'post_mention') textContent = `mentioned you in a post: "<span class="text-on-surface-variant italic">${notif.message.replace(/<[^>]*>?/gm, '').replace(/\u00A0/g, ' ')}</span>"`;
    else if (notif.type === 'comment_mention') textContent = `mentioned you in a comment: "<span class="text-on-surface-variant italic">${notif.message.replace(/<[^>]*>?/gm, '').replace(/\u00A0/g, ' ')}</span>"`;
    else if (notif.type === 'hotpost_like') textContent = 'liked your Hotpost.';
    else if (notif.type === 'hotpost_reply') textContent = `replied to your Hotpost: "<span class="text-on-surface-variant italic">${notif.message}</span>"`;
    else if (notif.type === 'connection_accepted') textContent = 'accepted your connection request.';
    else if (notif.type === 'new_follower') textContent = 'started following you.';
    else if (notif.type === 'page_new_post') textContent = 'published a new post.';
    else if (notif.type === 'page_new_hotpost') textContent = 'added a new hotpost.';
    else if (notif.type === 'connection_request') {
        textContent = 'sent you a connection request.';
        actionButtons = `
            <div class="flex gap-2 mt-2.5">
                <button data-user-id="${sender.id}" class="accept-request-btn bg-primary text-white px-5 py-1.5 rounded-full text-[11px] font-bold active:scale-95 transition-transform shadow-sm">Accept</button>
                <button data-user-id="${sender.id}" class="decline-request-btn bg-surface-variant/50 text-on-surface dark:text-gray-200 px-5 py-1.5 rounded-full text-[11px] font-bold active:scale-95 transition-transform">Decline</button>
            </div>
        `;
    }
    
    return `
        <div data-notif-id="${notif.id}" class="notif-card p-4 ${isUnread} flex items-start gap-3.5 cursor-pointer hover:bg-surface-variant/30 dark:hover:bg-neutral-800/50 transition-colors">
            <div class="relative shrink-0">
                <img loading="lazy" src="${optimizedAvatar}" onerror="${fallback}" class="w-12 h-12 rounded-full object-cover shadow-sm border border-surface-variant/50">
                <div class="absolute -bottom-1 -right-1 w-5 h-5 rounded-full ${ui.bg} flex items-center justify-center border-[1.5px] border-surface dark:border-[#121212]">
                    <span class="material-symbols-outlined text-[10px] ${ui.color}" style="font-variation-settings: 'FILL' 1">${ui.icon}</span>
                </div>
            </div>
            <div class="flex-1 min-w-0">
                <p class="text-[13px] text-on-surface dark:text-gray-200 leading-snug">
                    <span class="font-extrabold text-[14px]">${sender.full_name}</span> ${textContent}
                </p>
                <p class="text-[11px] font-medium text-on-surface-variant dark:text-gray-500 mt-0.5">${timeAgo(notif.created_at)}</p>
                ${actionButtons}
            </div>
        </div>
    `;
}

async function handleNotificationClick(notif, element) {
    element.classList.remove('bg-primary/5', 'dark:bg-primary/10');
    element.classList.add('bg-surface', 'dark:bg-[#121212]');

    if (['post_like', 'post_comment', 'page_new_post', 'comment_reply', 'comment_like', 'post_mention', 'comment_mention'].includes(notif.type)) {
        const { data } = await supabase.from('posts')
            .select('id')
            .eq('id', notif.target_id)
            .eq('is_deleted', false)
            .maybeSingle();
            
        if (data) {
            closeNotifications(); 
            setTimeout(() => window.openSinglePostView(notif.target_id), 150);

            if (['post_comment', 'comment_reply', 'comment_like', 'comment_mention'].includes(notif.type)) {
                setTimeout(() => window.openCommentsModal(notif.target_id), 500);
            }
        } else {
            showToast('Post not available.', 'info');
        }
    }
    else if (notif.type === 'hotpost_like' || notif.type === 'hotpost_reply' || notif.type === 'page_new_hotpost') {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        
        const { data } = await supabase.from('hotposts')
            .select('id, user_id')
            .eq('id', notif.target_id)
            .eq('is_deleted', false)
            .gt('created_at', twentyFourHoursAgo)
            .maybeSingle();
        
        if (data) {
            closeNotifications();
            setTimeout(() => {
                if (typeof window.openHotpostViewer === 'function') window.openHotpostViewer(data.user_id); 
            }, 150);
        } else {
            showToast('Hotpost expired.', 'info');
        }
    }
    else if (notif.type === 'connection_accepted' || notif.type === 'connection_request' || notif.type === 'new_follower') {
        closeNotifications();
        setTimeout(() => window.viewUserProfile(notif.sender.id), 150);
    }
}

async function handleAcceptRequest(userId, btn) {
    await window.handleConnectionAction(userId, 'accept', btn);
    fetchNotifications(); 
}

async function handleDeclineRequest(userId, btn) {
    await window.handleConnectionAction(userId, 'decline', btn);
    fetchNotifications(); 
}

async function markAllAsReadSilent() {
    try {
        await supabase.from('notifications').update({ is_read: true })
            .eq('user_id', currentUser.id).eq('is_read', false);
    } catch (error) {
        console.error('Error auto-marking read:', error);
    }
}

window.closeNotifications = closeNotifications;
