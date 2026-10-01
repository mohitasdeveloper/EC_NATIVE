// bafs.js — the BAFs App, rendered natively inside the Search tab.
//
// This replaces the old <iframe src="bafs-study-planner.html">. The app now lives in
// the same document as everything else, so:
//   - it scrolls with the page (no boxed-in 70vh iframe with its own inner scroller),
//   - the full-screen PDF viewer, back button, verification gate and toasts are called
//     directly instead of through postMessage / window.parent / iframe.contentWindow,
//   - its data is cached (localStorage) so a re-open paints instantly and works offline,
//     then refreshes from Supabase in the background.
//
// Icons come from the app's bundled Material Symbols Outlined font, so the whole
// screen (icons included) works with no internet.
//
// Isolation is by scoping instead of by iframe: every selector in bafs.css starts with
// #bafs-root, every id in the markup is bafs-*, keyframes are bafs-*, and all lookups
// below are scoped to the mounted root, so nothing can collide with the main app.
//
// Data still comes from the BAFs app's OWN Supabase project (anon key, no auth) — that
// is unchanged. Remove the pill in index.html, the 'bafs' branch in search.js, this file
// and bafs.css together once exam season is over.
import { showToast } from './ui.js';

const SUPABASE_URL = 'https://bhapahazfsxtozpuftvm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_hQXxIGqbJGE_8OXYzymg6g_IRbbtWal';
const DATA_CACHE_KEY = 'bafs_data_v1';
const PDF_TAG = 'bafs'; // groups BAFs PDFs in window.pdfStore so a changed link can drop its old copy
const CSS_HREF = new URL('bafs.css', import.meta.url).href;

