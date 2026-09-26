import { initHotposts } from './hotposts.js';
import { showToast } from './ui.js';
import { timeAgo, getActionQueue, clearAction, getFeedFromCache } from './utils.js';
import { supabase } from './supabase.js';
import { initFeed } from './feed.js';
import { initSearch } from './search.js';
import { initNotifications } from './notifications.js';
import { initMessages } from './messages.js';
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_AVATARS_PRESET } from './config.js';
import { getBlockedUserIds as getBlockedUsersOptimized, onConnectionChanged, onBlockChanged, getAcceptedConnections } from './data-layer.js';
import { renderPostCardsHtml } from './post-card.js';

let currentUserProfile = null;
window.addEventListener('load', () => {
    // Initialize the Pull-to-Refresh Engine
    // This allows the user to drag down to refresh
    if (typeof initPullToRefresh === 'function') {
        initPullToRefresh();
    }
});

// 🚀 SPLASH SCREEN — tied to real readiness, not a flat timer.
//
// Previously this waited for `window.load` (which only fires once every
// external script/font has finished downloading) plus a hardcoded extra
// 2000ms on top — so on a slow connection the splash could sit for many
// seconds for no functional reason, and on a fast one it always cost at
// least 2s. Now it's hidden as soon as the app actually knows what to
// show (see the calls to hideSplash() in the DOMContentLoaded handler
// below), with this timeout only as a last-resort safety net so a stuck
// network call can never leave the user staring at the splash forever.
let splashHidden = false;
function hideSplash() {
    if (splashHidden) return;
    splashHidden = true;

    const splash = document.getElementById('app-splash-screen');
    if (splash) {
        splash.style.pointerEvents = 'none';
        splash.style.opacity = '0';
        document.body.classList.remove('overflow-hidden');
        setTimeout(() => splash.remove(), 500);
    }

    // Also dismiss the native Capacitor splash screen if it's still up
    // (see capacitor.config.ts — launchAutoHide is off so the native
    // splash stays visible, covering the load, until we explicitly hide
    // it here). window.Capacitor only exists inside the native app, so
    // this is a no-op when the page is opened in a plain browser.
    try {
        window.Capacitor?.Plugins?.SplashScreen?.hide();
    } catch (e) { /* not running inside the native shell — ignore */ }
}
// Absolute safety net: never let a hung network call keep the splash up.
setTimeout(hideSplash, 8000);

// 🚀 BACKGROUND SYNC PROCESSOR
window.processOfflineQueue = async function() {
    if (!navigator.onLine) return;
    
    const queue = await getActionQueue();
    if (queue.length === 0) return;

    let successCount = 0;
    for (const action of queue) {
        try {
            if (action.type === 'like_post') {
                if (action.payload.isLiked) await supabase.from('post_likes').delete().match({ post_id: action.payload.postId, user_id: action.payload.userId });
                else await supabase.from('post_likes').insert({ post_id: action.payload.postId, user_id: action.payload.userId });
            } 
            else if (action.type === 'save_post') {
                if (action.payload.isSaved) await supabase.from('saved_posts').delete().match({ post_id: action.payload.postId, user_id: action.payload.userId });
                else await supabase.from('saved_posts').insert({ post_id: action.payload.postId, user_id: action.payload.userId });
            }
            else if (action.type === 'rsvp_event') {
                if (action.payload.isCurrentlyAttending) await supabase.from('post_event_rsvps').delete().match({ post_id: action.payload.postId, user_id: action.payload.userId });
                else await supabase.from('post_event_rsvps').insert({ post_id: action.payload.postId, user_id: action.payload.userId, status: 'attending' });
            }
            else if (action.type === 'comment_post') {
                await supabase.from('post_comments').insert(action.payload);
            }
            else if (action.type === 'poll_vote') {
                await supabase.rpc('cast_poll_vote', {
                    p_post_id: action.payload.postId,
                    p_user_id: action.payload.userId,
                    p_option_id: String(action.payload.optionId),
                    p_is_undo: action.payload.isUndo
                });
            }
            
            // Remove from queue once successfully pushed to Supabase
            await clearAction(action.id);
            successCount++;
        } catch (err) {
            console.error("Queue process error:", err);
        }
    }
    
    if (successCount > 0) {
        setTimeout(() => {
            showToast(`Synced ${successCount} offline actions!`, 'success');
            if (typeof window.executeContextualRefresh === 'function') window.executeContextualRefresh();
        }, 1500);
    }
};

// Trigger the sync when the device comes back online
window.addEventListener('online', () => {
    setTimeout(window.processOfflineQueue, 2000); 
});
// ==========================================
// GLOBAL CLOUDINARY COMPRESSION ENGINE
// ==========================================
window.loadedTabs = new Set(['view-dashboard']); // Feed is loaded by default on boot

window.optimizeImageUrl = function(url, type = 'feed') {
    if (!url || !url.includes('cloudinary.com')) return url;
    if (url.includes('/upload/q_auto')) return url; 
    
    let params = 'q_auto,f_auto,w_800'; 
    if (type === 'avatar') params = 'q_auto:eco,f_auto,w_150,h_150,c_fill'; 
    else if (type === 'hotpost') params = 'q_auto:low,f_auto,w_720'; // full-screen viewing — favor sharpness over file size

    return url.replace('/upload/', `/upload/${params}/`);
};

