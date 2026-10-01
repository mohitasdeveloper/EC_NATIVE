import { supabase } from './supabase.js';
import { getUserSuggestions, getTopConnectedUsers } from './data-layer.js';
import { showToast } from './ui.js';
import { flushStudyTime, formatStudyDuration } from './study-time.js';
let currentUser = null;
let searchTimeout = null;
let currentSearchTab = 'all';
let currentDiscoverTab = 'popular';
let bafsModule = null; // bafs.js, imported the first time the BAFs App pill is used

const LIST_SKELETON = `
    <div class="flex items-start gap-4 py-3 animate-pulse">
        <div class="w-[52px] h-[52px] rounded-full shimmer-bg shrink-0"></div>
        <div class="flex-1 mt-1">
            <div class="h-4 shimmer-bg rounded-md w-1/2 mb-2"></div>
            <div class="h-3 shimmer-bg rounded-md w-3/4 mb-2"></div>
            <div class="h-2.5 shimmer-bg rounded-md w-1/3 mt-3"></div>
        </div>
    </div>
`.repeat(4);



export function initSearch(user) {
    currentUser = user;
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('clear-search-btn');
    const tabsContainer = document.getElementById('search-tabs-container');
    
    // Live Debounced Search Listener
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            clearTimeout(searchTimeout);
            
            // Toggle Clear Button Visibility
            if (clearBtn) {
                if (query.length > 0) clearBtn.classList.remove('hidden');
                else clearBtn.classList.add('hidden');
            }

            if (query.length === 0) {
                tabsContainer.classList.add('hidden');
                document.getElementById('search-results-container').classList.add('hidden');
                document.getElementById('explore-users-container').classList.remove('hidden');
            } else {
                document.getElementById('explore-users-container').classList.add('hidden');
                tabsContainer.classList.remove('hidden');
                
                const resultsContainer = document.getElementById('search-results-container');
                resultsContainer.classList.remove('hidden');
                resultsContainer.innerHTML = LIST_SKELETON;
                
                searchTimeout = setTimeout(() => {
                    performSearch(query);
                }, 300);
            }
        });
    }

    // Clear Button Click Handler
    if (clearBtn && searchInput) {
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            clearBtn.classList.add('hidden');
            clearTimeout(searchTimeout);
            
            tabsContainer.classList.add('hidden');
            document.getElementById('search-results-container').classList.add('hidden');
            document.getElementById('explore-users-container').classList.remove('hidden');
            
            searchInput.focus(); // Keep keyboard open
        });
    }

    // Tabs Listener
    if (tabsContainer) {
        tabsContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.search-tab-btn');
            if (!btn) return;

            // Reset all tabs to inactive styles
            document.querySelectorAll('.search-tab-btn').forEach(b => {
                b.classList.remove('bg-on-surface', 'text-surface', 'dark:bg-white', 'dark:text-black');
                b.classList.add('bg-surface-variant/30', 'text-on-surface-variant', 'dark:bg-neutral-800', 'dark:text-gray-300');
            });
            
            // Apply active styles to clicked tab
            btn.classList.remove('bg-surface-variant/30', 'text-on-surface-variant', 'dark:bg-neutral-800', 'dark:text-gray-300');
            btn.classList.add('bg-on-surface', 'text-surface', 'dark:bg-white', 'dark:text-black');

            currentSearchTab = btn.dataset.tab;

            const query = searchInput.value.trim();
            if (query.length > 0) {
                document.getElementById('search-results-container').innerHTML = LIST_SKELETON;
                performSearch(query);
            }
        });
    }
    
    bindLeaderboardHandlers();

    // Default to the BAFs App pill specifically for that course's students —
    // everyone else still defaults to Popular. Exact match on the course
    // string as given; this is a temporary, exam-season pill (see
    // loadDiscoverList's 'bafs' branch) pointing at a separate Supabase
    // project, not something to leave wired up indefinitely.
    if (currentUser.course === 'TY B.Com (Accounting & Finance)') {
        window.setDiscoverTab('bafs');
    } else {
        loadDiscoverList('popular');
    }
}