const TEMPLATE = `
<div id="bafs-body">
    <div class="view active" id="bafs-view-home">
      <div class="sec-head">
        <div class="sec-head-title">Next Exam</div>
        <div class="sec-head-action" data-nav="tt">See all<span class="msr">chevron_right</span></div>
      </div>
      <div class="countdown-card">
        <div class="cd-banner">
          <div class="cd-banner-eyebrow"><span class="msr">timer</span>Countdown<span class="cd-widget-btn" data-widget title="Add countdown widget to home screen"><span class="msr">widgets</span></span></div>
          <div class="cd-banner-name" id="bafs-cd-name">Loading…</div>
          <div class="cd-banner-meta"><span class="msr">event</span><span id="bafs-cd-meta"></span></div>
        </div>
        <div class="cd-body">
          <div class="cd-tiles">
            <div class="cd-tile"><div class="cd-num" id="bafs-cd-d">--</div><div class="cd-unit">Days</div></div>
            <div class="cd-tile"><div class="cd-num" id="bafs-cd-h">--</div><div class="cd-unit">Hours</div></div>
            <div class="cd-tile"><div class="cd-num" id="bafs-cd-m">--</div><div class="cd-unit">Mins</div></div>
            <div class="cd-tile"><div class="cd-num" id="bafs-cd-s">--</div><div class="cd-unit">Secs</div></div>
          </div>
          <div class="cd-progress-row">
            <div class="cd-track"><div class="cd-fill" id="bafs-cd-bar" style="width:0%"></div></div>
            <div class="cd-pct" id="bafs-cd-pct">0%</div>
          </div>
        </div>
      </div>
      <div class="sec-head"><div class="sec-head-title">Resources</div></div>
      <div class="quick-grid">
        <div class="qg-card" data-nav="qbank"><div class="qg-icon" style="background:var(--md-primary-dim);"><span class="msr s28 w300" style="color:var(--md-primary);">quiz</span></div><div class="qg-label">Question Bank</div></div>
        <div class="qg-card" data-nav="pyq"><div class="qg-icon" style="background:#FCE8E6;"><span class="msr s28 w300" style="color:#EA4335;">history_edu</span></div><div class="qg-label">PYQ Papers</div></div>
        <div class="qg-card" data-nav="syllabus"><div class="qg-icon" style="background:#E6F4EA;"><span class="msr s28 w300" style="color:#34A853;">checklist</span></div><div class="qg-label">Syllabus</div></div>
        <div class="qg-card" data-nav="pattern"><div class="qg-icon" style="background:#FEF7E0;"><span class="msr s28 w300" style="color:#B06000;">bar_chart</span></div><div class="qg-label">Paper Pattern</div></div>
        <div class="qg-card" data-nav="notes"><div class="qg-icon" style="background:#F3E8FD;"><span class="msr s28 w300" style="color:#A142F4;">sticky_note_2</span></div><div class="qg-label">Notes</div></div>
        <div class="qg-card" data-nav="tt"><div class="qg-icon" style="background:var(--md-primary-dim);"><span class="msr s28 w300" style="color:var(--md-primary);">calendar_month</span></div><div class="qg-label">Timetable</div></div>
      </div>
      <div class="sec-head">
        <div class="sec-head-title">All Exams</div>
        <div class="sec-head-action" data-nav="tt">Timetable<span class="msr">arrow_forward</span></div>
      </div>
      <div class="exam-list" id="bafs-home-exams"></div>
      <div class="pb16"></div>
    </div>
    <div class="view" id="bafs-view-search">
      <div class="search-header">
        <div class="icon-btn" data-back><span class="msr">arrow_back</span></div>
        <input type="text" id="bafs-search-input" placeholder="Search papers, topics, notes..." autocomplete="off">
      </div>
      <div style="height:12px;"></div>
      <div class="list-section" id="bafs-search-results">
        <div class="empty-state">Type to search across everything.</div>
      </div>
    </div>
    <div class="view" id="bafs-view-tt">
      <div class="view-strip" style="background:var(--md-primary);color:#fff;">
        <div class="vs-top-row">
          <div>
            <div class="vs-eyebrow">Exam Schedule</div>
            <div class="vs-title" id="bafs-tt-title">Loading...</div>
          </div>
          <div class="icon-btn" data-back style="margin:-8px -8px 0 0;"><span class="msr">close</span></div>
        </div>
        <div class="vs-sub">Track your upcoming dates</div>
      </div>
      <div class="tt-list" id="bafs-tt-cards"></div>
    </div>
    <div class="view" id="bafs-view-qbank">
      <div class="view-strip" style="background:var(--md-primary);color:#fff;">
        <div class="vs-top-row">
          <div><div class="vs-eyebrow">Study Tool</div><div class="vs-title">Question Bank</div></div>
          <div class="icon-btn" data-back style="margin:-8px -8px 0 0;"><span class="msr">close</span></div>
        </div>
        <div class="vs-sub">Important questions per paper</div>
      </div>
      <div class="sub-tabs" id="bafs-qbank-tabs"></div><div style="height:8px;"></div>
      <div class="notes-wrap" id="bafs-qbank-list"></div><div class="pb16"></div>
    </div>
    <div class="view" id="bafs-view-pyq">
      <div class="view-strip" style="background:#EA4335;color:#fff;">
        <div class="vs-top-row">
          <div><div class="vs-eyebrow">Practice</div><div class="vs-title">Past Papers</div></div>
          <div class="icon-btn" data-back style="margin:-8px -8px 0 0;"><span class="msr">close</span></div>
        </div>
        <div class="vs-sub">Real exam papers from past years</div>
      </div>
      <div class="year-scroller" id="bafs-pyq-years"></div>
      <div class="list-section" id="bafs-pyq-list"></div>
    </div>
    <div class="view" id="bafs-view-syllabus">
      <div class="view-strip" style="background:#34A853;color:#fff;">
        <div class="vs-top-row">
          <div><div class="vs-eyebrow">Reference</div><div class="vs-title">Syllabus</div></div>
          <div class="icon-btn" data-back style="margin:-8px -8px 0 0;"><span class="msr">close</span></div>
        </div>
        <div class="vs-sub">Unit-wise topics for all papers</div>
      </div>
      <div class="sub-tabs" id="bafs-syl-tabs"></div><div style="height:8px;"></div>
      <div class="g-accordion" id="bafs-syl-acc"></div><div class="pb16"></div>
    </div>
    <div class="view" id="bafs-view-pattern">
      <div class="view-strip" style="background:#F9AB00;color:#202124;">
        <div class="vs-top-row">
          <div><div class="vs-eyebrow" style="color:#5F6368;">Reference</div><div class="vs-title">Paper Pattern</div></div>
          <div class="icon-btn" data-back style="margin:-8px -8px 0 0;"><span class="msr">close</span></div>
        </div>
        <div class="vs-sub" style="opacity:.7;">Marks scheme & exam structure</div>
      </div>
      <div style="height:12px;"></div>
      <div class="list-section" id="bafs-pattern-list"></div><div class="pb16"></div>
    </div>
    <div class="view" id="bafs-view-notes">
      <div class="view-strip" style="background:#A142F4;color:#fff;">
        <div class="vs-top-row">
          <div><div class="vs-eyebrow">Study Material</div><div class="vs-title">Notes</div></div>
          <div class="icon-btn" data-back style="margin:-8px -8px 0 0;"><span class="msr">close</span></div>
        </div>
        <div class="vs-sub">Chapter-wise revision material</div>
      </div>
      <div class="sub-tabs" id="bafs-notes-tabs"></div><div style="height:8px;"></div>
      <div class="notes-wrap" id="bafs-notes-list"></div><div class="pb16"></div>
    </div>
  </div>
  <div id="bafs-gate" role="dialog" aria-modal="true" aria-labelledby="bafs-gate-title">
    <div class="gate-card">
      <div class="gate-badge"><span class="msr" id="bafs-gate-icon">lock</span></div>
      <div class="gate-eyebrow">Verified students only</div>
      <div class="gate-title" id="bafs-gate-title">Verify to unlock</div>
      <div class="gate-sub" id="bafs-gate-sub">Confirm your student ID to open the BAFs App.</div>
      <div class="gate-perks"><span>Question Bank</span><span>PYQ Papers</span><span>Notes</span><span>Paper Pattern</span></div>
      <button class="gate-btn" id="bafs-gate-btn" type="button"><span class="msr" id="bafs-gate-btn-icon">verified_user</span><span id="bafs-gate-btn-text">Verify now</span></button>
      <div class="gate-foot" id="bafs-gate-foot">Takes a minute · just your college ID</div>
    </div>
  </div>
`;

/* ═══════════════════════════════════════
   STATE
═══════════════════════════════════════ */
let root = null;          // #bafs-root while mounted, else null
let sb = null;            // Supabase client (BAFs project) — created once, reused
let mountToken = 0;       // bumped on every mount/unmount so late async work can tell it is stale
let loadToken = 0;
let timers = [];
let cleanups = [];
let viewStack = ['home'];
let gateShown = null;
let warmingPdfs = false;
let lastPayloadJson = '';
let EXAMS = [], QBANK = [], NOTES = [], SYLLABUS = [], PYQS = [], PYQ_YEARS = [];
let qbankTab = '', sylTab = '', notesTab = '', pyqYear = '';

/* ═══════════════════════════════════════
   UTILS  (all DOM lookups are scoped to the mounted root)
═══════════════════════════════════════ */
const $  = s => (root ? root.querySelector(s) : null);
const $$ = s => (root ? [...root.querySelectorAll(s)] : []);
const pad = n => String(n).padStart(2,'0');