// ========================================================
// BULLETPROOF PULL-TO-REFRESH ENGINE
// ========================================================
function initPullToRefresh() {
    if (window._ptrActive) return;
    window._ptrActive = true;

    // 1. DYNAMICALLY INJECT CSS & UI BUBBLE
    const style = document.createElement('style');
    style.innerHTML = `
        /* Force kill native browser overscroll completely */
        html, body { overscroll-behavior: none !important; }
        
        #smart-ptr {
            position: fixed; top: var(--sat); left: 50%; z-index: 2147483647; /* Maximum z-index */
            transform: translate(-50%, -150px);
            display: flex; align-items: center; gap: 8px;
            background: #ffffff; padding: 10px 20px;
            border-radius: 50px; box-shadow: 0 4px 15px rgba(0,0,0,0.2);
            transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s ease;
            opacity: 0; pointer-events: none;
        }
        html.dark #smart-ptr { background: #1e1e1e; border: 1px solid rgba(255,255,255,0.1); }
        #smart-ptr-icon { color: #10B981; font-size: 24px; transition: transform 0.1s; }
        #smart-ptr-text { font-size: 14px; font-weight: 700; color: #000; }
        html.dark #smart-ptr-text { color: #fff; }
        .ptr-spin { animation: ptrSpin 1s linear infinite; }
        @keyframes ptrSpin { 100% { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);

    const ptrContainer = document.createElement('div');
    ptrContainer.id = 'smart-ptr';
    ptrContainer.innerHTML = `
        <span id="smart-ptr-icon" class="material-symbols-outlined">refresh</span>
        <span id="smart-ptr-text">Pull to refresh</span>
    `;
    document.body.appendChild(ptrContainer);

    const icon = document.getElementById('smart-ptr-icon');
    const text = document.getElementById('smart-ptr-text');

    let startY = 0;
    let isDragging = false;
    let isRefreshing = false;
    let lastVisualDist = 0;
    const triggerPoint = 80;

    // 2. ULTRA-SAFE TOP DETECTOR
    // This accurately climbs the DOM to ensure you are at the absolute top of the feed!
    function isAtAbsoluteTop(node) {
        let current = node;
        while (current && current !== document.body && current !== document.documentElement) {
            if (current.scrollTop > 2) return false; 
            current = current.parentNode;
        }
        if ((window.scrollY || document.documentElement.scrollTop) > 2) return false;
        return true;
    }

    document.addEventListener('touchstart', (e) => {
        if (isRefreshing) return;
        
        // Block if swiping on a modal or camera
        if (e.target.closest('[id^="modal-"]:not(.hidden), [id^="view-create-post"]:not(.hidden)')) return;

        if (isAtAbsoluteTop(e.target)) {
            startY = e.touches[0].clientY;
            isDragging = true;
            lastVisualDist = 0;
            ptrContainer.style.transition = 'none'; 
            icon.classList.remove('ptr-spin');
        }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!isDragging || isRefreshing) return;

        const distance = e.touches[0].clientY - startY;

        if (distance < 0) {
            isDragging = false; // Cancel drag if they scroll upwards
            return;
        }

        if (distance > 0 && isAtAbsoluteTop(e.target)) {
            if (e.cancelable) e.preventDefault(); // 🛑 KILLS NATIVE BROWSER SCROLL

            lastVisualDist = distance * 0.45;
            
            ptrContainer.style.opacity = '1';
            ptrContainer.style.transform = `translate(-50%, ${Math.min(lastVisualDist, triggerPoint + 20)}px)`;
            icon.style.transform = `rotate(${lastVisualDist * 3}deg)`;

            if (lastVisualDist >= triggerPoint) {
                text.innerText = "Release to refresh";
                if (navigator.vibrate && text.dataset.vibrated !== 'true') {
                    navigator.vibrate(10);
                    text.dataset.vibrated = 'true';
                }
            } else {
                text.innerText = "Pull to refresh";
                text.dataset.vibrated = 'false';
            }
        }
    }, { passive: false }); // 🛑 MUST BE FALSE FOR PREVENT DEFAULT TO WORK

    const handleTouchEnd = async () => {
        if (!isDragging) return;
        isDragging = false;

        ptrContainer.style.transition = 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s ease';
        
        if (lastVisualDist >= triggerPoint && !isRefreshing) {
            isRefreshing = true;
            
            // Snap to loading position
            ptrContainer.style.transform = `translate(-50%, 60px)`;
            text.innerText = "Refreshing...";
            icon.style.transform = '';
            icon.classList.add('ptr-spin');

            try {
                if (window.executeContextualRefresh) await window.executeContextualRefresh();
            } catch(e) { console.error(e); }

            // Hide bubble after loading completes
            isRefreshing = false;
            ptrContainer.style.transform = `translate(-50%, -150px)`;
            ptrContainer.style.opacity = '0';
            setTimeout(() => icon.classList.remove('ptr-spin'), 300);

        } else {
            // Did not pull far enough, cancel
            ptrContainer.style.transform = `translate(-50%, -150px)`;
            ptrContainer.style.opacity = '0';
        }
        lastVisualDist = 0;
    };

    document.addEventListener('touchend', handleTouchEnd, { passive: true });
    document.addEventListener('touchcancel', handleTouchEnd, { passive: true });
}

window.executeContextualRefresh = async function() {
    const activeTab = document.querySelector('.tab-content:not(.hidden)');
    if (!activeTab) return;

    try {
        if (activeTab.id === 'view-dashboard') {
            if (typeof window.refreshMainFeed === 'function') await window.refreshMainFeed();
            if (typeof window.refreshHotposts === 'function') await window.refreshHotposts();
        } 
        else if (activeTab.id === 'view-search') {
            if (typeof window.refreshDiscover === 'function') await window.refreshDiscover();
        }
        else if (activeTab.id === 'view-messages') {
            if (typeof window.refreshMessages === 'function') await window.refreshMessages();
        }
        else if (activeTab.id === 'view-profile') {
            // 🚀 FIX: Now re-fetches your entire profile (stats, bio, and posts)
            if (typeof window.refreshMyProfile === 'function') {
                await window.refreshMyProfile();
            }
        }
        await new Promise(res => setTimeout(res, 800)); // Minimum time for visual effect
    } catch (e) {
        console.error("Contextual Refresh Error:", e);
    }
};

// 🚀 NEW: Dedicated function to sync your profile data with the database natively
// 🚀 NEW: Dedicated function to sync your profile data with the database natively
window.refreshMyProfile = async function() {
    if (!currentUserProfile) return;
    
    // Do NOT attempt to refresh the profile if the user is currently offline
    if (!navigator.onLine) return; 

    try {
        const { data: profile, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', currentUserProfile.id)
            .single();
        
        if (error) throw error;
        
        currentUserProfile = profile;
        localStorage.setItem('ecampus_profile_cache', JSON.stringify(profile));
        
        populateProfileUI(currentUserProfile); 
    } catch (err) {
        console.error("Error refreshing profile:", err);
    }
};
// Duplicate of the "GLOBAL CLOUDINARY COMPRESSION ENGINE" window.optimizeImageUrl
// above used to live here — it silently won at runtime (last `window.X =` wins),
// so hotpost images were actually using its 600px/q_auto:eco settings this whole
// time regardless of the other definition's intent. Decided: 720px/q_auto:low
// for hotposts going forward (see CHANGELOG) — removed this shadowed copy.
// ========================================================
// CLIENT-SIDE IMAGE COMPRESSOR
// ========================================================
window.compressImage = function(file, maxSize = 800, quality = 0.8) {
    return new Promise((resolve, reject) => {
        if (!file.type.match(/image.*/)) {
            resolve(file);
            return;
        }

        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = event => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > maxSize) {
                        height = Math.round((height *= maxSize / width));
                        width = maxSize;
                    }
                } else {
                    if (height > maxSize) {
                        width = Math.round((width *= maxSize / height));
                        height = maxSize;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob(blob => {
                    if (!blob) {
                        reject(new Error('Canvas compression failed'));
                        return;
                    }
                    const compressedFile = new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".webp", {
                        type: 'image/webp',
                        lastModified: Date.now()
                    });
                    resolve(compressedFile);
                }, 'image/webp', quality);
            };
            img.onerror = error => reject(error);
        };
        reader.onerror = error => reject(error);
    });
};

// ========================================================
// PROFESSIONAL SKELETON LOADERS
// ========================================================
const FEED_SKELETON = `
    <div class="bg-surface-container-lowest dark:bg-[#1e1e1e] rounded-[32px] p-5 border border-surface-variant/60 dark:border-neutral-800 shadow-sm mb-5">
        <div class="flex items-center gap-3 mb-4">
            <div class="w-10 h-10 rounded-full shimmer-bg shrink-0"></div>
            <div class="flex-1">
                <div class="h-3.5 shimmer-bg rounded-md w-1/3 mb-2.5"></div>
                <div class="h-2.5 shimmer-bg rounded-md w-1/4"></div>
            </div>
        </div>
        <div class="h-3 shimmer-bg rounded-md w-3/4 mb-2.5"></div>
        <div class="h-3 shimmer-bg rounded-md w-full mb-2.5"></div>
        <div class="h-3 shimmer-bg rounded-md w-5/6 mb-4"></div>
        <div class="w-full h-48 shimmer-bg rounded-2xl mb-4"></div>
        <div class="flex items-center gap-6 border-t border-surface-variant/40 dark:border-neutral-800 pt-4 mt-2">
            <div class="h-5 w-12 shimmer-bg rounded-md"></div>
            <div class="h-5 w-12 shimmer-bg rounded-md"></div>
        </div>
    </div>
`.repeat(3);

const LIST_SKELETON = `
    <div class="flex items-center gap-4 p-3 mb-3 bg-white dark:bg-neutral-900 rounded-2xl border border-gray-200 dark:border-neutral-800">
        <div class="w-12 h-12 rounded-full shimmer-bg shrink-0"></div>
        <div class="flex-1">
            <div class="h-3.5 shimmer-bg rounded-md w-1/2 mb-2.5"></div>
            <div class="h-2.5 shimmer-bg rounded-md w-1/3"></div>
        </div>
    </div>
`.repeat(5);


// Reads the session supabase-js persisted in localStorage (key: sb-<project-ref>-auth-token).
// Only used as an OFFLINE fallback — see the DOMContentLoaded boot below.
function readStoredSupabaseSession() {
    try {
        const key = Object.keys(localStorage).find((k) => /^sb-.+-auth-token$/.test(k));
        if (!key) return null;
        const parsed = JSON.parse(localStorage.getItem(key));
        const s = parsed && (parsed.currentSession || parsed);
        return s && s.user && s.user.id ? s : null;
    } catch (e) {
        return null;
    }
}

// ========================================================
// APP INITIALIZATION & LAYOUT
// ========================================================
document.addEventListener('DOMContentLoaded', async () => {
    // 0. Forced-update gate — runs before anything else touches the
    // session/profile. If the installed build is below the current
    // min_version_code, this renders a full-screen "Update Required"
    // overlay and returns true; boot stops right here.
    const { checkForcedUpdate } = await import('./version-gate.js');
    if (await checkForcedUpdate()) {
        hideSplash();
        return;
    }

  // 1. Check user sessions
    let { data: { session }, error: sessionError } = await supabase.auth.getSession();

    // 🚀 OFFLINE FIX: supabase-js access tokens last ~1 hour. Offline, an expired
    // token can't be refreshed, so getSession() comes back with NO session (and a
    // fetch error) even though the user is still logged in — which used to bounce
    // everyone to the login screen whenever they opened the app offline after an
    // hour. When offline, trust the stored session and the cached profile instead;
    // supabase-js refreshes the token by itself as soon as the network is back.
    if ((sessionError || !session) && !navigator.onLine) {
        const stored = readStoredSupabaseSession();
        if (stored && localStorage.getItem('ecampus_profile_cache')) {
            session = stored;
            sessionError = null;
        }
    }

    // If there is strictly no session, go to login.
    if (sessionError || !session) {
        hideSplash();
        window.location.replace("./auth/login.html");
        return;
    }

   // 2. Fetch user profile (Instant Offline Short-Circuit)
    let profile = null;

    if (!navigator.onLine) {
        // 🚀 INSTANT OFFLINE BOOT: Skip the network completely to prevent the 30-second hang
        const cachedProfile = localStorage.getItem('ecampus_profile_cache');
        if (cachedProfile) {
            profile = JSON.parse(cachedProfile);
            console.log("Loaded profile instantly from offline cache.");
        } else {
            hideSplash();
            showToast('Could not load your profile. Please reconnect to the internet.', 'error');
            return; // Halt boot, but don't log them out!
        }
    } else {
        // NORMAL ONLINE BOOT
        try {
            const { data, error } = await supabase
                .from('users')
                .select('*')
                .eq('auth_user_id', session.user.id)
                .single();

            if (error || !data) throw error;
            
            // Save to cache for offline use
            profile = data;
            localStorage.setItem('ecampus_profile_cache', JSON.stringify(profile));

        } catch (error) {
            console.error('Error fetching profile from DB:', error);
            
            // Try to load from offline cache as a last resort
            const cachedProfile = localStorage.getItem('ecampus_profile_cache');
            if (cachedProfile) {
                profile = JSON.parse(cachedProfile);
                console.log("Loaded profile from offline cache after network failure.");
            } else {
                hideSplash();
                showToast('Could not load your profile. Please try logging in again.', 'error');
                await supabase.auth.signOut();
                window.location.replace('auth/login.html');
                return;
            }
        }
    }

    currentUserProfile = profile;
    // 🚀 HOTFIX: Prevent verification screen flash on boot
    const verifyView = document.getElementById('view-verification');
    if (verifyView) verifyView.style.setProperty('display', 'none', 'important');

    // Initialize the verification module in the background
    import('./verification.js').then(async module => {
        await module.initVerification(profile);
        
        // Remove the CSS lock and reset classes so it stays hidden but is ready for manual clicks
        setTimeout(() => {
            if (verifyView) {
                verifyView.classList.remove('flex');
                verifyView.classList.add('hidden');
                verifyView.style.removeProperty('display');
            }
            // Forcefully un-hide the main app elements that verification.js hid
            const mainContent = document.getElementById('main-content');
            const header = document.querySelector('header');
            const nav = document.querySelector('nav');
            
            if (mainContent) { mainContent.classList.remove('hidden'); mainContent.style.display = ''; }
            if (header) { header.classList.remove('hidden'); header.style.display = ''; }
            if (nav) { nav.classList.remove('hidden'); nav.style.display = ''; }
        }, 100);
    });

    // Proceed to load the app UI (Read-Only access granted)
    initializeApp(profile);
    hideSplash();

    // Inject the Persistent Verification Banner
    setupVerificationBanner(profile.verification_status);
});

function initializeApp(profile) {
    console.log('Welcome to ECampus,', profile.full_name);

    initHotposts(profile);
    initFeed(profile);
    initSearch(profile);
    initNotifications(profile);
    initMessages(profile);

    window.processOfflineQueue(); // <-- ADD THIS LINE HERE

    updateHeaderAvatar(profile.profile_img_url, profile.full_name);
    populateProfileUI(profile);
    setupMoreMenuListener();
    setupThemeToggle(); 
    setupEditProfileAvatarUpload();
    document.getElementById('sign-out-btn').addEventListener('click', handleSignOut);
    setupBlockedUsersListener();

    setupAppBackButton();
    initPullToRefresh(); 

    // COLD START PENDING ROUTE SYSTEM
    const pendingRoute = localStorage.getItem('pending_notification_route');
    if (pendingRoute) {
        localStorage.removeItem('pending_notification_route');
        try {
            const routeData = JSON.parse(pendingRoute);
            
            if (routeData.type.startsWith('post_')) {
                switchTab('dashboard'); 
                setTimeout(() => window.openSinglePostView(routeData.target_id), 300);
            } 
            else if (routeData.type === 'connection_accepted' || routeData.type === 'connection_request') {
                switchTab('dashboard');
                setTimeout(() => window.viewUserProfile(routeData.sender_id), 300);
            } 
            else if (routeData.type.startsWith('hotpost_')) {
                switchTab('dashboard');
                setTimeout(() => {
                    if (typeof window.showMyHotposts === 'function') window.showMyHotposts();
                    else if (typeof window.openHotpostViewer === 'function') window.openHotpostViewer(profile.id);
                }, 300);
            } else if (routeData.type === 'new_message' && routeData.sender_id) {
                // 🚀 NEW: same gap as the two other push-tap handlers — cold-starting
                // from a chat notification used to just land on the dashboard.
                switchTab('dashboard');
                setTimeout(() => { if (typeof window.openConversation === 'function') window.openConversation(routeData.sender_id); }, 300);
            } else {
                switchTab('dashboard');
            }
        } catch(e) {
            console.error("Route parsing error", e);
            switchTab('dashboard');
        }
    } else {
        switchTab('dashboard'); 
    }

    // 🚀 Shared-post deep link: ?post=<id> in the URL (from the new Share button's
    // copied/shared links) opens straight to that post, the same way a notification
    // tap does above. Strips the param afterward so refreshing doesn't re-trigger it.
    const sharedPostId = new URLSearchParams(window.location.search).get('post');
    if (sharedPostId) {
        setTimeout(() => window.openSinglePostView(sharedPostId), 400);
        const cleanUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, cleanUrl);
    }
}
   

async function updateNativeStatusBar(isDark) {
    try {
        // @capacitor/status-bar was removed (its window-colour APIs are the
        // "deprecated for edge-to-edge" warning in Play Console). The strip
        // behind the status bar is painted by .status-bar-guard in CSS, so
        // the only native job left is choosing light/dark ICONS, which the
        // built-in SystemBars plugin does. Same no-bundler access pattern
        // as the InAppBrowser plugin: window.Capacitor.Plugins.
        if (window.Capacitor && window.Capacitor.isNativePlatform()) {
            const SystemBars = window.Capacitor.Plugins && window.Capacitor.Plugins.SystemBars;
            if (!SystemBars) return;
            // 'DARK' = light icons for a dark background, 'LIGHT' = dark icons
            // for a light background (same meaning the old StatusBar had).
            await SystemBars.setStyle({ style: isDark ? 'DARK' : 'LIGHT' });
        }
    } catch (error) {
        console.warn('System bars configuration bypassed.');
    }
}

// Pushes the app's chosen theme (light/dark) to the native side so the
// BAFS exam-countdown home-screen widget (see bafs-study-planner.html and
// ExamWidgetProvider.java) can match it instead of always rendering in one
// fixed look. No-op outside the Android app build — AndroidWidgetTheme only
// exists there.
function syncWidgetTheme(isDark) {
    if (window.AndroidWidgetTheme && window.AndroidWidgetTheme.setTheme) {
        try { window.AndroidWidgetTheme.setTheme(isDark ? 'dark' : 'light'); } catch (e) { /* older app build without the bridge */ }
    }
}

function setupThemeToggle() {
    const themeToggle = document.getElementById('theme-toggle-switch');
    if (!themeToggle) return;

    const isDarkMode = localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches);

    document.documentElement.classList.toggle('dark', isDarkMode);
    themeToggle.checked = isDarkMode;
    updateNativeStatusBar(isDarkMode);
    syncWidgetTheme(isDarkMode);

    themeToggle.addEventListener('change', () => {
        if (themeToggle.checked) {
            document.documentElement.classList.add('dark');
            localStorage.setItem('theme', 'dark');
            
            // 🚀 FIX: Forcefully overwrite the boot script's background color!
            document.body.style.setProperty('background-color', '#121212', 'important');
            
            updateNativeStatusBar(true);
            syncWidgetTheme(true);
        } else {
            document.documentElement.classList.remove('dark');
            localStorage.setItem('theme', 'light');
            
            // 🚀 FIX: Forcefully overwrite the boot script's background color!
            document.body.style.setProperty('background-color', '#f8f9fa', 'important');
            
            updateNativeStatusBar(false);
            syncWidgetTheme(false);
        }
    });
}

// 🚀 GLOBAL TICK GENERATOR (Strict Hex Engine)
window.getTickHtml = function(type) {
    if (!type || type.toLowerCase().trim() === 'none') return '';
    const color = type.trim();
    // Only accept a hex colour (#0af, #00aaff, #00aaffcc) or a plain colour
    // keyword. tick_type comes from the database and is dropped straight
    // into a style attribute, so anything else is ignored rather than trusted.
    if (!/^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(color)) return '';
    // Sized in em so the badge scales with whatever name it sits next to
    // (14px post names, 22px profile headers, ...) instead of a fixed 14px
    // that looked tiny on big names. shrink-0 stops it being squashed when a
    // long name truncates; the small negative vertical-align keeps it
    // optically centred on the text when the parent isn't a flex row.
    return `<span class="material-symbols-outlined shrink-0" aria-label="Verified" style="font-size:1.2em; vertical-align:-0.2em; color:${color}; font-variation-settings:'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 20;">verified</span>`;
};
// ========================================================
// CORE PROFILE UI & SOCIALS
// ========================================================
function setupMoreMenuListener() {
    const moreMenu = document.getElementById('public-profile-more-menu');
    const moreBtn = document.getElementById('public-profile-more-btn');

    if (moreMenu) {
        moreMenu.addEventListener('click', (e) => {
            const button = e.target.closest('button');
            if (!button) return;

            const action = button.dataset.action;
            const modal = document.getElementById('modal-profile-public');
            const userId = modal.dataset.userId;
            const userName = document.getElementById('public-profile-name').textContent;

            if (!action || !userId) return;

            moreMenu.classList.add('hidden');

            if (action === 'report') {
                openReportModal(userId, userName);
            } else {
                handleConnectionAction(userId, action, null); 
            }
        });
    }

    document.addEventListener('click', (e) => {
        if (moreMenu && !moreMenu.classList.contains('hidden')) {
            if (moreBtn && !moreBtn.contains(e.target) && !moreMenu.contains(e.target)) {
                moreMenu.classList.add('hidden');
            }
        }
    });
}

function setupBlockedUsersListener() {
    const list = document.getElementById('blocked-users-list');
    if (!list) return;

    list.addEventListener('click', async (e) => {
        const unblockBtn = e.target.closest('.unblock-btn');
        if (unblockBtn && !unblockBtn.disabled) {
            const userIdToUnblock = unblockBtn.dataset.userId;
            unblockBtn.disabled = true;
            unblockBtn.textContent = '...';
            await handleConnectionAction(userIdToUnblock, 'unblock', null);
            openBlockedUsersModal(); 
        }
    });
}

const socialIconMap = {
    linkedin: { icon: 'fa-brands fa-linkedin-in', color: 'bg-[#0A66C2]' },
    instagram: { icon: 'fa-brands fa-instagram', color: 'bg-gradient-to-br from-purple-400 via-pink-500 to-red-500' },
    github: { icon: 'fa-brands fa-github', color: 'bg-[#181717] dark:bg-white dark:!text-black' },
    twitter: { icon: 'fa-brands fa-x-twitter', color: 'bg-[#000000] dark:bg-white dark:!text-black' },
    youtube: { icon: 'fa-brands fa-youtube', color: 'bg-[#FF0000]' },
    discord: { icon: 'fa-brands fa-discord', color: 'bg-[#5865F2]' },
    facebook: { icon: 'fa-brands fa-facebook-f', color: 'bg-[#1877F2]' },
    whatsapp: { icon: 'fa-brands fa-whatsapp', color: 'bg-[#25D366]' },
    snapchat: { icon: 'fa-brands fa-snapchat', color: 'bg-[#FFFC00] !text-black' }, 
    telegram: { icon: 'fa-brands fa-telegram', color: 'bg-[#229ED9]' },
    spotify: { icon: 'fa-brands fa-spotify', color: 'bg-[#1DB954]' },
    reddit: { icon: 'fa-brands fa-reddit-alien', color: 'bg-[#FF4500]' },
    website: { icon: 'fa-solid fa-globe', color: 'bg-primary' }, 
    other: { icon: 'fa-solid fa-link', color: 'bg-gray-500' }
};

function renderSocialLinks(links, container = null) {
    const targetContainer = container || document.getElementById('profile-social-links');
    if (!targetContainer) return;

    targetContainer.innerHTML = ''; 

    if (links && links.length > 0) {
        links.forEach(link => {
            const platformInfo = socialIconMap[link.platform] || socialIconMap['other'];
            const linkEl = document.createElement('a');
            linkEl.href = link.url;
            linkEl.target = '_blank';
            linkEl.title = link.platform.charAt(0).toUpperCase() + link.platform.slice(1);
            linkEl.className = `w-[52px] h-[52px] rounded-2xl flex items-center justify-center text-white text-2xl ${platformInfo.color} transition-transform hover:scale-110 shrink-0 shadow-sm`;
            linkEl.innerHTML = `<i class="${platformInfo.icon}"></i>`;
            targetContainer.appendChild(linkEl);
        });
    }

    if (!container) {
        const addButton = document.createElement('button');
        addButton.onclick = () => openEditSocialsModal();
        addButton.className = 'w-[52px] h-[52px] rounded-2xl flex items-center justify-center bg-gray-100 dark:bg-neutral-800 border-2 border-dashed border-gray-300 dark:border-neutral-700 text-gray-400 dark:text-gray-500 hover:border-primary hover:text-primary transition-colors shrink-0';
        addButton.innerHTML = `<span class="material-symbols-outlined">add</span>`;
        targetContainer.appendChild(addButton);
    }
}

// Story ring on the profile-page avatar: mirrors the Hotpost tray's own ring
// (same gray shades for viewed/unviewed). Tapping opens the viewer only when
// there's an active Hotpost — a plain avatar otherwise, changing your picture
// is Edit Profile's job now. Called from populateProfileUI (once, on load) AND
// every time you switch to the Profile tab (see switchTab below) — the tray's
// own fetch may well not have finished yet the first time this runs at boot.
function updateMyProfileAvatarRing() {
    const avatarRingEl = document.getElementById('my-profile-avatar-ring');
    if (!avatarRingEl) return;
    const ringState = typeof window.getMyHotpostRingState === 'function' ? window.getMyHotpostRingState() : null;
    if (ringState) {
        const ringClass = ringState.viewed ? 'from-gray-300 to-gray-400' : 'from-gray-400 to-gray-600';
        avatarRingEl.className = `shrink-0 mr-6 rounded-full p-[2.5px] bg-gradient-to-tr ${ringClass} cursor-pointer active:scale-95 transition-transform`;
        avatarRingEl.onclick = () => window.showMyHotposts();
    } else {
        avatarRingEl.className = 'shrink-0 mr-6 rounded-full p-[2.5px]';
        avatarRingEl.onclick = null;
    }
}
window.updateMyProfileAvatarRing = updateMyProfileAvatarRing;

function populateProfileUI(profile) {
    if (!profile) return;
    // Keep the ID-verification form prefilled with the latest profile details
    if (typeof window.prefillVerificationForm === 'function') window.prefillVerificationForm(profile);
    
    const headerNameEl = document.getElementById('my-profile-header-name');
    if (headerNameEl) headerNameEl.textContent = profile.full_name;
    
    const tickEl = document.getElementById('my-profile-header-tick');
    if (tickEl) {
        if (profile.tick_type && profile.tick_type.toLowerCase().trim() !== 'none') {
            tickEl.className = `material-symbols-outlined text-[18px]`;
            tickEl.style.color = profile.tick_type.trim();
            tickEl.style.fontVariationSettings = "'FILL' 1";
            tickEl.classList.remove('hidden');
        } else {
            tickEl.classList.add('hidden');
            tickEl.style.color = '';
        }
    }
    
    const avatarEl = document.getElementById('my-profile-avatar');
    if (avatarEl) avatarEl.src = profile.profile_img_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(profile.full_name)}&background=e1e3e4`;

    updateMyProfileAvatarRing();

    const connCountEl = document.getElementById('my-profile-connection-count');
    if (connCountEl) {
        connCountEl.textContent = profile.connection_count || 0;
        // Dynamically change label based on role
        if (profile.role === 'page') {
            connCountEl.nextElementSibling.textContent = 'Followers';
            const sidebarText = document.getElementById('sidebar-stats-text');
            if (sidebarText) sidebarText.textContent = 'Followers';
        } else {
            connCountEl.nextElementSibling.textContent = 'Connections';
            const sidebarText = document.getElementById('sidebar-stats-text');
            if (sidebarText) sidebarText.textContent = 'Connections';
        }
    }
    
    const courseEl = document.getElementById('my-profile-course');
    if (courseEl) courseEl.textContent = profile.role === 'page' ? 'Official Page' : (profile.course || 'Student');
    
    const bioEl = document.getElementById('my-profile-bio');
    if (bioEl) bioEl.textContent = profile.bio || 'No bio yet. Click "Edit Profile" to add one!';
    
    const feedInputAvatar = document.getElementById('feed-input-avatar');
    if (feedInputAvatar) feedInputAvatar.src = profile.profile_img_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(profile.full_name)}&background=e1e3e4`;
    
    renderSocialLinks(profile.social_links, document.getElementById('my-profile-social-links'));
    const privacyToggle = document.getElementById('privacy-toggle-switch');
    if (privacyToggle) privacyToggle.checked = profile.is_private || false;

    if (typeof fetchMyProfileFeed === 'function') {
        fetchMyProfileFeed(profile.id);
    }
// Sync Native Mention Privacy Label
    const mentionPrivacyLabel = document.getElementById('mention-privacy-label');
    if (mentionPrivacyLabel) {
        mentionPrivacyLabel.textContent = profile.mention_privacy === 'none' ? 'No One' : 'Connections';
    }
    // Sync Bottom Nav Avatar
    const navAvatar = document.getElementById('nav-profile-avatar');
    if (navAvatar) navAvatar.src = typeof optimizeImageUrl === 'function' ? optimizeImageUrl(profile.profile_img_url, 'avatar') : profile.profile_img_url;

    // 🚀 NEW: Fetch Page Services for "My Profile"
    if (profile.role === 'page') {
        if (typeof window.fetchPageServices === 'function') window.fetchPageServices(profile.id, true);
    } else {
        const myServicesWrapper = document.getElementById('my-profile-services-wrapper');
        if (myServicesWrapper) myServicesWrapper.classList.add('hidden');
    }
}
// ========================================================
// PROFILE FEED RENDER ENGINE
// ========================================================
window.fetchMyProfileFeed = async function(userId) {
    const feedContainer = document.getElementById('my-profile-feed');
    if(!feedContainer) return;

    feedContainer.innerHTML = FEED_SKELETON; 
    
    // 🚀 OFFLINE INTERCEPTOR for Profile Feed
    if (!navigator.onLine) {
        try {
            const cachedPosts = await getFeedFromCache();
            // Filter the cached feed for only this user's posts
            const myPosts = cachedPosts.filter(post => post.user_id === userId);
            
            if (myPosts.length === 0) {
                feedContainer.innerHTML = `
                    <div class="py-12 flex flex-col items-center justify-center opacity-40 text-on-surface-variant">
                        <span class="material-symbols-outlined text-[42px] mb-2">cloud_off</span>
                        <p class="text-sm font-medium">No cached posts for this profile.</p>
                    </div>`;
                return;
            }
            feedContainer.innerHTML = generatePostHTML(myPosts, currentUserProfile.id);
            const countEl = document.getElementById('my-profile-posts-count');
            if (countEl) countEl.textContent = myPosts.length;
        } catch (e) {
            console.error("Offline profile feed error:", e);
        }
        return;
    }

    try {
        const { data: posts, error } = await supabase
            .from('posts')
            .select(`
                *,
                users ( id, full_name, profile_img_url, role, tick_type ),
                post_likes ( user_id ),
                post_comments ( id, content, created_at, is_deleted, parent_comment_id, users(id, full_name, profile_img_url, tick_type) ),
                post_polls (*),
                post_poll_votes ( user_id, option_id ),
                post_events (*),
                post_event_rsvps ( user_id, status ),
                saved_posts ( user_id )
            `)
            .eq('user_id', userId)
            .eq('is_deleted', false)
            .eq('is_archived', false)
            .gt('expires_at', new Date().toISOString())
            .or('is_reported.eq.false,is_verified.eq.true')
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        const countEl = document.getElementById('my-profile-posts-count');
        if (countEl) countEl.textContent = posts.length;

        if (posts.length === 0) {
            feedContainer.innerHTML = `
                <div class="py-12 flex flex-col items-center justify-center opacity-40 text-on-surface-variant">
                    <span class="material-symbols-outlined text-[42px] mb-2">menu_book</span>
                    <p class="text-sm font-medium">No posts yet</p>
                </div>`;
            return;
        }

        feedContainer.innerHTML = generatePostHTML(posts, currentUserProfile.id);

    } catch (err) {
        console.error("Error fetching my feed:", err);
        feedContainer.innerHTML = `<p class="text-xs text-center py-4 text-error">Failed to load posts.</p>`;
    }
}

// (getPollTimeLeft moved to post-card.js — shared with feed.js)

function generatePostHTML(posts, currentUserId) {
    // Card markup itself now lives in post-card.js, shared with feed.js's main
    // feed renderer — see renderPostCardsHtml for what used to differ between
    // the two copies of this (and why that was a real, user-facing bug).
    return renderPostCardsHtml(posts, currentUserId, currentUserProfile?.profile_img_url);
}
// ========================================================
// SIDEBAR & SETTINGS
// ========================================================
window.openSettingsSidebar = function() {
    const sidebar = document.getElementById('settings-sidebar');
    const content = document.getElementById('settings-main-panel'); // Fixed ID
    const bottomNav = document.querySelector('nav'); 
    
    sidebar.classList.remove('hidden');
    sidebar.classList.add('flex');
    if (bottomNav) bottomNav.classList.add('hidden');
    
    void sidebar.offsetWidth;
    sidebar.classList.remove('opacity-0');
    content.classList.remove('translate-x-full');
};

window.closeSettingsSidebar = function() {
    const sidebar = document.getElementById('settings-sidebar');
    const content = document.getElementById('settings-main-panel'); // Fixed ID
    const bottomNav = document.querySelector('nav');
    
    sidebar.classList.add('opacity-0');
    content.classList.add('translate-x-full');
    
    // Also close any open sub-panels so it resets for next time
    const subPanels = document.querySelectorAll('[id^="settings-"][id$="-panel"]');
    subPanels.forEach(panel => {
        if (panel.id !== 'settings-main-panel') panel.classList.add('translate-x-full');
    });

    setTimeout(() => {
        sidebar.classList.remove('flex');
        sidebar.classList.add('hidden');
        if (bottomNav) bottomNav.classList.remove('hidden');
    }, 300);
};
async function togglePrivacy(isPrivate) {
    try {
        const { error } = await supabase.from('users').update({ is_private: isPrivate }).eq('id', currentUserProfile.id);
        if (error) throw error;
        currentUserProfile.is_private = isPrivate;
        showToast(isPrivate ? 'Account is now Private' : 'Account is now Public', 'success');
    } catch (err) {
        console.error("Privacy toggle error:", err);
        showToast('Failed to update privacy settings', 'error');
        document.getElementById('privacy-toggle-switch').checked = !isPrivate;
    }
}

function shareMyProfile() {
    if (navigator.share) {
        navigator.share({
            title: `${currentUserProfile.full_name}'s Profile`,
            text: `Check out my ECampus profile!`,
            url: window.location.href
        }).catch(console.error);
    } else {
        // 🚀 FIX: this used to just show a "copied!" toast without ever actually
        // writing anything to the clipboard — the link was never copied.
        navigator.clipboard.writeText(window.location.href)
            .then(() => showToast('Profile link copied to clipboard!', 'success'))
            .catch(() => showToast('Could not copy link.', 'error'));
    }
}

