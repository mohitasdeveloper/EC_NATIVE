import { supabase } from './supabase.js';
import { getUserSuggestions, getTopConnectedUsers } from './data-layer.js';
import { showToast } from './ui.js';
let currentUser = null;
let searchTimeout = null;
let currentSearchTab = 'all';
let currentDiscoverTab = 'popular';

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
    
    loadDiscoverList('popular');
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

    container.innerHTML = LIST_SKELETON;
    try {
        const users = tab === 'popular'
            ? await getTopConnectedUsers(currentUser.id, 15)
            : await getUserSuggestions(currentUser.id, 12);

        // The person tapped the other pill while this
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

function getTickHtml(tickType) {
    return window.getTickHtml ? window.getTickHtml(tickType) : '';
}
// Search across all users and pages
let latestSearchToken = 0; // Tracks the most recent search

// Search across users (name, course, role) — students and pages
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

        // Search Users: Name, Course, or User Type (Role)
        const usersRes = await supabase
            .from('users')
            .select('id, full_name, profile_img_url, course, tick_type, role')
            .or(`full_name.ilike.%${safeQuery}%,course.ilike.%${safeQuery}%,role.ilike.%${safeQuery}%`)
            .eq('is_deleted', false)
            .eq('is_deactivated', false)
            .not('id', 'in', `(${excludeIds.join(',')})`)
            .limit(20);

        if (usersRes.error) throw usersRes.error;

        // If a new search started while we were waiting for the database, abort this one!
        if (thisSearchToken !== latestSearchToken) return;

        const allUsers = usersRes.data || [];

        const studentsData = allUsers.filter(u => u.role !== 'page');
        const pagesData = allUsers.filter(u => u.role === 'page');

        let html = '';

      // Inject UI Content based on Active Tab
        if (currentSearchTab === 'all') {
            if (allUsers.length === 0) {
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
        } else if (currentSearchTab === 'users') {
            if (studentsData.length === 0) return container.innerHTML = getEmptyStateHTML(query, 'Users');
            html += renderUserList(studentsData);
        } else if (currentSearchTab === 'pages') {
            if (pagesData.length === 0) return container.innerHTML = getEmptyStateHTML(query, 'Pages');
            html += renderUserList(pagesData);
        }

        container.innerHTML = html;

    } catch (err) {
        console.error('Search error:', err);
        container.innerHTML = `<p class="text-sm text-center py-4 text-error">Search failed.</p>`;
    }
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