// 🚀 The Search/Discover tab's empty-query view used to show a Featured
// Services grid — replaced with two pill-switchable lists: Popular (top
// connection counts, default) and Suggested (reuses getUserSuggestions, the
// same data source as the feed's own "suggested for you" widget).
window.setDiscoverTab = function (tab) {
    if (tab === currentDiscoverTab) return;
    currentDiscoverTab = tab;
    document.querySelectorAll('.discover-tab-btn').forEach(btn => {
        const active = btn.dataset.discoverTab === tab;
        btn.classList.toggle('bg-on-surface', active);
        btn.classList.toggle('text-surface', active);
        btn.classList.toggle('dark:bg-white', active);
        btn.classList.toggle('dark:text-black', active);
        btn.classList.toggle('bg-surface-variant/30', !active);
        btn.classList.toggle('text-on-surface-variant', !active);
        btn.classList.toggle('dark:bg-neutral-800', !active);
        btn.classList.toggle('dark:text-gray-300', !active);
    });
    loadDiscoverList(tab);
};

async function loadDiscoverList(tab) {
    const container = document.getElementById('discover-list-container');
    if (!container || !currentUser) return;

    // Any other pill: tear the BAFs App down first (stops its timers, releases its
    // back-button hook) — it is rebuilt from its local data cache next time it's opened.
    if (tab !== 'bafs' && bafsModule) bafsModule.unmountBafs();

    // BAFs App: the exam-season study planner (its own Supabase project, own UI). It used to
    // be an <iframe>; it is now mounted straight into this container by bafs.js — same page,
    // so it scrolls with the tab, the PDF viewer / verification gate / back button are plain
    // function calls, and it paints instantly from a local data cache on re-open. bafs.js is
    // loaded on demand, so it costs nothing at launch for anyone who never taps the pill.
    // Remove the pill (index.html), this branch, bafs.js and bafs.css together once exam
    // season is over.
    if (tab === 'bafs') {
        container.innerHTML = `<div class="space-y-3 animate-pulse py-2"><div class="h-28 shimmer-bg rounded-2xl"></div><div class="h-16 shimmer-bg rounded-2xl"></div><div class="h-16 shimmer-bg rounded-2xl"></div></div>`;
        try {
            bafsModule = bafsModule || await import('./bafs.js');
            if (currentDiscoverTab !== 'bafs') return; // pill changed while the module loaded
            await bafsModule.mountBafs(container);
        } catch (e) {
            console.error('Error loading BAFs App:', e);
            if (currentDiscoverTab === 'bafs') container.innerHTML = `<p class="text-sm text-center py-8 text-error">Failed to load.</p>`;
        }
        return;
    }

    // Leaderboard: study time from the in-app PDF viewer (see the section below).
    if (tab === 'leaderboard') {
        loadLeaderboard({ shell: true });
        return;
    }

    container.innerHTML = LIST_SKELETON;
    try {
        const users = tab === 'popular'
            ? await getTopConnectedUsers(currentUser.id, 15)
            : await getUserSuggestions(currentUser.id, 12);

        // The person tapped another pill (BAFs App / Leaderboard…) while this
        // was loading — don't paint over whatever they switched to.
        if (currentDiscoverTab !== tab) return;

        if (!users || users.length === 0) {
            container.innerHTML = `<p class="text-sm italic text-center py-8 text-on-surface-variant dark:text-gray-400">${tab === 'popular' ? 'No one to show yet.' : 'No suggestions right now.'}</p>`;
            return;
        }
        container.innerHTML = renderUserList(users);
    } catch (e) {
        console.error(`Error loading Discover (${tab}):`, e);
        if (currentDiscoverTab !== tab) return;
        container.innerHTML = `<p class="text-sm text-center py-8 text-error">Failed to load.</p>`;
    }
}

// ============================================================
// LEADERBOARD pill — study time from the in-app PDF viewer
// ============================================================
// The time itself is recorded by study-time.js. Ranking, the per-period
// "hide my name" switches and blocked-user masking are all decided in Postgres
// (study_leaderboard() in supabase/study_time.sql). This code only draws what
// comes back: a hidden entry arrives with NO id, name or photo, so there is
// nothing in the client to leak or to un-hide.
const LB_LIMIT = 50;
const LB_PERIODS = [
    { key: 'daily',   label: 'Daily',    when: 'today' },
    { key: 'weekly',  label: 'Weekly',   when: 'this week' },
    { key: 'alltime', label: 'All-time', when: 'all-time' },
];
let currentLbPeriod = 'daily';
let latestLbToken = 0; // a slow response for a period/pill the person has left must not paint over the current one
let lbHandlersBound = false;