// 🚀 Share button for feed posts (the paper-plane icon in the action row) — was
// missing entirely; like/comment/save existed but there was no way to share a
// post at all. Opens a "Send to" sheet — Instagram-style avatar grid + search —
// so a post can be sent straight into a chat (in-app), with "Share externally"
// (OS share sheet / copy link) as a separate row below the grid.
window.shareFeedPost = async function(postId, authorName) {
    const externalRow = `
        <button onclick="window.closeActionSheet(); window.shareFeedPostExternally('${postId}', '${authorName}')" class="w-full flex items-center gap-3 py-2 px-1 text-[13.5px] font-semibold text-on-surface dark:text-gray-100 text-left">
            <span class="w-10 h-10 rounded-full bg-surface-variant/40 dark:bg-neutral-800 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-[19px]">ios_share</span></span>
            Share externally
        </button>`;

    window.openActionSheet(`
        <h3 class="text-[15px] font-extrabold text-on-surface dark:text-gray-100 mb-3 px-1">Share post</h3>
        <div class="relative mb-3">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant dark:text-gray-500 text-[18px] pointer-events-none">search</span>
            <input type="text" placeholder="Search" oninput="window.filterShareSheetConnections(this.value)" class="w-full bg-surface-variant/30 dark:bg-neutral-800 rounded-xl pl-9 pr-3 py-2.5 text-[13.5px] text-on-surface dark:text-gray-100 outline-none focus:ring-1 focus:ring-primary/50">
        </div>
        <div id="share-sheet-connections" class="grid grid-cols-4 gap-y-4 max-h-[38vh] overflow-y-auto pt-1 pb-2">
            <div class="col-span-4 flex justify-center py-6"><div class="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin"></div></div>
        </div>
        <div class="border-t border-surface-variant/40 dark:border-neutral-800 mt-1 pt-1">${externalRow}</div>
    `);

    try {
        const connections = await getAcceptedConnections(currentUserProfile.id);
        const container = document.getElementById('share-sheet-connections');
        if (!container) return; // sheet was closed before this resolved

        if (!connections || connections.length === 0) {
            container.innerHTML = `<p class="col-span-4 text-[12.5px] text-on-surface-variant dark:text-gray-500 text-center py-4 px-2">Connect with people to share posts straight into a chat.</p>`;
            return;
        }

        container.innerHTML = connections.map(u => {
            const safeName = (u.full_name || '').replace(/'/g, "\\'");
            const firstName = (u.full_name || '').split(' ')[0];
            return `
            <button id="share-grid-${u.id}" data-name="${(u.full_name || '').toLowerCase()}" onclick="window.handleSendPostToConnection('${postId}', '${u.id}', '${safeName}')" class="flex flex-col items-center gap-1.5 active:scale-95 transition-transform">
                <div class="relative">
                    <img src="${u.profile_img_url}" class="w-16 h-16 rounded-full object-cover">
                    <span id="share-grid-status-${u.id}" class="absolute bottom-0 right-0 w-5 h-5 rounded-full bg-surface dark:bg-[#1e1e1e] flex items-center justify-center"></span>
                </div>
                <p class="text-[11.5px] font-semibold text-on-surface dark:text-gray-100 truncate w-16 text-center">${firstName}</p>
            </button>`;
        }).join('');
    } catch (e) {
        console.error('Error loading connections for share sheet:', e);
        const container = document.getElementById('share-sheet-connections');
        if (container) container.innerHTML = `<p class="col-span-4 text-[12.5px] text-error text-center py-4">Couldn't load your connections.</p>`;
    }
};

// Live filter for the search box in the "Send to" sheet — pure DOM query, no
// extra state to keep in sync since the full grid is already rendered.
window.filterShareSheetConnections = function(query) {
    const q = query.trim().toLowerCase();
    document.querySelectorAll('#share-sheet-connections [data-name]').forEach(el => {
        el.classList.toggle('hidden', q.length > 0 && !el.dataset.name.includes(q));
    });
};

// Tapping an avatar in the share sheet — shows a spinner then a checkmark badge
// on that avatar so it's obvious the send actually went through, then auto-closes.
window.handleSendPostToConnection = async function(postId, userId, name) {
    const statusEl = document.getElementById(`share-grid-status-${userId}`);
    if (statusEl) statusEl.innerHTML = `<span class="material-symbols-outlined text-[14px] text-on-surface-variant animate-spin">progress_activity</span>`;

    const ok = await window.sendPostToChat(userId, postId);

    if (ok) {
        if (statusEl) statusEl.innerHTML = `<span class="material-symbols-outlined text-[16px] text-primary" style="font-variation-settings: 'FILL' 1;">check_circle</span>`;
        showToast(`Sent to ${name}`, 'success');
        setTimeout(() => window.closeActionSheet(), 700);
    } else if (statusEl) {
        statusEl.innerHTML = '';
    }
};

// The old behavior (OS share sheet / copy link) — kept as "Share externally"
// inside the sheet above instead of being the only option. Builds a real deep
// link: ?post=<id>, picked up on load by the same routing this app already uses
// for notification deep links (see initializeApp's pending-route handling), so
// the link actually opens that exact post for whoever opens it.
window.shareFeedPostExternally = function(postId, authorName) {
    const shareUrl = `${window.location.origin}${window.location.pathname}?post=${postId}`;
    if (navigator.share) {
        navigator.share({
            title: `${authorName ? authorName + "'s" : 'A'} post on ECampus`,
            text: `Check out this post on ECampus!`,
            url: shareUrl
        }).catch(() => {});
    } else {
        navigator.clipboard.writeText(shareUrl)
            .then(() => showToast('Link copied to clipboard!', 'success'))
            .catch(() => showToast('Could not copy link.', 'error'));
    }
};

window.openSettingsSidebar = openSettingsSidebar;
window.closeSettingsSidebar = closeSettingsSidebar;
window.togglePrivacy = togglePrivacy;
window.shareMyProfile = shareMyProfile;

function updateHeaderAvatar(avatarUrl, fullName) {
    const avatarImg = document.getElementById('header-avatar');
    if (avatarImg) avatarImg.src = avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=e1e3e4`;
}

// ========================================================
// UPLOADS & USER ACTIONS 
// ========================================================

function setupEditProfileAvatarUpload() {
    const avatarInput = document.getElementById('edit-avatar-upload-input');
    if (!avatarInput) return;

    avatarInput.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;

        const preview = document.getElementById('edit-profile-avatar-preview');
        const mainProfileAvatar = document.getElementById('my-profile-avatar');
        const originalSrc = preview.src;

        const tempUrl = URL.createObjectURL(file);
        preview.src = tempUrl;
        preview.style.opacity = '0.5';
        preview.style.filter = 'blur(3px)';
        preview.style.transition = 'all 0.3s ease';
        if (mainProfileAvatar) mainProfileAvatar.src = tempUrl;

        try {
            const formData = new FormData();
            const fileToUpload = typeof compressImage === 'function' ? await compressImage(file, 500, 0.8) : file;
            formData.append('file', fileToUpload);
            formData.append('upload_preset', CLOUDINARY_AVATARS_PRESET);

            const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, { method: 'POST', body: formData });
            const data = await res.json();
            if (data.error) throw new Error(data.error.message);

            await saveUserProfile({ profile_img_url: data.secure_url }, false);

            preview.src = data.secure_url;
            preview.style.opacity = '1';
            preview.style.filter = 'blur(0px)';
            if (mainProfileAvatar) mainProfileAvatar.src = data.secure_url;
            updateHeaderAvatar(data.secure_url, currentUserProfile.full_name);

            showToast('Profile picture updated!', 'success');

        } catch (error) {
            console.error('Error updating avatar:', error);
            showToast('Failed to update avatar.', 'error');
            preview.src = originalSrc; 
            preview.style.opacity = '1';
            preview.style.filter = 'blur(0px)';
            if (mainProfileAvatar) mainProfileAvatar.src = originalSrc;
        } finally {
            avatarInput.value = '';
        }
    });
}

// (Removed: setupProfileAvatarUpload — this was a second, now-orphaned copy of
// the exact same upload logic as setupEditProfileAvatarUpload above, wired to
// the main profile page avatar. That avatar no longer opens the file picker on
// tap — it opens your Hotpost when you have one, same as the story tray — and
// Edit Profile's "Edit picture" button (which already syncs this same avatar's
// <img> on success, see mainProfileAvatar above) is the one remaining way to
// change your picture.)

async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.replace('auth/login.html');
}

window.switchTab = switchTab;
window.openProfileModal = openProfileModal;
window.closeProfileModals = closeProfileModals;

let tempSocialLinks = [];

window.openEditProfileModal = function() {
    if (!currentUserProfile) return;

    document.getElementById('edit-profile-name').value = currentUserProfile.full_name || '';
    document.getElementById('edit-profile-id').value = currentUserProfile.student_id || '';
    document.getElementById('edit-profile-course').value = currentUserProfile.course || '';
    document.getElementById('edit-profile-bio').value = currentUserProfile.bio || '';
    document.getElementById('edit-profile-avatar-preview').src = currentUserProfile.profile_img_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUserProfile.full_name)}&background=e1e3e4`;

    const modal = document.getElementById('modal-edit-profile');
    const bottomNav = document.querySelector('nav');

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (bottomNav) bottomNav.classList.add('hidden'); 

    setTimeout(() => {
        modal.classList.remove('translate-x-full');
    }, 10);
};

window.closeEditProfileModal = function() {
    const modal = document.getElementById('modal-edit-profile');
    const bottomNav = document.querySelector('nav');

    modal.classList.add('translate-x-full');

    setTimeout(() => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        if (bottomNav) bottomNav.classList.remove('hidden'); 
    }, 300);
};

window.triggerEditAvatarUpload = function() {
    document.getElementById('edit-avatar-upload-input').click();
};

window.saveUserProfile = async function(extraUpdates = {}, closeModal = true) {
    const btn = document.getElementById('save-profile-btn');
    if (closeModal && btn) {
        btn.disabled = true;
        btn.innerHTML = 'Saving...';
    }

    const updates = {
        full_name: document.getElementById('edit-profile-name').value.trim(),
        student_id: document.getElementById('edit-profile-id').value.trim(),
        course: document.getElementById('edit-profile-course').value.trim(),
        bio: document.getElementById('edit-profile-bio').value.trim(),
        ...extraUpdates
    };

    try {
        const { data, error } = await supabase.from('users').update(updates).eq('id', currentUserProfile.id).select().single();
        if (error) throw error;

        currentUserProfile = data;
        populateProfileUI(currentUserProfile);
        updateHeaderAvatar(currentUserProfile.profile_img_url, currentUserProfile.full_name);

        if (closeModal) {
            showToast('Profile updated!', 'success');
            closeEditProfileModal();
        }

    } catch (error) {
        console.error('Error saving profile:', error);
        showToast('Failed to save profile.', 'error');
    } finally {
        if (closeModal && btn) {
            btn.disabled = false;
            btn.innerHTML = 'Save';
        }
    }
};
// ========================================================
// SOCIAL LINKS EDITOR (Native Full-Screen Engine)
// ========================================================
function openEditSocialsModal() {
    if (!currentUserProfile) return;
    
    let links = currentUserProfile.social_links;
    if (typeof links === 'string') {
        try { links = JSON.parse(links); } catch(e) { links = []; }
    }
    tempSocialLinks = Array.isArray(links) ? JSON.parse(JSON.stringify(links)) : [];
    
    renderTempSocialsList();
    
    const modal = document.getElementById('modal-edit-socials');
    const bottomNav = document.querySelector('nav');
    
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (bottomNav) bottomNav.classList.add('hidden');
    
    setTimeout(() => {
        modal.classList.remove('translate-x-full');
    }, 10);
}

function closeSocialsModal() {
    const modal = document.getElementById('modal-edit-socials');
    const bottomNav = document.querySelector('nav');
    
    modal.classList.add('translate-x-full');
    
    setTimeout(() => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        if (bottomNav) bottomNav.classList.remove('hidden');
    }, 300);
}

function renderTempSocialsList() {
    const list = document.getElementById('modal-socials-list');
    list.innerHTML = '';
    
    if (!Array.isArray(tempSocialLinks) || tempSocialLinks.length === 0) {
        list.innerHTML = `
            <div class="py-10 flex flex-col items-center justify-center opacity-40 text-on-surface-variant">
                <span class="material-symbols-outlined text-[42px] mb-2">link_off</span>
                <p class="text-sm font-medium">No links added yet.</p>
            </div>`;
        return;
    }

    const platformStyles = {
        linkedin: { icon: 'fa-brands fa-linkedin-in', color: 'text-[#0A66C2]' },
        instagram: { icon: 'fa-brands fa-instagram', color: 'text-pink-500' },
        github: { icon: 'fa-brands fa-github', color: 'text-on-surface dark:text-white' },
        twitter: { icon: 'fa-brands fa-x-twitter', color: 'text-on-surface dark:text-white' },
        youtube: { icon: 'fa-brands fa-youtube', color: 'text-[#FF0000]' },
        discord: { icon: 'fa-brands fa-discord', color: 'text-[#5865F2]' },
        whatsapp: { icon: 'fa-brands fa-whatsapp', color: 'text-[#25D366]' },
        snapchat: { icon: 'fa-brands fa-snapchat', color: 'text-[#FFFC00] drop-shadow-sm' },
        telegram: { icon: 'fa-brands fa-telegram', color: 'text-[#229ED9]' },
        spotify: { icon: 'fa-brands fa-spotify', color: 'text-[#1DB954]' },
        reddit: { icon: 'fa-brands fa-reddit-alien', color: 'text-[#FF4500]' },
        website: { icon: 'fa-solid fa-globe', color: 'text-primary' }
    };

    tempSocialLinks.forEach((link, index) => {
        const style = platformStyles[link.platform] || { icon: 'fa-solid fa-link', color: 'text-gray-500' };
        
        list.innerHTML += `
            <div class="flex items-center gap-3 bg-surface-container-lowest dark:bg-[#1e1e1e] p-3.5 rounded-2xl border border-surface-variant/50 dark:border-neutral-800 shadow-sm animate-fadeIn">
                <div class="w-10 h-10 rounded-full bg-surface-variant/30 dark:bg-neutral-800 flex items-center justify-center ${style.color} shrink-0">
                    <i class="${style.icon} text-[18px]"></i>
                </div>
                <div class="flex-1 min-w-0">
                    <p class="font-extrabold text-[13px] text-on-surface dark:text-gray-100 uppercase tracking-wide">${link.platform}</p>
                    <p class="text-[12px] text-on-surface-variant dark:text-gray-400 truncate mt-0.5">${link.url}</p>
                </div>
                <button onclick="removeSocialLinkTemp(${index})" class="w-8 h-8 rounded-full bg-error/10 text-error flex items-center justify-center active:scale-95 transition-transform shrink-0">
                    <span class="material-symbols-outlined text-[18px]">delete</span>
                </button>
            </div>
        `;
    });
}

function addSocialLinkTemp() {
    const platformId = document.getElementById('add-social-platform').value;
    let val = document.getElementById('add-social-url').value.trim();
    
    if (!val) {
        showToast('Please enter your username, number, or link.', 'warning');
        return;
    }

    const config = socialPlatformsConfig[platformId];
    let finalUrl = val;

    if (!val.startsWith('http://') && !val.startsWith('https://')) {
        if (val.startsWith('@') && platformId !== 'youtube') {
            val = val.substring(1);
        }
        if (platformId === 'youtube' && !val.startsWith('@') && !val.includes('/')) {
            val = '@' + val;
        }
        finalUrl = config.prefix + val;
    }

    const existingLinkIndex = tempSocialLinks.findIndex(link => link.platform === platformId);
    if (existingLinkIndex > -1) {
        tempSocialLinks[existingLinkIndex].url = finalUrl;
    } else {
        tempSocialLinks.push({ platform: platformId, url: finalUrl });
    }
    
    renderTempSocialsList();
    document.getElementById('add-social-url').value = '';
}

function removeSocialLinkTemp(index) {
    tempSocialLinks.splice(index, 1);
    renderTempSocialsList();
}

async function saveSocialLinks() {
    const { error } = await supabase.from('users').update({ social_links: tempSocialLinks }).eq('id', currentUserProfile.id);

    if (error) {
        showToast('Failed to save social links.', 'error');
        console.error('Error saving social links:', error);
    } else {
        currentUserProfile.social_links = tempSocialLinks;
        populateProfileUI(currentUserProfile);
        showToast('Social links updated!', 'success');
        closeSocialsModal();
    }
}

window.openEditProfileModal = openEditProfileModal;
window.closeEditProfileModal = closeEditProfileModal;
window.triggerEditAvatarUpload = triggerEditAvatarUpload;
window.saveUserProfile = saveUserProfile;
window.openEditSocialsModal = openEditSocialsModal;
window.closeSocialsModal = closeSocialsModal;
window.addSocialLinkTemp = addSocialLinkTemp;
window.removeSocialLinkTemp = removeSocialLinkTemp;
window.saveSocialLinks = saveSocialLinks;