function parseTime(timeStr) {
  const match = timeStr.match(/(\d+):(\d+)\s*(a\.m\.|p\.m\.|am|pm)/i);
  if(!match) return '00:00:00';
  let h = parseInt(match[1]), m = match[2], p = match[3].toLowerCase();
  if(p.includes('p') && h < 12) h += 12;
  if(p.includes('a') && h === 12) h = 0;
  return String(h).padStart(2, '0') + ':' + m + ':00';
}

const isDone = e => new Date() > e.dt;
const getNext = () => EXAMS.find(e => !isDone(e)) || EXAMS[EXAMS.length - 1];

function getDisplayDate(dateStr) {
  const d = new Date(dateStr);
  return { dayNum: d.getDate(), monthStr: d.toLocaleString('en-US', { month: 'short' }), full: d.toLocaleString('en-US', { day: 'numeric', month: 'long', year: 'numeric' }) };
}

function addRipple(el, color = 'rgba(0,0,0,.07)') {
  el.style.position = 'relative'; el.style.overflow = 'hidden';
  el.addEventListener('pointerdown', ev => {
    const rect = el.getBoundingClientRect(), size = Math.max(rect.width, rect.height) * 2.2;
    const r = Object.assign(document.createElement('span'), { style: `position:absolute;border-radius:50%;pointer-events:none;width:${size}px;height:${size}px;left:${ev.clientX - rect.left - size/2}px;top:${ev.clientY - rect.top - size/2}px;background:${color};transform:scale(0);animation:bafs-ripple .5s ease-out forwards` });
    el.append(r); setTimeout(() => r.remove(), 600);
  });
}


// Same on-screen feedback as everywhere else in the app (the standalone page had its own snackbar).
function toast(msg, icon = 'info') {
  showToast(msg, icon === 'error' ? 'error' : icon === 'lock' ? 'warning' : 'info');
}

/* ═══════════════════════════════════════
   PDFS  — stored on the device by pdf-viewer.js (window.pdfStore), so they open
   instantly and offline, even after the app has been closed and reopened.
═══════════════════════════════════════ */
// Downloads every BAFs PDF (notes / qbank / previous-year papers) that isn't on the
// device yet, so they all open offline — not just ones already viewed. An already-stored
// URL is never touched again; only a changed link is a new download, and the copy of
// the link it replaced is dropped.
async function warmPdfCache() {
  if (warmingPdfs || !isUnlocked() || !window.pdfStore) return; // don't spend a locked user's data
  const urls = [...new Set([...NOTES, ...QBANK, ...PYQS].map(x => x.pdf_url).filter(Boolean))];
  if (!urls.length) return;
  warmingPdfs = true;
  try {
    await window.pdfStore.prefetch(urls, { tag: PDF_TAG });
    await window.pdfStore.prune(PDF_TAG, urls);
  } catch (e) { /* storage unavailable — PDFs still open fine online */ }
  finally { warmingPdfs = false; }
}

// Delegates to the shared full-screen viewer (pdf-viewer.js) — locked down, no
// download/export, never navigates the WebView to the PDF URL itself.
function openPdf(url, title) {
  if (!isUnlocked()) { applyGate(); return; }
  if (!url) { toast('PDF link not available', 'error'); return; }
  window.openPdfViewer(url, title, { tag: PDF_TAG });
}

/* ═══════════════════════════════════════
   VERIFIED-ONLY GATE
   Status comes straight from main.js (window.getVerificationStatus), falling back to
   the profile cache it keeps in localStorage. Anything other than 'verified' is
   locked. NOTE: this is a UI gate, not a security boundary — the BAFs tables are
   readable with the public anon key.
═══════════════════════════════════════ */
function getVerifStatus() {
  try {
    if (typeof window.getVerificationStatus === 'function') {
      const st = window.getVerificationStatus();
      if (st !== undefined) return st;
    }
  } catch (e) { /* fall through to the cache */ }
  try {
    const c = JSON.parse(localStorage.getItem('ecampus_profile_cache') || 'null');
    return c ? c.verification_status : null;
  } catch (e) { return null; }
}
const isUnlocked = () => getVerifStatus() === 'verified';

const GATE_COPY = {
  pending:  { icon: 'hourglass_top', title: 'Verification in review', sub: 'Your ID is with our team. The BAFs App unlocks the moment you are approved.', btn: 'View status', btnIcon: 'schedule', foot: 'You will be unlocked automatically' },
  rejected: { icon: 'lock', title: 'Verification needs attention', sub: 'We could not verify your ID. Re-submit your details to unlock the BAFs App.', btn: 'Re-verify now', btnIcon: 'verified_user', foot: 'Takes a minute · just your college ID' },
  none:     { icon: 'lock', title: 'Verify to unlock', sub: 'The BAFs App is for verified students. Confirm your student ID to get full access.', btn: 'Verify now', btnIcon: 'verified_user', foot: 'Takes a minute · just your college ID' },
};

function applyGate() {
  if (!root) return;
  const st = getVerifStatus();
  if (st === 'verified') {
    if (gateShown !== false) {
      const wasLocked = root.classList.contains('locked');
      root.classList.remove('locked');
      if (wasLocked) {
        root.classList.add('unlocking');
        const r = root;
        setTimeout(() => r.classList.remove('unlocking'), 400);
        warmPdfCache(); // just got unlocked — grab anything that isn't on the device yet
      }
      gateShown = false;
    }
    return;
  }
  const c = GATE_COPY[st === 'pending' ? 'pending' : st === 'rejected' ? 'rejected' : 'none'];
  $('#bafs-gate-icon').textContent = c.icon;
  $('#bafs-gate-title').textContent = c.title;
  $('#bafs-gate-sub').textContent = c.sub;
  $('#bafs-gate-btn-text').textContent = c.btn;
  $('#bafs-gate-btn-icon').textContent = c.btnIcon;
  $('#bafs-gate-foot').textContent = c.foot;
  root.classList.add('locked');
  gateShown = true;
}

