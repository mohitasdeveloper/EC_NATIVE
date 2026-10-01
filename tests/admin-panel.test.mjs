// Behavioural test for www/admin.js — no browser, no Supabase, no npm deps.
//   node tests/admin-panel.test.mjs
//
// It loads the REAL admin.js next to stub versions of its three imports, gives
// it a tiny fake DOM, feeds it canned RPC responses, and then drives every
// tab: checking what it renders, which RPCs each button fires (name + exact
// params), that user-supplied text is HTML-escaped, and that the shared
// confirm dialog is always restored afterwards. It cannot check pixels or the
// SQL — see tests/README.md for what this does and doesn't cover.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wwwDir = path.join(here, '..', 'www');

// ---------- minimal fake DOM ----------
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const registry = new Map();
class El {
  constructor(id = '') {
    this.id = id; this._html = ''; this.value = ''; this.style = {}; this.parentNode = null;
    this.listeners = {}; this._classes = new Set(); this._text = '';
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      contains: (c) => self._classes.has(c),
      toggle: (c, f) => { (f ?? !self._classes.has(c)) ? self._classes.add(c) : self._classes.delete(c); },
      replace: (a, b) => { if (!self._classes.has(a)) return false; self._classes.delete(a); self._classes.add(b); return true; },
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ''); this._html = esc(this._text); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  async click() { for (const fn of this.listeners.click || []) await fn(); }
  cloneNode() { const c = new El(this.id); c.className = this.className; c._text = this._text; c._html = this._html; c.parentNode = this.parentNode; return c; }
}
const document = {
  createElement: () => new El(),
  getElementById(id) {
    if (!registry.has(id)) {
      const el = new El(id);
      el.parentNode = { replaceChild: (n, o) => registry.set(o.id, n) };
      registry.set(id, el);
    }
    return registry.get(id);
  },
};
globalThis.document = document;
globalThis.window = globalThis;
globalThis.window.optimizeImageUrl = (u) => u;

// ---------- stub imports + load the real module ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-test-'));
fs.copyFileSync(path.join(wwwDir, 'admin.js'), path.join(tmp, 'admin.js'));
fs.writeFileSync(path.join(tmp, 'ui.js'), `export function showToast(m,t){ (globalThis.__toasts ||= []).push([m,t]); }`);
fs.writeFileSync(path.join(tmp, 'utils.js'), `export function timeAgo(){ return '1h ago'; }`);
fs.writeFileSync(path.join(tmp, 'supabase.js'), `
export const supabase = {
  rpc: async (name, params) => globalThis.__rpc(name, params || {}),
  from: () => ({ select: () => ({ order: async () => globalThis.__appVersions() }) }),
};`);

const calls = []; let failNext = null;
const fixtures = {
  admin_get_dashboard_stats: { pending_verifications: 3, pending_reports: 2, open_tickets: 1, reported_posts: 4, total_users: 120, suspended_users: 5 },
  admin_list_verifications: [
    { id: 'v1', user_id: 'u9', legal_name: '<script>alert(1)</script>', student_id: 'S1', course: 'BAFS', id_card_url: 'http://x/id.jpg', selfie_url: 'http://x/s.jpg', status: 'pending', rejection_reason: null, created_at: '2026-09-20T10:00:00Z', full_name: 'A', email: 'a@x.com', profile_img_url: '' },
    { id: 'v2', user_id: 'u8', legal_name: 'Bee', student_id: 'S2', course: 'BBA', id_card_url: 'http://x/id2.jpg', selfie_url: null, status: 'pending', rejection_reason: null, created_at: '2026-09-21T10:00:00Z', full_name: 'B', email: 'b@x.com', profile_img_url: '' },
  ],
  admin_list_reports: [
    { id: 'r1', reporter_id: 'u1', reporter_name: 'Rep', reported_user_id: null, reported_user_name: null, reported_user_suspended: null, reported_post_id: 'p1', reported_post_content: 'bad <b>post</b>', reported_post_author_id: 'u2', reported_post_author_name: 'Author', reported_post_deleted: false, reason: 'spam', description: 'desc', status: 'pending_review', created_at: '2026-09-20T10:00:00Z' },
    { id: 'r2', reporter_id: 'u1', reporter_name: 'Rep', reported_user_id: 'u3', reported_user_name: 'Target', reported_user_suspended: false, reported_post_id: null, reported_post_content: null, reported_post_author_id: null, reported_post_author_name: null, reported_post_deleted: null, reason: 'abuse', description: null, status: 'pending_review', created_at: '2026-09-20T10:00:00Z' },
  ],
  admin_get_app_settings: [{ key: 'screen_privacy', enabled: false, updated_at: '2026-09-20T10:00:00Z', updated_by_name: 'Boss' }],
  admin_list_feedback: [{ id: 'f1', user_id: 'u4', full_name: 'Fay', email: 'f@x.com', type: 'issue', description: 'app crashes', media_url: null, status: 'pending', admin_reply: null, created_at: '2026-09-20T10:00:00Z' }],
  admin_search_users: [
    { id: 'admin-1', full_name: 'Boss', email: 'boss@x.com', student_id: '1', course: 'X', college: 'C', role: 'student', tick_type: 'none', is_admin: true, is_volunteer: false, special_post: false, is_private: false, is_deactivated: false, is_suspended: false, is_deleted: false, verification_status: 'verified', connection_count: 4, profile_img_url: '' },
    { id: 'u5', full_name: 'Sam', email: 'sam@x.com', student_id: '2', course: 'Y', college: 'C', role: 'student', tick_type: 'none', is_admin: false, is_volunteer: false, special_post: false, is_private: false, is_deactivated: true, is_suspended: false, is_deleted: false, verification_status: 'unverified', connection_count: 0, profile_img_url: '' },
  ],
};
globalThis.__rpc = async (name, params) => {
  calls.push([name, params]);
  if (failNext === name) { failNext = null; return { data: null, error: new Error('boom') }; }
  return { data: name in fixtures ? structuredClone(fixtures[name]) : null, error: null };
};
globalThis.__appVersions = async () => ({ data: [{ platform: 'android', min_version_code: 120, update_message: 'Please update' }], error: null });