// ========================================================
// PUBLIC/PRIVATE PROFILE VIEWS 
// ========================================================
async function viewUserProfile(userId) {
    if (window.isLongPressing) return; 

    const moreMenu = document.getElementById('public-profile-more-menu');
    if (moreMenu) moreMenu.classList.add('hidden');

    if (userId === currentUserProfile.id) {
        switchTab('profile');
        return;
    }

    // --- 1. INSTANT UI FEEDBACK (SHIMMER) ---
    document.getElementById('modal-profile-public').dataset.userId = userId;
    
    // Header & Avatar
    document.getElementById('public-profile-header-name').innerHTML = `<div class="w-24 h-4 rounded-md shimmer-bg"></div>`;
    const avatarEl = document.getElementById('public-profile-avatar');
    avatarEl.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='; // Transparent placeholder
    avatarEl.parentElement.classList.add('shimmer-bg');
    
    // Details
    document.getElementById('public-profile-name').innerHTML = `<div class="w-32 h-6 rounded-md shimmer-bg mx-auto"></div>`;
    document.getElementById('public-profile-course').innerHTML = `<div class="w-20 h-4 rounded-md shimmer-bg mx-auto"></div>`;
    document.getElementById('public-profile-connection-count').parentElement.innerHTML = `<span id="public-profile-connection-count" class="font-bold">-</span>`;
    document.getElementById('public-profile-bio').innerHTML = `<div class="flex flex-col gap-1.5 items-center"><div class="w-48 h-3 rounded-md shimmer-bg"></div><div class="w-32 h-3 rounded-md shimmer-bg"></div></div>`;
    document.getElementById('public-profile-social-links').innerHTML = '';
    
    // Actions & Feed
    document.getElementById('public-profile-actions').innerHTML = `<div class="w-full h-11 rounded-xl shimmer-bg"></div>`;
    document.getElementById('public-profile-feed').innerHTML = FEED_SKELETON;

    // Slide up instantly!
    openProfileModal('public');

    // --- 2. NOW FETCH DATA ---
    const { data: user, error } = await supabase.from('users').select('*').eq('id', userId).single();
    if (error || !user) {
        showToast('Could not load profile.', 'error');
        closeProfileModals();
        return;
    }

    let connection = null;
    let followRecord = null;

    if (user.role === 'page') {
        const { data: fData, error: fError } = await supabase
            .from('page_followers').select('*').eq('page_id', user.id).eq('follower_id', currentUserProfile.id).maybeSingle();
        followRecord = fData;
    } else {
        const { data: cData } = await supabase
            .from('connections').select('status, action_user_id')
            .or(`and(user_one_id.eq.${currentUserProfile.id},user_two_id.eq.${user.id}),and(user_one_id.eq.${user.id},user_two_id.eq.${currentUserProfile.id})`).maybeSingle();
        connection = cData;
    }

    const isConnected = connection?.status === 'accepted';
    const getTickHtmlLocal = (tickType) => window.getTickHtml ? window.getTickHtml(tickType) : '';

    // Remove Avatar Shimmer
    avatarEl.parentElement.classList.remove('shimmer-bg');
    
    // Populate Top Meta Data
    document.getElementById('public-profile-header-name').innerHTML = `<span class="flex items-center gap-1">${user.full_name} ${getTickHtmlLocal(user.tick_type)}</span>`;
    avatarEl.src = user.profile_img_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4`;
    document.getElementById('public-profile-name').innerHTML = `<span class="flex items-center justify-center gap-1">${user.full_name} ${getTickHtmlLocal(user.tick_type)}</span>`;

    // --- Handle PRIVATE Profile directly in the same UI container ---
    if (user.is_private && !isConnected && user.role !== 'page') {
        document.getElementById('public-profile-course').textContent = user.course || 'Student';
        
        // Disable Click & Route
        const statsContainer = document.getElementById('public-profile-connection-count').parentElement;
        statsContainer.innerHTML = `<span id="public-profile-connection-count" class="font-bold text-on-surface dark:text-gray-200">Private</span> account`;
        statsContainer.className = "text-sm text-on-surface-variant dark:text-gray-400 mb-4 inline-block px-4 py-1.5 rounded-xl bg-surface-variant/10";
        statsContainer.onclick = null; // LOCKED

        document.getElementById('public-profile-bio').innerHTML = ''; 
        document.getElementById('public-profile-social-links').innerHTML = '';

        const actionsContainer = document.getElementById('public-profile-actions');
        if (connection?.status === 'pending' && connection.action_user_id === currentUserProfile.id) {
            actionsContainer.innerHTML = `<button class="btn-secondary w-full">Cancel Request</button>`;
            actionsContainer.firstElementChild.onclick = () => handleConnectionAction(user.id, 'cancel', actionsContainer.firstElementChild);
        } else {
            actionsContainer.innerHTML = `<button class="btn-primary w-full">Request to Connect</button>`;
            actionsContainer.firstElementChild.onclick = () => handleConnectionAction(user.id, 'request', actionsContainer.firstElementChild);
        }

        // Inject the Lock Screen into the feed area
        document.getElementById('public-profile-feed').innerHTML = `
            <div class="w-full bg-surface-variant/20 dark:bg-neutral-900/50 border border-surface-variant/50 dark:border-neutral-800 p-8 rounded-3xl mt-6 flex flex-col items-center justify-center shadow-inner">
                <span class="material-symbols-outlined text-[42px] text-on-surface-variant opacity-60 mb-3">lock</span>
                <h4 class="text-[16px] font-bold text-on-surface dark:text-gray-100 mb-1">This Account is Private</h4>
                <p class="text-[13px] text-on-surface-variant dark:text-gray-400 px-4 text-center">Connect to see their full profile and feed.</p>
            </div>
        `;
    } 
    // --- Handle PUBLIC Profile / PAGE Profile / CONNECTED PRIVATE Profile ---
    else {
        const statsHtml = user.role === 'page' ? 
            `<span id="public-profile-connection-count" class="font-bold text-on-surface dark:text-gray-200">${user.connection_count || 0}</span> followers` : 
            `<span id="public-profile-connection-count" class="font-bold text-on-surface dark:text-gray-200">${user.connection_count || 0}</span> connections`;
        
        // Enable Click & Route
        const statsContainer = document.getElementById('public-profile-connection-count').parentElement;
        statsContainer.innerHTML = statsHtml;
        statsContainer.className = "text-sm text-on-surface-variant dark:text-gray-400 mb-4 cursor-pointer hover:text-primary transition-colors inline-block px-4 py-1.5 rounded-xl bg-surface-variant/10 active:bg-surface-variant/20 active:scale-95";
        statsContainer.onclick = () => window.openUserConnectionsModal(user.id, user.role, user.full_name); // CLICKABLE!

       document.getElementById('public-profile-course').textContent = user.role === 'page' ? 'Official Page' : (user.course || 'Student');
        document.getElementById('public-profile-bio').textContent = user.bio || 'No bio available.';
        
        // 🚀 NEW: Fetch Page Services for "Public Profile"
        if (user.role === 'page') {
            if (typeof window.fetchPageServices === 'function') window.fetchPageServices(user.id, false);
        } else {
            const pubServicesWrapper = document.getElementById('public-profile-services-wrapper');
            if (pubServicesWrapper) pubServicesWrapper.classList.add('hidden');
        }
        
        renderSocialLinks(user.social_links, document.getElementById('public-profile-social-links'));
        renderProfileActions(user, connection, followRecord);

      // Fetch their Posts Feed
        try {
            const { data: posts, error: postsError } = await supabase
                .from('posts')
                .select(`
                    *, 
                    users ( id, full_name, profile_img_url, role, tick_type ), 
                    post_likes ( user_id ), 
                    post_comments ( id, content, created_at, is_deleted, parent_comment_id, users(id, full_name, profile_img_url, tick_type) ), 
                    post_polls (*), 
                    post_poll_votes ( user_id, option_id ),
                    post_events (*),
                    post_event_rsvps ( user_id, status )
                `)
                .eq('user_id', userId).eq('is_deleted', false)
                .neq('post_type', 'anonymous') // a profile page inherently says "these are theirs" — showing an Anonymous post here would out the author regardless of how the card itself renders
                .gt('expires_at', new Date().toISOString())
                .or('is_reported.eq.false,is_verified.eq.true')
                .order('created_at', { ascending: false }).limit(20);

            if (postsError) throw postsError;
            
            if (posts.length === 0) {
                document.getElementById('public-profile-feed').innerHTML = `<div class="py-12 flex flex-col items-center justify-center opacity-40 text-on-surface-variant"><span class="material-symbols-outlined text-[42px] mb-2">photo_camera</span><p class="text-sm font-semibold">No posts yet</p></div>`;
                return;
            }
            document.getElementById('public-profile-feed').innerHTML = generatePostHTML(posts, currentUserProfile.id);
        } catch (postsErr) {
            document.getElementById('public-profile-feed').innerHTML = `<p class="text-sm text-center py-4 text-error">Failed to load posts feed.</p>`;
        }
    }
} // 🚀 CRITICAL: This is the closing brace that was missing!
function renderProfileActions(user, connection, followRecord) {
    const actionsContainer = document.getElementById('public-profile-actions');
    const moreMenuBtn = document.getElementById('public-profile-more-btn');
    const moreMenu = document.getElementById('public-profile-more-menu');

    actionsContainer.innerHTML = '';
    moreMenu.innerHTML = '';
    moreMenuBtn.classList.remove('hidden'); 
    moreMenu.classList.add('hidden');

    const userId = user.id;
    let mainButtonHtml = '';
    let moreMenuItems = [];

    // PAGE LOGIC
    if (user.role === 'page') {
        if (!followRecord) {
            mainButtonHtml = `
                <button onclick="handleFollowAction('${userId}', 'follow', this)" class="btn-primary flex-1 !py-2.5 rounded-xl text-sm">Follow</button>
                <button class="btn-secondary flex-1 !py-2.5 rounded-xl text-sm flex items-center justify-center gap-1.5"><span class="material-symbols-outlined text-[18px]">chat_bubble</span> Message</button>
            `;
        } else {
            const isNotifyOn = followRecord.receive_notifications;
            const bellIcon = isNotifyOn ? 'notifications_active' : 'notifications_off';
            
            // Clear visual indicator: Primary color + border when ON, Muted when OFF
            const bellStyle = isNotifyOn 
                ? 'bg-primary/15 text-primary border-primary/40 dark:bg-primary/20' 
                : 'bg-surface-variant/40 dark:bg-neutral-800 text-on-surface-variant/50 dark:text-gray-500 border-surface-variant/60';
            
            const bellTitle = isNotifyOn ? 'Notifications ON (Click to turn OFF)' : 'Notifications OFF (Click to turn ON)';

            mainButtonHtml = `
                <button onclick="handleFollowAction('${userId}', 'unfollow', this)" class="btn-secondary flex-1 !py-2.5 rounded-xl text-sm">Following</button>
                <button class="btn-primary flex-1 !py-2.5 rounded-xl text-sm flex items-center justify-center gap-1.5"><span class="material-symbols-outlined text-[18px]">chat_bubble</span> Message</button>
                <button onclick="handleFollowAction('${userId}', 'toggle_bell', this, ${!isNotifyOn})" title="${bellTitle}" class="${bellStyle} !p-0 w-12 flex items-center justify-center border rounded-xl transition-all active:scale-95 shrink-0">
                    <span class="material-symbols-outlined text-[20px]" style="font-variation-settings: 'FILL' ${isNotifyOn ? 1 : 0};">${bellIcon}</span>
                </button>
            `;
        }
        // Message button — no connection required for Pages (see
        // messages_insert_page_bypass in migration_page_broadcast_v13.sql).
        // Wiring happens after the shared `actionsContainer.innerHTML =
        // mainButtonHtml` reassignment below, not here — that reassignment
        // recreates the DOM nodes and would wipe out an onclick set earlier.
        moreMenuItems.push({ label: 'Report Page', action: 'report', class: 'text-orange-500' });
    } 
    // STUDENT LOGIC
    else {
        if (!connection) { 
            mainButtonHtml = `<button class="btn-primary flex-1 !py-2.5 rounded-xl text-sm">Connect</button>`;
            actionsContainer.innerHTML = mainButtonHtml;
            actionsContainer.firstElementChild.onclick = () => handleConnectionAction(userId, 'request', actionsContainer.firstElementChild);
            moreMenuItems.push({ label: 'Block User', action: 'block', class: 'text-error' });
        } else if (connection.status === 'pending') {
            if (connection.action_user_id === currentUserProfile.id) { 
                mainButtonHtml = `<button class="btn-secondary flex-1 !py-2.5 rounded-xl text-sm">Cancel Request</button>`;
                actionsContainer.innerHTML = mainButtonHtml;
                actionsContainer.firstElementChild.onclick = () => handleConnectionAction(userId, 'cancel', actionsContainer.firstElementChild);
            } else { 
                mainButtonHtml = `<button class="btn-primary flex-1 !py-2.5 rounded-xl text-sm">Accept</button><button class="btn-secondary flex-1 !py-2.5 rounded-xl text-sm">Decline</button>`;
                actionsContainer.innerHTML = mainButtonHtml;
                actionsContainer.children[0].onclick = () => handleConnectionAction(userId, 'accept', actionsContainer.children[0]);
                actionsContainer.children[1].onclick = () => handleConnectionAction(userId, 'decline', actionsContainer.children[1]);
            }
            moreMenuItems.push({ label: 'Block User', action: 'block', class: 'text-error' });
        } else if (connection.status === 'accepted') {
            mainButtonHtml = `
                <button class="btn-secondary flex-1 !py-2.5 rounded-xl text-sm" disabled>✓ Connected</button>
                <button class="btn-primary flex-1 !py-2.5 rounded-xl text-sm flex items-center justify-center gap-1.5"><span class="material-symbols-outlined text-[18px]">chat_bubble</span> Message</button>
            `;
            actionsContainer.innerHTML = mainButtonHtml;
            actionsContainer.children[1].onclick = () => {
                window.closeProfileModals();
                setTimeout(() => window.openConversation(userId), 260);
            };
            moreMenuItems.push({ label: 'Remove connection', action: 'unfriend', class: 'text-error' });
            moreMenuItems.push({ label: 'Block User', action: 'block', class: 'text-error' });
        } else if (connection.status === 'blocked') {
            if (connection.action_user_id === currentUserProfile.id) { 
                mainButtonHtml = `<button class="btn-error flex-1 !py-2.5 rounded-xl text-sm">Unblock</button>`;
                actionsContainer.innerHTML = mainButtonHtml;
                actionsContainer.firstElementChild.onclick = () => handleConnectionAction(userId, 'unblock', actionsContainer.firstElementChild);
            } else { 
                mainButtonHtml = `<button class="btn-secondary flex-1 !py-2.5 rounded-xl text-sm" disabled>Blocked</button>`;
                actionsContainer.innerHTML = mainButtonHtml;
            }
        }
        if (!(connection?.status === 'blocked' && connection.action_user_id !== currentUserProfile.id)) {
            moreMenuItems.push({ label: 'Report User', action: 'report', class: 'text-orange-500' });
        }
    }

    if (user.role === 'page') {
        actionsContainer.innerHTML = mainButtonHtml;
        // Message button is always the second rendered button in both PAGE
        // LOGIC branches above (Follow+Message, or Following+Message+bell).
        actionsContainer.children[1].onclick = () => {
            window.closeProfileModals();
            setTimeout(() => window.openConversation(userId), 260);
        };
    }

    if (moreMenuItems.length > 0) {
        moreMenu.innerHTML = moreMenuItems.map(item =>
            `<button data-action="${item.action}" class="w-full text-left px-4 py-2.5 text-sm font-bold hover:bg-surface-variant/30 dark:hover:bg-neutral-800 rounded-lg ${item.class} transition-colors">${item.label}</button>`
        ).join('');
    }
}

window.handleFollowAction = async function(pageId, action, btn, notifyState = true) {
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined text-xl animate-spin">progress_activity</span>`;

    try {
        if (action === 'follow') {
            await supabase.from('page_followers').insert({ page_id: pageId, follower_id: currentUserProfile.id });
            await supabase.rpc('increment_connection_count', { user_id: pageId });
            
            // Trigger Notification to the Page
            await supabase.from('notifications').insert({
                user_id: pageId,
                sender_id: currentUserProfile.id,
                type: 'new_follower'
            });

            showToast('You are now following this page.', 'success');
        } else if (action === 'unfollow') {
            await supabase.from('page_followers').delete().match({ page_id: pageId, follower_id: currentUserProfile.id });
            await supabase.rpc('decrement_connection_count', { user_id: pageId });
            showToast('Unfollowed page.', 'info');
        } else if (action === 'toggle_bell') {
            await supabase.rpc('toggle_page_notifications', { p_page_id: pageId, p_follower_id: currentUserProfile.id, p_notify: notifyState });
            showToast(notifyState ? 'Notifications turned ON' : 'Notifications turned OFF', 'success');
        }
        viewUserProfile(pageId);
    } catch (error) {
        console.error('Follow action error:', error);
        showToast('Action failed.', 'error');
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
};

// ========================================================
// CONNECTION & BLOCKING ENGINE
// ========================================================
async function handleConnectionAction(targetUserId, action, btn) {
    // 🚀 Soft Restrict Check: Block sending or accepting connection requests
    if (['request', 'accept'].includes(action)) {
        if (!window.checkVerification('connect with peers')) return; 
    }

    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="material-symbols-outlined text-xl animate-spin">progress_activity</span>`;
    }

    try {
        const { data, error } = await supabase.rpc('manage_connection', {
            p_target_user_id: targetUserId,
            p_action: action
        });

        if (error) throw error;

        // connection_request / connection_accepted notifications now live inside
        // manage_connection itself (see migration_manage_connection_notifications_v10.sql)
        // — same transaction as the request/accept, so it can't drift out of sync
        // with the RPC's actual state changes the way a client-side hook could.

        // 🚀 FIX: Invalidate relevant caches based on the connection action result
        if (data === 'accepted' || data === 'unfriended' || data === 'unblocked') {
            if (typeof window.onConnectionAdded === 'function') {
                window.onConnectionAdded(targetUserId);
            }
        } else if (data === 'blocked') {
            if (typeof window.onConnectionBlocked === 'function') {
                window.onConnectionBlocked(targetUserId);
            }
        }

        const msg = typeof getSuccessMessage === 'function' ? getSuccessMessage(data) : 'Action successful!';
        showToast(msg, 'success');

        if (btn && action === 'request' && data === 'request_sent') btn.textContent = 'Request Sent';

        // Refresh the profile UI so the "Block" instantly changes to "Unblock"
        const modal = document.getElementById('modal-profile-public');
        if (modal && !modal.classList.contains('hidden') && modal.dataset.userId === targetUserId) {
            viewUserProfile(targetUserId);
        }

        // 🚀 FIX: Auto-refresh my own profile if I accept or remove a connection so my count updates!
        if (action === 'accept' || action === 'unfriend') {
            if (typeof window.refreshMyProfile === 'function') {
                window.refreshMyProfile();
            }
        }

    } catch (error) {
        console.error(`Error performing action '${action}':`, error);
        showToast(error.message || 'An error occurred.', 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}
window.handleConnectionAction = handleConnectionAction;

function getSuccessMessage(result) {
    const messages = { request_sent: 'Connection request sent!', accepted: 'Connection accepted!', cancelled: 'Request cancelled.', declined: 'Request declined.', unfriended: 'Connection removed.', blocked: 'User blocked.', unblocked: 'User unblocked.' };
    return messages[result] || 'Action successful!';
}

function openReportModal(userId, userName) {
    const modal = document.getElementById('modal-report-user');
    modal.classList.replace('hidden', 'flex');
    document.getElementById('report-user-name').textContent = userName;
    document.getElementById('submit-report-btn').dataset.userId = userId;
}

function closeReportModal() {
    const modal = document.getElementById('modal-report-user');
    modal.classList.replace('flex', 'hidden');
    document.getElementById('report-reason').value = '';
    document.getElementById('report-description').value = '';
}

async function submitReport() {
    const btn = document.getElementById('submit-report-btn');
    const userId = btn.dataset.userId;
    const reason = document.getElementById('report-reason').value;
    const description = document.getElementById('report-description').value.trim();

    if (!reason) {
        showToast('Please select a reason for the report.', 'warning');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Submitting...';

    try {
        const { error } = await supabase.rpc('create_report', { p_reported_user_id: userId, p_reason: reason, p_description: description || null });
        if (error) throw error;
        showToast('Report submitted successfully. Our team will review it.', 'success');
        closeReportModal();
        closeProfileModals();
    } catch (error) {
        showToast('Failed to submit report.', 'error');
        console.error('Error submitting report:', error);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Submit Report';
    }
}

window.viewUserProfile = viewUserProfile;

// ==========================================
// LAZY-LOADING TAB ROUTER (Instagram Style)
// ==========================================
function switchTab(tabId) {
    document.querySelectorAll(".tab-content").forEach(tab => tab.classList.add("hidden"));
    
    const activeView = document.getElementById(`view-${tabId}`);
    if (activeView) activeView.classList.remove("hidden");

    const header = document.querySelector("header");
    if (tabId === "dashboard") header.classList.remove("hidden");
    else header.classList.add("hidden");

    const bottomNav = document.querySelector('nav');
    if (bottomNav) bottomNav.classList.remove('hidden');

    // 🚀 RESET ALL NAV ITEMS
    document.querySelectorAll(".nav-item").forEach(btn => {
        btn.classList.remove("text-on-surface", "dark:text-white");
        btn.classList.add("text-on-surface-variant", "dark:text-gray-500");
        
        // Handle Material Icons
        const icon = btn.querySelector(".material-symbols-outlined");
        if (icon) icon.style.fontVariationSettings = "'FILL' 0";

        // Handle SVG Icons
        const svgIcon = btn.querySelector("svg");
        if (svgIcon) {
            svgIcon.setAttribute("stroke-width", "2");
        }

        // Reset Profile Avatar border
        const avatar = btn.querySelector("img");
        if (avatar) {
            avatar.classList.remove("border-on-surface", "dark:border-white");
            avatar.classList.add("border-transparent");
        }
    });

    // 🚀 ACTIVATE CURRENT TAB
    const activeBtn = document.getElementById(`nav-${tabId}`);
    if (activeBtn) {
        activeBtn.classList.remove("text-on-surface-variant", "dark:text-gray-500");
        activeBtn.classList.add("text-on-surface", "dark:text-white");
        
        // Handle Material Icons
        const icon = activeBtn.querySelector(".material-symbols-outlined");
        if (icon) icon.style.fontVariationSettings = "'FILL' 1";

        // Handle SVG Icons (Make outline thicker)
        const svgIcon = activeBtn.querySelector("svg");
        if (svgIcon) {
            svgIcon.setAttribute("stroke-width", "2.5");
        }

        // Add Active border to Profile Avatar
        const avatar = activeBtn.querySelector("img");
        if (avatar) {
            avatar.classList.remove("border-transparent");
            avatar.classList.add("border-on-surface", "dark:border-white");
        }
    }

    window.scrollTo({ top: 0, behavior: "instant" });

    // Refresh the profile avatar's story ring every time Profile is opened —
    // not just once at boot — since the Hotpost tray's own data can easily
    // change (new post, viewed a story) between visits.
    if (tabId === 'profile') updateMyProfileAvatarRing();

    // 🚀 THE LAZY LOADER ENGINE
    if (window.loadedTabs && !window.loadedTabs.has(`view-${tabId}`)) {
        window.loadedTabs.add(`view-${tabId}`);
        if (tabId === 'search' && typeof window.refreshDiscover === 'function') window.refreshDiscover();
        else if (tabId === 'messages' && typeof window.refreshMessages === 'function') window.refreshMessages();
        else if (tabId === 'profile' && typeof window.fetchMyProfileFeed === 'function' && typeof currentUserProfile !== 'undefined') window.fetchMyProfileFeed(currentUserProfile.id);
    }
}
window.switchTab = switchTab; // Expose globally without crashing

function openProfileModal(type) {
    const modal = document.getElementById(`modal-profile-${type}`);
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        setTimeout(() => modal.classList.remove('translate-y-full'), 10);
    }
}

function closeProfileModals() {
    document.querySelectorAll('[id^="modal-profile-"]').forEach(modal => {
        if (!modal.classList.contains('translate-y-full')) {
            modal.classList.add('translate-y-full');
            setTimeout(() => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }, 300);
        }
    });
}

window.openReportModal = openReportModal;
window.closeReportModal = closeReportModal;
window.submitReport = submitReport;
window.toggleMoreMenu = () => document.getElementById('public-profile-more-menu').classList.toggle('hidden');

// ========================================================
// LIST MODALS (CONNECTIONS / BLOCKED) WITH SKELETONS
// ========================================================
async function openConnectionsModal() {
    const modal = document.getElementById('modal-connections');
    const list = document.getElementById('connections-list');
    if (!modal || !list) return;

    modal.classList.replace('hidden', 'flex');
    list.innerHTML = LIST_SKELETON; 

    try {
        const { data, error } = await supabase
            .from('connections')
            .select('status, user_one:user_one_id(id, full_name, profile_img_url, course), user_two:user_two_id(id, full_name, profile_img_url, course)')
            .or(`user_one_id.eq.${currentUserProfile.id},user_two_id.eq.${currentUserProfile.id}`)
            .eq('status', 'accepted');

        if (error) throw error;

        const connections = data.map(conn => conn.user_one.id === currentUserProfile.id ? conn.user_two : conn.user_one).filter(Boolean); 

        if (connections.length === 0) {
            list.innerHTML = `<p class="text-sm italic text-center py-8 text-on-surface-variant dark:text-gray-400">You have no connections yet.</p>`;
            return;
        }

        list.innerHTML = connections.map(user => {
            const rawAvatarUrl = user.profile_img_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4`;
            const optimizedAvatar = typeof window.optimizeImageUrl === 'function' ? window.optimizeImageUrl(rawAvatarUrl, 'avatar') : rawAvatarUrl;
            const fallback = `this.onerror=null; this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4';`;

            return `
            <div onclick="window.viewUserProfile('${user.id}'); closeConnectionsModal();" class="flex items-center gap-4 p-3 bg-surface-container-lowest dark:bg-neutral-900/50 rounded-2xl border border-surface-variant/40 dark:border-neutral-800 shadow-sm cursor-pointer hover:bg-surface-variant/20 transition-colors">
                <img loading="lazy" src="${optimizedAvatar}" onerror="${fallback}" class="w-12 h-12 rounded-full object-cover border border-surface-variant/50 shrink-0">
                <div class="flex-1 min-w-0">
                    <p class="font-bold text-sm text-on-surface dark:text-gray-100 truncate">${user.full_name}</p>
                    <p class="text-[11px] text-on-surface-variant dark:text-gray-400 mt-0.5 truncate">${user.course || 'Student'}</p>
                </div>
            </div>
            `;
        }).join('');

    } catch (error) {
        console.error('Error fetching connections:', error);
        list.innerHTML = `<p class="text-sm italic text-center py-8 text-error">Failed to load connections.</p>`;
    }
}

function closeConnectionsModal() {
    const modal = document.getElementById('modal-connections');
    if (modal) modal.classList.replace('flex', 'hidden');
}

window.openConnectionsModal = openConnectionsModal;
window.closeConnectionsModal = closeConnectionsModal;

// ========================================================
// FOLLOWERS MODAL (For Pages)
// ========================================================
window.handleProfileStatsClick = function() {
    if (currentUserProfile.role === 'page') {
        openFollowersModal();
    } else {
        openConnectionsModal();
    }
};

async function openFollowersModal() {
    const modal = document.getElementById('modal-followers');
    const list = document.getElementById('followers-list');
    if (!modal || !list) return;

    modal.classList.replace('hidden', 'flex');
    list.innerHTML = LIST_SKELETON; 

    try {
        const { data, error } = await supabase
            .from('page_followers')
            .select('users!page_followers_follower_id_fkey(id, full_name, profile_img_url, course)')
            .eq('page_id', currentUserProfile.id);

        if (error) throw error;

        // Clean up the nested Supabase response
        const followers = data.map(f => f.users).filter(Boolean);

        if (followers.length === 0) {
            list.innerHTML = `<p class="text-sm italic text-center py-8 text-on-surface-variant dark:text-gray-400">You have no followers yet.</p>`;
            return;
        }

        list.innerHTML = followers.map(user => {
            const rawAvatarUrl = user.profile_img_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4`;
            const optimizedAvatar = typeof window.optimizeImageUrl === 'function' ? window.optimizeImageUrl(rawAvatarUrl, 'avatar') : rawAvatarUrl;
            const fallback = `this.onerror=null; this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4';`;

            return `
            <div onclick="window.viewUserProfile('${user.id}'); closeFollowersModal();" class="flex items-center gap-4 p-3 bg-surface-container-lowest dark:bg-neutral-900/50 rounded-2xl border border-surface-variant/40 dark:border-neutral-800 shadow-sm cursor-pointer hover:bg-surface-variant/20 transition-colors">
                <img loading="lazy" src="${optimizedAvatar}" onerror="${fallback}" class="w-12 h-12 rounded-full object-cover border border-surface-variant/50 shrink-0">
                <div class="flex-1 min-w-0">
                    <p class="font-bold text-sm text-on-surface dark:text-gray-100 truncate">${user.full_name}</p>
                    <p class="text-[11px] text-on-surface-variant dark:text-gray-400 mt-0.5 truncate">${user.course || 'Student'}</p>
                </div>
            </div>
            `;
        }).join('');

    } catch (error) {
        console.error('Error fetching followers:', error);
        list.innerHTML = `<p class="text-sm italic text-center py-8 text-error">Failed to load followers.</p>`;
    }
}