function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function lbIsMissingSql(err) {
    return err?.code === 'PGRST202' || err?.code === '42883' || /could not find the function/i.test(String(err?.message || ''));
}

// One delegated listener pair on the (persistent) list container, so the
// markup below stays plain strings with data-* hooks — no inline handlers.
function bindLeaderboardHandlers() {
    const container = document.getElementById('discover-list-container');
    if (!container || lbHandlersBound) return;
    lbHandlersBound = true;

    container.addEventListener('click', (e) => {
        const periodBtn = e.target.closest('[data-lb-period]');
        if (periodBtn) { switchLeaderboardPeriod(periodBtn.dataset.lbPeriod); return; }
        if (e.target.closest('[data-lb-retry]')) { loadLeaderboard(); return; }
        const row = e.target.closest('[data-lb-user]');
        if (row && typeof window.viewUserProfile === 'function') window.viewUserProfile(row.dataset.lbUser);
    });

    container.addEventListener('change', (e) => {
        const sw = e.target.closest('[data-lb-hide]');
        if (sw) setLeaderboardHidden(sw.dataset.lbHide, sw.checked, sw);
    });
}

function switchLeaderboardPeriod(period) {
    if (period === currentLbPeriod || !LB_PERIODS.some(p => p.key === period)) return;
    currentLbPeriod = period;
    loadLeaderboard();
}

// shell:  build the frame (entering the pill).  silent: refresh in place with no skeleton.
async function loadLeaderboard({ shell = false, silent = false } = {}) {
    const container = document.getElementById('discover-list-container');
    if (!container || !currentUser) return;
    const period = currentLbPeriod;
    const token = ++latestLbToken;
    const stale = () => token !== latestLbToken || currentDiscoverTab !== 'leaderboard';

    if (shell || !document.getElementById('lb-body')) {
        container.innerHTML = lbShellHtml(period);
    } else if (!silent) {
        document.getElementById('lb-periods').innerHTML = lbPeriodPillsHtml(period);
        document.getElementById('lb-body').innerHTML = LIST_SKELETON;
    }

    try {
        // Send the seconds just earned first so "your time" isn't a flush behind
        // — but never hold the screen for a slow network.
        let giveUp;
        await Promise.race([flushStudyTime(), new Promise(r => { giveUp = setTimeout(r, 3000); })]);
        clearTimeout(giveUp);
        const { data, error } = await supabase.rpc('study_leaderboard', { p_period: period, p_limit: LB_LIMIT });
        if (error) throw error;
        if (!data || !Array.isArray(data.entries)) throw new Error('Unexpected leaderboard response');
        if (stale()) return;

        document.getElementById('lb-summary').innerHTML = lbSummaryHtml(data.totals);
        document.getElementById('lb-periods').innerHTML = lbPeriodPillsHtml(period);
        document.getElementById('lb-body').innerHTML = lbBodyHtml(data, period);
        document.getElementById('lb-privacy').innerHTML = lbPrivacyHtml(data.prefs);
    } catch (err) {
        if (stale() || silent) return;
        console.error('Error loading leaderboard:', err);
        const missing = lbIsMissingSql(err);
        document.getElementById('lb-body').innerHTML = `
            <div class="py-10 text-center">
                <span class="material-symbols-outlined text-[36px] mb-2 opacity-40 text-on-surface-variant dark:text-gray-400">${missing ? 'info' : 'cloud_off'}</span>
                <p class="text-sm font-medium text-on-surface-variant dark:text-gray-400">${missing ? "The leaderboard isn't set up yet." : "Couldn't load the leaderboard."}</p>
                ${missing ? '' : `<button data-lb-retry class="mt-3 px-4 py-1.5 rounded-full text-[13px] font-bold bg-on-surface text-surface dark:bg-white dark:text-black">Retry</button>`}
            </div>`;
    }
}

