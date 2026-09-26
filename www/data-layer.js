/**
 * DATA LAYER - Centralized API calls with caching and deduplication
 * Reduces duplicate queries, implements smart TTL caching
 */

import { supabase } from './supabase.js';

// ==========================================
// CACHE MANAGER
// ==========================================

class CacheManager {
    constructor() {
        this.cache = new Map();
        this.timers = new Map();
    }

    set(key, value, ttlMs = 5 * 60 * 1000) {
        this.cache.set(key, value);
        
        // Clear previous timer
        if (this.timers.has(key)) clearTimeout(this.timers.get(key));
        
        // Set new expiration
        const timer = setTimeout(() => {
            this.cache.delete(key);
            this.timers.delete(key);
        }, ttlMs);
        
        this.timers.set(key, timer);
    }

    get(key) {
        return this.cache.get(key) || null;
    }

    has(key) {
        return this.cache.has(key);
    }

    clear(pattern = null) {
        if (!pattern) {
            this.cache.clear();
            this.timers.forEach(timer => clearTimeout(timer));
            this.timers.clear();
            return;
        }
        // Clear keys matching pattern (e.g., "blocked:*")
        for (const key of this.cache.keys()) {
            if (key.startsWith(pattern)) {
                this.cache.delete(key);
                if (this.timers.has(key)) {
                    clearTimeout(this.timers.get(key));
                    this.timers.delete(key);
                }
            }
        }
    }
}

const cache = new CacheManager();

// ==========================================
// DEDUPLICATION FOR IN-FLIGHT REQUESTS
// ==========================================

const inFlightRequests = new Map();

async function deduplicatedFetch(key, fetchFn) {
    // If request is already in flight, return that promise
    if (inFlightRequests.has(key)) {
        return inFlightRequests.get(key);
    }

    // Start the fetch
    const promise = fetchFn()
        .finally(() => {
            inFlightRequests.delete(key);
        });

    inFlightRequests.set(key, promise);
    return promise;
}

// ==========================================
// BLOCKED USERS
// ==========================================

export async function getBlockedUserIds(userId) {
    const cacheKey = `blocked:${userId}`;
    
    // Check cache
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }

    // Deduplicate in-flight requests
    return deduplicatedFetch(cacheKey, async () => {
        try {
            // Fixed: Use proper Supabase filter syntax with parentheses
            const { data, error } = await supabase
                .from('connections')
                .select('user_one_id, user_two_id')
                .eq('status', 'blocked')
                .or(`user_one_id.eq.${userId},user_two_id.eq.${userId}`);
            
            if (error) throw error;
            if (!data) return [];

            const blocked = data.map(c => 
                c.user_one_id === userId ? c.user_two_id : c.user_one_id
            );

            // Cache for 10 minutes
            cache.set(cacheKey, blocked, 10 * 60 * 1000);
            return blocked;
        } catch (e) {
            console.error("Error fetching blocked list:", e);
            return [];
        }
    });
}

// Invalidate blocked list when connection changes
export function invalidateBlockedCache(userId) {
    cache.clear(`blocked:${userId}`);
}

// ==========================================
// USER SUGGESTIONS
// ==========================================

