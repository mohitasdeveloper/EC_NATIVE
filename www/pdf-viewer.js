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

   Cross-frame: when this script runs inside an iframe (e.g. the BAFs
   study planner, embedded in the main app), a fixed-position overlay
   would only ever cover that iframe's own box, not the real device
   screen. So when embedded, open()/close() are forwarded via
   postMessage to window.top instead, and the actual top-level page
   (which also includes this same script) renders the overlay itself —
   genuinely full-screen, while the iframe/host page underneath it is
   otherwise unaffected. Loaded directly (not in a frame), it just
   renders locally as normal.
   ══════════════════════════════════════════════════════════════════ */
(function () {
    if (window.openPdfViewer) return; // already installed on this page

    const isEmbedded = (function () {
        try { return window.top !== window.self; } catch (e) { return true; }
    })();

    const PDFJS_VERSION = '3.11.174';
    const PDFJS_SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
    const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;

    let pdfjsReady = null;
    function loadPdfJs() {
        if (pdfjsReady) return pdfjsReady;
        pdfjsReady = new Promise((resolve, reject) => {
            if (window.pdfjsLib) {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
                resolve(window.pdfjsLib);
                return;
            }
            const s = document.createElement('script');
            s.src = PDFJS_SRC;
            s.onload = () => {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
                resolve(window.pdfjsLib);
            };
            s.onerror = () => reject(new Error('pdf.js failed to load'));
            document.head.appendChild(s);
        });
        return pdfjsReady;
    }

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
            #pdfv-overlay { position: fixed; inset: 0; background: #202124; z-index: 99999; display: flex; flex-direction: column; font-family: inherit; }
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

    // ── Local rendering (always runs in the actual top-level document —
    // either because this page isn't embedded, or because it received a
    // postMessage from an embedded child asking it to open one) ──
    async function localOpen(url, title) {
        if (!url) return;
        if (document.body) injectMarkup();
        else { document.addEventListener('DOMContentLoaded', () => localOpen(url, title)); return; }

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
        showStatus(`<div class="pdfv-spinner"></div><div>Opening PDF…</div>`);
        overlay.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        if (window.AndroidSecure && window.AndroidSecure.enable) {
            try { window.AndroidSecure.enable(); } catch (e) { /* older app build without the bridge */ }
        }

        try {
            const pdfjsLib = await loadPdfJs();
            const res = await fetch(url);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const buf = await res.arrayBuffer();
            const doc = await pdfjsLib.getDocument({ data: buf }).promise;
            if (state.url !== url) return; // superseded by a newer open() call
            state.doc = doc;
            state.pageCount = doc.numPages;
            await buildShells();
            hideStatus();
        } catch (err) {
            console.error('PDF load failed:', err);
            const safeTitle = JSON.stringify(title || '');
            const safeUrl = JSON.stringify(url);
            showStatus(`
                <span class="pdfv-error-icon">${ICON_ERROR}</span>
                <div>Couldn't load this PDF.</div>
                <div class="pdfv-actions"><button class="pdfv-status-btn" onclick='window.openPdfViewer(${safeUrl}, ${safeTitle})'>Retry</button></div>
            `);
        }
    }

    function localClose() {
        const overlay = document.getElementById('pdfv-overlay');
        if (overlay) overlay.classList.add('hidden');
        document.body.style.overflow = '';
        if (state.observer) state.observer.disconnect();
        state = { doc: null, pageCount: 0, url: '', observer: null, rendered: null };
        if (window.AndroidSecure && window.AndroidSecure.disable) {
            try { window.AndroidSecure.disable(); } catch (e) { /* ignore */ }
        }
    }

    // ── Public API: forward to the top-level document when embedded,
    // otherwise render right here ──
    window.openPdfViewer = function (url, title) {
        if (!url) return;
        if (isEmbedded) {
            try { window.top.postMessage({ __pdfViewer: true, action: 'open', url, title }, '*'); return; }
            catch (e) { /* fall through and render locally as a last resort */ }
        }
        localOpen(url, title);
    };

    window.closePdfViewer = function () {
        if (isEmbedded) {
            try { window.top.postMessage({ __pdfViewer: true, action: 'close' }, '*'); return; }
            catch (e) { /* fall through */ }
        }
        localClose();
    };

    if (!isEmbedded) {
        window.addEventListener('message', (e) => {
            if (e.origin !== window.location.origin) return; // same-origin only — ignore anything from third-party content in other iframes (e.g. the in-app browser)
            const data = e.data;
            if (!data || typeof data !== 'object' || !data.__pdfViewer) return;
            if (data.action === 'open') localOpen(data.url, data.title);
            else if (data.action === 'close') localClose();
        });
    }

    function showStatus(html) {
        const s = document.getElementById('pdfv-status');
        s.innerHTML = html;
        s.style.display = 'flex';
    }
    function hideStatus() { document.getElementById('pdfv-status').style.display = 'none'; }

    async function buildShells() {
        const wrap = document.getElementById('pdfv-pages');
        const body = document.getElementById('pdfv-body');
        const containerWidth = wrap.clientWidth || (body.clientWidth - 24);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const myUrl = state.url;

        for (let i = 1; i <= state.pageCount; i++) {
            if (state.url !== myUrl) return; // viewer was closed/reopened mid-build
            const page = await state.doc.getPage(i);
            const base = page.getViewport({ scale: 1 });
            const scale = containerWidth / base.width;
            const shell = document.createElement('div');
            shell.className = 'pdfv-shell';
            shell.dataset.page = i;
            shell.style.width = Math.round(base.width * scale) + 'px';
            shell.style.height = Math.round(base.height * scale) + 'px';
            wrap.appendChild(shell);
        }
        if (state.url !== myUrl) return;
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