// Opens the same full-screen verification view the app's banner opens.
function openVerification() {
  const v = document.getElementById('view-verification');
  if (v) { v.classList.replace('hidden', 'flex'); return; }
  toast('Open your profile to verify your ID', 'lock');
}

const PP_IMAGES = {
  "Financial Accounting - V": "https://i.ibb.co/Fky8nL0K/image.png",
  "Corporate Financial Reporting - I": "https://i.ibb.co/YTjx578q/image.png",
  "IKS": "https://i.ibb.co/vCRsQNCP/image.png",
  "SRS": "https://i.ibb.co/fVCMggHb/image.png",
  "Direct and Indirect Tax – I": "https://i.ibb.co/d03xsw7G/image.png",
  "FMM": "https://i.ibb.co/YTjx578q/image.png"
};
const PP_ALIASES = {
  // 'exam short_name or paper (any case)': 'title exactly as in PP_IMAGES'
};
const ppKey = t => String(t || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

function findPatternUrl(exam) {
  const alias = Object.keys(PP_ALIASES).find(k => ppKey(k) === ppKey(exam.short_name) || ppKey(k) === ppKey(exam.paper));
  if (alias && PP_IMAGES[PP_ALIASES[alias]]) return PP_IMAGES[PP_ALIASES[alias]];
  const paper = ppKey(exam.paper), short = ppKey(exam.short_name);
  const titles = Object.keys(PP_IMAGES);
  const hit =
    titles.find(t => ppKey(t) === paper) ||                                   // exact paper name
    (short && titles.find(t => ppKey(t) === short)) ||                        // short name, e.g. FMM
    titles.find(t => paper && (ppKey(t).includes(paper) || paper.includes(ppKey(t))));
  return hit ? PP_IMAGES[hit] : null;
}


function openPattern(exam) {
  if (!isUnlocked()) { applyGate(); return; }
  const url = findPatternUrl(exam);
  if (!url) { toast('Paper pattern not uploaded yet', 'info'); return; }
  const title = exam.paper + ' – Paper Pattern';
  if (typeof window.openServiceLink === 'function') { window.openServiceLink(url, true, title, { plain: true }); return; }
  window.open(url, '_blank');
}

/* ═══════════════════════════════════════
   NAVIGATION
   Internal view stack instead of history.pushState: the standalone page could use its
   own iframe history, but in the main document that would mix with the app's own
   history/back handling. main.js's back handler calls bafsIsAtHome()/bafsGoBack().
═══════════════════════════════════════ */
function showView(view) {
  $$('.view').forEach(v => v.classList.remove('active'));
  const el = $(`#bafs-view-${view}`);
  if (el) el.classList.add('active');
  window.scrollTo(0, 0);
  if (view === 'search') setTimeout(() => { const i = $('#bafs-search-input'); if (i) i.focus(); }, 100);
}

function navTo(view) {
  if (viewStack[viewStack.length - 1] === view) return;
  viewStack.push(view);
  showView(view);
}

export function bafsIsAtHome() { return viewStack.length <= 1; }
export function bafsGoBack() {
  if (viewStack.length <= 1) return;
  viewStack.pop();
  showView(viewStack[viewStack.length - 1]);
}

/* ═══════════════════════════════════════
   COUNTDOWN
═══════════════════════════════════════ */
function tickCD() {
  if(!EXAMS.length) return;
  const next = getNext(), now = new Date(), diff = next.dt - now;
  $('#bafs-cd-name').textContent = next.paper;
  $('#bafs-cd-meta').textContent = `${next.exam_day}, ${getDisplayDate(next.exam_date).full}  ·  ${next.start_time} – ${next.end_time}`;
  
  if (diff <= 0) {
    ['cd-d','cd-h','cd-m','cd-s'].forEach(id => $('#bafs-'+id).textContent = '00');
  } else {
    $('#bafs-cd-d').textContent = pad(Math.floor(diff / 86400000));
    $('#bafs-cd-h').textContent = pad(Math.floor((diff % 86400000) / 3600000));
    $('#bafs-cd-m').textContent = pad(Math.floor((diff % 3600000)  / 60000));
    $('#bafs-cd-s').textContent = pad(Math.floor((diff % 60000)    / 1000));
  }
  
  // PROGRESS BAR: Based on completed exams vs total exams
  const totalExams = EXAMS.length;
  const completedExams = EXAMS.filter(e => isDone(e)).length;
  const pct = totalExams > 0 ? (completedExams / totalExams) * 100 : 0;
  
  $('#bafs-cd-bar').style.width = pct.toFixed(1) + '%';
  $('#bafs-cd-pct').textContent = Math.round(pct) + '%';
}
function addCountdownWidget() {
  if (window.AndroidWidgetPin && window.AndroidWidgetPin.requestPin) {
    try { window.AndroidWidgetPin.requestPin(); } catch (e) { /* older app build without the bridge */ }
  } else {
    alert('Home screen widgets are available in the ECampus Android app.');
  }
}
function showShimmers() {
  const noteShimmer = `<div class="note-card" style="box-shadow:none; border:1px solid var(--md-outline);"><div class="note-icon shimmer-bg"></div><div class="note-body"><div class="shimmer-bg" style="height:14px; width:70%; border-radius:4px; margin-bottom:6px;"></div><div class="shimmer-bg" style="height:12px; width:40%; border-radius:4px;"></div></div></div>`.repeat(4);
  const listShimmer = `<div class="g-item" style="box-shadow:none; border:1px solid var(--md-outline);"><div class="gi-lead shimmer-bg" style="border-radius:var(--radius-md);"></div><div class="gi-body"><div class="shimmer-bg" style="height:14px; width:70%; border-radius:4px; margin-bottom:6px;"></div><div class="shimmer-bg" style="height:12px; width:40%; border-radius:4px;"></div></div></div>`.repeat(4);
  const examShimmer = `<div class="exam-card" style="box-shadow:none; border:1px solid var(--md-outline);"><div class="ec-date shimmer-bg"></div><div class="ec-info"><div class="shimmer-bg" style="height:14px; width:80%; border-radius:4px; margin-bottom:6px;"></div><div class="shimmer-bg" style="height:12px; width:50%; border-radius:4px;"></div></div></div>`.repeat(3);
  const tabShimmer = `<div style="display:flex; gap:8px; padding:14px 16px;"><div class="shimmer-bg" style="height:20px; width:60px; border-radius:4px;"></div><div class="shimmer-bg" style="height:20px; width:60px; border-radius:4px;"></div><div class="shimmer-bg" style="height:20px; width:60px; border-radius:4px;"></div></div>`;

  $('#bafs-cd-name').innerHTML = '<div class="shimmer-bg-dark" style="height:20px; width:60%; border-radius:4px; margin:2px 0;"></div>';
  $('#bafs-cd-meta').innerHTML = '<div class="shimmer-bg-dark" style="height:14px; width:40%; border-radius:4px;"></div>';
  $('#bafs-home-exams').innerHTML = examShimmer;
  $('#bafs-tt-cards').innerHTML = examShimmer;
  $('#bafs-qbank-tabs').innerHTML = tabShimmer;
  $('#bafs-qbank-list').innerHTML = noteShimmer;
  $('#bafs-pyq-list').innerHTML = listShimmer;
  $('#bafs-pattern-list').innerHTML = listShimmer;
  $('#bafs-syl-tabs').innerHTML = tabShimmer;
  $('#bafs-syl-acc').innerHTML = listShimmer;
  $('#bafs-notes-tabs').innerHTML = tabShimmer;
  $('#bafs-notes-list').innerHTML = noteShimmer;
}


/* ═══════════════════════════════════════
   RENDER UI
═══════════════════════════════════════ */
function renderHomeExams() {
  const wrap = $('#bafs-home-exams'); wrap.innerHTML = '';
  const next = getNext();
  EXAMS.forEach(e => {
    const done = isDone(e), isNext = e.id === next.id && !done;
    const dObj = getDisplayDate(e.exam_date);
    const card = document.createElement('div');
    card.className = 'exam-card' + (done ? ' done' : '');
    card.innerHTML = `<div class="ec-date" style="background:${done?'#F1F3F4':e.dim};"><div class="ec-day" style="color:${done?'#9AA0A6':e.color};">${dObj.dayNum}</div><div class="ec-month" style="color:${done?'#9AA0A6':e.color};">${dObj.monthStr}</div></div><div class="ec-info"><div class="ec-paper">${e.paper}</div><div class="ec-sub">${e.exam_day} · ${e.start_time} – ${e.end_time}</div></div><div class="ec-right"><div class="ec-cred" style="background:${done?'#F1F3F4':e.dim};color:${done?'#9AA0A6':e.color};">${done ? 'Done' : e.credits+' Cr'}</div>${isNext ? `<div class="pulse-dot pulse" style="background:${e.color};"></div>` : ''}</div>`;
    card.onclick = () => navTo('tt');
    addRipple(card); wrap.appendChild(card);
  });
}

function renderTT() {
  const wrap = $('#bafs-tt-cards'); wrap.innerHTML = '';
  const next = getNext();
  if (EXAMS.length > 0) $('#bafs-tt-title').textContent = `${EXAMS.length} Papers Schedule`;

  EXAMS.forEach(e => {
    const done = isDone(e), isNext = e.id === next.id && !done;
    const dObj = getDisplayDate(e.exam_date);
    let badgeTxt = done ? 'Completed' : (isNext ? 'Next Up' : 'Upcoming');
    let badgeStyle = done ? 'background:#F1F3F4;color:#9AA0A6;' : (isNext ? `background:${e.color};color:#fff;` : `background:${e.dim};color:${e.txt};`);
    
    const card = document.createElement('div'); card.className = 'tt-card';
    card.innerHTML = `<div class="tt-inner"><div class="tt-bar" style="background:${done?'#DADCE0':e.color};"></div><div class="tt-body"><div class="tt-top"><div class="tt-paper" style="opacity:${done?.6:1};">${e.paper}</div><div class="tt-badge ${isNext?'pulse':''}" style="${badgeStyle}">${badgeTxt}</div></div><div class="tt-chips"><div class="tt-chip" style="background:${done?'#F1F3F4':e.dim};color:${done?'#9AA0A6':e.txt};"><span class="msr">event</span>${e.exam_day}, ${dObj.full}</div><div class="tt-chip" style="background:#FEF7E0;color:#B06000;"><span class="msr">schedule</span>${e.start_time} – ${e.end_time}</div><div class="tt-chip" style="background:${done?'#F1F3F4':'#E6F4EA'};color:${done?'#9AA0A6':'#137333'};"><span class="msr">school</span>${e.credits} Credits</div></div></div></div>`;
    addRipple(card); wrap.appendChild(card);
  });
}

function buildSubTabs(containerId, activeKey, cb) {
  const wrap = $('#bafs-' + containerId); wrap.innerHTML = '';
  EXAMS.forEach(e => {
    const t = document.createElement('div');
    t.className = 'sub-tab' + (e.short_name === activeKey ? ' active' : '');
    t.textContent = e.short_name;
    t.onclick = () => cb(e.short_name);
    addRipple(t, 'rgba(26,115,232,.1)'); wrap.appendChild(t);
  });
}

function renderQbank() {
  buildSubTabs('qbank-tabs', qbankTab, k => { qbankTab = k; renderQbank(); });
  const wrap = $('#bafs-qbank-list'); wrap.innerHTML = '';
  const qData = QBANK.filter(q => q.exam_short_name === qbankTab);
  if(!qData.length) { wrap.innerHTML = '<div class="empty-state">No questions available yet.</div>'; return; }
  
  qData.forEach(q => {
    const card = document.createElement('div'); card.className = 'note-card';
    card.innerHTML = `<div class="note-strip" style="background:${q.color};"></div><div class="note-icon" style="background:${q.dim};"><span class="msr fill-w5" style="color:${q.color};">${q.icon}</span></div><div class="note-body"><div class="note-title">${q.title}</div><div class="note-meta"><span>${q.pages} pages</span><span>·</span><span>${q.upd}</span><span class="note-pill" style="background:${q.dim};color:${q.color};">${q.tag}</span></div></div><div class="note-dl"><span class="msr" style="color:${q.color};">picture_as_pdf</span></div>`;
    card.onclick = () => openPdf(q.pdf_url, q.title);
    addRipple(card); wrap.appendChild(card);
  });
}

function renderPYQ() {
  const yw = $('#bafs-pyq-years'); yw.innerHTML = '';
  PYQ_YEARS.forEach(y => {
    const c = document.createElement('div');
    c.className = 'y-chip' + (y === pyqYear ? ' active' : '');
    c.innerHTML = `<span class="msr">history_edu</span>${y}`;
    c.onclick = () => { pyqYear = y; renderPYQ(); };
    yw.appendChild(c);
  });
  
  const wrap = $('#bafs-pyq-list'); wrap.innerHTML = '';
  const filtered = PYQS.filter(p => p.year_range === pyqYear);
  if (!filtered.length) { wrap.innerHTML = `<div class="empty-state">No past papers available for ${pyqYear}.</div>`; return; }

  filtered.forEach(p => {
    const e = EXAMS.find(x => x.short_name === p.exam_short_name);
    if (!e) return;
    const item = document.createElement('div'); item.className = 'g-item';
    item.innerHTML = `<div class="gi-lead" style="background:${e.dim};"><span class="msr" style="color:${e.color};">description</span></div><div class="gi-body"><div class="gi-title">${e.paper}</div><div class="gi-sub">${p.year_range}  ·  ${e.credits} Credits</div></div><div class="gi-trail"><span class="msr s20" style="color:${e.color};">picture_as_pdf</span></div>`;
    item.onclick = () => openPdf(p.pdf_url, e.paper + ' (' + p.year_range + ')');
    addRipple(item); wrap.appendChild(item);
  });
}

function renderSyllabus() {
  buildSubTabs('syl-tabs', sylTab, k => { sylTab = k; renderSyllabus(); });
  const wrap = $('#bafs-syl-acc'); wrap.innerHTML = '';
  const exam = EXAMS.find(e => e.short_name === sylTab);
  const units = SYLLABUS.filter(s => s.exam_short_name === sylTab);
  if(!units.length) { wrap.innerHTML = '<div class="empty-state">Syllabus pending.</div>'; return; }

  units.forEach(unit => {
    const item = document.createElement('div'); item.className = 'g-acc';
    let topics = typeof unit.topics === 'string' ? JSON.parse(unit.topics) : unit.topics;
    item.innerHTML = `<div class="g-acc-hd"><div class="g-acc-lead" style="background:${exam.dim};"><span class="msr" style="color:${exam.color};">menu_book</span></div><div class="g-acc-info"><div class="g-acc-title">${unit.title}</div><div class="g-acc-count">${topics.length} topics</div></div><div class="g-acc-chevron"><span class="msr">expand_more</span></div></div><div class="g-acc-body">${topics.map(t => `<div class="g-acc-topic"><div class="g-acc-bullet" style="background:${exam.color};"></div><span>${t}</span></div>`).join('')}</div>`;
    item.querySelector('.g-acc-hd').onclick = () => item.classList.toggle('open');
    addRipple(item.querySelector('.g-acc-hd'), 'rgba(26,115,232,.07)'); wrap.appendChild(item);
  });
}

function renderPattern() {
  const wrap = $('#bafs-pattern-list'); wrap.innerHTML = '';
  if(!EXAMS.length) { wrap.innerHTML = '<div class="empty-state">Pattern details pending.</div>'; return; }
  EXAMS.forEach(e => {
    const has = !!findPatternUrl(e);
    const item = document.createElement('div'); item.className = 'g-item';
    item.innerHTML = `<div class="gi-lead" style="background:${e.dim};"><span class="msr" style="color:${e.color};">bar_chart</span></div><div class="gi-body"><div class="gi-title">${e.paper}</div><div class="gi-sub">${e.credits} Credits  ·  Paper Pattern</div></div><div class="gi-trail"><span class="msr s20" style="color:${e.color};">${has ? 'image' : 'chevron_right'}</span></div>`;
    item.onclick = () => openPattern(e);
    addRipple(item); wrap.appendChild(item);
  });
}

function renderNotes() {
  buildSubTabs('notes-tabs', notesTab, k => { notesTab = k; renderNotes(); });
  const wrap = $('#bafs-notes-list'); wrap.innerHTML = '';
  const nData = NOTES.filter(n => n.exam_short_name === notesTab);
  if(!nData.length) { wrap.innerHTML = '<div class="empty-state">No notes available yet.</div>'; return; }
  
  nData.forEach(n => {
    const card = document.createElement('div'); card.className = 'note-card';
    card.innerHTML = `<div class="note-strip" style="background:${n.color};"></div><div class="note-icon" style="background:${n.dim};"><span class="msr fill-w5" style="color:${n.color};">${n.icon}</span></div><div class="note-body"><div class="note-title">${n.title}</div><div class="note-meta"><span>${n.pages} pages</span><span>·</span><span>${n.upd}</span><span class="note-pill" style="background:${n.dim};color:${n.color};">${n.tag}</span></div></div><div class="note-dl"><span class="msr" style="color:${n.color};">picture_as_pdf</span></div>`;
    card.onclick = () => openPdf(n.pdf_url, n.title);
    addRipple(card); wrap.appendChild(card);
  });
}

/* ═══════════════════════════════════════
   GLOBAL SEARCH ENGINE
   (kept from the standalone app; like there, the view has no entry point in the current UI)
═══════════════════════════════════════ */
function bindSearch() {
  $('#bafs-search-input').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const wrap = $('#bafs-search-results');
    if(!query) { wrap.innerHTML = '<div class="empty-state">Type to search across everything.</div>'; return; }
  
    let results = [];

    EXAMS.forEach(ex => {
      if(ex.paper.toLowerCase().includes(query) || ex.short_name.toLowerCase().includes(query))
        results.push({ type: 'Exam', title: ex.paper, sub: ex.short_name + ' · Schedule', icon: 'school', color: ex.color, dim: ex.dim, action: () => { navTo('tt'); }});
    });

    NOTES.forEach(n => {
      if(n.title.toLowerCase().includes(query) || n.tag.toLowerCase().includes(query))
        results.push({ type: 'Note', title: n.title, sub: n.exam_short_name + ' · ' + n.tag, icon: n.icon, color: n.color, dim: n.dim, action: () => { openPdf(n.pdf_url, n.title); }});
    });

    QBANK.forEach(q => {
      if(q.title.toLowerCase().includes(query) || q.tag.toLowerCase().includes(query))
        results.push({ type: 'QBank', title: q.title, sub: q.exam_short_name + ' · ' + q.tag, icon: q.icon, color: q.color, dim: q.dim, action: () => { openPdf(q.pdf_url, q.title); }});
    });

    PYQS.forEach(p => {
      const ex = EXAMS.find(x => x.short_name === p.exam_short_name);
      if(ex && (ex.paper.toLowerCase().includes(query) || p.year_range.includes(query)))
        results.push({ type: 'PYQ', title: ex.paper + ' (' + p.year_range + ')', sub: 'Previous Year Paper', icon: 'history_edu', color: '#EA4335', dim: '#FCE8E6', action: () => { openPdf(p.pdf_url, ex.paper + ' (' + p.year_range + ')'); }});
    });

    SYLLABUS.forEach(s => {
      let tArr = typeof s.topics === 'string' ? JSON.parse(s.topics) : s.topics;
      let matchedTopics = tArr.filter(t => t.toLowerCase().includes(query));
      if (matchedTopics.length > 0 || s.title.toLowerCase().includes(query)) {
        results.push({ type: 'Syllabus', title: s.title, sub: s.exam_short_name + ' · Unit Match', icon: 'menu_book', color: '#34A853', dim: '#E6F4EA', action: () => { sylTab = s.exam_short_name; navTo('syllabus'); }});
      }
    });

    if(!results.length) { wrap.innerHTML = '<div class="empty-state">No results found for "'+query+'"</div>'; return; }

    wrap.innerHTML = '';
    results.slice(0, 15).forEach(r => {
      const item = document.createElement('div'); item.className = 'g-item';
      item.innerHTML = `<div class="gi-lead" style="background:${r.dim};"><span class="msr" style="color:${r.color};">${r.icon}</span></div><div class="gi-body"><div class="gi-title">${r.title}</div><div class="gi-sub">${r.type} · ${r.sub}</div></div><div class="gi-trail"><span class="msr s20" style="color:var(--md-on-surface-var);">chevron_right</span></div>`;
      item.onclick = r.action;
      addRipple(item); wrap.appendChild(item);
    });
  });
}