const admin = await import(pathToFileURL(path.join(tmp, 'admin.js')).href);

// ---------- helpers ----------
const flush = () => new Promise((r) => setTimeout(r, 0));
const body = () => document.getElementById('admin-panel-body').innerHTML;
const list = () => document.getElementById('admin-list-container').innerHTML;
const lastCall = (name) => [...calls].reverse().find((c) => c[0] === name);
const modal = () => document.getElementById('modal-confirm-action');
const yes = () => document.getElementById('confirm-action-yes');
const no = () => document.getElementById('confirm-action-no');
const toasts = () => globalThis.__toasts || [];
let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

modal().classList.add('hidden');
yes().className = 'flex-1 bg-error text-white'; yes().textContent = 'Delete';
const assertConfirmRestored = () => {
  assert.equal(yes().textContent, 'Delete', 'shared confirm label not restored');
  assert.ok(yes().className.includes('bg-error') && !yes().className.includes('bg-primary'), 'shared confirm colour not restored');
  assert.ok(modal().classList.contains('hidden'), 'confirm modal left open');
};

// ---------- tests ----------
console.log('admin.js');
await t('boot renders overview stats and the right tabs (no Colleges)', async () => {
  await admin.initAdmin({ id: 'admin-1', full_name: 'Boss' });
  assert.match(body(), /120/); assert.match(body(), /Suspended/); assert.match(body(), /Boss/);
  const strip = document.getElementById('admin-tab-strip').innerHTML;
  for (const l of ['Overview', 'Verify', 'Reports', 'Tickets', 'Users', 'App Config']) assert.ok(strip.includes(l), l);
  assert.ok(!strip.includes('Colleges'));
});

await t('verifications: list escapes user text, detail shows actions', async () => {
  await window.__adminSwitchTab('verifications');
  assert.deepEqual(lastCall('admin_list_verifications')[1], { p_status: 'pending' });
  assert.ok(!body().includes('Approved'), 'approved rows are deleted by a trigger, so no Approved filter');
  assert.ok(body().includes('Rejected') && body().includes('Pending'));
  assert.ok(list().includes('&lt;script&gt;') && !list().includes('<script>'));
  window.__adminOpenDetail('verification', 0); await flush();
  assert.match(body(), /Approve/); assert.match(body(), /Reject/);
  assert.ok(!body().includes('<script>alert'));
});
await t('reject needs a reason, then fires RPC with danger-styled confirm and restores modal', async () => {
  document.getElementById('admin-verify-reject-reason').value = '';
  window.__adminRejectVerification();
  assert.equal(toasts().at(-1)[1], 'warning');
  document.getElementById('admin-verify-reject-reason').value = 'blurry';
  window.__adminRejectVerification();
  assert.ok(!modal().classList.contains('hidden'));
  assert.ok(yes().className.includes('bg-error')); assert.equal(yes().textContent, 'Reject');
  await yes().click(); await flush();
  assert.deepEqual(lastCall('admin_review_verification')[1], { p_verification_id: 'v1', p_approve: false, p_rejection_reason: 'blurry' });
  assertConfirmRestored();
});
await t('approve uses a green (non-danger) confirm; cancel fires nothing and restores modal', async () => {
  window.__adminOpenDetail('verification', 1); await flush();
  const before = calls.length;
  window.__adminApproveVerification();
  assert.ok(yes().className.includes('bg-primary') && !yes().className.includes('bg-error'));
  assert.equal(yes().textContent, 'Approve');
  await no().click(); await flush();
  assert.equal(calls.length, before); assertConfirmRestored();
  window.__adminApproveVerification(); await yes().click(); await flush();
  assert.deepEqual(lastCall('admin_review_verification')[1], { p_verification_id: 'v2', p_approve: true });
  assertConfirmRestored();
});

