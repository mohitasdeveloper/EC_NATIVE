export function timeAgo(date) {
    const dateObj = new Date(date);
    const seconds = Math.floor((new Date() - dateObj) / 1000);
    let interval = seconds / 31536000;
    if (interval > 1) {
        return Math.floor(interval) + "y ago";
    }
    interval = seconds / 2592000;
    if (interval > 1) {
        return Math.floor(interval) + "mo ago";
    }
    interval = seconds / 86400;
    if (interval > 1) {
        return Math.floor(interval) + "d ago";
    }
    interval = seconds / 3600;
    if (interval > 1) {
        return Math.floor(interval) + "h ago";
    }
    interval = seconds / 60;
    if (interval > 1) {
        return Math.floor(interval) + "m ago";
    }
    return "Just now";
}

// 🚀 IMPROVED: Native Image Compressor with transparency support
export async function compressImage(file, maxWidth = 1080, quality = 0.7) {
    return new Promise((resolve, reject) => {
        try {
            if (!file.type.match(/image.*/)) {
                resolve(file); // Return original if not an image
                return;
            }

            const reader = new FileReader();
            reader.readAsDataURL(file);

            reader.onload = (event) => {
                try {
                    const img = new Image();
                    img.src = event.target.result;

                    img.onload = () => {
                        try {
                            const canvas = document.createElement('canvas');
                            let width = img.width;
                            let height = img.height;

                            // Scale down if it exceeds max width
                            if (width > maxWidth) {
                                height = Math.round((height * maxWidth) / width);
                                width = maxWidth;
                            }

                            canvas.width = width;
                            canvas.height = height;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, 0, 0, width, height);

                            // Use WebP with fallback to PNG to preserve transparency
                            // WebP is smaller and supports transparency
                            const mimeType = file.type === 'image/png' ? 'image/webp' : 'image/jpeg';
                            const extension = mimeType === 'image/webp' ? 'webp' : 'jpg';

                            canvas.toBlob((blob) => {
                                if (!blob) {
                                    reject(new Error('Failed to create blob from canvas'));
                                    return;
                                }

                                resolve(new File([blob], `${file.name.split('.')[0]}.${extension}`, {
                                    type: mimeType,
                                    lastModified: Date.now()
                                }));
                            }, mimeType, quality);
                        } catch (canvasErr) {
                            console.error("Canvas error:", canvasErr);
                            reject(canvasErr);
                        }
                    };

                    img.onerror = (error) => {
                        console.error("Image load error:", error);
                        reject(new Error('Failed to load image'));
                    };

                    // Set timeout to prevent hanging
                    setTimeout(() => {
                        if (!img.complete) {
                            reject(new Error('Image load timeout'));
                        }
                    }, 10000);
                } catch (readErr) {
                    console.error("Read load error:", readErr);
                    reject(readErr);
                }
            };

            reader.onerror = (error) => {
                console.error("FileReader error:", error);
                reject(new Error('Failed to read file'));
            };

            // Set timeout for file read
            setTimeout(() => {
                if (reader.readyState !== FileReader.DONE) {
                    reject(new Error('File read timeout'));
                }
            }, 10000);
        } catch (err) {
            console.error("Compression error:", err);
            reject(err);
        }
    });
}
// ==========================================
// OFFLINE STORAGE ENGINE (IndexedDB)
// ==========================================
export async function initDB() {
    return new Promise((resolve, reject) => {
        // Upgrade to Version 5 to add the Featured Services cache table
        const request = indexedDB.open('ECampusDB', 5);
        
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('feed_cache')) db.createObjectStore('feed_cache', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('hotposts_cache')) db.createObjectStore('hotposts_cache', { keyPath: 'user_id' }); 
            if (!db.objectStoreNames.contains('updates_cache')) db.createObjectStore('updates_cache', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('suggestions_cache')) db.createObjectStore('suggestions_cache', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('notifications_cache')) db.createObjectStore('notifications_cache', { keyPath: 'id' });
            
            // 🚀 NEW: Background Sync Action Queue
            if (!db.objectStoreNames.contains('action_queue')) {
                db.createObjectStore('action_queue', { keyPath: 'id', autoIncrement: true });
            }

            // 🚀 NEW: Featured Services grid (Search page) offline cache
            if (!db.objectStoreNames.contains('featured_services_cache')) {
                db.createObjectStore('featured_services_cache', { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject('Could not open IndexedDB');
    });
}

// --- KEEP EXISTING CACHE HELPERS ---
export async function saveFeedToCache(posts) {
    const db = await initDB();
    const tx = db.transaction('feed_cache', 'readwrite');
    tx.objectStore('feed_cache').clear(); 
    posts.forEach(post => tx.objectStore('feed_cache').put(post));
}
export async function getFeedFromCache() {
    const db = await initDB();
    return new Promise(resolve => {
        const req = db.transaction('feed_cache', 'readonly').objectStore('feed_cache').getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
        req.onerror = () => resolve([]);
    });
}
export async function saveHotpostsToCache(hotpostsByUserArray) {
    const db = await initDB();
    const tx = db.transaction('hotposts_cache', 'readwrite');
    tx.objectStore('hotposts_cache').clear(); 
    hotpostsByUserArray.forEach(item => tx.objectStore('hotposts_cache').put(item));
}
export async function getHotpostsFromCache() {
    const db = await initDB();
    return new Promise(resolve => {
        const req = db.transaction('hotposts_cache', 'readonly').objectStore('hotposts_cache').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve([]);
    });
}
export async function saveUpdatesToCache(updates) {
    const db = await initDB();
    const tx = db.transaction('updates_cache', 'readwrite');
    tx.objectStore('updates_cache').clear(); 
    updates.forEach(update => tx.objectStore('updates_cache').put(update));
}
export async function getUpdatesFromCache() {
    const db = await initDB();
    return new Promise(resolve => {
        const req = db.transaction('updates_cache', 'readonly').objectStore('updates_cache').getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
        req.onerror = () => resolve([]);
    });
}
export async function saveSuggestionsToCache(users) {
    const db = await initDB();
    const tx = db.transaction('suggestions_cache', 'readwrite');
    tx.objectStore('suggestions_cache').clear(); 
    users.forEach(user => tx.objectStore('suggestions_cache').put(user));
}
export async function getSuggestionsFromCache() {
    const db = await initDB();
    return new Promise(resolve => {
        const req = db.transaction('suggestions_cache', 'readonly').objectStore('suggestions_cache').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve([]);
    });
}
export async function saveFeaturedServicesToCache(items) {
    const db = await initDB();
    const tx = db.transaction('featured_services_cache', 'readwrite');
    tx.objectStore('featured_services_cache').clear();
    items.forEach(item => tx.objectStore('featured_services_cache').put(item));
}
export async function getFeaturedServicesFromCache() {
    const db = await initDB();
    return new Promise(resolve => {
        const req = db.transaction('featured_services_cache', 'readonly').objectStore('featured_services_cache').getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => (a.group_order - b.group_order) || (a.item_order - b.item_order)));
        req.onerror = () => resolve([]);
    });
}
export async function saveNotificationsToCache(notifs) {
    const db = await initDB();
    const tx = db.transaction('notifications_cache', 'readwrite');
    tx.objectStore('notifications_cache').clear(); 
    notifs.forEach(notif => tx.objectStore('notifications_cache').put(notif));
}
export async function getNotificationsFromCache() {
    const db = await initDB();
    return new Promise(resolve => {
        const req = db.transaction('notifications_cache', 'readonly').objectStore('notifications_cache').getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
        req.onerror = () => resolve([]);
    });
}

