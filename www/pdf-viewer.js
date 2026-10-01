/* ══════════════════════════════════════════════════════════════════
   SHARED IN-APP PDF VIEWER
   Full-screen, continuous-scroll, pinch/double-tap zoom. Renders
   fetched bytes on <canvas> via pdf.js — the WebView is never asked
   to navigate to the PDF URL itself, so there's nothing for the
   native download handler or an external browser to intercept.

   Locked down on purpose: no Download / Open-Externally controls,
   the URL is never written into a href or any DOM attribute, and
   long-press/right-click/text-select are disabled. Built for
   protected study material where the raw link and a save-to-device
   path shouldn't be exposed.

   Usage: <script src="pdf-viewer.js"></script>  (one line, any page)
   Then:  window.openPdfViewer(url, title)
          window.closePdfViewer()
   Self-contained — injects its own markup/CSS and lazy-loads pdf.js
   itself. Icons are inline SVG on purpose, not an icon-font class —
   this script runs on pages with different (or no) icon fonts loaded,
   and a missing font just means invisible buttons.

   Persistence: every PDF is stored ON THE DEVICE (IndexedDB, see the
   "Persistent PDF store" section below) the first time it is opened or
   prefetched, keyed by URL. After that it opens straight from local
   storage — no network, and it survives closing/reopening the app. The
   engine (pdf.js) is bundled in www/vendor/pdfjs (CDN only as a fallback)
   and warmed at idle, and pages are laid out from page 1's size instead
   of parsing every page first, so big PDFs paint immediately.
   Optional 3rd arg: window.openPdfViewer(url, title, { tag }) — a tag
   marks a group of PDFs (e.g. 'bafs') that window.pdfStore.prune() can
   later drop when their links change.

   Cross-frame: when this script runs inside an iframe (e.g. the BAFs
   study planner, embedded in the main app), a fixed-position overlay
   would only ever cover that iframe's own box, not the real device
   screen. So when embedded, open()/close() are forwarded via
   postMessage to window.top instead, and the actual top-level page
   (which also includes this same script) renders the overlay itself —
   genuinely full-screen, while the iframe/host page underneath it is
   otherwise unaffected. Loaded directly (not in a frame), it just
   renders locally as normal.

   Lifecycle events (top-level document only, i.e. wherever the overlay
   really renders): 'ecampus:pdf-open', 'ecampus:pdf-ready' (pages built
   and on screen) and 'ecampus:pdf-close', dispatched on window with NO
   detail — the URL is deliberately never handed out. study-time.js listens
   to these to count time spent reading. Nothing else depends on them, so
   the viewer still works on pages that don't listen (e.g. the planner).
   ══════════════════════════════════════════════════════════════════ */