function closeFollowersModal() {
    const modal = document.getElementById('modal-followers');
    if (modal) modal.classList.replace('flex', 'hidden');
}

window.openFollowersModal = openFollowersModal;
window.closeFollowersModal = closeFollowersModal;

async function openBlockedUsersModal() {
    const modal = document.getElementById('modal-blocked-users');
    const list = document.getElementById('blocked-users-list');
    if (!modal || !list) return;

    modal.classList.replace('hidden', 'flex');
    list.innerHTML = LIST_SKELETON; 

    try {
        const { data, error } = await supabase
            .from('connections')
            .select('user_one:user_one_id(id, full_name, profile_img_url, course), user_two:user_two_id(id, full_name, profile_img_url, course)')
            .eq('status', 'blocked')
            .eq('action_user_id', currentUserProfile.id);

        if (error) throw error;

        const blockedUsers = data.map(conn => conn.user_one.id === currentUserProfile.id ? conn.user_two : conn.user_one).filter(Boolean);

        if (blockedUsers.length === 0) {
            list.innerHTML = `<p class="text-sm italic text-center py-8 text-on-surface-variant dark:text-gray-400">You haven't blocked anyone.</p>`;
            return;
        }

      list.innerHTML = blockedUsers.map(user => {
            const rawAvatarUrl = user.profile_img_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4`;
            const optimizedAvatar = typeof window.optimizeImageUrl === 'function' ? window.optimizeImageUrl(rawAvatarUrl, 'avatar') : rawAvatarUrl;
            const fallback = `this.onerror=null; this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4';`;

            return `
            <div class="flex items-center gap-4 p-3 bg-surface-container-lowest dark:bg-neutral-900/50 rounded-2xl border border-surface-variant/40 dark:border-neutral-800 shadow-sm">
                <img loading="lazy" src="${optimizedAvatar}" onerror="${fallback}" class="w-12 h-12 rounded-full object-cover border border-surface-variant/50 shrink-0">
                <div class="flex-1 min-w-0">
                    <p class="font-bold text-sm text-on-surface dark:text-gray-100 truncate">${user.full_name}</p>
                    <p class="text-[11px] text-on-surface-variant dark:text-gray-400 mt-0.5 truncate">${user.course || 'Student'}</p>
                </div>
                <button data-user-id="${user.id}" class="unblock-btn bg-error/10 text-error px-4 py-2 rounded-xl text-xs font-bold active:scale-95 transition-transform hover:bg-error/20 shrink-0">
                    Unblock
                </button>
            </div>
            `;
        }).join('');
        
    } catch (error) {
        console.error('Error fetching blocked users:', error);
        list.innerHTML = `<p class="text-sm italic text-center py-8 text-error">Failed to load blocked users.</p>`;
    }
}

function closeBlockedUsersModal() {
    const modal = document.getElementById('modal-blocked-users');
    if (modal) modal.classList.replace('flex', 'hidden');
}

window.openBlockedUsersModal = openBlockedUsersModal;
window.closeBlockedUsersModal = closeBlockedUsersModal;

// NOTE: window.openSinglePostView used to be defined twice in this file — this
// earlier, less-complete copy (no polls/events, no reported/verified filter) was
// always silently overwritten by the fuller one further down, so it never actually
// ran. Removed to avoid anyone editing this dead copy by mistake; see the live
// definition under "SINGLE POST VIEWER ENGINE" below.

window.closeSinglePostView = function() {
    const modal = document.getElementById('modal-single-post');
    modal.classList.add('translate-x-full');
    
    const notifModal = document.getElementById('modal-notifications');
    if (notifModal && notifModal.classList.contains('hidden')) {
        const bottomNav = document.querySelector('nav');
        if (bottomNav) bottomNav.classList.remove('hidden');
    }
    
    setTimeout(() => modal.classList.replace('flex', 'hidden'), 300);

    };
// ========================================================
// NATIVE ANDROID BACK BUTTON ROUTER (The Waterfall)
// ========================================================
function setupAppBackButton() {
    
    const checkAndCloseTopLayer = () => {
     const modalHierarchy = [
            { id: 'modal-verify-camera', close: () => window.closeVerifyCamera && window.closeVerifyCamera() },
            // 🚀 NEW: Close Image Viewers and Peeks on Back Press
            { id: 'pdfv-overlay', close: () => window.closePdfViewer() },
            { id: 'modal-in-app-browser', close: () => window.closeInAppBrowser() },
            { id: 'popup-menu-card', close: () => window.closePopupMenu() },
            { id: 'modal-dp-viewer', close: () => window.closeDpViewer() },
            { id: 'modal-profile-peek', close: () => window.closeProfilePeek() },
            
            { id: 'modal-confirm-action', close: () => document.getElementById('confirm-action-no')?.click() },
            { id: 'modal-action-sheet', close: () => window.closeActionSheet() },
            { id: 'modal-story-details', close: () => document.getElementById('activity-backdrop-close')?.click() },
{ id: 'modal-post-comments', close: () => { if(typeof window.closeCommentsModal === 'function') window.closeCommentsModal(); } },
         { id: 'modal-poll-voters', close: () => document.getElementById('modal-poll-voters').classList.replace('flex','hidden') },
            { id: 'modal-report-post', close: () => window.closeReportPostModal() },
            { id: 'modal-report-user', close: () => window.closeReportModal() },
            { id: 'modal-edit-socials', close: () => window.closeSocialsModal() },
            { id: 'modal-edit-profile', close: () => window.closeEditProfileModal() },
            { id: 'modal-connections', close: () => window.closeConnectionsModal() },
            { id: 'modal-followers', close: () => window.closeFollowersModal() },
            { id: 'modal-blocked-users', close: () => window.closeBlockedUsersModal() },
            { id: 'modal-single-post', close: () => window.closeSinglePostView() },
            { id: 'modal-notifications', close: () => window.closeNotifications() },
           { id: 'modal-view-connections', close: () => window.closeUserConnectionsModal() },
            { id: 'modal-chat-conversation', close: () => window.closeConversation() },
            { id: 'modal-new-message', close: () => window.closeNewMessagePanel() },
            { id: 'modal-archived-chats', close: () => window.closeArchivedChats() },
            { id: 'modal-suggested-users', close: () => window.closeSuggestedUsersPanel() },
            
            // --- NEW: Hardware back support for sub-panels ---
            { id: 'settings-password-panel', close: () => window.closeSettingsSubPanel('settings-password-panel') },
            { id: 'settings-deactivate-panel', close: () => window.closeSettingsSubPanel('settings-deactivate-panel') },
            { id: 'settings-delete-panel', close: () => window.closeSettingsSubPanel('settings-delete-panel') },
            { id: 'settings-notifications-panel', close: () => window.closeSettingsSubPanel('settings-notifications-panel') },
            { id: 'settings-account-panel', close: () => window.closeSettingsSubPanel('settings-account-panel') },
            // -------------------------------------------------
{ id: 'modal-view-services', close: () => window.closeAllServicesModal() },
            { id: 'settings-sidebar', close: () => window.closeSettingsSidebar() },
            { id: 'view-create-post', close: () => {
                window.closeCreatePostView();
                // Clear any preview blobs memory when backing out of Create Post
                const imgUpload = document.getElementById('post-image-upload');
                if (imgUpload) imgUpload.value = '';
                const previewContainer = document.getElementById('post-image-preview-container');
                if (previewContainer && previewContainer.querySelector('img')) {
                    previewContainer.innerHTML = `<span class="material-symbols-outlined text-[32px] mb-2" id="img-icon-placeholder">add_photo_alternate</span><span class="text-sm font-medium" id="img-text-placeholder">Tap to upload image</span>`;
                }
            }},
            { id: 'modal-profile-public', close: () => window.closeProfileModals() },
            { id: 'modal-profile-private', close: () => window.closeProfileModals() },
            { id: 'modal-hotpost-camera', close: () => document.getElementById('close-hotpost-camera-btn')?.click() },
            { id: 'modal-view-hotpost', close: () => document.getElementById('close-hotpost-viewer-btn')?.click() },
            { id: 'modal-course-picker', close: () => window.closeCoursePicker() }
        ];
        // Remember to change the check loop to use 'hidden' OR 'translate-x-full' for the sub-panels:
        for (const modal of modalHierarchy) {
            const el = document.getElementById(modal.id);
            if (el && (!el.classList.contains('hidden') && !el.classList.contains('translate-x-full'))) {
                modal.close(); 
                return true; 
            }
        }

        // --- BAFs App (embedded Study Planner iframe) internal back navigation ---
        // Same-origin iframe with its own independent session history — the
        // hardware/browser back button above only ever sees the parent
        // document's history, so without this a back-press while inside one
        // of the iframe's sub-views would fall straight through to the
        // dashboard-switch/exit-app fallback below instead of stepping back
        // within the study planner itself.
        // Only when the Search tab is the one actually showing — switchTab
        // just toggles the "hidden" class, it doesn't destroy the iframe, so
        // without this check a back-press from a totally different tab could
        // still find the (invisible) iframe and incorrectly delegate to it.
        // (The pdfv-overlay check above already takes priority when a PDF —
        // opened from inside this iframe or anywhere else — is on screen, so
        // this is only reached once no PDF viewer is open.)
        const searchTabVisible = document.getElementById('view-search') && !document.getElementById('view-search').classList.contains('hidden');
        const bafsIframe = searchTabVisible ? document.querySelector('#discover-list-container iframe[title="BAFs App"]') : null;
        if (bafsIframe && bafsIframe.contentWindow && typeof bafsIframe.contentWindow.bafsIsAtHome === 'function') {
            if (!bafsIframe.contentWindow.bafsIsAtHome()) {
                bafsIframe.contentWindow.bafsGoBack();
                return true;
            }
        }

        const dashboardView = document.getElementById('view-dashboard');
        if (dashboardView && dashboardView.classList.contains('hidden')) {
            if (window.switchTab) window.switchTab('dashboard'); 
            return true; 
        }

        return false; 
    };

    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        try {
            const App = window.Capacitor.Plugins.App;
            if (App) {
                App.addListener('backButton', () => {
                    const handled = checkAndCloseTopLayer();
                    if (!handled) {
                        App.exitApp(); 
                    }
                });
            }
        } catch (err) {
            console.warn('Capacitor App plugin bypassed.', err);
        }
    } 
    
    window.history.pushState({ app_active: true }, "");
    
    window.addEventListener('popstate', () => {
        const handled = checkAndCloseTopLayer();
        if (handled) {
            window.history.pushState({ app_active: true }, "");
        } 
    });
}
// ========================================================
// CUSTOM COURSE PICKER ENGINE
// ========================================================
window.openCoursePicker = function() {
    const picker = document.getElementById('modal-course-picker');
    picker.classList.replace('hidden', 'flex');
};

window.closeCoursePicker = function() {
    const picker = document.getElementById('modal-course-picker');
    picker.classList.replace('flex', 'hidden');
};

window.selectCourse = function(courseName) {
    const editInput = document.getElementById('edit-profile-course');
    const verifyInput = document.getElementById('verify-course');
    const verifyView = document.getElementById('view-verification');
    
    // Check if the verification screen is currently open
    if (verifyView && !verifyView.classList.contains('hidden')) {
        if (verifyInput) verifyInput.value = courseName;
    } else {
        if (editInput) editInput.value = courseName;
    }
    
    closeCoursePicker();
};

// ========================================================
// SMART SOCIAL PLATFORM PICKER ENGINE
// ========================================================
const socialPlatformsConfig = {
    instagram: { name: 'Instagram', icon: 'fa-brands fa-instagram', color: 'bg-gradient-to-br from-purple-400 via-pink-500 to-red-500 text-white', placeholder: 'Username (e.g. johndoe)', type: 'text', prefix: 'https://instagram.com/' },
    snapchat: { name: 'Snapchat', icon: 'fa-brands fa-snapchat', color: 'bg-[#FFFC00] text-black', placeholder: 'Snapchat Username', type: 'text', prefix: 'https://snapchat.com/add/' },
    whatsapp: { name: 'WhatsApp', icon: 'fa-brands fa-whatsapp', color: 'bg-[#25D366] text-white', placeholder: 'Phone Number (e.g. 919876543210)', type: 'tel', prefix: 'https://wa.me/' },
    linkedin: { name: 'LinkedIn', icon: 'fa-brands fa-linkedin-in', color: 'bg-[#0A66C2] text-white', placeholder: 'LinkedIn Username', type: 'text', prefix: 'https://linkedin.com/in/' },
    twitter: { name: 'X (Twitter)', icon: 'fa-brands fa-x-twitter', color: 'bg-black dark:bg-white text-white dark:text-black', placeholder: 'X Username', type: 'text', prefix: 'https://x.com/' },
    spotify: { name: 'Spotify', icon: 'fa-brands fa-spotify', color: 'bg-[#1DB954] text-white', placeholder: 'Spotify Profile URL', type: 'url', prefix: '' },
    telegram: { name: 'Telegram', icon: 'fa-brands fa-telegram', color: 'bg-[#229ED9] text-white', placeholder: 'Telegram Username', type: 'text', prefix: 'https://t.me/' },
    discord: { name: 'Discord', icon: 'fa-brands fa-discord', color: 'bg-[#5865F2] text-white', placeholder: 'Discord Username', type: 'text', prefix: 'https://discord.com/users/' },
    reddit: { name: 'Reddit', icon: 'fa-brands fa-reddit-alien', color: 'bg-[#FF4500] text-white', placeholder: 'Reddit Username', type: 'text', prefix: 'https://reddit.com/user/' },
    github: { name: 'GitHub', icon: 'fa-brands fa-github', color: 'bg-[#181717] dark:bg-white text-white dark:text-black', placeholder: 'GitHub Username', type: 'text', prefix: 'https://github.com/' },
    youtube: { name: 'YouTube', icon: 'fa-brands fa-youtube', color: 'bg-[#FF0000] text-white', placeholder: 'Channel URL or @handle', type: 'text', prefix: 'https://youtube.com/' },
    website: { name: 'Website', icon: 'fa-solid fa-globe', color: 'bg-primary text-white', placeholder: 'example.com', type: 'url', prefix: 'https://' }
};

window.openSocialPicker = function() {
    const list = document.getElementById('social-picker-list');
    list.innerHTML = '';
    
    Object.keys(socialPlatformsConfig).forEach(key => {
        const config = socialPlatformsConfig[key];
        list.innerHTML += `
            <button onclick="selectSocialPlatform('${key}')" class="w-full flex items-center gap-4 p-3.5 rounded-2xl hover:bg-surface-variant/30 dark:hover:bg-neutral-800 transition-colors active:scale-[0.98] text-left border border-transparent hover:border-surface-variant/50 dark:hover:border-neutral-700">
                <div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 shadow-sm ${config.color}">
                    <i class="${config.icon} text-[18px]"></i>
                </div>
                <span class="font-extrabold text-[15px] text-on-surface dark:text-gray-100 tracking-wide">${config.name}</span>
            </button>
        `;
    });
    
    document.getElementById('modal-social-picker').classList.replace('hidden', 'flex');
};

window.closeSocialPicker = function() {
    document.getElementById('modal-social-picker').classList.replace('flex', 'hidden');
};

window.selectSocialPlatform = function(id) {
    const config = socialPlatformsConfig[id];
    
    document.getElementById('add-social-platform').value = id;
    document.getElementById('selected-social-name').textContent = config.name;
    document.getElementById('selected-social-icon').className = config.icon + ' text-[16px]';
    document.getElementById('selected-social-icon-box').className = `w-8 h-8 rounded-full flex items-center justify-center shrink-0 shadow-sm ${config.color}`;
    
    const input = document.getElementById('add-social-url');
    input.type = config.type;
    input.placeholder = config.placeholder;
    input.value = ''; 
    
    closeSocialPicker();
};

// ========================================================
// NATIVE LONG-PRESS ENGINE (Profile Peek & DP Viewer)
// ========================================================
let longPressTimer;
window.isLongPressing = false; 

document.addEventListener('touchstart', handleTouchStart, { passive: true });
document.addEventListener('touchend', handleTouchEnd);
document.addEventListener('touchmove', handleTouchMove, { passive: true });
document.addEventListener('mousedown', handleTouchStart);
document.addEventListener('mouseup', handleTouchEnd);
document.addEventListener('mousemove', handleTouchMove);

let touchStartX = 0;
let touchStartY = 0;

function handleTouchStart(e) {
    if (!e.target || typeof e.target.closest !== 'function') return;

    const profileLink = e.target.closest('.profile-link');
    const dpLink = e.target.closest('.dp-link');
    
    if (!profileLink && !dpLink) return;

    // 🚀 FIX: Safely record start position for BOTH touch screens and desktop clicks
    if (e.touches && e.touches.length > 0) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    } else if (e.clientX !== undefined) {
        touchStartX = e.clientX;
        touchStartY = e.clientY;
    }

    clearTimeout(longPressTimer);
    window.isLongPressing = false;
    
    longPressTimer = setTimeout(() => {
        window.isLongPressing = true;
        if (navigator.vibrate) navigator.vibrate(50);
        
        if (dpLink) {
            const imgSrc = dpLink.src || '';
            window.openDpViewer(imgSrc);
        } else if (profileLink) {
            const userId = profileLink.dataset.userId;
            
            // Ensure we are passing an image to the viewer, even if they tapped the wrapper div
            let imgEl = profileLink;
            if (profileLink.tagName !== 'IMG') {
                imgEl = profileLink.querySelector('img') || profileLink;
            }
            
            if (userId) window.openProfilePeek(userId, imgEl);
        }
    }, 400); 
}

function handleTouchMove(e) {
    let moveX, moveY;

    // 🚀 FIX: Intelligently extract coordinates without crashing
    if (e.touches && e.touches.length > 0) {
        moveX = e.touches[0].clientX;
        moveY = e.touches[0].clientY;
    } else if (e.clientX !== undefined) {
        moveX = e.clientX;
        moveY = e.clientY;
    } else {
        // If Android fires a ghost event with no coordinates, DO NOTHING! 
        // (This is what was killing the old profile cards)
        return; 
    }
    
    // Only cancel if they ACTUALLY dragged their finger more than 10 pixels
    if (Math.abs(moveX - touchStartX) > 10 || Math.abs(moveY - touchStartY) > 10) {
        clearTimeout(longPressTimer);
    }
}

function handleTouchEnd(e) {
    clearTimeout(longPressTimer);
    
    if (window.isLongPressing) {
        if (e.cancelable) e.preventDefault();
        setTimeout(() => { window.isLongPressing = false; }, 300);
    }
}