/* ═══════════════════════════════════════
   DATA: cache-first paint, then refresh from Supabase
═══════════════════════════════════════ */
function readCache() {
  try { return JSON.parse(localStorage.getItem(DATA_CACHE_KEY) || 'null'); } catch (e) { return null; }
}

function setData(p) {
  EXAMS = (p.exams || []).map(e => ({ ...e, dt: new Date(e.exam_date + 'T' + parseTime(e.start_time)) }));
  QBANK = p.qbank || [];
  NOTES = p.notes || [];
  SYLLABUS = p.syllabus || [];
  PYQS = p.pyqs || [];
  PYQ_YEARS = (p.pyq_years || []).map(y => y.year_range);
  const first = EXAMS.length ? EXAMS[0].short_name : '';
  const valid = k => EXAMS.some(e => e.short_name === k);
  if (!valid(qbankTab)) qbankTab = first;
  if (!valid(sylTab)) sylTab = first;
  if (!valid(notesTab)) notesTab = first;
  if (!PYQ_YEARS.includes(pyqYear)) pyqYear = PYQ_YEARS[0] || '';
}

function renderAll() {
  renderHomeExams();
  renderTT();
  renderQbank();
  renderPYQ();
  renderSyllabus();
  renderPattern();
  renderNotes();
  tickCD();
}