// ==========================================
// 🚀 IMPROVED: OFFLINE ACTION QUEUE HELPERS
// ==========================================
export async function queueOfflineAction(actionType, payload) {
    try {
        const db = await initDB();
        const tx = db.transaction('action_queue', 'readwrite');
        const action = { type: actionType, payload: payload, timestamp: Date.now() };
        const req = tx.objectStore('action_queue').add(action);
        
        return new Promise((resolve, reject) => {
            req.onsuccess = () => {
                console.log(`Queued action: ${actionType} with id ${req.result}`);
                resolve(req.result);
            };
            req.onerror = () => reject(new Error('Failed to queue action'));
        });
    } catch (err) {
        console.error("Queue offline action error:", err);
        throw err;
    }
}

export async function getActionQueue() {
    try {
        const db = await initDB();
        return new Promise((resolve, reject) => {
            const req = db.transaction('action_queue', 'readonly').objectStore('action_queue').getAll();
            req.onsuccess = () => {
                const result = req.result.sort((a, b) => a.timestamp - b.timestamp);
                resolve(result);
            };
            req.onerror = () => {
                console.error("Failed to get action queue:", req.error);
                resolve([]);
            };
        });
    } catch (err) {
        console.error("Get action queue error:", err);
        return [];
    }
}

export async function clearAction(actionId) {
    try {
        const db = await initDB();
        const tx = db.transaction('action_queue', 'readwrite');
        const req = tx.objectStore('action_queue').delete(actionId);
        
        return new Promise((resolve, reject) => {
            req.onsuccess = () => {
                console.log(`Cleared action ${actionId}`);
                resolve();
            };
            req.onerror = () => {
                console.error("Failed to clear action:", req.error);
                reject(new Error('Failed to clear action'));
            };
        });
    } catch (err) {
        console.error("Clear action error:", err);
        throw err;
    }
}