await t('reports: delete post resolves report; suspend user resolves report', async () => {
  await window.__adminSwitchTab('reports');
  assert.match(list(), /Post by Author/); assert.match(list(), /Target/);
  window.__adminOpenDetail('report', 0); await flush();
  assert.match(body(), /Delete post/); assert.ok(body().includes('bad &lt;b&gt;post&lt;/b&gt;'));
  window.__adminModeratePost(true, false); assert.ok(yes().className.includes('bg-error'));
  await yes().click(); await flush();
  assert.deepEqual(lastCall('admin_moderate_post')[1], { p_post_id: 'p1', p_delete: true, p_verify: false });
  assert.deepEqual(lastCall('admin_set_report_status')[1], { p_report_id: 'r1', p_status: 'resolved' });
  window.__adminOpenDetail('report', 1); await flush();
  assert.match(body(), /Suspend user/); assert.ok(!/Deactivate/.test(body()));
  window.__adminSuspendReportedUser(true); await yes().click(); await flush();
  assert.deepEqual(lastCall('admin_update_user')[1], { p_user_id: 'u3', p_is_suspended: true });
  assert.deepEqual(lastCall('admin_set_report_status')[1], { p_report_id: 'r2', p_status: 'resolved' });
  assertConfirmRestored();
});
await t('reports: protect post is non-danger', async () => {
  window.__adminOpenDetail('report', 0); await flush();
  window.__adminModeratePost(false, true);
  assert.ok(yes().className.includes('bg-primary'));
  await yes().click(); await flush();
  assert.deepEqual(lastCall('admin_moderate_post')[1], { p_post_id: 'p1', p_delete: false, p_verify: true });
});

await t('tickets: empty reply rejected, reply sends id/text/status', async () => {
  await window.__adminSwitchTab('feedback');
  window.__adminOpenDetail('feedback', 0); await flush();
  document.getElementById('admin-feedback-reply').value = ''; await window.__adminSendFeedbackReply();
  assert.equal(toasts().at(-1)[1], 'warning');
  document.getElementById('admin-feedback-reply').value = 'Fixed in next build';
  document.getElementById('admin-feedback-status').value = 'resolved';
  await window.__adminSendFeedbackReply();
  assert.deepEqual(lastCall('admin_reply_feedback')[1], { p_feedback_id: 'f1', p_reply: 'Fixed in next build', p_status: 'resolved' });
});

await t('users: list, self has no suspend/delete, others do, patches send right params', async () => {
  await window.__adminSwitchTab('users');
  assert.deepEqual(lastCall('admin_search_users')[1], { p_query: null });
  assert.match(list(), /Boss/); assert.match(list(), /PAUSED/);
  window.__adminOpenDetail('user', 0); await flush();
  assert.ok(!/Suspend Account/.test(body()) && !/Delete Account/.test(body()), 'self must not see suspend/delete');
  window.__adminOpenDetail('user', 1); await flush();
  assert.match(body(), /Suspend Account/); assert.match(body(), /Delete Account/);
  await window.__adminSetRole('page');
  assert.deepEqual(lastCall('admin_update_user')[1], { p_user_id: 'u5', p_role: 'page' });
  await window.__adminSetTick('#F2B705');
  assert.deepEqual(lastCall('admin_update_user')[1], { p_user_id: 'u5', p_tick_type: '#F2B705' });
  await window.__adminToggleField('special_post', true);
  assert.deepEqual(lastCall('admin_update_user')[1], { p_user_id: 'u5', p_special_post: true });
  await window.__adminSetVerificationStatus('verified');
  assert.deepEqual(lastCall('admin_update_user')[1], { p_user_id: 'u5', p_verification_status: 'verified' });
  window.__adminToggleSuspend(); assert.ok(yes().className.includes('bg-error'));
  await yes().click(); await flush();
  assert.deepEqual(lastCall('admin_update_user')[1], { p_user_id: 'u5', p_is_suspended: true });
  assert.match(body(), /Unsuspend Account/, 'UI should reflect new state');
  window.__adminToggleDelete(); await yes().click(); await flush();
  assert.deepEqual(lastCall('admin_update_user')[1], { p_user_id: 'u5', p_is_deleted: true });
  assertConfirmRestored();
});