async function setLeaderboardHidden(period, hidden, inputEl) {
    const meta = LB_PERIODS.find(p => p.key === period);
    if (!meta) return;
    inputEl.disabled = true;
    try {
        const { error } = await supabase.rpc('study_set_name_hidden', { p_period: period, p_hidden: hidden });
        if (error) throw error;
        showToast(hidden ? `Your name is hidden on the ${meta.label} board` : `Your name is visible on the ${meta.label} board`, 'success');
        loadLeaderboard({ silent: true }); // re-sync from the server: it is the source of truth for what others see
    } catch (err) {
        console.error('Error updating leaderboard privacy:', err);
        inputEl.checked = !hidden; // put the switch back
        showToast(lbIsMissingSql(err) ? "The leaderboard isn't set up yet." : "Couldn't update that. Please try again.", 'error');
    } finally {
        inputEl.disabled = false;
    }
}

function lbShellHtml(period) {
    return `<div id="lb-summary"></div>
        <div id="lb-periods" class="flex items-center gap-2 mb-3">${lbPeriodPillsHtml(period)}</div>
        <div id="lb-body">${LIST_SKELETON}</div>
        <div id="lb-privacy"></div>`;
}

function lbPeriodPillsHtml(active) {
    return LB_PERIODS.map(p => {
        const cls = p.key === active
            ? 'bg-on-surface text-surface dark:bg-white dark:text-black'
            : 'bg-surface-variant/30 text-on-surface-variant dark:bg-neutral-800 dark:text-gray-300';
        return `<button data-lb-period="${p.key}" class="shrink-0 px-3.5 py-1 rounded-full text-[12px] font-bold transition-colors ${cls}">${p.label}</button>`;
    }).join('');
}

function lbSummaryHtml(totals) {
    const t = totals || {};
    const stat = (label, secs) => `<div>
            <p class="text-[17px] font-extrabold text-on-surface dark:text-gray-100 tabular-nums">${formatStudyDuration(secs)}</p>
            <p class="text-[11px] font-medium text-on-surface-variant dark:text-gray-400 mt-0.5">${label}</p>
        </div>`;
    return `<div class="rounded-2xl p-4 mb-4 bg-surface-variant/10 dark:bg-neutral-900/30">
            <div class="flex items-center gap-2 mb-3">
                <span class="material-symbols-outlined text-[20px] text-primary">emoji_events</span>
                <p class="text-[13px] font-extrabold text-on-surface dark:text-gray-100">Your study time</p>
            </div>
            <div class="grid grid-cols-3 gap-2 text-center">${stat('Today', t.today)}${stat('This week', t.week)}${stat('All-time', t.alltime)}</div>
            <p class="text-[11px] leading-snug text-on-surface-variant/80 dark:text-gray-500 mt-3">Counts while a PDF is open and you're active. Daily resets at midnight IST, weekly on Monday.</p>
        </div>`;
}

function lbRankClass(rank) {
    return rank === 1 ? 'text-amber-500' : rank === 2 ? 'text-slate-400' : rank === 3 ? 'text-orange-600' : 'text-on-surface-variant dark:text-gray-400';
}