async function refresh(hadCache) {
  const token = ++loadToken;
  try {
    if (!sb) sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      // Anonymous, read-only access to a separate project — never needs (or should touch) a session.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const results = await Promise.all([
      sb.from('exams').select('*').eq('is_active', true).order('exam_date', { ascending: true }),
      sb.from('qbank').select('*').eq('is_active', true),
      sb.from('notes').select('*').eq('is_active', true),
      sb.from('syllabus').select('*').eq('is_active', true).order('unit_order', { ascending: true }),
      sb.from('pyqs').select('*').eq('is_active', true),
      sb.from('pyq_years').select('*').eq('is_active', true).order('year_range', { ascending: false })
    ]);
    if (token !== loadToken || !root) return;
    const failed = results.find(r => r.error);
    if (failed) throw failed.error;

    const payload = {
      exams: results[0].data || [], qbank: results[1].data || [], notes: results[2].data || [],
      syllabus: results[3].data || [], pyqs: results[4].data || [], pyq_years: results[5].data || []
    };
    const json = JSON.stringify(payload);
    if (json !== lastPayloadJson) {            // nothing changed since the cached paint → no re-render, no flicker
      lastPayloadJson = json;
      try { localStorage.setItem(DATA_CACHE_KEY, json); } catch (e) { /* storage full — just skip caching */ }
      setData(payload);
      renderAll();
    }
    warmPdfCache(); // background — don't block first paint on downloading every PDF
  } catch (err) {
    console.error('Supabase fetch error:', err);
    if (token !== loadToken || !root) return;
    if (hadCache) return; // showing the cached copy — stay quiet, it will refresh next time
    $('#bafs-cd-name').textContent = 'Couldn’t load exams';
    $('#bafs-cd-meta').textContent = '';
    setData({});
    renderAll();
    toast(navigator.onLine === false ? 'You are offline — connect once to load the BAFs App.' : 'Failed to sync data. Please refresh.', 'error');
  }
}

