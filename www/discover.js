import { supabase } from './supabase.js';
import { showToast } from './ui.js';
import { handleConnectionAction } from './main.js';

let currentUser = null;

export function initDiscover(user) {
    currentUser = user;
    
    const connectHandler = (e) => {
        const connectBtn = e.target.closest('.connect-btn');
        if (connectBtn && !connectBtn.disabled) {
            handleConnectionAction(connectBtn.dataset.userId, 'request', connectBtn);
        }
    };

    // Use event delegation for connect buttons
    const container = document.getElementById('discover-students-container');
    if (container) {
        container.addEventListener('click', connectHandler);
    }
    const popularContainer = document.getElementById('popular-users-container');
    if (popularContainer) {
        popularContainer.addEventListener('click', connectHandler);
    }
}

async function fetchDiscoverUsers() {
    const container = document.getElementById('discover-students-container');
    if (!container) return;
    container.innerHTML = `<p class="text-sm italic text-center py-4 text-gray-500 dark:text-gray-400">Finding peers...</p>`;

    try {
        // 1. Fetch all connections for the current user (optimized to only grab IDs)
        const { data: connections, error: connError } = await supabase
            .from('connections')
            .select('user_one_id, user_two_id')
            .or(`user_one_id.eq.${currentUser.id},user_two_id.eq.${currentUser.id}`);
        if (connError) throw connError;

        // 2. Get a list of all user IDs the current user is already interacting with (pending, accepted, blocked)
        const connectedUserIds = connections.map(c => {
            return c.user_one_id === currentUser.id ? c.user_two_id : c.user_one_id;
        });
        
        // Add the current user to the exclusion list so they don't see themselves
        const allExcludedIds = [currentUser.id, ...connectedUserIds];

        // 3. Fetch random/new users who are NOT in the excluded list
        const { data: users, error: usersError } = await supabase
            .from('users')
            .select('id, full_name, profile_img_url, course')
            .not('id', 'in', `(${allExcludedIds.join(',')})`)
            .limit(10);
        if (usersError) throw usersError;

        renderDiscoverUsers(users);

    } catch (error) {
        console.error('Error fetching discover users:', error);
        container.innerHTML = `<p class="text-sm italic text-center py-4 text-red-500">Could not load users to discover.</p>`;
    }
}
function renderDiscoverUsers(users) {
    const container = document.getElementById('discover-students-container');
    if (users.length === 0) {
        container.innerHTML = `<p class="text-sm italic text-center py-4 text-gray-500 dark:text-gray-400">No new students to discover right now.</p>`;
        return;
    }

    container.innerHTML = users.map(user => {
        const rawAvatarUrl = user.profile_img_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4`;
        const optimizedAvatar = typeof window.optimizeImageUrl === 'function' ? window.optimizeImageUrl(rawAvatarUrl, 'avatar') : rawAvatarUrl;
        const fallback = `this.onerror=null; this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4';`;
        const btnText = user.role === 'page' ? 'Follow' : 'Connect';
        
        // Changed to "Official Page"
        const subtitle = user.role === 'page' ? 'Official Page' : (user.course || 'Student');

        return `
        <div class="flex items-center gap-4 p-3 bg-white dark:bg-neutral-900 rounded-2xl border border-gray-200 dark:border-neutral-800 shadow-sm hover:border-primary/30 transition-colors">
            <img loading="lazy" onclick="window.viewUserProfile('${user.id}')" src="${optimizedAvatar}" onerror="${fallback}" class="w-12 h-12 rounded-full object-cover border border-surface-variant shadow-sm cursor-pointer hover:opacity-80 transition-opacity shrink-0">
            <div onclick="window.viewUserProfile('${user.id}')" class="flex-1 cursor-pointer min-w-0">
                <p class="font-bold text-sm text-gray-900 dark:text-gray-100 hover:text-primary transition-colors truncate">${user.full_name}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400 truncate">${subtitle}</p>
            </div>
            <button onclick="window.viewUserProfile('${user.id}')" class="connect-btn bg-primary/10 text-primary px-4 py-2 rounded-full text-[12px] font-bold tracking-wide transition-all hover:bg-primary/20 active:scale-95 shrink-0">
                ${btnText}
            </button>
        </div>
        `;
    }).join('');
}

function renderPopularUsers(users) {
    const container = document.getElementById('popular-users-container');
    if (!container || users.length === 0) {
        if (container) container.innerHTML = ''; 
        return;
    }

    container.innerHTML = users.map(user => {
        // 🚀 Compress Image & Add Fallback
        const rawAvatarUrl = user.profile_img_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4`;
        const optimizedAvatar = typeof window.optimizeImageUrl === 'function' ? window.optimizeImageUrl(rawAvatarUrl, 'avatar') : rawAvatarUrl;
        const fallback = `this.onerror=null; this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4';`;

        return `
        <div class="flex items-center gap-4 p-3 bg-white dark:bg-neutral-900 rounded-2xl border border-gray-200 dark:border-neutral-800 shadow-sm hover:border-primary/30 transition-colors">
            <img loading="lazy" onclick="window.viewUserProfile('${user.id}')" src="${optimizedAvatar}" onerror="${fallback}" class="w-12 h-12 rounded-full object-cover border border-surface-variant shadow-sm cursor-pointer hover:opacity-80 transition-opacity shrink-0">
            <div onclick="window.viewUserProfile('${user.id}')" class="flex-1 cursor-pointer min-w-0">
                <p class="font-bold text-sm text-gray-900 dark:text-gray-100 hover:text-primary transition-colors truncate">${user.full_name}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400 truncate">${user.connection_count || 0} connections</p>
            </div>
            <button data-user-id="${user.id}" class="connect-btn bg-primary/10 text-primary px-4 py-2 rounded-full text-[12px] font-bold tracking-wide transition-all hover:bg-primary/20 active:scale-95 shrink-0">
                Connect
            </button>
        </div>
        `;
    }).join('');
}

window.refreshDiscover = () => {
    fetchDiscoverUsers();
    fetchPopularUsers();
};