// ===============================================
// 1. FEED PEEK CARD LOGIC
// ===============================================
window.openProfilePeek = async function(userId, imgEl) {
    const modal = document.getElementById('modal-profile-peek');
    const card = document.getElementById('peek-card');
    
    if (!modal || !card) return; // Failsafe

    if (imgEl && imgEl.tagName === 'IMG') {
        document.getElementById('peek-avatar').src = imgEl.src;
    }
    
    document.getElementById('peek-name').innerHTML = 'Loading...';
    document.getElementById('peek-course').textContent = 'Fetching details...';
    
    modal.classList.replace('hidden', 'flex');
    modal.style.pointerEvents = 'auto';

    setTimeout(() => {
        modal.classList.remove('opacity-0');
        card.classList.remove('scale-90');
    }, 10);

    try {
        const { data: user, error } = await supabase.from('users').select('full_name, profile_img_url, course, tick_type').eq('id', userId).single();
        if (error) throw error;
        
        const optimizedAvatar = typeof window.optimizeImageUrl === 'function' ? window.optimizeImageUrl(user.profile_img_url, 'avatar') : user.profile_img_url;
        document.getElementById('peek-avatar').src = optimizedAvatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4`;
        
       // Verified tick badge — uses the single canonical window.getTickHtml
        const verifiedBadge = window.getTickHtml ? window.getTickHtml(user.tick_type) : '';
        
        document.getElementById('peek-name').innerHTML = `${user.full_name} ${verifiedBadge}`;
        document.getElementById('peek-course').textContent = user.course || 'Campus Member';
        
        document.getElementById('peek-view-profile-btn').onclick = () => {
            window.closeProfilePeek();
            setTimeout(() => window.viewUserProfile(userId), 200); 
        };
    } catch (err) {
        document.getElementById('peek-name').textContent = 'User Details Unavailable';
        document.getElementById('peek-course').textContent = '';
    }
}

window.closeProfilePeek = function() {
    const modal = document.getElementById('modal-profile-peek');
    const card = document.getElementById('peek-card');
    if (!modal || !card) return;
    
    modal.style.pointerEvents = 'none';
    modal.classList.add('opacity-0');
    card.classList.add('scale-90');
    
    setTimeout(() => {
        modal.classList.replace('flex', 'hidden');
        modal.style.pointerEvents = 'auto';
    }, 300);
}

// ===============================================
// 2. PROFILE DP VIEWER LOGIC (Instagram Style)
// ===============================================
window.openDpViewer = function(imgSrc) {
    const modal = document.getElementById('modal-dp-viewer');
    const card = document.getElementById('dp-viewer-card');
    const avatarImg = document.getElementById('dp-viewer-image');

    if (!modal || !card || !avatarImg) return; // Failsafe

    if (imgSrc && typeof imgSrc === 'string' && imgSrc.includes('cloudinary.com') && imgSrc.includes('w_150')) {
        imgSrc = imgSrc.replace('w_150,h_150', 'w_600,h_600');
    }
    
    avatarImg.src = imgSrc || '';

    modal.classList.replace('hidden', 'flex');
    modal.style.pointerEvents = 'auto';

    setTimeout(() => {
        modal.classList.remove('opacity-0');
        card.classList.remove('scale-90');
    }, 10);
};

window.closeDpViewer = function() {
    const modal = document.getElementById('modal-dp-viewer');
    const card = document.getElementById('dp-viewer-card');
    if (!modal || !card) return;
    
    modal.style.pointerEvents = 'none';
    modal.classList.add('opacity-0');
    
    // Clear any inline scale/translate transforms generated by the pinch-to-zoom engine
    card.style.transform = '';
    card.classList.add('scale-90');
    
    setTimeout(() => {
        modal.classList.replace('flex', 'hidden');
        modal.style.pointerEvents = 'auto';
    }, 300);
};

// 🚀 NEW: Instagram-Style Pinch to Zoom & Drag Physics Engine
function setupDpViewerPhysics() {
    const viewer = document.getElementById('modal-dp-viewer');
    const card = document.getElementById('dp-viewer-card');
    if (!viewer || !card) return;

    let initialPinchDist = 0;
    let currentScale = 1;
    let startX = 0, startY = 0;
    let currentX = 0, currentY = 0;
    
    viewer.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            // Calculate the distance and center point between two fingers
            initialPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            startX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            startY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            
            card.style.transition = 'none'; // Lock tracking strictly to fingers (no lag)
        }
    }, { passive: true });

    viewer.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2) {
            if (e.cancelable) e.preventDefault(); // Lock background scrolling
            
            // Calculate Zoom
            const currentDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            currentScale = Math.max(1, Math.min(currentDist / initialPinchDist, 4)); // Max 4x zoom
            
            // Calculate Drag
            const moveX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const moveY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            currentX = moveX - startX;
            currentY = moveY - startY;

            // Apply transformations
            card.style.transform = `translate(${currentX}px, ${currentY}px) scale(${currentScale})`;
        }
    }, { passive: false });

    viewer.addEventListener('touchend', (e) => {
        // If they release 1 or both fingers, snap back to the center instantly
        if (e.touches.length < 2 && currentScale > 1) {
            currentScale = 1;
            currentX = 0;
            currentY = 0;
            card.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
            card.style.transform = 'translate(0px, 0px) scale(1)';
        }
    }, { passive: true });
}

// Boot the physics engine
document.addEventListener('DOMContentLoaded', setupDpViewerPhysics);

// ========================================================
// GLOBAL BLOCK & FILTER LOGIC
// ========================================================
// 🚀 IMPROVED: Now uses data-layer with caching
// Import at top: import { getBlockedUserIds } from './data-layer.js';
// Keep window.getBlockedUserIds for backwards compatibility
window.getBlockedUserIds = async function(currentUserId) {
    try {
        // This will use caching from data-layer
        const { getBlockedUserIds: getBlocked } = await import('./data-layer.js');
        return await getBlocked(currentUserId);
    } catch (e) {
        console.error("Error fetching blocked list:", e);
        // Fallback to direct query if data-layer unavailable
        try {
            const { data } = await supabase
                .from('connections')
                .select('user_one_id, user_two_id')
                .eq('status', 'blocked')
                .or(`user_one_id.eq.${currentUserId},user_two_id.eq.${currentUserId}`);
            
            if (!data) return [];
            return data.map(c => c.user_one_id === currentUserId ? c.user_two_id : c.user_one_id);
        } catch (fallbackErr) {
            console.error("Fallback blocked list error:", fallbackErr);
            return [];
        }
    }
};

// ========================================================
// NATIVE NESTED SETTINGS ROUTING & LOGIC
// ========================================================

// ========================================================
// NATIVE NESTED SETTINGS ROUTING & LOGIC
// ========================================================

window.openSettingsSubPanel = function(panelId) {
    const panel = document.getElementById(panelId);
    if (panel) {
        panel.classList.remove('translate-x-full');
    }
};

window.closeSettingsSubPanel = function(panelId) {
    const panel = document.getElementById(panelId);
    if (panel) {
        panel.classList.add('translate-x-full');
    }
};

// 1. Change Password (Fixed Auth Dependency)
window.executeChangePassword = async function() {
    const oldPw = document.getElementById('cp-old').value;
    const newPw = document.getElementById('cp-new').value;
    const confirmPw = document.getElementById('cp-confirm').value;
    const btn = document.getElementById('btn-change-password');
    const errorDiv = document.getElementById('cp-error-msg');

    // Reset UI
    errorDiv.classList.add('hidden');
    errorDiv.textContent = '';
    
    const showError = (msg) => {
        errorDiv.textContent = msg;
        errorDiv.classList.remove('hidden');
    };

    if (!oldPw || !newPw || !confirmPw) return showError('Please fill all fields.');
    if (newPw !== confirmPw) return showError('New passwords do not match.');
    if (newPw.length < 6) return showError('Password must be at least 6 characters.');

    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined animate-spin">progress_activity</span>`;

    try {
        // Guarantee we have the active session email
        const { data: { user }, error: userErr } = await supabase.auth.getUser();
        if (userErr || !user) throw new Error("Could not verify active user session.");

        // Step 1: Re-authenticate to verify old password
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email: user.email,
            password: oldPw
        });

        if (authError) {
            btn.disabled = false;
            btn.innerHTML = originalText;
            return showError('Incorrect Current Password.');
        }

        // Step 2: Update Password securely
        const { error: updateError } = await supabase.auth.updateUser({ password: newPw });
        if (updateError) throw updateError;

        showToast('Password updated successfully!', 'success');
        document.getElementById('cp-old').value = '';
        document.getElementById('cp-new').value = '';
        document.getElementById('cp-confirm').value = '';
        closeSettingsSubPanel('settings-password-panel');

    } catch (err) {
        console.error("Change Password Error:", err);
        showError(err.message || 'Failed to update password.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
};

// 2. Deactivate Account
window.executeDeactivateAccount = async function() {
    const btn = document.getElementById('btn-deactivate-final');
    btn.textContent = 'Deactivating...';
    btn.disabled = true;

    try {
        await supabase.from('users').update({ is_deactivated: true }).eq('id', currentUserProfile.id);
        await supabase.auth.signOut();
        window.location.replace('auth/login.html');
    } catch (e) {
        showToast('Failed to deactivate.', 'error');
        btn.textContent = 'Deactivate Now';
        btn.disabled = false;
    }
};

// 3. Delete Account
window.executeDeleteAccount = async function() {
    const btn = document.getElementById('btn-delete-final');
    btn.textContent = 'Deleting...';
    btn.disabled = true;
    
    try {
        await supabase.from('users').update({ is_deleted: true }).eq('id', currentUserProfile.id);
        await supabase.auth.signOut();
        window.location.replace('auth/login.html'); 
    } catch (e) {
        showToast('Failed to delete.', 'error');
        btn.textContent = 'Permanently Delete Account';
        btn.disabled = false;
    }
};

// Unmute straight from the centralized Settings list — reuses messages.js's own
// window.setChatMute (same function the chat's "⋯" menu uses), so its in-memory
// cache and toast stay consistent instead of this page doing its own DB write.
window.unmuteChatFromSettings = function(partnerId, btnElement) {
    if (typeof window.setChatMute !== 'function') return;
    window.setChatMute(partnerId, 'off');
    const row = btnElement.closest('.flex.items-center.justify-between');
    if (row) { row.style.transition = 'opacity 0.2s ease'; row.style.opacity = '0'; setTimeout(() => row.remove(), 200); }
};

// 4. Manage Notification Settings
// 🚀 NEW: Update global push settings in JSONB
window.toggleGlobalPushSetting = async function(category, isEnabled) {
    // Treat undefined/null as empty object
    const currentSettings = currentUserProfile.push_settings || {};
    currentSettings[category] = isEnabled;

    try {
        const { error } = await supabase
            .from('users')
            .update({ push_settings: currentSettings })
            .eq('id', currentUserProfile.id);

        if (error) throw error;
        currentUserProfile.push_settings = currentSettings;
        
        // No toast needed here, iOS/Instagram style is silent toggle success
    } catch (err) {
        console.error(err);
        showToast('Failed to update setting', 'error');
        // Revert UI if DB fails
        document.getElementById(`push-toggle-${category}`).checked = !isEnabled;
    }
};

window.fetchNotificationSettings = async function() {
    // 1. Sync the state of the Global Toggles
    const settings = currentUserProfile.push_settings || {};
    // If setting is undefined, assume TRUE (default on)
    document.getElementById('push-toggle-likes').checked = settings.likes !== false;
    document.getElementById('push-toggle-comments').checked = settings.comments !== false;
    document.getElementById('push-toggle-mentions').checked = settings.mentions !== false;
    document.getElementById('push-toggle-connections').checked = settings.connections !== false;
    document.getElementById('push-toggle-messages').checked = settings.messages !== false;

    // 2. Muted chats — surfaced here too (not just per-chat via the "⋯" menu) so
    // there's one place to see and undo every mute at once.
    const mutedList = document.getElementById('notification-muted-chats-list');
    if (mutedList) {
        mutedList.innerHTML = `<p class="text-sm italic text-center py-3 text-on-surface-variant dark:text-gray-400">Loading...</p>`;
        try {
            const { data: mutedRows, error: mutedError } = await supabase
                .from('conversation_settings')
                .select('partner_id, muted_until, users:partner_id(full_name, profile_img_url)')
                .eq('user_id', currentUserProfile.id)
                .gt('muted_until', new Date().toISOString());

            if (mutedError) throw mutedError;

            if (!mutedRows || mutedRows.length === 0) {
                mutedList.innerHTML = `<p class="text-sm text-center py-4 text-on-surface-variant dark:text-gray-500">No muted chats.</p>`;
            } else {
                mutedList.innerHTML = mutedRows.map(row => `
                    <div class="flex items-center justify-between p-3 bg-surface-container-lowest dark:bg-neutral-900/50 rounded-2xl border border-surface-variant/40 dark:border-neutral-800 shadow-sm mb-2">
                        <div class="flex items-center gap-3 min-w-0">
                            <img src="${row.users?.profile_img_url}" class="w-10 h-10 rounded-full object-cover border border-surface-variant/50 shrink-0">
                            <p class="font-bold text-[14px] text-on-surface dark:text-gray-100 truncate">${row.users?.full_name || 'Unknown'}</p>
                        </div>
                        <button onclick="window.unmuteChatFromSettings('${row.partner_id}', this)" class="text-[12.5px] font-bold text-primary px-3 py-1.5 rounded-full bg-primary/10 active:scale-95 transition-transform shrink-0">Unmute</button>
                    </div>
                `).join('');
            }
        } catch (e) {
            console.error('Error loading muted chats:', e);
            mutedList.innerHTML = `<p class="text-sm text-center py-4 text-error">Failed to load muted chats.</p>`;
        }
    }

    // 3. Fetch specific Page Toggles (Existing Logic)
    const list = document.getElementById('notification-settings-list');
    list.innerHTML = `<p class="text-sm italic text-center py-4 text-on-surface-variant dark:text-gray-400">Loading...</p>`;

    try {
        const { data, error } = await supabase
            .from('page_followers')
            .select('receive_notifications, page_id, users!page_followers_page_id_fkey(full_name, profile_img_url)')
            .eq('follower_id', currentUserProfile.id);

        if (error) throw error;

        if (data.length === 0) {
            list.innerHTML = `<p class="text-sm text-center py-8 text-on-surface-variant dark:text-gray-500">You are not following any pages.</p>`;
            return;
        }

        list.innerHTML = data.map(item => `
            <div class="flex items-center justify-between p-3 bg-surface-container-lowest dark:bg-neutral-900/50 rounded-2xl border border-surface-variant/40 dark:border-neutral-800 shadow-sm mb-2">
                <div class="flex items-center gap-3">
                    <img src="${item.users.profile_img_url}" class="w-10 h-10 rounded-full object-cover border border-surface-variant/50">
                    <p class="font-bold text-[14px] text-on-surface dark:text-gray-100">${item.users.full_name}</p>
                </div>
                <label class="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" onchange="window.togglePageBell('${item.page_id}', this.checked)" class="sr-only peer" ${item.receive_notifications ? 'checked' : ''}>
                    <div class="w-11 h-6 bg-surface-variant dark:bg-neutral-700 rounded-full peer peer-checked:bg-primary peer-checked:after:translate-x-full after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
                </label>
            </div>
        `).join('');

    } catch (err) {
        console.error('Error fetching notification settings:', err);
        list.innerHTML = `<p class="text-sm text-center py-4 text-error">Failed to load settings.</p>`;
    }
};
window.togglePageBell = async function(pageId, notifyState) {
    try {
        await supabase.rpc('toggle_page_notifications', { p_page_id: pageId, p_follower_id: currentUserProfile.id, p_notify: notifyState });
        showToast(notifyState ? 'Alerts ON' : 'Alerts OFF', 'success');
    } catch (err) {
        console.error('Failed to toggle alert', err);
        showToast('Failed to update setting.', 'error');
    }
};
// ========================================================
// PUBLIC CONNECTIONS VIEWER (Instagram Style List)
// ========================================================
let currentViewedConnections = []; // Stores list for live search

window.openUserConnectionsModal = async function(userId, role, userName) {
    const modal = document.getElementById('modal-view-connections');
    const title = document.getElementById('view-connections-title');
    const list = document.getElementById('view-connections-list');
    const searchInput = document.getElementById('view-connections-search');

    modal.classList.replace('hidden', 'flex');
    setTimeout(() => modal.classList.remove('translate-x-full'), 10);

    title.textContent = userName;
    searchInput.value = '';
    list.innerHTML = LIST_SKELETON; // Show loading shimmer
    currentViewedConnections = [];

    try {
        let users = [];

        if (role === 'page') {
            const { data, error } = await supabase
                .from('page_followers')
                .select('users!page_followers_follower_id_fkey(id, full_name, profile_img_url, course, tick_type)')
                .eq('page_id', userId);
            if (error) throw error;
            users = data.map(f => f.users).filter(Boolean);
        } else {
            const { data, error } = await supabase
                .from('connections')
                .select('user_one:user_one_id(id, full_name, profile_img_url, course, tick_type), user_two:user_two_id(id, full_name, profile_img_url, course, tick_type)')
                .or(`user_one_id.eq.${userId},user_two_id.eq.${userId}`)
                .eq('status', 'accepted');
            if (error) throw error;
            users = data.map(conn => conn.user_one.id === userId ? conn.user_two : conn.user_one).filter(Boolean);
        }

        currentViewedConnections = users;
        renderViewConnectionsList(users);

        // 🚀 LIVE SEARCH FILTER
        searchInput.oninput = (e) => {
            const q = e.target.value.toLowerCase().trim();
            const filtered = currentViewedConnections.filter(u => 
                u.full_name.toLowerCase().includes(q) || 
                (u.course && u.course.toLowerCase().includes(q))
            );
            renderViewConnectionsList(filtered, q !== '');
        };

    } catch (error) {
        console.error('Error fetching user connections:', error);
        list.innerHTML = `<p class="text-sm italic text-center py-8 text-error">Failed to load list.</p>`;
    }
};

window.closeUserConnectionsModal = function() {
    const modal = document.getElementById('modal-view-connections');
    modal.classList.add('translate-x-full');
    setTimeout(() => modal.classList.replace('flex', 'hidden'), 300);
};

function renderViewConnectionsList(users, isSearch = false) {
    const list = document.getElementById('view-connections-list');

    if (users.length === 0) {
        list.innerHTML = `<div class="py-16 flex flex-col items-center justify-center opacity-40 text-on-surface-variant"><span class="material-symbols-outlined text-[42px] mb-2">group_off</span><p class="text-sm font-semibold">${isSearch ? 'No users found.' : 'No connections yet.'}</p></div>`;
        return;
    }

    list.innerHTML = users.map(user => {
        const optimizedAvatar = typeof window.optimizeImageUrl === 'function' ? window.optimizeImageUrl(user.profile_img_url, 'avatar') : user.profile_img_url;
        const fallback = `this.onerror=null; this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4';`;
        const tickHtml = window.getTickHtml ? window.getTickHtml(user.tick_type) : '';

        return `
        <div onclick="window.closeUserConnectionsModal(); setTimeout(() => window.viewUserProfile('${user.id}'), 150);" class="flex items-center gap-3.5 p-3 hover:bg-surface-variant/20 dark:hover:bg-neutral-800/50 rounded-2xl cursor-pointer active:scale-[0.98] transition-all">
            <img loading="lazy" src="${optimizedAvatar || fallback}" onerror="${fallback}" class="w-12 h-12 rounded-full object-cover border border-surface-variant/50 shrink-0">
            <div class="flex-1 min-w-0">
                <p class="font-bold text-[14.5px] text-on-surface dark:text-gray-100 truncate flex items-center gap-1">${user.full_name} ${tickHtml}</p>
                <p class="text-[12px] font-medium text-on-surface-variant dark:text-gray-500 mt-0.5 truncate">${user.course || 'Student'}</p>
            </div>
            <button class="w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-variant/50 transition-colors shrink-0">
                <span class="material-symbols-outlined text-[20px]">chevron_right</span>
            </button>
        </div>
        `;
    }).join('');
}

// ========================================================
// PREFERENCES & PRIVACY UPDATES
// ========================================================
window.openMentionPrivacySelector = function() {
    const buttons = `
        <div class="px-4 py-3 border-b border-surface-variant/40 dark:border-neutral-800 text-center">
            <p class="text-xs font-bold text-on-surface-variant uppercase tracking-wider">Allow Mentions From</p>
        </div>
        <button onclick="window.updateMentionPrivacy('connections')" class="w-full flex items-center gap-3 px-5 py-4 border-b border-surface-variant/40 dark:border-neutral-800 font-bold text-[15px] text-on-surface dark:text-gray-100 hover:bg-surface-variant/30 active:bg-surface-variant/50 transition-colors"><span class="material-symbols-outlined text-primary">group</span> My Connections</button>
        <button onclick="window.updateMentionPrivacy('none')" class="w-full flex items-center gap-3 px-5 py-4 font-bold text-[15px] text-on-surface dark:text-gray-100 hover:bg-surface-variant/30 active:bg-surface-variant/50 transition-colors"><span class="material-symbols-outlined text-error">block</span> No One</button>
    `;
    window.openActionSheet(buttons);
};

window.updateMentionPrivacy = async function(val) {
    window.closeActionSheet();
    try {
        const { error } = await supabase.from('users').update({ mention_privacy: val }).eq('id', currentUserProfile.id);
        if (error) throw error;
        
        currentUserProfile.mention_privacy = val;
        
        const labelEl = document.getElementById('mention-privacy-label');
        if (labelEl) labelEl.textContent = val === 'connections' ? 'Connections' : 'No One';
        
        showToast(`Mentions allowed from: ${val === 'connections' ? 'My Connections' : 'No One'}`, 'success');
    } catch (err) {
        console.error("Mention privacy error:", err);
        showToast('Failed to update settings', 'error');
    }
};

// ========================================================
// ACTIVITY PANELS LOGIC (Saved, Liked, Archived)
// ========================================================
window.fetchSavedPosts = async function() {
    const container = document.getElementById('saved-posts-container');
    if (!container) return;
    container.innerHTML = FEED_SKELETON; 

    try {
       const { data, error } = await supabase.from('posts').select(`
            *, users ( id, full_name, profile_img_url, role, tick_type ),
            post_likes ( user_id ),
            post_comments ( id, content, created_at, is_deleted, parent_comment_id, users(id, full_name, profile_img_url, tick_type) ),
            post_polls (*),
            post_poll_votes ( user_id, option_id ),
            post_events (*),
            post_event_rsvps ( user_id, status ),
            saved_posts!inner ( user_id )
        `)
        .eq('saved_posts.user_id', currentUserProfile.id)
        .eq('is_deleted', false)
        .eq('is_archived', false)
        .or('is_reported.eq.false,is_verified.eq.true')
        .order('created_at', { ascending: false });

        if (error) throw error;
        if (data.length === 0) {
            container.innerHTML = `<div class="py-16 flex flex-col items-center justify-center opacity-40 text-on-surface-variant"><span class="material-symbols-outlined text-[42px] mb-2">bookmark</span><p class="text-sm font-semibold">No saved posts.</p></div>`;
            return;
        }
        container.innerHTML = generatePostHTML(data, currentUserProfile.id);
    } catch (e) {
        console.error(e);
        container.innerHTML = `<p class="text-sm text-center py-4 text-error">Failed to load saved posts.</p>`;
    }
};

window.fetchLikedPosts = async function() {
    const container = document.getElementById('liked-posts-container');
    if (!container) return;
    container.innerHTML = FEED_SKELETON;

    try {
      const { data, error } = await supabase.from('posts').select(`
            *, users ( id, full_name, profile_img_url, role, tick_type ),
            post_likes!inner ( user_id ),
            post_comments ( id, content, created_at, is_deleted, parent_comment_id, users(id, full_name, profile_img_url, tick_type) ),
            post_polls (*),
            post_poll_votes ( user_id, option_id ),
            post_events (*),
            post_event_rsvps ( user_id, status ),
            saved_posts ( user_id )
        `)
        .eq('post_likes.user_id', currentUserProfile.id)
        .eq('is_deleted', false)
        .eq('is_archived', false)
        .or('is_reported.eq.false,is_verified.eq.true')
        .order('created_at', { ascending: false });

        if (error) throw error;
        if (data.length === 0) {
            container.innerHTML = `<div class="py-16 flex flex-col items-center justify-center opacity-40 text-on-surface-variant"><span class="material-symbols-outlined text-[42px] mb-2">favorite</span><p class="text-sm font-semibold">You haven't liked any posts.</p></div>`;
            return;
        }
        container.innerHTML = generatePostHTML(data, currentUserProfile.id);
    } catch (e) {
        console.error(e);
        container.innerHTML = `<p class="text-sm text-center py-4 text-error">Failed to load liked posts.</p>`;
    }
};

window.fetchArchivedPosts = async function() {
    const container = document.getElementById('archived-posts-container');
    if (!container) return;
    container.innerHTML = FEED_SKELETON;

    try {
       const { data, error } = await supabase.from('posts').select(`
            *, users ( id, full_name, profile_img_url, role, tick_type ),
            post_likes ( user_id ),
            post_comments ( id, content, created_at, is_deleted, parent_comment_id, users(id, full_name, profile_img_url, tick_type) ),
            post_polls (*),
            post_poll_votes ( user_id, option_id ),
            post_events (*),
            post_event_rsvps ( user_id, status ),
            saved_posts ( user_id )
        `)
        .eq('user_id', currentUserProfile.id)
        .eq('is_deleted', false)
        .eq('is_archived', true)
        .or('is_reported.eq.false,is_verified.eq.true')
        .order('created_at', { ascending: false });

        if (error) throw error;
        if (data.length === 0) {
            container.innerHTML = `<div class="py-16 flex flex-col items-center justify-center opacity-40 text-on-surface-variant"><span class="material-symbols-outlined text-[42px] mb-2">archive</span><p class="text-sm font-semibold">Your archive is empty.</p></div>`;
            return;
        }
        container.innerHTML = generatePostHTML(data, currentUserProfile.id);
    } catch (e) {
        console.error(e);
        container.innerHTML = `<p class="text-sm text-center py-4 text-error">Failed to load archive.</p>`;
    }
};

// ========================================================
// SINGLE POST VIEWER ENGINE
// ========================================================
window.openSinglePostView = async function(postId) {
    const modal = document.getElementById('modal-single-post');
    const container = document.getElementById('single-post-container');
    const bottomNav = document.querySelector('nav');
    
    modal.classList.replace('hidden', 'flex');
    if (bottomNav) bottomNav.classList.add('hidden');
    setTimeout(() => modal.classList.remove('translate-x-full'), 10);
    
    container.innerHTML = FEED_SKELETON; 
    
   try {
        const { data: posts, error } = await supabase
            .from('posts')
            .select(`
                *,
                users ( id, full_name, profile_img_url, role, tick_type ),
                post_likes ( user_id ),
                post_comments ( id, content, created_at, is_deleted, parent_comment_id, users(id, full_name, profile_img_url, tick_type) ),
                post_polls (*),
                post_poll_votes ( user_id, option_id ),
                post_events (*),
                post_event_rsvps ( user_id, status ),
                saved_posts ( user_id )
            `)
            .eq('id', postId)
            .eq('is_deleted', false)
            .or('is_reported.eq.false,is_verified.eq.true')

        if (error) throw error;
        
        if (!posts || posts.length === 0) {
            container.innerHTML = `
                <div class="py-16 flex flex-col items-center justify-center opacity-40 text-on-surface-variant">
                    <span class="material-symbols-outlined text-[48px] mb-2">delete</span>
                    <p class="text-sm font-semibold">Post no longer available</p>
                </div>`;
            return;
        }
        
        container.innerHTML = generatePostHTML(posts, currentUserProfile.id);

    } catch (error) {
        console.error('Error fetching single post:', error);
        container.innerHTML = `<p class="text-sm text-center py-10 text-error">Failed to load post.</p>`;
    }
};

window.closeSinglePostView = function() {
    const modal = document.getElementById('modal-single-post');
    modal.classList.add('translate-x-full');
    
    const notifModal = document.getElementById('modal-notifications');
    if (notifModal && notifModal.classList.contains('hidden')) {
        const bottomNav = document.querySelector('nav');
        if (bottomNav) bottomNav.classList.remove('hidden');
    }
    
    setTimeout(() => modal.classList.replace('flex', 'hidden'), 300);
};

// ========================================================
// FEEDBACK & SUPPORT ENGINE
// ========================================================
let currentFeedbackBlob = null;

// Handle Image Preview
document.getElementById('feedback-image-upload')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const container = document.getElementById('feedback-image-preview-container');
    const reader = new FileReader();

    reader.onload = (event) => {
        currentFeedbackBlob = file;
        container.innerHTML = `
            <img src="${event.target.result}" class="w-full h-full object-cover rounded-xl">
            <button type="button" class="absolute top-2 right-2 bg-black/60 text-white rounded-full p-1 hover:bg-black/80 transition-colors z-10" onclick="event.stopPropagation(); document.getElementById('feedback-image-upload').value=''; currentFeedbackBlob=null; document.getElementById('feedback-image-preview-container').innerHTML='<span class=\\'material-symbols-outlined text-[28px] mb-1\\'>add_photo_alternate</span><span class=\\'text-xs font-medium\\'>Tap to upload image</span>';">
                <span class="material-symbols-outlined text-[18px]">close</span>
            </button>
        `;
    };
    reader.readAsDataURL(file);
});