await t('app config: shows platform, save sends parsed version code', async () => {
  await window.__adminSwitchTab('config');
  assert.match(body(), /android/); assert.ok(body().includes('value="120"'));
  document.getElementById('admin-version-code-android').value = 'abc'; await window.__adminSaveVersion('android');
  assert.equal(toasts().at(-1)[1], 'warning');
  document.getElementById('admin-version-code-android').value = '130';
  document.getElementById('admin-version-msg-android').value = 'Update now';
  await window.__adminSaveVersion('android'); assert.ok(yes().className.includes('bg-error'));
  await yes().click(); await flush();
  assert.deepEqual(lastCall('admin_update_app_version')[1], { p_platform: 'android', p_min_version_code: 130, p_update_message: 'Update now' });
  assertConfirmRestored();
});

await t('tick colour ring: drag maps pointer angle to hue, brightness slider, Apply sends #RRGGBB', async () => {
  await window.__adminSwitchTab('users');
  window.__adminOpenDetail('user', 1); await flush();
  assert.match(body(), /Custom colour/); assert.ok(body().includes('id="admin-tick-ring"'));
  assert.ok(body().includes('conic-gradient'), 'the ring is a conic gradient');
  assert.match(body(), /Apply colour/);
  const ring = document.getElementById('admin-tick-ring');
  ring.getBoundingClientRect = () => ({ left: 0, top: 0, width: 168, height: 168 });
  const down = ring.listeners.pointerdown.at(-1);
  window.__adminTickLight('50');
  // tapping the hole in the middle is ignored (default hue 214 is kept)
  down({ clientX: 84, clientY: 84, pointerId: 1 });
  await window.__adminApplyTickColor();
  assert.notEqual(lastCall('admin_update_user')[1].p_tick_type, '#F00F0F');
  // top of the ring = hue 0 (red); right-lower = hue 120 (green)
  down({ clientX: 84, clientY: 0, pointerId: 1 });
  await window.__adminApplyTickColor();
  assert.deepEqual(lastCall('admin_update_user')[1], { p_user_id: 'u5', p_tick_type: '#F00F0F' });
  window.__adminOpenDetail('user', 1); await flush();
  const ring2 = document.getElementById('admin-tick-ring');
  ring2.getBoundingClientRect = () => ({ left: 0, top: 0, width: 168, height: 168 });
  window.__adminTickLight('50');
  ring2.listeners.pointerdown.at(-1)({ clientX: 84 + 84 * Math.cos(Math.PI / 6), clientY: 84 + 84 * Math.sin(Math.PI / 6), pointerId: 1 });
  await window.__adminApplyTickColor();
  assert.deepEqual(lastCall('admin_update_user')[1], { p_user_id: 'u5', p_tick_type: '#0FF00F' });
  assert.match(lastCall('admin_update_user')[1].p_tick_type, /^#[0-9A-F]{6}$/);
  // dragging keeps updating the hue; letting go stops it. (Apply re-renders the
  // detail, which re-binds the ring, so grab fresh handlers and finish the drag
  // before applying.)
  window.__adminOpenDetail('user', 1); await flush();
  const ring3 = document.getElementById('admin-tick-ring');
  ring3.getBoundingClientRect = () => ({ left: 0, top: 0, width: 168, height: 168 });
  window.__adminTickLight('50');
  const [dn, mv, up] = [ring3.listeners.pointerdown.at(-1), ring3.listeners.pointermove.at(-1), ring3.listeners.pointerup.at(-1)];
  mv({ clientX: 84, clientY: 0 });                       // not dragging yet: ignored
  dn({ clientX: 168, clientY: 84, pointerId: 1 });       // right edge = hue 90
  mv({ clientX: 84, clientY: 0 });                       // dragged to the top = hue 0
  up();
  mv({ clientX: 84, clientY: 168 });                     // after letting go: ignored
  await window.__adminApplyTickColor();
  assert.equal(lastCall('admin_update_user')[1].p_tick_type, '#F00F0F', 'hue follows the drag and stops on pointerup');
});

await t('reset password: only for non-admins; validates, generates, confirms, then shows the new password', async () => {
  await window.__adminSwitchTab('users');
  window.__adminOpenDetail('user', 0); await flush();   // Boss is an admin (and self)
  assert.ok(!/Reset Password/.test(body()), 'admin accounts get no reset button');
  window.__adminOpenDetail('user', 1); await flush();   // Sam
  assert.match(body(), /Reset Password/);
  window.__adminPushDetail('user_password'); await flush();
  assert.ok(body().includes('id="admin-pw-input"')); assert.match(body(), /sam@x\.com/);
  const calls0 = calls.length;
  document.getElementById('admin-pw-input').value = 'short';
  window.__adminSubmitPasswordReset();
  assert.equal(toasts().at(-1)[1], 'warning'); assert.equal(calls.length, calls0, 'no RPC for a short password');
  window.__adminGeneratePassword();
  const gen = document.getElementById('admin-pw-input').value;
  assert.match(gen, /^[A-Za-z0-9]{12}$/); assert.ok(!/[0OlI1]/.test(gen), 'no look-alike characters');
  document.getElementById('admin-pw-input').value = '  Tr0ub4dor9  ';
  window.__adminSubmitPasswordReset();
  assert.ok(yes().className.includes('bg-error'), 'resetting a password is a danger confirm');
  failNext = 'admin_reset_user_password';
  await yes().click(); await flush();
  assert.equal(toasts().at(-1)[1], 'error'); assert.ok(!document.getElementById('admin-pw-area').innerHTML.includes('Password updated for'));
  window.__adminSubmitPasswordReset(); await yes().click(); await flush();
  assert.deepEqual(lastCall('admin_reset_user_password')[1], { p_user_id: 'u5', p_new_password: 'Tr0ub4dor9' });
  const area = document.getElementById('admin-pw-area').innerHTML;
  assert.match(area, /Password updated for Sam/); assert.ok(area.includes('Tr0ub4dor9')); assert.match(area, /Copy/);
  assertConfirmRestored();
});

await t('app config: Full Privacy switch reflects state, confirms (safe styling), sends the setting, applies locally', async () => {
  await window.__adminSwitchTab('config');
  assert.match(body(), /Full Privacy Mode/); assert.ok(body().includes('aria-checked="false"')); assert.match(body(), /by Boss/);
  assert.ok(body().includes('android'), 'version gate still renders alongside it');
  let applied = null; window.__applyScreenPrivacy = (v) => { applied = v; };
  window.__adminTogglePrivacy(true);
  assert.ok(yes().className.includes('bg-primary') && !yes().className.includes('bg-error'));
  assert.equal(yes().textContent, 'Turn on');
  await yes().click(); await flush();
  assert.deepEqual(lastCall('admin_set_app_setting')[1], { p_key: 'screen_privacy', p_enabled: true });
  assert.equal(applied, true);
  assertConfirmRestored();
  window.__adminTogglePrivacy(false); await yes().click(); await flush();
  assert.deepEqual(lastCall('admin_set_app_setting')[1], { p_key: 'screen_privacy', p_enabled: false });
  assert.equal(applied, false);
});

await t('app config: if the privacy SQL has not been run, the card says so and the version gate still works', async () => {
  failNext = 'admin_get_app_settings';
  await window.__adminSwitchTab('config');
  assert.match(body(), /Not set up yet/); assert.match(body(), /admin_panel\.sql/); assert.ok(body().includes('value="120"'));
  assert.ok(!body().includes('aria-checked'), 'no switch when the setting cannot be read');
});

await t('app config: a failed privacy update shows an error and does not apply locally', async () => {
  await window.__adminSwitchTab('config');
  let applied = 'untouched'; window.__applyScreenPrivacy = (v) => { applied = v; };
  failNext = 'admin_set_app_setting';
  window.__adminTogglePrivacy(true); await yes().click(); await flush();
  assert.equal(toasts().find((x) => x[0] === 'boom')?.[1], 'error'); assert.equal(applied, 'untouched');
});

await t('back handler unwinds detail before closing panel', async () => {
  await window.__adminSwitchTab('verifications');
  window.__adminOpenDetail('verification', 0); await flush();
  assert.equal(window.__adminHandleBack(), true); await flush();
  assert.equal(window.__adminHandleBack(), false);
});

await t('RPC failure shows an error state instead of throwing', async () => {
  failNext = 'admin_list_reports';
  await window.__adminSwitchTab('reports');
  assert.match(body(), /Something went wrong/); assert.match(body(), /boom/);
});

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
fs.rmSync(tmp, { recursive: true, force: true });