export async function getUserSuggestions(userId, limit = 12) {
    const cacheKey = `suggestions:${userId}:${limit}`;
    
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }

    return deduplicatedFetch(cacheKey, async () => {
        try {
            // Fixed: Use proper Supabase filter syntax with parentheses
            const { data: connData } = await supabase
                .from('connections')
                .select('user_one_id, user_two_id')
                .or(`user_one_id.eq.${userId},user_two_id.eq.${userId}`);

            let excludeIds = [userId];
            if (connData) {
                connData.forEach(c => {
                    excludeIds.push(c.user_one_id === userId ? c.user_two_id : c.user_one_id);
                });
            }

            // Get followed pages
            const { data: followData } = await supabase
                .from('page_followers')
                .select('page_id')
                .eq('follower_id', userId);

            if (followData) {
                followData.forEach(f => excludeIds.push(f.page_id));
            }

            // Fetch suggestions
            const { data: users, error } = await supabase
                .from('users')
                .select('id, full_name, profile_img_url, tick_type, role, course')
                .eq('is_deleted', false)
                .eq('is_deactivated', false)
                .not('id', 'in', `(${excludeIds.join(',')})`)
                .limit(limit);

            if (error) throw error;

            const suggestions = users ? users.sort(() => 0.5 - Math.random()) : [];
            
            // Cache for 30 minutes
            cache.set(cacheKey, suggestions, 30 * 60 * 1000);
            return suggestions;
        } catch (e) {
            console.error("Suggestions fetch error:", e);
            return [];
        }
    });
}

export function invalidateSuggestionsCache(userId) {
    cache.clear(`suggestions:${userId}`);
}

// Powers the "Popular" pill on the Search/Discover tab — top N users by
// connection_count. Deliberately does NOT exclude existing
// connections/followed pages the way getUserSuggestions does, since this is
// a straightforward "who's most connected" leaderboard, not a "who to
// connect with next" recommendation.
export async function getTopConnectedUsers(userId, limit = 15) {
    // Cached globally (same leaderboard for everyone), not per-user — so the
    // query itself must NOT exclude the viewer, or user A's cached result
    // would incorrectly omit user A when user B looks at the same list.
    // Fetch a small buffer beyond `limit` and filter the viewer out client-side.
    const cacheKey = `top-connected:${limit + 1}`;

    let topUsers;
    if (cache.has(cacheKey)) {
        topUsers = cache.get(cacheKey);
    } else {
        topUsers = await deduplicatedFetch(cacheKey, async () => {
            try {
                const { data: users, error } = await supabase
                    .from('users')
                    .select('id, full_name, profile_img_url, tick_type, role, course, connection_count')
                    .eq('is_deleted', false)
                    .eq('is_deactivated', false)
                    .order('connection_count', { ascending: false })
                    .limit(limit + 1);

                if (error) throw error;

                const result = users || [];
                cache.set(cacheKey, result, 15 * 60 * 1000); // 15 min — a leaderboard, not something that needs to be second-by-second fresh
                return result;
            } catch (e) {
                console.error('Top connected users fetch error:', e);
                return [];
            }
        });
    }

    return topUsers.filter(u => u.id !== userId).slice(0, limit);
}

// ==========================================
// ACCEPTED CONNECTIONS (For messaging)
// ==========================================

export async function getAcceptedConnections(userId) {
    const cacheKey = `connections:${userId}`;
    
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }

    return deduplicatedFetch(cacheKey, async () => {
        try {
            // Step 1: Get accepted connections
            const { data: connections, error: connError } = await supabase
                .from('connections')
                .select('user_one_id, user_two_id')
                .eq('status', 'accepted')
                .or(`user_one_id.eq.${userId},user_two_id.eq.${userId}`);

            if (connError) throw connError;
            if (!connections || connections.length === 0) {
                cache.set(cacheKey, [], 15 * 60 * 1000);
                return [];
            }

            // Step 2: Extract other user IDs
            const otherUserIds = connections.map(conn => 
                conn.user_one_id === userId ? conn.user_two_id : conn.user_one_id
            );

            // Step 3: Fetch user details
            const { data: users, error: userError } = await supabase
                .from('users')
                .select('id, full_name, profile_img_url, tick_type')
                .in('id', otherUserIds);

            if (userError) throw userError;

            // Cache for 15 minutes
            cache.set(cacheKey, users || [], 15 * 60 * 1000);
            return users || [];
        } catch (e) {
            console.error("Error fetching accepted connections:", e);
            return [];
        }
    });
}

export function invalidateConnectionsCache(userId) {
    cache.clear(`connections:${userId}`);
}