// Submit Feedback
window.submitSupportFeedback = async function() {
    const type = document.getElementById('feedback-type').value;
    const description = document.getElementById('feedback-description').value.trim();
    const btn = document.getElementById('btn-submit-feedback');

    if (!description) return showToast('Please enter a description.', 'warning');

    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined animate-spin text-[24px]">progress_activity</span>`;

    try {
        let mediaUrl = null;

        // Upload to Cloudinary if image attached
        if (currentFeedbackBlob) {
            const compressedFile = typeof compressImage === 'function' ? await compressImage(currentFeedbackBlob, 1080, 0.7) : currentFeedbackBlob;
            const formData = new FormData();
            formData.append('file', compressedFile);
            formData.append('upload_preset', CLOUDINARY_AVATARS_PRESET); // Using existing preset

            const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, { method: 'POST', body: formData });
            const data = await res.json();
            if (data.error) throw new Error(data.error.message);
            mediaUrl = data.secure_url;
        }

        // Insert into Database
        const { error } = await supabase.from('user_feedbacks').insert({
            user_id: currentUserProfile.id,
            type: type,
            description: description,
            media_url: mediaUrl
        });

        if (error) throw error;

        showToast('Successfully submitted! Our team will review it.', 'success');
        
        // Reset Form
        document.getElementById('feedback-description').value = '';
        currentFeedbackBlob = null;
        document.getElementById('feedback-image-preview-container').innerHTML = `<span class="material-symbols-outlined text-[28px] mb-1">add_photo_alternate</span><span class="text-xs font-medium">Tap to upload image</span>`;
        window.closeSettingsSubPanel('settings-submit-feedback-panel');

    } catch (error) {
        console.error("Feedback error:", error);
        showToast('Failed to submit. Please try again.', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Submit';
    }
};

// Fetch Support History
window.fetchSupportHistory = async function() {
    const container = document.getElementById('support-history-container');
    container.innerHTML = `<div class="w-full flex justify-center py-8"><span class="material-symbols-outlined animate-spin text-primary text-[32px]">progress_activity</span></div>`;

    try {
        const { data, error } = await supabase
            .from('user_feedbacks')
            .select('*')
            .eq('user_id', currentUserProfile.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (data.length === 0) {
            container.innerHTML = `
                <div class="py-16 flex flex-col items-center justify-center opacity-40 text-on-surface-variant">
                    <span class="material-symbols-outlined text-[42px] mb-2">history</span>
                    <p class="text-sm font-semibold">No past support requests.</p>
                </div>`;
            return;
        }

        container.innerHTML = data.map(ticket => {
            let statusBadge = '';
            if (ticket.status === 'pending') statusBadge = `<span class="bg-yellow-500/10 text-yellow-600 dark:text-yellow-500 px-2 py-0.5 rounded text-[10px] font-extrabold uppercase">Pending</span>`;
            else if (ticket.status === 'in_progress') statusBadge = `<span class="bg-blue-500/10 text-blue-600 dark:text-blue-500 px-2 py-0.5 rounded text-[10px] font-extrabold uppercase">In Progress</span>`;
            else statusBadge = `<span class="bg-green-500/10 text-green-600 dark:text-green-500 px-2 py-0.5 rounded text-[10px] font-extrabold uppercase">Resolved</span>`;

            const imgHtml = ticket.media_url ? `<img src="${typeof optimizeImageUrl === 'function' ? optimizeImageUrl(ticket.media_url, 'feed') : ticket.media_url}" class="w-full h-32 object-cover rounded-xl mt-3 border border-surface-variant/40 dark:border-neutral-800">` : '';

            const replyHtml = ticket.admin_reply ? `
                <div class="mt-4 bg-primary/10 border border-primary/20 rounded-xl p-3 relative">
                    <div class="flex items-center gap-1.5 text-primary mb-1">
                        <span class="material-symbols-outlined text-[16px]">support_agent</span>
                        <span class="text-[12px] font-bold uppercase tracking-wider">Support Reply</span>
                    </div>
                    <p class="text-[13.5px] text-on-surface dark:text-gray-100 whitespace-pre-wrap">${ticket.admin_reply}</p>
                </div>
            ` : '';

            return `
                <div class="bg-surface-container-lowest dark:bg-neutral-900/40 border border-surface-variant/50 dark:border-neutral-800 p-4 rounded-2xl shadow-sm mb-4 animate-fadeIn">
                    <div class="flex justify-between items-start mb-2">
                        <div class="flex items-center gap-2">
                            <span class="material-symbols-outlined text-on-surface-variant text-[18px]">${ticket.type === 'issue' ? 'bug_report' : 'feedback'}</span>
                            <span class="text-[13px] font-bold text-on-surface dark:text-gray-200 capitalize">${ticket.type}</span>
                        </div>
                        ${statusBadge}
                    </div>
                    
                    <p class="text-[14px] text-on-surface-variant dark:text-gray-400 whitespace-pre-wrap">${ticket.description}</p>
                    
                    ${imgHtml}
                    ${replyHtml}
                    
                    <p class="text-[11px] font-medium text-on-surface-variant/60 dark:text-gray-500 mt-3 pt-3 border-t border-surface-variant/30 dark:border-neutral-800">
                        Submitted on ${new Date(ticket.created_at).toLocaleDateString()}
                    </p>
                </div>
            `;
        }).join('');

    } catch (err) {
        console.error(err);
        container.innerHTML = `<p class="text-sm text-center py-4 text-error">Failed to load history.</p>`;
    }
};
// Opens the native bottom sheet with your options
window.openReportReasonSelector = function() {
    const buttons = `
        <div class="px-4 py-3 border-b border-surface-variant/40 dark:border-neutral-800 text-center">
            <p class="text-xs font-bold text-on-surface-variant uppercase tracking-wider">Select Reason</p>
        </div>
        <button onclick="setReportReason('spam', 'Spam or Fake Account')" class="w-full flex items-center px-5 py-4 border-b border-surface-variant/40 dark:border-neutral-800 font-bold text-[15px] text-on-surface dark:text-gray-100 hover:bg-surface-variant/30 active:bg-surface-variant/50 transition-colors">Spam or Fake Account</button>
        <button onclick="setReportReason('harassment', 'Harassment or Bullying')" class="w-full flex items-center px-5 py-4 border-b border-surface-variant/40 dark:border-neutral-800 font-bold text-[15px] text-on-surface dark:text-gray-100 hover:bg-surface-variant/30 active:bg-surface-variant/50 transition-colors">Harassment or Bullying</button>
        <button onclick="setReportReason('inappropriate_content', 'Inappropriate Content')" class="w-full flex items-center px-5 py-4 font-bold text-[15px] text-on-surface dark:text-gray-100 hover:bg-surface-variant/30 active:bg-surface-variant/50 transition-colors">Inappropriate Content</button>
    `;
    window.openActionSheet(buttons); // Spawns the sheet
};

// Handles the selection, updates the UI, and closes the sheet
window.setReportReason = function(value, labelText) {
    // 1. Update the hidden input so submitPostReport() in feed.js can read it
    document.getElementById('report-post-reason').value = value;
    
    // 2. Update the UI text to look active/selected
    const label = document.getElementById('report-reason-label');
    label.textContent = labelText;
    label.classList.remove('text-on-surface-variant', 'dark:text-gray-400');
    label.classList.add('text-on-surface', 'dark:text-gray-100', 'font-medium');
    
    // 3. Close the bottom sheet
    window.closeActionSheet();
};
// Opens the native bottom sheet for Feedback Type
window.openFeedbackTypeSelector = function() {
    const buttons = `
        <div class="px-4 py-3 border-b border-surface-variant/40 dark:border-neutral-800 text-center">
            <p class="text-xs font-bold text-on-surface-variant uppercase tracking-wider">Feedback Type</p>
        </div>
        <button onclick="setFeedbackType('issue', 'Report an Issue')" class="w-full flex items-center gap-3 px-5 py-4 border-b border-surface-variant/40 dark:border-neutral-800 font-bold text-[15px] text-on-surface dark:text-gray-100 hover:bg-surface-variant/30 active:bg-surface-variant/50 transition-colors">
            <span class="material-symbols-outlined text-error">bug_report</span> Report an Issue
        </button>
        <button onclick="setFeedbackType('feedback', 'General Feedback')" class="w-full flex items-center gap-3 px-5 py-4 font-bold text-[15px] text-on-surface dark:text-gray-100 hover:bg-surface-variant/30 active:bg-surface-variant/50 transition-colors">
            <span class="material-symbols-outlined text-primary">feedback</span> General Feedback
        </button>
    `;
    window.openActionSheet(buttons);
};

// Handles the selection and updates the UI
window.setFeedbackType = function(value, labelText) {
    // Update hidden input for the database submission
    document.getElementById('feedback-type').value = value;
    
    // Update the visible label
    document.getElementById('feedback-type-label').textContent = labelText;
    
    // Close the Action Sheet
    window.closeActionSheet();
};
// ========================================================
// GLOBAL VERIFICATION ENGINE (Soft Restrict)
// ========================================================
window._lastVerificationToast = 0; // Global throttle tracker

// Read-only status for embedded same-origin mini-apps (e.g. the BAFs iframe
// blurs itself until this returns 'verified'). undefined = profile not loaded yet.
window.getVerificationStatus = function() {
    return currentUserProfile ? currentUserProfile.verification_status : undefined;
};

window.checkVerification = function(actionName = 'do this') {
    if (!currentUserProfile) return false;
    const status = currentUserProfile.verification_status;
    
    if (status === 'verified') return true;

    // 🚀 HOTFIX: Prevent double-toasts by throttling requests to 1 per second
    const now = Date.now();
    if (now - window._lastVerificationToast < 1000) return false; 
    window._lastVerificationToast = now;

    // Smart contextual messaging
    let msg = `You must verify your student ID to ${actionName}.`;
    if (status === 'pending') msg = `Your ID is under review. You can ${actionName} once approved.`;
    else if (status === 'rejected') msg = `Verification rejected. Please update your details to ${actionName}.`;

    import('./ui.js').then(({ showToast }) => showToast(msg, 'warning'));
    
    // 🚀 HOTFIX: Auto-open modal removed. Now it ONLY shows the toast message!
    
    return false;
};

function setupVerificationBanner(status) {
    const banner = document.getElementById('verification-banner');
    const title = document.getElementById('banner-title');
    const desc = document.getElementById('banner-desc');
    
    if (!banner) return;

    if (status === 'verified') {
        banner.classList.add('hidden');
        return;
    }

    banner.classList.remove('hidden');
    
    if (status === 'pending') {
        banner.className = "mx-4 mb-4 mt-2 bg-blue-500/10 border border-blue-500/30 rounded-2xl p-4 flex items-center justify-between cursor-pointer";
        title.className = "text-[14px] font-bold text-blue-600 dark:text-blue-500 leading-tight";
        title.textContent = "ID Under Review";
        desc.textContent = "We are currently verifying your credentials.";
        banner.querySelector('.material-symbols-outlined').textContent = "hourglass_empty";
        banner.querySelector('.material-symbols-outlined').classList.replace('text-orange-500', 'text-blue-500');
        banner.querySelector('.material-symbols-outlined:last-child').classList.replace('text-orange-500', 'text-blue-500');
    } else if (status === 'rejected') {
        banner.className = "mx-4 mb-4 mt-2 bg-error/10 border border-error/30 rounded-2xl p-4 flex items-center justify-between cursor-pointer";
        title.className = "text-[14px] font-bold text-error leading-tight";
        title.textContent = "Verification Rejected";
        desc.textContent = "Tap here to update your details.";
        banner.querySelector('.material-symbols-outlined').textContent = "error";
        banner.querySelector('.material-symbols-outlined').classList.replace('text-orange-500', 'text-error');
        banner.querySelector('.material-symbols-outlined:last-child').classList.replace('text-orange-500', 'text-error');
    }
}
// ========================================================
// PAGE SERVICES ENGINE (Native Cards & Capacitor Router)
// ========================================================

const SERVICE_ICONS = [
    'link', 'language', 'shopping_cart', 'storefront', 'calendar_month', 'event_available',
    'support_agent', 'forum', 'chat', 'description', 'assignment', 'school', 'menu_book',
    'groups', 'sports_esports', 'palette', 'code', 'movie', 'music_note', 'volunteer_activism',
    'article', 'confirmation_number', 'video_library', 'photo_library', 'work', 'gavel',
    'health_and_safety', 'fitness_center', 'restaurant', 'local_cafe', 'flight', 'hotel',
    'account_balance', 'campaign', 'podcasts', 'headset', 'mic', 'camera_alt', 'videocam',
    'local_offer', 'payments', 'qr_code_scanner', 'star', 'emoji_events'
];

// --- 1. Capacitor Native Link Router ---
window.openServiceLink = async function(url, openInApp, title, opts) {
    if (!url) return;
    
    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }

    // PDFs always get the dedicated full-screen in-app viewer (pdf-viewer.js)
    // — never Custom Tabs, never a plain window.open — from every place a
    // link can be opened: services, chat message links, event "View Link"
    // buttons. That viewer fetches bytes and renders on <canvas>, so the
    // WebView is never asked to navigate to the PDF URL itself (the same
    // fix already applied to BAFs study material, now reachable from
    // anywhere in the app). This ignores the open_in_app setting on
    // purpose — a raw document should never be handed to an external
    // browser/Custom Tab that could offer to download it.
    try {
        const pathname = new URL(url).pathname;
        if (/\.pdf$/i.test(pathname)) {
            if (window.openPdfViewer) { window.openPdfViewer(url, title); return; }
        }
    } catch (e) { /* not a parseable URL — fall through to normal handling below */ }

    // Append the current user's details as query params before opening —
    // student_id is offset by +5489 (e.g. student_id "1" -> 5490), matching
    // the scheme the linked mini-apps expect. Centralized here so EVERY
    // service link (featured or regular) carries it, not just featured ones.
    // opts.plain === true skips this (public pages such as Help / Privacy /
    // Terms don't need the user's identity in the URL).
    if (!(opts && opts.plain)) try {
        const parsed = new URL(url);
        const numericId = parseInt(currentUserProfile?.student_id, 10);
        if (!isNaN(numericId)) parsed.searchParams.set('student_id', String(numericId + 5489));
        if (currentUserProfile?.full_name) parsed.searchParams.set('name', currentUserProfile.full_name);
        parsed.searchParams.set('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
        url = parsed.toString();
    } catch (e) {
        console.error('Error appending service link params:', e); // fall back to the raw url
    }

    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        // Native app, "open in app": a real native WebView (@capgo/inappbrowser),
        // NOT Chrome Custom Tabs. Custom Tabs is Chrome itself — it shows the
        // address bar / domain and has "Open in Chrome" + "Copy link" in its
        // menu, which is exactly what "internal" links are meant to avoid.
        // The native WebView dialog has only our toolbar (close button) and
        // no URL. If the plugin is missing (old build) or fails, fall back to
        // the in-page iframe viewer — never out to Chrome — because the
        // developer asked for this link to stay inside the app.
        if (openInApp) {
            const opened = await openInNativeWebView(url, title);
            if (!opened) window.openInAppWebview(url);
            return;
        }
        // "External" needs to mean the real system browser, on ANY domain —
        // not whatever Capacitor's allowNavigation happens to decide for
        // that host today. window.open(url, '_system') used to be the only
        // path here, but it rides on that same domain-whitelist logic, so
        // it's not a reliable explicit choice. AndroidLinkHandler.openExternal
        // (native bridge, added in MainActivity.java) always launches a real
        // ACTION_VIEW intent regardless of domain; fall back to the old
        // behavior only if an older app build doesn't have the bridge yet.
        if (window.AndroidLinkHandler && window.AndroidLinkHandler.openExternal) {
            window.AndroidLinkHandler.openExternal(url);
        } else {
            window.open(url, '_system');
        }
        return;
    }

    // Web/PWA: open inside our own in-app webview instead of leaving to a
    // new browser tab — that's what "openInApp" should actually mean here.
    if (openInApp) {
        window.openInAppWebview(url);
    } else {
        window.open(url, '_blank');
    }
};


// --- Native in-app WebView (no address bar, no "open in Chrome") ---
async function openInNativeWebView(url, title) {
    try {
        const IAB = window.Capacitor.Plugins && window.Capacitor.Plugins.InAppBrowser;
        if (!IAB || typeof IAB.openWebView !== 'function') {
            throw new Error('InAppBrowser plugin not registered on native bridge');
        }
        const dark = document.documentElement.classList.contains('dark');
        await IAB.openWebView({
            url: url,
            title: title || 'ECampus',
            // Toolbar: close button + (optional) title only. visibleTitle:false
            // stops the toolbar from echoing the page title/host, and no
            // share/navigation toolbar type is used (those expose the URL).
            visibleTitle: false,
            showReloadButton: false,
            toolbarColor: dark ? '#121212' : '#f8f9fa',
            toolbarTextColor: dark ? '#ffffff' : '#111111',
            backgroundColor: dark ? 'black' : 'white',
            // targetSdk 36 is edge-to-edge: keep the toolbar below the status bar.
            useTopInset: true,
            // Android back button goes back inside the page first, then closes.
            activeNativeNavigationForWebview: true,
            materialPicker: true
        });
        return true;
    } catch (e) {
        console.error('Native in-app WebView failed, using iframe fallback', e);
        return false;
    }
}

// ==========================================
// IN-APP WEBVIEW (web/PWA in-app browser)
// ==========================================
let inAppBrowserUrl = '';
let inAppBrowserLoadTimer = null;