/* ═══════════════════════════════════════
   MOUNT / UNMOUNT
═══════════════════════════════════════ */
function ensureLink(id, href) {
  let l = document.getElementById(id);
  if (!l) {
    l = document.createElement('link');
    l.id = id; l.rel = 'stylesheet'; l.href = href;
    document.head.appendChild(l);
  }
  return l;
}

function stylesheetReady(link) {
  return new Promise(resolve => {
    if (link.sheet) return resolve();
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
    setTimeout(resolve, 1500); // never hold the screen hostage to a stalled stylesheet
  });
}

function trackIconFont() {
  const mark = () => { if (root) root.classList.add('fonts-loaded'); };
  if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load("24px 'Material Symbols Outlined'"), document.fonts.ready]).then(mark, mark);
  } else mark();
  timers.push(setTimeout(mark, 3000)); // safety net — never shimmer forever if font loading stalls
}

export async function mountBafs(container) {
  unmountBafs();
  const myMount = ++mountToken;
  const css = ensureLink('bafs-css', CSS_HREF);
  await stylesheetReady(css);
  if (myMount !== mountToken || !container.isConnected) return; // switched away while the CSS loaded

  root = document.createElement('div');
  root.id = 'bafs-root';
  root.innerHTML = TEMPLATE;
  container.innerHTML = '';
  container.appendChild(root);

  viewStack = ['home'];
  gateShown = null;
  lastPayloadJson = '';
  window.bafsIsAtHome = bafsIsAtHome;   // main.js's back-button handler looks for these
  window.bafsGoBack = bafsGoBack;

  // ── one delegated click handler for all the static markup (replaces the inline onclick="…"s) ──
  root.addEventListener('click', (ev) => {
    const nav = ev.target.closest('[data-nav]');
    if (nav) { navTo(nav.dataset.nav); return; }
    if (ev.target.closest('[data-back]')) { bafsGoBack(); return; }
    if (ev.target.closest('[data-widget]')) { addCountdownWidget(); return; }
    if (ev.target.closest('#bafs-gate-btn')) { openVerification(); return; }
  });
  $$('.qg-card').forEach(el => addRipple(el, 'rgba(0,0,0,.06)'));
  bindSearch();
  trackIconFont();
  applyGate();

  // Keep the gate in step with the app (approval, re-submission…)
  const onStorage = (e) => { if (e.key === 'ecampus_profile_cache') applyGate(); };
  const onVisible = () => { if (!document.hidden) applyGate(); };
  window.addEventListener('storage', onStorage);
  document.addEventListener('visibilitychange', onVisible);
  cleanups.push(() => window.removeEventListener('storage', onStorage), () => document.removeEventListener('visibilitychange', onVisible));
  timers.push(setInterval(() => { if (gateShown !== false) applyGate(); }, 2500));
  timers.push(setInterval(tickCD, 1000));

  // Cached copy → paint immediately (works offline too); otherwise shimmers until the network answers.
  const cached = readCache();
  if (cached && cached.exams && cached.exams.length) {
    lastPayloadJson = JSON.stringify({
      exams: cached.exams || [], qbank: cached.qbank || [], notes: cached.notes || [],
      syllabus: cached.syllabus || [], pyqs: cached.pyqs || [], pyq_years: cached.pyq_years || []
    });
    setData(cached);
    renderAll();
    warmPdfCache();
    refresh(true);
  } else {
    showShimmers();
    refresh(false);
  }
}

export function unmountBafs() {
  mountToken++;
  loadToken++;
  timers.forEach(t => { clearInterval(t); clearTimeout(t); });
  timers = [];
  cleanups.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
  cleanups = [];
  if (window.bafsIsAtHome === bafsIsAtHome) { delete window.bafsIsAtHome; delete window.bafsGoBack; }
  if (root) { root.remove(); root = null; }
}