// ==========================================
// HOTPOSTS WITH EFFICIENT FILTERING
// ==========================================

export async function getHotposts(userId) {
    const cacheKey = `hotposts:${userId}`;
    
    // Note: Don't cache hotposts aggressively since they're time-sensitive
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }

    return deduplicatedFetch(cacheKey, async () => {
        try {
            const blockedIds = await getBlockedUserIds(userId);
            // FIXED: getAcceptedConnections now returns array directly
            const myConns = await getAcceptedConnections(userId);
            const myConnectionIds = new Set((myConns || []).map(c => c.id));

            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

            let query = supabase
                .from('hotposts')
                .select(`
                    id, created_at, media_url, caption, visibility, user_id, allow_rewatch, media_type,
                    users!inner ( id, full_name, profile_img_url, tick_type, is_deleted, is_deactivated ),
                    hotpost_views ( viewer_id ),
                    hotpost_likes ( user_id )
                `)
                .gt('created_at', twentyFourHoursAgo)
                .eq('is_deleted', false)
                .eq('users.is_deleted', false)
                .eq('users.is_deactivated', false)
                .eq('hotpost_likes.is_deleted', false)
                .order('created_at', { ascending: false });

            if (blockedIds.length > 0) {
                query = query.not('user_id', 'in', `(${blockedIds.join(',')})`);
            }

            const { data, error } = await query;
            if (error) throw error;

            // Client-side filtering for connection visibility
            const filtered = (data || []).filter(post => {
                if (post.user_id === userId) return true;
                if (post.visibility === 'connections' && !myConnectionIds.has(post.user_id)) return false;
                return true;
            });

            // Cache for 2 minutes since hotposts are time-sensitive
            cache.set(cacheKey, filtered, 2 * 60 * 1000);
            return filtered;
        } catch (e) {
            console.error("Hotposts fetch error:", e);
            return [];
        }
    });
}

export function invalidateHotpostsCache(userId) {
    cache.clear(`hotposts:${userId}`);
}

// ==========================================
// CACHE INVALIDATION
// ==========================================

/**
 * Call when user follows/unfollows someone
 */
export function onConnectionChanged(userId) {
    invalidateConnectionsCache(userId);
    invalidateSuggestionsCache(userId);
    invalidateHotpostsCache(userId);
}

/**
 * Call when user blocks/unblocks someone
 */
export function onBlockChanged(userId) {
    invalidateBlockedCache(userId);
    // Clear all lists that depend on blocked users
    cache.clear('');
}

/**
 * Call when new post is published
 */
export function onPostPublished() {
    // Don't clear feed cache - use realtime updates instead
}

/**
 * Call when connection settings change
 */
export function onSettingsChanged(userId) {
    // Clear relevant caches
    invalidateConnectionsCache(userId);
    invalidateSuggestionsCache(userId);
}

// ==========================================
// NOTIFICATION CREATION
// ==========================================
// Almost every notification type had a full render/click-handling path already
// built in notifications.js (icons, click targets, preview text) — but nothing
// in the app actually ever INSERTed a row for most of them. The only one that
// worked end-to-end was 'new_follower' (main.js's handleFollowAction). This is
// the one shared place every real trigger point now calls, so the "never
// notify yourself" rule and error handling live in exactly one spot.
export async function createNotification({ userId, senderId, type, message = null, targetId = null }) {
    if (!userId || !senderId || userId === senderId) return; // never notify yourself
    try {
        const { error } = await supabase.from('notifications').insert({
            user_id: userId,
            sender_id: senderId,
            type,
            message,
            target_id: targetId
        });
        if (error) throw error;
    } catch (e) {
        // Notifications are a nice-to-have, not something that should ever block
        // or roll back the action that triggered them (a like, a comment, etc).
        console.error(`createNotification(${type}) failed:`, e);
    }
}

// ==========================================
// EXPORT CACHE MANAGER FOR TESTING
// ==========================================

export { cache };