window.openInAppWebview = function (url) {
    const modal = document.getElementById('modal-in-app-browser');
    const frame = document.getElementById('in-app-browser-frame');
    const loading = document.getElementById('in-app-browser-loading');
    const fallback = document.getElementById('in-app-browser-fallback');
    if (!modal || !frame) return;

    inAppBrowserUrl = url;

    loading?.classList.remove('hidden');
    fallback?.classList.add('hidden');
    fallback?.classList.remove('flex');

    frame.onload = () => {
        clearTimeout(inAppBrowserLoadTimer);
        loading?.classList.add('hidden');
        fallback?.classList.add('hidden');
        fallback?.classList.remove('flex');
    };
    frame.src = url;

    modal.classList.replace('hidden', 'flex');
    setTimeout(() => modal.classList.remove('translate-x-full'), 10);

    // Some sites block embedding entirely (X-Frame-Options / CSP
    // frame-ancestors) — the browser can't tell our page when that
    // happens (cross-origin), so this is a best-effort timeout: if
    // nothing loaded within 8s, offer the "try again" fallback instead
    // of leaving a spinner running forever.
    clearTimeout(inAppBrowserLoadTimer);
    inAppBrowserLoadTimer = setTimeout(() => {
        loading?.classList.add('hidden');
        fallback?.classList.remove('hidden');
        fallback?.classList.add('flex');
    }, 8000);
};

window.closeInAppBrowser = function () {
    const modal = document.getElementById('modal-in-app-browser');
    const frame = document.getElementById('in-app-browser-frame');
    if (!modal) return;
    modal.classList.add('translate-x-full');
    clearTimeout(inAppBrowserLoadTimer);
    setTimeout(() => {
        modal.classList.replace('flex', 'hidden');
        if (frame) frame.src = 'about:blank'; // stop any audio/video playing behind the scenes
    }, 300);
};

window.reloadInAppBrowser = function () {
    const frame = document.getElementById('in-app-browser-frame');
    const loading = document.getElementById('in-app-browser-loading');
    const fallback = document.getElementById('in-app-browser-fallback');
    if (!frame || !inAppBrowserUrl) return;
    loading?.classList.remove('hidden');
    fallback?.classList.add('hidden');
    fallback?.classList.remove('flex');
    frame.src = inAppBrowserUrl;
    clearTimeout(inAppBrowserLoadTimer);
    inAppBrowserLoadTimer = setTimeout(() => {
        loading?.classList.add('hidden');
        fallback?.classList.remove('hidden');
        fallback?.classList.add('flex');
    }, 8000);
};

// --- 2. Fetch & Render Engine ---
window.fetchPageServices = async function(userId, isMyProfile = false) {
    const wrapperId = isMyProfile ? 'my-profile-services-wrapper' : 'public-profile-services-wrapper';
    const containerId = isMyProfile ? 'my-profile-services-container' : 'public-profile-services-container';
    
    const wrapper = document.getElementById(wrapperId);
    const container = document.getElementById(containerId);
    if (!wrapper || !container) return;

    try {
        const { data, error } = await supabase
            .from('page_services')
            .select('*')
            .eq('page_id', userId)
            .eq('is_active', true)
            .order('order_index', { ascending: true })
            .order('created_at', { ascending: false });

        if (error) throw error;

        // If no services and not owner, hide entirely
        if (data.length === 0 && !isMyProfile) {
            wrapper.classList.add('hidden');
            return;
        }

        wrapper.classList.remove('hidden');
        
        // Setup "View All" Button
        const viewAllBtnId = isMyProfile ? 'my-services-view-all' : 'public-services-view-all';
        const viewAllBtn = document.getElementById(viewAllBtnId);
        if (viewAllBtn) {
            if (data.length > 0) {
                viewAllBtn.classList.remove('hidden');
                const userName = isMyProfile ? 'My' : document.getElementById('public-profile-name').textContent.replace(/(<([^>]+)>)/gi, "").trim();
                viewAllBtn.onclick = () => window.openAllServicesModal(userId, isMyProfile, userName);
            } else {
                viewAllBtn.classList.add('hidden');
            }
        }

        let html = '';

        // Add 'Add Link' button for owners
        if (isMyProfile) {
            html += `
            <div onclick="window.openManageServiceModal()" class="w-[75vw] sm:w-[280px] min-h-[150px] rounded-[24px] border-2 border-dashed border-surface-variant dark:border-neutral-700 bg-transparent flex flex-col items-center justify-center p-4 shrink-0 snap-start cursor-pointer active:scale-[0.98] transition-all hover:border-primary/50 group">
                <div class="w-12 h-12 rounded-full bg-surface-variant/30 dark:bg-neutral-800 text-on-surface dark:text-gray-300 flex items-center justify-center mb-3 group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                    <span class="material-symbols-outlined text-[24px]">add</span>
                </div>
                <p class="text-[14px] font-extrabold text-on-surface-variant dark:text-gray-400 group-hover:text-primary transition-colors text-center">Add New Service</p>
            </div>
            `;
        }

        // Render actual service cards
        data.forEach(service => {
            const clickAction = isMyProfile 
                ? `window.openManageServiceModal('${service.id}', '${service.title.replace(/'/g, "\\'")}', '${(service.description || '').replace(/'/g, "\\'")}', '${service.url}', '${service.icon_name}', ${service.open_in_app})`
                : `window.openServiceLink('${service.url}', ${service.open_in_app}, '${service.title.replace(/'/g, "\\'")}')`;

            html += `
            <div onclick="${clickAction}" class="w-[75vw] sm:w-[280px] min-h-[150px] rounded-[24px] border border-surface-variant/60 dark:border-neutral-800 bg-surface dark:bg-neutral-900 flex flex-col p-4 shrink-0 snap-start cursor-pointer active:scale-[0.98] transition-all shadow-sm hover:shadow-md hover:border-primary/40 group text-left relative overflow-hidden">
                <div class="w-11 h-11 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-3">
                    <span class="material-symbols-outlined text-[22px]">${service.icon_name}</span>
                </div>
                <div class="flex flex-col flex-1 mb-4">
                    <p class="text-[15px] font-extrabold text-on-surface dark:text-gray-100 leading-snug line-clamp-1 mb-1">${service.title}</p>
                    ${service.description ? `<p class="text-[12px] font-medium text-on-surface-variant dark:text-gray-500 line-clamp-2 leading-snug">${service.description}</p>` : ''}
                </div>
                <div class="mt-auto pt-3 border-t border-surface-variant/40 dark:border-neutral-800 w-full flex items-center justify-between text-[11px] font-extrabold ${isMyProfile ? 'text-on-surface-variant dark:text-gray-400' : 'text-primary'} uppercase tracking-wider">
                    <span>${isMyProfile ? 'Edit Service' : 'Open Link'}</span>
                    <span class="material-symbols-outlined text-[14px] transition-transform ${isMyProfile ? '' : 'group-hover:translate-x-1'}">${isMyProfile ? 'edit' : 'arrow_forward'}</span>
                </div>
            </div>
            `;
        });

        container.innerHTML = html;

    } catch (err) {
        console.error("Error fetching services:", err);
    }
};

// --- 3. Modal Controls ---
window.openManageServiceModal = function(id = '', title = '', desc = '', url = '', icon = 'link', openInApp = true) {
    const modal = document.getElementById('modal-manage-service');
    const card = document.getElementById('manage-service-card');
    
    document.getElementById('manage-service-title').textContent = id ? 'Edit Service' : 'Add Service';
    document.getElementById('service-edit-id').value = id;
    document.getElementById('service-title-input').value = title;
    document.getElementById('service-desc-input').value = desc; // 🚀 Set Description
    document.getElementById('service-url-input').value = url;
    document.getElementById('service-icon-value').value = icon;
    document.getElementById('service-selected-icon').textContent = icon;
    document.getElementById('service-inapp-toggle').checked = openInApp;
    
    const deleteBtn = document.getElementById('service-delete-btn');
    if (id) deleteBtn.classList.remove('hidden');
    else deleteBtn.classList.add('hidden');

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.pointerEvents = 'auto';
    
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        card.style.transform = ''; 
        card.classList.remove('translate-y-full');
    }, 10);
};

window.closeManageServiceModal = function() {
    const modal = document.getElementById('modal-manage-service');
    const card = document.getElementById('manage-service-card');
    
    modal.style.pointerEvents = 'none';
    modal.classList.add('opacity-0');
    card.style.transform = ''; 
    card.classList.add('translate-y-full');
    
    setTimeout(() => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }, 300);
};

// --- 4. Database Mutations ---
window.saveService = async function() {
    const btn = document.getElementById('service-save-btn');
    const id = document.getElementById('service-edit-id').value;
    const title = document.getElementById('service-title-input').value.trim();
    const desc = document.getElementById('service-desc-input').value.trim(); // 🚀 Get Description
    const url = document.getElementById('service-url-input').value.trim();
    const icon = document.getElementById('service-icon-value').value;
    const openInApp = document.getElementById('service-inapp-toggle').checked;

    if (!title || !url) return import('./ui.js').then(({ showToast }) => showToast('Title and URL are required.', 'warning'));

    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined animate-spin">progress_activity</span>`;

    try {
        const payload = { page_id: currentUserProfile.id, title, description: desc, url, icon_name: icon, open_in_app: openInApp };

        if (id) {
            const { error } = await supabase.from('page_services').update(payload).eq('id', id);
            if (error) throw error;
            import('./ui.js').then(({ showToast }) => showToast('Service updated.', 'success'));
        } else {
            const { error } = await supabase.from('page_services').insert(payload);
            if (error) throw error;
            import('./ui.js').then(({ showToast }) => showToast('Service added!', 'success'));
        }

        closeManageServiceModal();
        fetchPageServices(currentUserProfile.id, true);

    } catch (error) {
        console.error(error);
        import('./ui.js').then(({ showToast }) => showToast('Failed to save service.', 'error'));
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save Service';
    }
};
window.deleteService = async function() {
    const id = document.getElementById('service-edit-id').value;
    if (!id) return;

    if (!confirm("Remove this link?")) return;

    try {
        const { error } = await supabase.from('page_services').delete().eq('id', id);
        if (error) throw error;
        import('./ui.js').then(({ showToast }) => showToast('Link removed.', 'success'));
        
        closeManageServiceModal();
        fetchPageServices(currentUserProfile.id, true);
    } catch (e) {
        import('./ui.js').then(({ showToast }) => showToast('Failed to delete.', 'error'));
    }
};

// --- 5. Icon Picker Controls ---
window.openServiceIconPicker = function() {
    const modal = document.getElementById('modal-service-icon-picker');
    const card = document.getElementById('service-icon-picker-card');
    const grid = document.getElementById('service-icon-grid');

    grid.innerHTML = SERVICE_ICONS.map(icon => `
        <div onclick="window.selectServiceIcon('${icon}')" class="aspect-square rounded-2xl bg-surface-variant/20 hover:bg-primary/20 hover:text-primary dark:bg-neutral-800 flex items-center justify-center cursor-pointer active:scale-90 transition-all text-on-surface dark:text-gray-200 border border-transparent hover:border-primary/30">
            <span class="material-symbols-outlined text-[28px]">${icon}</span>
        </div>
    `).join('');

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.pointerEvents = 'auto';
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        card.classList.remove('translate-y-full');
    }, 10);
};

window.closeServiceIconPicker = function() {
    const modal = document.getElementById('modal-service-icon-picker');
    const card = document.getElementById('service-icon-picker-card');
    
    modal.style.pointerEvents = 'none';
    modal.classList.add('opacity-0');
    card.classList.add('translate-y-full');
    
    setTimeout(() => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }, 300);
};

window.selectServiceIcon = function(iconName) {
    document.getElementById('service-selected-icon').textContent = iconName;
    document.getElementById('service-icon-value').value = iconName;
    closeServiceIconPicker();
};
window.toggleQuizMode = function(isChecked) {
    const container = document.getElementById('quiz-settings-container');
    if (isChecked) container.classList.remove('hidden');
    else container.classList.add('hidden');
};
// ==========================================
// CUSTOM VOTERS LIST ENGINE
// ==========================================
let currentCustomList = [];

window.fetchCustomList = async function() {
    const container = document.getElementById('custom-list-container');
    if (!container || !currentUserProfile) return;
    
    container.innerHTML = `<p class="text-sm italic text-center py-4 text-on-surface-variant">Loading list...</p>`;
    
    try {
        const { data, error } = await supabase.from('users').select('custom_voters_list').eq('id', currentUserProfile.id).single();
        if (error) throw error;
        
        currentCustomList = data.custom_voters_list || [];
        
        if (currentCustomList.length === 0) {
            container.innerHTML = `<p class="text-sm italic text-center py-4 text-on-surface-variant">Your list is empty.</p>`;
            return;
        }

        const { data: users, error: userErr } = await supabase.from('users').select('id, full_name, profile_img_url').in('id', currentCustomList);
        if (userErr) throw userErr;

        container.innerHTML = users.map(u => `
            <div class="flex items-center justify-between p-3 bg-surface-variant/10 dark:bg-neutral-800 rounded-xl">
                <div class="flex items-center gap-3">
                    <img src="${u.profile_img_url}" class="w-8 h-8 rounded-full object-cover">
                    <span class="text-[13px] font-bold text-on-surface dark:text-gray-100">${u.full_name}</span>
                </div>
                <button onclick="window.removeFromCustomList('${u.id}')" class="text-error hover:bg-error/10 p-1.5 rounded-lg active:scale-90 transition-colors">
                    <span class="material-symbols-outlined text-[18px]">person_remove</span>
                </button>
            </div>
        `).join('');

    } catch (e) {
        container.innerHTML = `<p class="text-sm text-center py-4 text-error">Failed to load list.</p>`;
    }
};

window.searchUsersForCustomList = async function(query) {
    const resultsContainer = document.getElementById('custom-list-search-results');
    if (!query || query.trim() === '') {
        resultsContainer.classList.add('hidden');
        return;
    }

    try {
        const { data, error } = await supabase.from('users').select('id, full_name, profile_img_url')
            .ilike('full_name', `%${query.trim()}%`)
            .neq('id', currentUserProfile.id)
            .limit(5);

        if (error || !data.length) {
            resultsContainer.classList.add('hidden');
            return;
        }

        resultsContainer.innerHTML = data.map(u => {
            const isAdded = currentCustomList.includes(u.id);
            return `
            <div onclick="window.${isAdded ? 'removeFromCustomList' : 'addToCustomList'}('${u.id}')" class="flex items-center justify-between p-3 hover:bg-surface-variant/30 cursor-pointer transition-colors">
                <div class="flex items-center gap-3">
                    <img src="${u.profile_img_url}" class="w-8 h-8 rounded-full object-cover">
                    <span class="text-[13px] font-bold text-on-surface dark:text-gray-100">${u.full_name}</span>
                </div>
                <span class="material-symbols-outlined text-[18px] ${isAdded ? 'text-error' : 'text-primary'}">
                    ${isAdded ? 'person_remove' : 'person_add'}
                </span>
            </div>
        `}).join('');
        resultsContainer.classList.remove('hidden');
    } catch(e) {}
};

window.addToCustomList = async function(userId) {
    if (currentCustomList.includes(userId)) return;
    currentCustomList.push(userId);
    
    document.getElementById('custom-list-search').value = '';
    document.getElementById('custom-list-search-results').classList.add('hidden');
    
    const { error } = await supabase.from('users').update({ custom_voters_list: currentCustomList }).eq('id', currentUserProfile.id);
    if (!error) window.fetchCustomList();
};

window.removeFromCustomList = async function(userId) {
    currentCustomList = currentCustomList.filter(id => id !== userId);
    const { error } = await supabase.from('users').update({ custom_voters_list: currentCustomList }).eq('id', currentUserProfile.id);
    if (!error) window.fetchCustomList();
};

// Wire up the new Panel open event
const originalOpenSettingsSubPanel = window.openSettingsSubPanel;
window.openSettingsSubPanel = function(panelId) {
    if (panelId === 'settings-custom-list-panel') {
        window.fetchCustomList();
    }
    if (originalOpenSettingsSubPanel) originalOpenSettingsSubPanel(panelId);
};

// --- All Services Modal & Search Logic ---
let currentViewedServices = [];

window.openAllServicesModal = async function(userId, isMyProfile, userName) {
    const modal = document.getElementById('modal-view-services');
    const title = document.getElementById('view-services-title');
    const list = document.getElementById('view-services-list');
    const searchInput = document.getElementById('view-services-search');

    modal.classList.replace('hidden', 'flex');
    setTimeout(() => modal.classList.remove('translate-x-full'), 10);

    title.textContent = isMyProfile ? 'My Services' : `${userName}'s Services`;
    searchInput.value = '';
    list.innerHTML = LIST_SKELETON; // Show loading shimmer
    currentViewedServices = [];

    try {
        const { data, error } = await supabase
            .from('page_services')
            .select('*')
            .eq('page_id', userId)
            .eq('is_active', true)
            .order('order_index', { ascending: true })
            .order('created_at', { ascending: false });

        if (error) throw error;

        currentViewedServices = data;
        renderViewServicesList(data, isMyProfile);

        // LIVE SEARCH FILTER
        searchInput.oninput = (e) => {
            const q = e.target.value.toLowerCase().trim();
            const filtered = currentViewedServices.filter(s => 
                s.title.toLowerCase().includes(q) || 
                (s.description && s.description.toLowerCase().includes(q))
            );
            renderViewServicesList(filtered, isMyProfile, q !== '');
        };

    } catch (error) {
        console.error('Error fetching services list:', error);
        list.innerHTML = `<p class="text-sm italic text-center py-8 text-error">Failed to load services.</p>`;
    }
};

window.closeAllServicesModal = function() {
    const modal = document.getElementById('modal-view-services');
    modal.classList.add('translate-x-full');
    setTimeout(() => modal.classList.replace('flex', 'hidden'), 300);
};

function renderViewServicesList(services, isMyProfile, isSearch = false) {
    const list = document.getElementById('view-services-list');

    if (services.length === 0) {
        list.innerHTML = `<div class="py-16 flex flex-col items-center justify-center opacity-40 text-on-surface-variant"><span class="material-symbols-outlined text-[42px] mb-2">search_off</span><p class="text-sm font-semibold">${isSearch ? 'No services found.' : 'No services available.'}</p></div>`;
        return;
    }

    list.innerHTML = services.map(service => {
        const clickAction = isMyProfile 
            ? `window.openManageServiceModal('${service.id}', '${service.title.replace(/'/g, "\\'")}', '${(service.description || '').replace(/'/g, "\\'")}', '${service.url}', '${service.icon_name}', ${service.open_in_app})`
            : `window.openServiceLink('${service.url}', ${service.open_in_app}, '${service.title.replace(/'/g, "\\'")}')`;

        return `
        <div onclick="${clickAction}" class="flex items-center gap-4 p-4 bg-surface-container-lowest dark:bg-neutral-900/50 rounded-2xl border border-surface-variant/40 dark:border-neutral-800 shadow-sm cursor-pointer hover:bg-surface-variant/20 transition-colors group">
            <div class="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 border border-primary/20">
                <span class="material-symbols-outlined text-[24px]">${service.icon_name}</span>
            </div>
            <div class="flex-1 min-w-0">
                <p class="font-extrabold text-[15px] text-on-surface dark:text-gray-100 truncate">${service.title}</p>
                ${service.description ? `<p class="text-[12px] font-medium text-on-surface-variant dark:text-gray-500 mt-0.5 truncate">${service.description}</p>` : ''}
            </div>
            <button class="w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant group-hover:text-primary transition-colors shrink-0">
                <span class="material-symbols-outlined text-[20px]">${isMyProfile ? 'edit' : 'arrow_forward'}</span>
            </button>
        </div>
        `;
    }).join('');
}

// ==========================================
// NETWORK & CACHE MANAGEMENT
// ==========================================

// Handle network status changes
window.addEventListener('online', () => {
    console.log('App online - syncing offline data');
    showToast('Back online! Syncing data...', 'info');
    
    // Trigger offline queue sync
    if (typeof window.processOfflineQueue === 'function') {
        setTimeout(window.processOfflineQueue, 1000);
    }
    
    // Refresh current view
    if (typeof window.refreshCurrentView === 'function') {
        window.refreshCurrentView();
    }
});

window.addEventListener('offline', () => {
    console.log('App offline');
    showToast('You are offline. Changes will sync when online.', 'warning');
});

// Context-aware refresh based on active tab
window.refreshCurrentView = async function() {
    try {
        const activeTab = document.querySelector('[data-tab].active');
        if (!activeTab) return;

        const tabName = activeTab.dataset.tab;

        if (tabName === 'feed' && typeof window.refreshMainFeed === 'function') {
            await window.refreshMainFeed();
        } else if (tabName === 'hotposts' && typeof window.refreshHotposts === 'function') {
            await window.refreshHotposts();
        } else if (tabName === 'messages' && typeof window.fetchInbox === 'function') {
            await window.fetchInbox();
        } else if (tabName === 'notifications' && typeof window.fetchNotifications === 'function') {
            await window.fetchNotifications();
        }
    } catch (err) {
        console.error("Refresh current view error:", err);
    }
};

// Periodic cache cleanup every 30 minutes
setInterval(() => {
    try {
        console.debug('Running periodic cache cleanup...');
        if (typeof window.cleanupCache === 'function') {
            window.cleanupCache();
        }
    } catch (e) {
        console.debug("Cache cleanup error:", e);
    }
}, 30 * 60 * 1000);

// Add cache invalidation on user connection changes
window.onConnectionAdded = async function(userId) {
    try {
        if (typeof onConnectionChanged === 'function') {
            await onConnectionChanged(userId);
        }
    } catch (e) {
        console.error("Error invalidating connection cache:", e);
    }
};

window.onConnectionBlocked = async function(userId) {
    try {
        if (typeof onBlockChanged === 'function') {
            await onBlockChanged(userId);
        }
    } catch (e) {
        console.error("Error invalidating block cache:", e);
    }
};
