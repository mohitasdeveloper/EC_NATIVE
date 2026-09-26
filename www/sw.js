const CACHE_NAME = 'ecampus-cache-v9';
const STATIC_ASSETS = [
    './',
    './index.html',
    './style.css',
    './main.js',
    './feed.js',
    './hotposts.js',
    './search.js',
    './messages.js',
    './notifications.js',
    './utils.js',
    './ui.js',
    './config.js',
    './supabase.js',
    './post-card.js',
    './data-layer.js',
    './verification.js',
    './discover.js',
    './pdf-viewer.js',
    './offline.html',
    './favicon.svg',
    './auth/signup.html',
    './auth/login.html',
    './auth/auth.js',
    './tailwind.css',
    // 🚀 Self-hosted fonts (replaces fonts.googleapis.com at runtime) -
    // precached on install so icons/text never fall back to plain text
    // when the app is opened offline for the very first time.
    './fonts/fonts.css',
    './fonts/inter-300.woff2',
    './fonts/inter-400.woff2',
    './fonts/inter-500.woff2',
    './fonts/inter-600.woff2',
    './fonts/inter-700.woff2',
    './fonts/inter-800.woff2',
    './fonts/courgette-400.woff2',
    './fonts/material-symbols-outlined.woff2',
    // Third-party libs are bundled (npm run build -> www/vendor), so the app
    // boots offline even on the very first launch.
    './vendor/supabase.js',
    './vendor/quill.min.js',
    './vendor/quill.snow.css',
    './vendor/quill.mention.min.js',
    './vendor/quill.mention.min.css',
    './vendor/html2canvas.min.js',
    './vendor/fontawesome/css/all.min.css',
    './vendor/fontawesome/webfonts/fa-brands-400.woff2',
    './vendor/fontawesome/webfonts/fa-solid-900.woff2',
    './vendor/fontawesome/webfonts/fa-regular-400.woff2'
];

// App-shell file types that should always be re-fetched from the network
// first, so a fresh deploy shows up the moment the app is opened — not
// whenever the browser eventually decides the cache is stale.
function isAppShellRequest(request) {
    if (request.mode === 'navigate') return true;
    if (request.destination === 'script' || request.destination === 'style') return true;
    try {
        const u = new URL(request.url);
        if (u.origin === self.location.origin && /\.(js|html|css)(\?|$)/.test(u.pathname)) return true;
    } catch (e) { /* ignore malformed URLs */ }
    return false;
}

// 1. Install & Cache Static Assets (Bulletproof Version)
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            console.log('Caching assets one by one to prevent crashes...');
            for (let asset of STATIC_ASSETS) {
                try {
                    // Try to cache the file
                    await cache.add(asset);
                } catch (e) {
                    // If the file is missing on GitHub, just skip it and don't crash!
                    console.warn(`Skipped missing asset: ${asset}`);
                }
            }
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME && cache !== 'ecampus-external-cache-v1') return caches.delete(cache);
                })
            );
        })
    );
    self.clients.claim();
});

// 2. Network-first for the app shell (HTML/JS/CSS) — always try to get the
//    latest deploy first; only fall back to what's cached when offline.
async function networkFirst(request) {
    try {
        const networkResponse = await fetch(request, { cache: 'no-store' });
        if (networkResponse && networkResponse.ok) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
        }
        return networkResponse;
    } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
            const url = request.url;
            if (url.includes('/auth/login.html')) return caches.match('./auth/login.html');
            return caches.match('./index.html');
        }
        return new Response('', { status: 503, statusText: 'Offline' });
    }
}

// 3. Cache-first for everything else (fonts, images, avatars, CDN assets) —
//    these essentially never change, so serving instantly from cache is
//    both faster and perfectly safe.
async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const networkResponse = await fetch(request);
        const cacheableDomains = [
            'cloudinary.com',
            'ui-avatars.com',
            'fonts.googleapis.com',
            'fonts.gstatic.com',
            'cdn.tailwindcss.com',
            'cdnjs.cloudflare.com',
            'cdn.jsdelivr.net'
        ];
        if (cacheableDomains.some(domain => request.url.includes(domain))) {
            const clone = networkResponse.clone();
            caches.open('ecampus-external-cache-v1').then((cache) => cache.put(request, clone)).catch(() => {});
        }
        return networkResponse;
    } catch (err) {
        return new Response('', { status: 503, statusText: 'Offline' });
    }
}

// 4. Intercept Fetch Requests
self.addEventListener('fetch', (event) => {
    const url = event.request.url;

    // Ignore all Supabase database, auth & realtime requests (we handle offline manually)
    if (url.includes('supabase.co/rest') || url.includes('supabase.co/auth') || url.includes('supabase.co/realtime')) return;

    if (isAppShellRequest(event.request)) {
        event.respondWith(networkFirst(event.request));
    } else {
        event.respondWith(cacheFirst(event.request));
    }
});