function lbRowHtml(e) {
    const masked = !e.user_id;   // hidden by its owner for this period, or blocked with you
    const isMe = !!e.is_me;
    const clickable = !masked && !isMe;

    let avatar;
    if (masked) {
        avatar = `<div class="w-10 h-10 rounded-full bg-surface-variant/40 dark:bg-neutral-800 flex items-center justify-center shrink-0">
                <span class="material-symbols-outlined text-[22px] text-on-surface-variant dark:text-gray-400">person</span>
            </div>`;
    } else {
        const fallbackUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(e.full_name || '')}&background=e1e3e4`;
        const raw = e.profile_img_url || fallbackUrl;
        const src = typeof window.optimizeImageUrl === 'function' ? window.optimizeImageUrl(raw, 'avatar') : raw;
        avatar = `<img loading="lazy" src="${esc(src)}" onerror="${esc(`this.onerror=null; this.src='${fallbackUrl}';`)}" class="w-10 h-10 rounded-full object-cover shrink-0 border border-surface-variant/50">`;
    }

    const youTag = isMe ? `<span class="ml-1 shrink-0 px-1.5 py-[1px] rounded-md bg-primary/10 text-primary text-[10px] font-extrabold">You</span>` : '';
    const hiddenNote = isMe && e.hidden
        ? `<p class="text-[11px] font-medium text-on-surface-variant dark:text-gray-500 mt-0.5 flex items-center gap-1"><span class="material-symbols-outlined text-[13px]">visibility_off</span>Hidden from others</p>`
        : '';

    return `<div ${clickable ? `data-lb-user="${esc(e.user_id)}"` : ''} class="flex items-center gap-3 py-2.5 px-2 rounded-2xl ${isMe ? 'bg-primary/10' : ''} ${clickable ? 'cursor-pointer active:opacity-60 transition-opacity' : ''}">
            <span class="w-7 shrink-0 text-center text-[15px] font-extrabold tabular-nums ${lbRankClass(e.rank)}">${esc(e.rank)}</span>
            ${avatar}
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1 min-w-0">
                    <p class="font-bold text-[14px] text-on-surface dark:text-gray-100 truncate ${masked ? 'italic opacity-70' : ''}">${masked ? 'Anonymous' : esc(e.full_name)}</p>
                    ${youTag}${masked ? '' : getTickHtml(e.tick_type)}
                </div>
                ${hiddenNote}
            </div>
            <span class="shrink-0 text-[13px] font-bold text-on-surface dark:text-gray-100 tabular-nums">${formatStudyDuration(e.seconds)}</span>
        </div>`;
}

function lbBodyHtml(data, period) {
    const meta = LB_PERIODS.find(p => p.key === period) || LB_PERIODS[0];
    const entries = data.entries;
    const me = data.me;
    const note = 'text-[12px] font-semibold text-on-surface-variant dark:text-gray-400 mb-2 px-1';

    let html = me
        ? `<p class="${note}">You're <span class="font-extrabold text-on-surface dark:text-gray-100">#${esc(me.rank)}</span> of ${esc(data.participants)} · ${meta.when}</p>`
        : `<p class="${note}">You're not on the ${meta.label} board yet. Time counts while a PDF is open.</p>`;

    if (entries.length === 0) {
        return html + `<div class="py-10 flex flex-col items-center justify-center text-center text-on-surface-variant dark:text-gray-400">
                <span class="material-symbols-outlined text-[38px] mb-2 opacity-50">emoji_events</span>
                <p class="text-sm font-medium">No study time recorded ${period === 'alltime' ? 'yet' : meta.when}.<br>Be the first!</p>
            </div>`;
    }

    html += `<div>${entries.map(lbRowHtml).join('')}</div>`;

    // Outside the top N: pin your own row underneath so you always see where you are.
    if (me && !entries.some(e => e.is_me)) {
        html += `<div class="flex justify-center py-0.5 text-on-surface-variant/60 dark:text-gray-600"><span class="material-symbols-outlined text-[18px]">more_horiz</span></div>`;
        html += lbRowHtml({
            ...me, is_me: true,
            user_id: currentUser.id, full_name: currentUser.full_name,
            profile_img_url: currentUser.profile_img_url, tick_type: currentUser.tick_type,
        });
    }
    return html;
}

function lbPrivacyHtml(prefs) {
    const p = prefs || {};
    const sw = (meta) => `<div class="flex flex-col items-center gap-2">
            <span class="text-[12px] font-bold text-on-surface dark:text-gray-200">${meta.label}</span>
            <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" data-lb-hide="${meta.key}" aria-label="Hide my name on the ${meta.label} board" ${p[meta.key] ? 'checked' : ''} class="sr-only peer">
                <div class="w-11 h-6 bg-surface-variant dark:bg-neutral-700 rounded-full peer peer-checked:bg-primary peer-checked:after:translate-x-full after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
            </label>
        </div>`;
    return `<div class="rounded-2xl p-4 mt-4 mb-2 bg-surface-variant/10 dark:bg-neutral-900/30">
            <div class="flex items-center gap-2 mb-1">
                <span class="material-symbols-outlined text-[20px] text-on-surface dark:text-gray-200">visibility_off</span>
                <p class="text-[13px] font-extrabold text-on-surface dark:text-gray-100">Hide my name</p>
            </div>
            <p class="text-[12px] leading-snug text-on-surface-variant dark:text-gray-400 mb-3">Turn it on for a board and everyone else sees you as Anonymous there. Your rank and time still count.</p>
            <div class="grid grid-cols-3 gap-2">${LB_PERIODS.map(sw).join('')}</div>
        </div>`;
}