(function () {
    if (window.openPdfViewer) return; // already installed on this page

    const isEmbedded = (function () {
        try { return window.top !== window.self; } catch (e) { return true; }
    })();

    const PDFJS_VERSION = '3.11.174';
    // Bundled copy first (npm run build → www/vendor/pdfjs, precached by sw.js) so the
    // engine loads from disk with no network. The CDN is only a fallback for dev
    // builds that skipped the vendor step.
    const SCRIPT_BASE = (document.currentScript && document.currentScript.src) || window.location.href;
    const PDFJS_SOURCES = [
        {
            src: new URL('vendor/pdfjs/pdf.min.js', SCRIPT_BASE).href,
            worker: new URL('vendor/pdfjs/pdf.worker.min.js', SCRIPT_BASE).href
        },
        {
            src: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`,
            worker: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`
        }
    ];

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.onload = () => resolve();
            el.onerror = () => { el.remove(); reject(new Error('failed to load ' + src)); };
            document.head.appendChild(el);
        });
    }

    function emit(name) {
        try { window.dispatchEvent(new CustomEvent('ecampus:pdf-' + name)); } catch (e) { /* listeners must never break the viewer */ }
    }

    let pdfjsReady = null;
    function loadPdfJs() {
        if (pdfjsReady) return pdfjsReady;
        pdfjsReady = (async () => {
            if (window.pdfjsLib) {
                if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_SOURCES[0].worker;
                return window.pdfjsLib;
            }
            let lastErr = null;
            for (const source of PDFJS_SOURCES) {
                try {
                    await loadScript(source.src);
                    if (!window.pdfjsLib) throw new Error('pdfjsLib missing after load');
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc = source.worker;
                    return window.pdfjsLib;
                } catch (e) { lastErr = e; }
            }
            throw lastErr || new Error('pdf.js failed to load');
        })();
        // A failed load must not stay cached forever — let the next open try again.
        pdfjsReady.catch(() => { pdfjsReady = null; });
        return pdfjsReady;
    }

    // ═══════════════ Persistent PDF store (on-device, survives app restarts) ═══════════════
    // Raw PDF bytes live in IndexedDB, keyed by URL. Same rule the old service-worker
    // cache used: a URL that is already stored is served from disk and never refetched;
    // only a *different* URL (link changed) is a fresh download. Unlike Cache Storage
    // this doesn't depend on the service worker being active, on the URL ending in
    // .pdf, or on the WebView keeping the cache around — and we ask the browser to
    // mark the storage persistent so it isn't evicted under storage pressure.
    const STORE_DB = 'ECampusPDFs';
    const STORE_NAME = 'pdfs';
    const STORE_UNTAGGED_LIMIT = 300 * 1024 * 1024; // FIFO-trim PDFs opened ad hoc beyond this; tagged sets are managed via prune()
    const LEGACY_CACHE = 'ecampus-pdf-cache-v1';     // old sw.js bucket — migrated on first open, then emptied

    let dbPromise = null;
    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve) => {
            try {
                const req = indexedDB.open(STORE_DB, 1);
                req.onupgradeneeded = () => {
                    if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME, { keyPath: 'url' });
                };
                req.onsuccess = () => {
                    const db = req.result;
                    db.onversionchange = () => { db.close(); dbPromise = null; };
                    resolve(db);
                };
                req.onerror = () => resolve(null);
                req.onblocked = () => resolve(null);
            } catch (e) { resolve(null); } // IndexedDB unavailable — viewer still works, just without persistence
        });
        return dbPromise;
    }

    // Runs fn(objectStore) in one transaction; resolves with the request's result, or
    // null if the transaction failed/aborted (e.g. quota exceeded).
    async function withStore(mode, fn) {
        const db = await openDb();
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const t = db.transaction(STORE_NAME, mode);
                let result = null;
                const req = fn(t.objectStore(STORE_NAME));
                if (req) req.onsuccess = () => { result = req.result; };
                t.oncomplete = () => resolve(result);
                t.onerror = () => resolve(null);
                t.onabort = () => resolve(null);
            } catch (e) { resolve(null); }
        });
    }
    const storeGetRec = (url) => withStore('readonly', os => os.get(url));
    const storePutRec = (rec) => withStore('readwrite', os => os.put(rec));
    const storeDelete = (url) => withStore('readwrite', os => os.delete(url));

    async function storeList() {
        const db = await openDb();
        if (!db) return [];
        return new Promise((resolve) => {
            const out = [];
            try {
                const t = db.transaction(STORE_NAME, 'readonly');
                const req = t.objectStore(STORE_NAME).openCursor();
                req.onsuccess = () => {
                    const c = req.result;
                    if (c) { const v = c.value; out.push({ url: v.url, size: v.size || 0, tag: v.tag, savedAt: v.savedAt || 0 }); c.continue(); }
                };
                t.oncomplete = () => resolve(out);
                t.onerror = () => resolve(out);
                t.onabort = () => resolve(out);
            } catch (e) { resolve(out); }
        });
    }

    let persistAsked = false;
    function askPersistent() {
        if (persistAsked) return;
        persistAsked = true;
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* not supported */ }
    }

    // Never store an error page / HTML body that happened to come back as 200 —
    // it would otherwise "open" forever as a broken PDF.
    async function looksLikePdf(blob) {
        try {
            const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
            for (let i = 0; i + 4 <= head.length; i++) {
                if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46) return true; // %PDF
            }
        } catch (e) { /* fall through */ }
        return false;
    }

    async function trimStore() {
        const all = await storeList();
        let total = all.reduce((n, r) => n + r.size, 0);
        if (total <= STORE_UNTAGGED_LIMIT) return;
        const victims = all.filter(r => !r.tag).sort((a, b) => a.savedAt - b.savedAt);
        for (const v of victims) {
            if (total <= STORE_UNTAGGED_LIMIT) break;
            await storeDelete(v.url);
            total -= v.size;
        }
    }

    async function saveBlob(url, blob, tag) {
        if (!(await looksLikePdf(blob))) return false;
        askPersistent();
        const ok = await storePutRec({ url, blob, size: blob.size, tag: tag || undefined, savedAt: Date.now() });
        if (ok) trimStore();
        return !!ok;
    }

    async function readLegacyCache(url) {
        try {
            if (!('caches' in window)) return null;
            const hit = await caches.match(url, { cacheName: LEGACY_CACHE });
            return hit ? await hit.blob() : null;
        } catch (e) { return null; }
    }

    // Blob for a URL that is NOT in the store yet: old SW cache first (free, local), else network.
    async function obtainBlob(url, onDownload) {
        const legacy = await readLegacyCache(url);
        if (legacy) return { blob: legacy, legacy: true };
        if (onDownload) onDownload();
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return { blob: await res.blob(), legacy: false };
    }

    // → { buf, fromStore }. Store hit = disk read only. Miss = fetch once, then persist.
    async function getPdfBytes(url, opts) {
        opts = opts || {};
        const rec = await storeGetRec(url);
        if (rec && rec.blob) {
            try { return { buf: await rec.blob.arrayBuffer(), fromStore: true }; }
            catch (e) { /* unreadable copy — drop it and fetch again below */ storeDelete(url); }
        }
        const got = await obtainBlob(url, opts.onDownload);
        saveBlob(url, got.blob, opts.tag).then(ok => {
            if (ok && got.legacy) { try { caches.open(LEGACY_CACHE).then(c => c.delete(url)).catch(() => {}); } catch (e) { /* ignore */ } }
        });
        return { buf: await got.blob.arrayBuffer(), fromStore: false };
    }

    // Download every URL that isn't stored yet (3 at a time — gentle on mobile data).
    // Already-stored URLs are left completely alone (only retagged if needed).
    async function prefetch(urls, opts) {
        opts = opts || {};
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        const list = [...new Set((urls || []).filter(Boolean))];
        let i = 0;
        async function worker() {
            while (i < list.length) {
                const url = list[i++];
                try {
                    const rec = await storeGetRec(url);
                    if (rec) {
                        if (opts.tag && rec.tag !== opts.tag) await storePutRec(Object.assign({}, rec, { tag: opts.tag }));
                        continue;
                    }
                    const got = await obtainBlob(url);
                    const ok = await saveBlob(url, got.blob, opts.tag);
                    if (ok && got.legacy) { try { const c = await caches.open(LEGACY_CACHE); await c.delete(url); } catch (e) { /* ignore */ } }
                } catch (e) { /* offline / dead link right now — try again next launch */ }
            }
        }
        await Promise.all(Array.from({ length: Math.min(opts.concurrency || 3, list.length) }, worker));
    }

    // Drop stored PDFs of a tag whose URL is no longer in keepUrls (the link changed).
    async function prune(tag, keepUrls) {
        const keep = new Set(keepUrls || []);
        const all = await storeList();
        for (const r of all) if (r.tag === tag && !keep.has(r.url)) await storeDelete(r.url);
    }

    window.pdfStore = {
        has: async (url) => !!(await storeGetRec(url)),
        prefetch,
        prune,
        remove: (url) => storeDelete(url)
    };

    // Plain geometric shapes (arrow / padlock / warning) — not a font
    // glyph, not anyone's creative work, just standard UI iconography
    // drawn inline so it renders identically regardless of what icon
    // font (if any) the host page has loaded.
    const ICON_BACK = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z"/></svg>';
    const ICON_LOCK = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5zM9 6a3 3 0 1 1 6 0v3H9zm3 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>';
    const ICON_ERROR = '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2zm0-4h-2V7h2z"/></svg>';

    let injected = false;
    function injectMarkup() {
        if (injected) return;
        injected = true;

        const style = document.createElement('style');
        style.textContent = `
            #pdfv-overlay { position: fixed; inset: 0; background: #202124; z-index: 99999; display: flex; flex-direction: column; font-family: inherit; --sat: var(--sat-raw, var(--safe-area-inset-top, env(safe-area-inset-top, 0px))); /* full screen: covers the offline strip, so only the status bar */ }
            #pdfv-overlay.hidden { display: none !important; }
            .pdfv-bar { flex-shrink: 0; display: flex; align-items: center; gap: 2px; min-height: 56px; padding: 0 4px; padding-top: var(--sat); background: #202124; color: #fff; }
            .pdfv-btn { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0; background: transparent; border: 0; }
            .pdfv-btn:active { background: rgba(255,255,255,.12); }
            .pdfv-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-left: 4px; }
            .pdfv-page { flex-shrink: 0; font-size: 12px; color: rgba(255,255,255,.65); padding: 0 8px; }
            .pdfv-lock { flex-shrink: 0; display: flex; align-items: center; color: rgba(255,255,255,.5); padding-right: 12px; }
            .pdfv-body { position: relative; flex: 1; overflow: auto; background: #525659; touch-action: pan-x pan-y; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; padding: 12px 12px 40px; }
            #pdfv-zoom-sizer { position: relative; }
            .pdfv-pages { display: flex; flex-direction: column; align-items: center; gap: 10px; transform-origin: 0 0; width: max-content; }
            .pdfv-shell { position: relative; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.45); overflow: hidden; }
            .pdfv-canvas { display: block; width: 100%; height: 100%; pointer-events: none; }
            .pdfv-status { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: #fff; font-size: 13px; text-align: center; padding: 0 30px; }
            .pdfv-spinner { width: 30px; height: 30px; border-radius: 50%; border: 3px solid rgba(255,255,255,.25); border-top-color: #fff; animation: pdfvspin .8s linear infinite; }
            @keyframes pdfvspin { to { transform: rotate(360deg); } }
            .pdfv-error-icon { color: #EA4335; }
            .pdfv-actions { display: flex; gap: 10px; margin-top: 4px; }
            .pdfv-status-btn { padding: 9px 16px; border-radius: 999px; background: rgba(255,255,255,.14); color: #fff; font-size: 13px; font-weight: 500; border: 0; }
            .pdfv-status-btn:active { background: rgba(255,255,255,.24); }
        `;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'pdfv-overlay';
        overlay.className = 'hidden';
        overlay.innerHTML = `
            <div class="pdfv-bar">
                <button class="pdfv-btn" id="pdfv-close" aria-label="Close">${ICON_BACK}</button>
                <div class="pdfv-title" id="pdfv-title">PDF</div>
                <div class="pdfv-page" id="pdfv-page"></div>
                <span class="pdfv-lock" title="Protected document">${ICON_LOCK}</span>
            </div>
            <div class="pdfv-body" id="pdfv-body">
                <div id="pdfv-zoom-sizer">
                    <div class="pdfv-pages" id="pdfv-pages"></div>
                </div>
                <div class="pdfv-status" id="pdfv-status"><div class="pdfv-spinner"></div><div>Opening PDF…</div></div>
            </div>
        `;
        document.body.appendChild(overlay);
        document.getElementById('pdfv-close').addEventListener('click', localClose);
        initZoomGestures();
    }

    let state = { doc: null, pageCount: 0, url: '', observer: null, rendered: null, scale: 1, naturalW: 0, naturalH: 0 };

    // ── In-memory parsed-document cache (this browsing session only) ──
    // The service worker (sw.js) already keeps every PDF's raw bytes in
    // Cache Storage forever, so after the first view a fetch() for the
    // same link never touches the network again — but pdf.js still has to
    // re-parse those bytes into a document on every open. That parse is
    // the only "loading" left once a PDF is cached, so we additionally
    // keep the parsed pdfjsLib document itself in memory, keyed by URL:
    // reopening the same PDF later in the same session skips fetch AND
    // parse entirely and goes straight to painting pages. Capped to the
    // last 25 PDFs viewed so memory doesn't grow unbounded; destroy()
    // on eviction releases pdf.js's internal buffers for the dropped one.
    const DOC_CACHE_LIMIT = 25;
    const docCache = new Map(); // url -> { doc, pageCount }

    function cacheDoc(url, doc) {
        if (docCache.has(url)) docCache.delete(url); // refresh recency
        docCache.set(url, { doc, pageCount: doc.numPages });
        while (docCache.size > DOC_CACHE_LIMIT) {
            const oldestUrl = docCache.keys().next().value;
            const evicted = docCache.get(oldestUrl);
            docCache.delete(oldestUrl);
            if (evicted && evicted.doc && evicted.doc !== doc) {
                try { evicted.doc.destroy(); } catch (e) { /* already gone */ }
            }
        }
    }

    // ── Local rendering (always runs in the actual top-level document —
    // either because this page isn't embedded, or because it received a
    // postMessage from an embedded child asking it to open one) ──
    async function localOpen(url, title, opts) {
        if (!url) return;
        if (document.body) injectMarkup();
        else { document.addEventListener('DOMContentLoaded', () => localOpen(url, title, opts)); return; }

        const overlay = document.getElementById('pdfv-overlay');
        const pages = document.getElementById('pdfv-pages');
        const sizer = document.getElementById('pdfv-zoom-sizer');
        if (state.observer) { state.observer.disconnect(); }
        state = { doc: null, pageCount: 0, url: url, observer: null, rendered: new Set(), scale: 1, naturalW: 0, naturalH: 0 };

        document.getElementById('pdfv-title').textContent = title || (url.split('/').pop().split('?')[0]) || 'PDF';
        document.getElementById('pdfv-page').textContent = '';
        pages.innerHTML = '';
        pages.style.transform = 'scale(1)';
        sizer.style.width = '';
        sizer.style.height = '';
        overlay.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        emit('open');
        // Through ScreenSecure (screen-privacy.js) so closing the viewer doesn't
        // switch off the admin's app-wide Full Privacy block; falls back to the
        // raw bridge if that module hasn't loaded.
        if (window.ScreenSecure) {
            window.ScreenSecure.hold('pdf');
        } else if (window.AndroidSecure && window.AndroidSecure.enable) {
            try { window.AndroidSecure.enable(); } catch (e) { /* older app build without the bridge */ }
        }

        // Already parsed earlier this session — skip fetch + parse, go
        // straight to painting. No spinner needed; it's instant.
        const hit = docCache.get(url);
        if (hit) {
            docCache.delete(url); docCache.set(url, hit); // bump recency
            state.doc = hit.doc;
            state.pageCount = hit.pageCount;
            try {
                await buildShells();
                hideStatus(); // clear any leftover spinner/error overlay from a previous PDF
                if (state.url === url) emit('ready'); // not if a newer open()/close() superseded this one
                return;
            } catch (err) {
                // Cached doc object went stale/unusable — fall through and re-fetch+parse below.
                docCache.delete(url);
            }
        }

        showStatus(`<div class="pdfv-spinner"></div><div>Opening PDF…</div>`);

        try {
            // Engine + bytes are needed together: start both now instead of one after the other.
            const onDownload = () => { if (state.url === url) showStatus(`<div class="pdfv-spinner"></div><div>Downloading PDF…</div>`); };
            const enginePromise = loadPdfJs();
            const bytesPromise = getPdfBytes(url, { tag: opts && opts.tag, onDownload });
            bytesPromise.catch(() => {}); // surfaced by the await below; avoids an unhandled-rejection race with enginePromise
            const pdfjsLib = await enginePromise;
            let got = await bytesPromise;

            let doc;
            try {
                doc = await pdfjsLib.getDocument({ data: got.buf }).promise;
            } catch (parseErr) {
                // A stored copy that won't parse is corrupt — discard it and fetch a clean one once.
                if (!got.fromStore) throw parseErr;
                await storeDelete(url);
                got = await getPdfBytes(url, { tag: opts && opts.tag, onDownload });
                doc = await pdfjsLib.getDocument({ data: got.buf }).promise;
            }
            if (state.url !== url) return; // superseded by a newer open() call
            state.doc = doc;
            state.pageCount = doc.numPages;
            cacheDoc(url, doc);
            await buildShells();
            hideStatus();
            if (state.url === url) emit('ready');
        } catch (err) {
            console.error('PDF load failed:', err);
            showStatus(`
                <span class="pdfv-error-icon">${ICON_ERROR}</span>
                <div>Couldn't load this PDF.</div>
                <div class="pdfv-actions"><button class="pdfv-status-btn" id="pdfv-retry">Retry</button></div>
            `);
            const retry = document.getElementById('pdfv-retry');
            if (retry) retry.addEventListener('click', () => localOpen(url, title, opts));
        }
    }

    function localClose() {
        emit('close');
        const overlay = document.getElementById('pdfv-overlay');
        if (overlay) overlay.classList.add('hidden');
        document.body.style.overflow = '';
        if (state.observer) state.observer.disconnect();
        state = { doc: null, pageCount: 0, url: '', observer: null, rendered: null };
        if (window.ScreenSecure) {
            window.ScreenSecure.release('pdf');
        } else if (window.AndroidSecure && window.AndroidSecure.disable) {
            try { window.AndroidSecure.disable(); } catch (e) { /* ignore */ }
        }
    }

    // ── Public API: forward to the top-level document when embedded,
    // otherwise render right here ──
    window.openPdfViewer = function (url, title, opts) {
        if (!url) return;
        if (isEmbedded) {
            try { window.top.postMessage({ __pdfViewer: true, action: 'open', url, title, opts }, '*'); return; }
            catch (e) { /* fall through and render locally as a last resort */ }
        }
        localOpen(url, title, opts);
    };

    window.closePdfViewer = function () {
        if (isEmbedded) {
            try { window.top.postMessage({ __pdfViewer: true, action: 'close' }, '*'); return; }
            catch (e) { /* fall through */ }
        }
        localClose();
    };

    // Warm-up: load the bundled pdf.js and open the store DB while the app is idle, so
    // the first PDF a student taps doesn't also pay for engine start-up.
    if (!isEmbedded) {
        const warm = () => { loadPdfJs().catch(() => {}); openDb(); };
        window.addEventListener('load', () => {
            if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 4000 });
            else setTimeout(warm, 2000);
        });
    }

    if (!isEmbedded) {
        window.addEventListener('message', (e) => {
            if (e.origin !== window.location.origin) return; // same-origin only — ignore anything from third-party content in other iframes (e.g. the in-app browser)
            const data = e.data;
            if (!data || typeof data !== 'object' || !data.__pdfViewer) return;
            if (data.action === 'open') localOpen(data.url, data.title, data.opts);
            else if (data.action === 'close') localClose();
        });
    }

    function showStatus(html) {
        const s = document.getElementById('pdfv-status');
        s.innerHTML = html;
        s.style.display = 'flex';
    }
    function hideStatus() { document.getElementById('pdfv-status').style.display = 'none'; }

    // Height of a page's shell when the page is scaled to the container width.
    function shellHeightFor(base, containerWidth) {
        return Math.round(base.height * (containerWidth / base.width));
    }

    // Paint fast: only page 1 is inspected up front. Every page gets a placeholder shell
    // of page 1's size (nearly every PDF has uniform pages), the observer starts
    // rendering what's on screen, and the remaining pages' real sizes are filled in in
    // the background (refineShellSizes) — instead of awaiting getPage() for ALL pages
    // (hundreds, for a big notes PDF) before showing anything.
    async function buildShells() {
        const wrap = document.getElementById('pdfv-pages');
        const body = document.getElementById('pdfv-body');
        const containerWidth = wrap.clientWidth || (body.clientWidth - 24);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const myUrl = state.url;

        const first = await state.doc.getPage(1);
        if (state.url !== myUrl) return; // viewer was closed/reopened mid-build
        const w = Math.round(containerWidth);
        const h = shellHeightFor(first.getViewport({ scale: 1 }), containerWidth);
        const frag = document.createDocumentFragment();
        for (let i = 1; i <= state.pageCount; i++) {
            const shell = document.createElement('div');
            shell.className = 'pdfv-shell';
            shell.dataset.page = i;
            shell.style.width = w + 'px';
            shell.style.height = h + 'px';
            frag.appendChild(shell);
        }
        wrap.appendChild(frag);
        // Baseline (scale-1) size of the content, so zooming can size the
        // sizer element to naturalSize * currentScale — that's what makes
        // .pdfv-body's native overflow: auto scrolling correctly reach the
        // zoomed-in content in both directions, with no custom pan code.
        state.naturalW = wrap.offsetWidth;
        state.naturalH = wrap.offsetHeight;
        const sizer = document.getElementById('pdfv-zoom-sizer');
        sizer.style.width = state.naturalW + 'px';
        sizer.style.height = state.naturalH + 'px';
        setupObserver(containerWidth, dpr, myUrl);
        updatePageIndicator();
        refineShellSizes(myUrl, containerWidth);
    }

    // Applies a page's true height to its shell (and the zoom sizer). If the shell is
    // above what the reader is looking at, scroll by the same amount so the view
    // doesn't jump.
    function fitShell(shell, base, containerWidth) {
        const h = shellHeightFor(base, containerWidth);
        const cur = parseFloat(shell.style.height) || 0;
        if (Math.abs(h - cur) <= 1) return;
        const body = document.getElementById('pdfv-body');
        const above = (shell.offsetTop + cur) * state.scale <= body.scrollTop;
        shell.style.height = h + 'px';
        state.naturalH = document.getElementById('pdfv-pages').offsetHeight;
        document.getElementById('pdfv-zoom-sizer').style.height = (state.naturalH * state.scale) + 'px';
        if (above) body.scrollTop += (h - cur) * state.scale;
    }

    async function refineShellSizes(myUrl, containerWidth) {
        for (let i = 2; i <= state.pageCount; i++) {
            if (state.url !== myUrl) return;
            try {
                const page = await state.doc.getPage(i);
                if (state.url !== myUrl) return;
                const shell = document.querySelector('.pdfv-shell[data-page="' + i + '"]');
                if (shell) fitShell(shell, page.getViewport({ scale: 1 }), containerWidth);
            } catch (e) { /* page unreadable — keep the placeholder size */ }
            if (i % 12 === 0) await new Promise(r => setTimeout(r, 0)); // let scrolling/rendering breathe
        }
    }

    function setupObserver(containerWidth, dpr, myUrl) {
        const shells = document.querySelectorAll('.pdfv-shell');
        state.observer = new IntersectionObserver((entries) => {
            if (state.url !== myUrl) return;
            entries.forEach(entry => {
                const num = parseInt(entry.target.dataset.page, 10);
                if (entry.isIntersecting && !state.rendered.has(num)) {
                    state.rendered.add(num);
                    renderInto(entry.target, num, containerWidth, dpr, myUrl);
                }
            });
            updatePageIndicator();
        }, { root: document.getElementById('pdfv-body'), rootMargin: '600px 0px', threshold: 0.01 });
        shells.forEach(s => state.observer.observe(s));

        const body = document.getElementById('pdfv-body');
        let ticking = false;
        body.addEventListener('scroll', () => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => { updatePageIndicator(); ticking = false; });
        }, { passive: true });
    }

    function renderInto(shell, num, containerWidth, dpr, myUrl) {
        state.doc.getPage(num).then(page => {
            if (state.url !== myUrl) return;
            const base = page.getViewport({ scale: 1 });
            fitShell(shell, base, containerWidth); // page may differ from the placeholder size
            const scale = (containerWidth / base.width) * dpr;
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.className = 'pdfv-canvas';
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.oncontextmenu = () => false;
            page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise.then(() => {
                if (state.url !== myUrl) return;
                shell.innerHTML = '';
                shell.appendChild(canvas);
            }).catch(e => console.error(e));
        }).catch(e => console.error(e));
    }

    function updatePageIndicator() {
        const body = document.getElementById('pdfv-body');
        const shells = document.querySelectorAll('.pdfv-shell');
        if (!shells.length) return;
        const bodyTop = body.getBoundingClientRect().top;
        let current = 1;
        for (const s of shells) {
            if (s.getBoundingClientRect().top - bodyTop < body.clientHeight * 0.4) current = parseInt(s.dataset.page, 10);
            else break;
        }
        document.getElementById('pdfv-page').textContent = current + ' / ' + state.pageCount;
    }

    // Sets scale, resizes the sizer to match (so .pdfv-body's native
    // overflow:auto scroll bounds correctly grow/shrink with it), and — if
    // an anchor point is given — adjusts scroll position so that the
    // content under the anchor point stays under it, instead of the view
    // jumping when the scale changes.
    function applyZoom(newScale, anchorClientX, anchorClientY) {
        const body = document.getElementById('pdfv-body');
        const pages = document.getElementById('pdfv-pages');
        const sizer = document.getElementById('pdfv-zoom-sizer');
        newScale = Math.max(1, Math.min(3, newScale));

        let contentX = null, contentY = null, originX = 0, originY = 0;
        if (anchorClientX != null) {
            const rect = body.getBoundingClientRect();
            originX = anchorClientX - rect.left;
            originY = anchorClientY - rect.top;
            contentX = (body.scrollLeft + originX) / state.scale;
            contentY = (body.scrollTop + originY) / state.scale;
        }

        state.scale = newScale;
        pages.style.transform = `scale(${newScale})`;
        sizer.style.width = (state.naturalW * newScale) + 'px';
        sizer.style.height = (state.naturalH * newScale) + 'px';

        if (contentX != null) {
            body.scrollLeft = contentX * newScale - originX;
            body.scrollTop = contentY * newScale - originY;
        }
    }

    // Pinch-zoom (anchored at the midpoint between the two fingers) +
    // double-tap-zoom (anchored at the tap point). Panning around zoomed
    // content is just native overflow:auto scrolling — applyZoom() keeps
    // the sizer element's size in sync with the current scale, so there's
    // no custom single-finger pan code needed at all.
    function initZoomGestures() {
        const body = document.getElementById('pdfv-body');
        let pinchStartDist = 0, pinchStartScale = 1, lastTapTime = 0, lastTapX = 0, lastTapY = 0;
        const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

        body.addEventListener('touchstart', e => {
            if (e.touches.length === 2) {
                pinchStartDist = dist(e.touches[0], e.touches[1]);
                pinchStartScale = state.scale;
            }
        }, { passive: true });

        body.addEventListener('touchmove', e => {
            if (e.touches.length === 2 && pinchStartDist > 0) {
                e.preventDefault();
                const m = mid(e.touches[0], e.touches[1]);
                const newScale = pinchStartScale * (dist(e.touches[0], e.touches[1]) / pinchStartDist);
                applyZoom(newScale, m.x, m.y);
            }
        }, { passive: false });

        body.addEventListener('touchend', e => {
            if (e.changedTouches.length === 1 && e.touches.length === 0) {
                const now = Date.now();
                const x = e.changedTouches[0].clientX, y = e.changedTouches[0].clientY;
                if (now - lastTapTime < 300 && Math.hypot(x - lastTapX, y - lastTapY) < 30) {
                    applyZoom(state.scale > 1 ? 1 : 2.2, x, y);
                    lastTapTime = 0;
                } else {
                    lastTapTime = now; lastTapX = x; lastTapY = y;
                }
            }
        });
    }
})();