function getTickHtml(tickType) {
    return window.getTickHtml ? window.getTickHtml(tickType) : '';
}
// Search across all users and services
let latestSearchToken = 0; // Tracks the most recent search

// Search across users (name, course, role) and services (title, desc, author)
async function performSearch(query) {
    const container = document.getElementById('search-results-container');
    
    // Increment token for this specific search to prevent race conditions
    latestSearchToken++;
    const thisSearchToken = latestSearchToken;
    
    try {
        const blockedIds = await window.getBlockedUserIds(currentUser.id);
        const excludeIds = [currentUser.id, ...blockedIds];

        // Clean query for PostgREST 'or' syntax (commas break the array logic)
        const safeQuery = query.replace(/,/g, ' ');

        // Run both queries simultaneously for speed
        const [usersRes, servicesByTextRes] = await Promise.all([
            // 1. Search Users: Name, Course, or User Type (Role)
            supabase
                .from('users')
                .select('id, full_name, profile_img_url, course, tick_type, role')
                .or(`full_name.ilike.%${safeQuery}%,course.ilike.%${safeQuery}%,role.ilike.%${safeQuery}%`)
                .eq('is_deleted', false)
                .eq('is_deactivated', false)
                .not('id', 'in', `(${excludeIds.join(',')})`)
                .limit(20),
            
            // 2. Search Services: Title or Description
            supabase
                .from('page_services')
                .select('id, title, description, icon_name, url, open_in_app, page_id, users!inner(full_name, is_deleted, is_deactivated)')
                .or(`title.ilike.%${safeQuery}%,description.ilike.%${safeQuery}%`)
                .eq('is_active', true)
                .eq('users.is_deleted', false)
                .eq('users.is_deactivated', false)
                .not('page_id', 'in', `(${excludeIds.join(',')})`)
                .limit(20)
        ]);

        if (usersRes.error) throw usersRes.error;
        if (servicesByTextRes.error) throw servicesByTextRes.error;
        
        // If a new search started while we were waiting for the database, abort this one!
        if (thisSearchToken !== latestSearchToken) return;

        const allUsers = usersRes.data || [];
        
        // 3. Search Services By Author ("by__"):
        // If the query matched a Page's name, fetch their services too!
        const matchedPageIds = allUsers.filter(u => u.role === 'page').map(u => u.id);
        let additionalServices = [];
        
        if (matchedPageIds.length > 0) {
            const { data: authorServices } = await supabase
                .from('page_services')
                .select('id, title, description, icon_name, url, open_in_app, page_id, users!inner(full_name, is_deleted, is_deactivated)')
                .in('page_id', matchedPageIds)
                .eq('is_active', true)
                .eq('users.is_deleted', false)
                .eq('users.is_deactivated', false);
                
            if (authorServices) additionalServices = authorServices;
        }

        // Combine and deduplicate all service results
        const servicesDataMap = new Map();
        [...(servicesByTextRes.data || []), ...additionalServices].forEach(svc => {
            servicesDataMap.set(svc.id, svc);
        });
        const servicesData = Array.from(servicesDataMap.values());

        const studentsData = allUsers.filter(u => u.role !== 'page');
        const pagesData = allUsers.filter(u => u.role === 'page');

        let html = '';

      // Inject UI Content based on Active Tab
        if (currentSearchTab === 'all') {
            if (allUsers.length === 0 && servicesData.length === 0) {
                container.innerHTML = getEmptyStateHTML(query);
                return;
            }

            let isFirstSection = true;

            // 1. Pages First
            if (pagesData.length > 0) {
                html += `<h4 class="text-[13px] font-extrabold text-on-surface dark:text-gray-100 mb-2 ${isFirstSection ? 'mt-2' : 'mt-4'}">Pages</h4>`;
                html += renderUserList(pagesData.slice(0, 5));
                isFirstSection = false;
            }

            // 2. Students (Users) Second
            if (studentsData.length > 0) {
                html += `<h4 class="text-[13px] font-extrabold text-on-surface dark:text-gray-100 mb-2 ${isFirstSection ? 'mt-2' : 'mt-4'}">Users</h4>`;
                html += renderUserList(studentsData.slice(0, 5));
                isFirstSection = false;
            }

            // 3. Services Third
            if (servicesData.length > 0) {
                html += `<h4 class="text-[13px] font-extrabold text-on-surface dark:text-gray-100 mb-2 ${isFirstSection ? 'mt-2' : 'mt-4'}">Services</h4>`;
                html += renderServiceList(servicesData.slice(0, 5));
                isFirstSection = false;
            }
        } else if (currentSearchTab === 'users') {
            if (studentsData.length === 0) return container.innerHTML = getEmptyStateHTML(query, 'Users');
            html += renderUserList(studentsData);
        } else if (currentSearchTab === 'pages') {
            if (pagesData.length === 0) return container.innerHTML = getEmptyStateHTML(query, 'Pages');
            html += renderUserList(pagesData);
        } else if (currentSearchTab === 'services') {
            if (servicesData.length === 0) return container.innerHTML = getEmptyStateHTML(query, 'Services');
            html += renderServiceList(servicesData);
        }

        container.innerHTML = html;

    } catch (err) {
        console.error('Search error:', err);
        container.innerHTML = `<p class="text-sm text-center py-4 text-error">Search failed.</p>`;
    }
}

// 🚀 NEW: The ChatGPT Style List Renderer
function renderServiceList(services) {
    return services.map(svc => `
        <div onclick="window.openServiceLink('${svc.url}', ${svc.open_in_app}, '${(svc.title || '').replace(/'/g, "\\'")}')" class="flex items-start gap-4 py-3 cursor-pointer active:opacity-60 transition-opacity">
            <!-- Circular Icon -->
            <div class="w-[52px] h-[52px] rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 border border-primary/20">
                <span class="material-symbols-outlined text-[26px]">${svc.icon_name}</span>
            </div>
            <!-- Content Area -->
            <div class="flex-1 min-w-0 flex flex-col pt-0.5">
                <p class="font-extrabold text-[15px] text-on-surface dark:text-gray-100 truncate leading-tight">${svc.title}</p>
                ${svc.description ? `<p class="text-[13px] text-on-surface-variant dark:text-gray-400 leading-snug line-clamp-2 mt-1 pr-2">${svc.description}</p>` : ''}
                <p class="text-[11px] font-medium text-on-surface-variant/70 dark:text-gray-500 mt-1.5">
                    By ${svc.users.full_name}
                </p>
            </div>
        </div>
    `).join('');
}

// Existing User Renderer — used for both search results and the Discover
// pills (Popular/Suggested).
function renderUserList(users) {
    return users.map(user => {
        const rawAvatarUrl = user.profile_img_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4`;
        const optimizedAvatar = typeof window.optimizeImageUrl === 'function' ? window.optimizeImageUrl(rawAvatarUrl, 'avatar') : rawAvatarUrl;
        const fallback = `this.onerror=null; this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4';`;
        
        const subtitle = user.role === 'page' ? 'Official Page' : (user.course || 'Student');

        return `
        <div onclick="window.viewUserProfile('${user.id}')" class="flex items-center gap-3 py-3 cursor-pointer active:opacity-60 transition-opacity">
            <img loading="lazy" src="${optimizedAvatar}" onerror="${fallback}" class="w-[52px] h-[52px] rounded-full object-cover shrink-0 border border-surface-variant/50">

            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1">
                    <p class="font-bold text-[14px] text-on-surface dark:text-gray-100 truncate">
                        ${user.full_name}
                    </p>
                    ${getTickHtml(user.tick_type)}
                </div>
                <p class="text-[13px] font-medium text-on-surface-variant dark:text-gray-500 mt-[1px] truncate">
                    ${subtitle}
                </p>
            </div>
        </div>
        `;
    }).join('');
}

function getEmptyStateHTML(query, type = 'results') {
    return `
        <div class="py-12 flex flex-col items-center justify-center opacity-40 text-on-surface-variant">
            <span class="material-symbols-outlined text-[42px] mb-2">search_off</span>
            <p class="text-sm font-medium">No ${type.toLowerCase()} found matching "${query}"</p>
        </div>
    `;
}
