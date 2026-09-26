// auth/auth.js — one module for the merged Log In / Sign Up screen.
// (Replaces the old login.js + signup.js, which duplicated showMessage,
// setLoading and the session check.)

// The Supabase client needs window.supabase, which comes from a CDN <script>.
// If that script didn't load (offline / blocked) importing supabase.js throws.
// Import it defensively so the toggle, pickers and validation still work and
// the user gets a readable message instead of a dead screen.
let sb = null;
try {
    ({ supabase: sb } = await import('../supabase.js'));
} catch (err) {
    console.error('Supabase client unavailable:', err);
}

// Forced-update gate — a device can land here without ever having a
// session, so this has to run on the login screen too, not just main.js.
// If it shows the "Update Required" screen, boot() below is never wired up.
let forceUpdateShown = false;
try {
    const { checkForcedUpdate } = await import('../version-gate.js');
    forceUpdateShown = await checkForcedUpdate();
} catch (err) {
    console.error('version-gate unavailable:', err);
}

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------
// Data
// ------------------------------------------------------------------
const COLLEGE_NAME = 'B. K. Birla Night College';

// Exact strings are stored in users.course — do not "tidy" them
// (note SY B.A. keeps its trailing dot to match existing data).
const COURSE_GROUPS = [
    {
        title: 'First Year (FY)',
        items: ['FY B.A', 'FY B.Sc', 'FY B.Com', 'FY B.Com (Management Studies)', 'FY B.Com (Accounting & Finance)', 'FY B.Com (Financial Markets)', 'FY B.Sc (Computer Science)'],
    },
    {
        title: 'Second Year (SY)',
        items: ['SY B.A.', 'SY B.Sc', 'SY B.Com', 'SY B.Com (Management Studies)', 'SY B.Com (Accounting & Finance)', 'SY B.Com (Financial Markets)', 'SY B.Sc (Computer Science)'],
    },
    {
        title: 'Third Year (TY)',
        items: ['TY B.A', 'TY B.Sc', 'TY B.Com', 'TY B.Com (Management Studies)', 'TY B.Com (Accounting & Finance)', 'TY B.Com (Financial Markets)', 'TY B.Sc (Computer Science)'],
    },
];

const GENDERS = [
    { value: 'Male', icon: 'male', color: 'text-primary' },
    { value: 'Female', icon: 'female', color: 'text-pink-500' },
    { value: 'Other', icon: 'transgender', color: 'text-purple-500' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const selection = { course: '', gender: '' };
let mode = 'login';

// ------------------------------------------------------------------
// Small UI helpers
// ------------------------------------------------------------------
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

const MESSAGE_BASE = 'w-full mb-4 px-4 py-3 rounded-xl text-[13px] font-bold text-center border ';
const MESSAGE_STYLES = {
    error: 'text-error bg-error/10 border-error/20',
    success: 'text-primary bg-primary/10 border-primary/20',
};

function showMessage(text, type = 'error') {
    const box = $('auth-message');
    if (!text) {
        box.textContent = '';
        box.className = 'hidden';
        return;
    }
    box.textContent = text;
    box.className = MESSAGE_BASE + MESSAGE_STYLES[type];
}

function setLoading(button, isLoading) {
    if (!button) return;
    button.disabled = isLoading;
    button.querySelector('.btn-text')?.classList.toggle('hidden', isLoading);
    button.querySelector('.btn-spinner')?.classList.toggle('hidden', !isLoading);
}

// Field error highlight. ring-* as well as border-*, because the global
// dark-mode input rule in style.css forces border-color with !important.
const INVALID_CLASSES = ['border-error', 'dark:border-error', 'ring-1', 'ring-error'];

function markInvalid(elId) {
    const node = $(elId);
    if (!node) return;
    node.classList.add(...INVALID_CLASSES);
    if (node.tagName === 'INPUT' && node.type !== 'checkbox') node.focus();
    else node.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function clearInvalid(node) {
    node?.classList.remove(...INVALID_CLASSES);
}

function fail(elId, message) {
    showMessage(message, 'error');
    markInvalid(elId);
}

function requireClient() {
    if (sb) return true;
    showMessage('Can’t reach the server. Check your internet connection and reopen the app.');
    return false;
}

// ------------------------------------------------------------------
// Mode toggle (Log In <-> Sign Up)
// ------------------------------------------------------------------
const TAB_ACTIVE = ['text-on-surface', 'dark:text-white'];
const TAB_INACTIVE = ['text-on-surface-variant', 'dark:text-gray-400'];

function replayFade(node) {
    node.classList.remove('fade-in');
    void node.offsetWidth; // restart the CSS animation
    node.classList.add('fade-in');
}

function setMode(next) {
    mode = next;
    const isLogin = next === 'login';

    $('panel-login').classList.toggle('hidden', !isLogin);
    $('panel-signup').classList.toggle('hidden', isLogin);
    replayFade($(isLogin ? 'panel-login' : 'panel-signup'));

    $('auth-title').textContent = isLogin ? 'Welcome Back!' : 'Create an Account';
    $('auth-subtitle').textContent = isLogin ? 'Please sign in to continue' : 'Join your campus network';

    $('auth-toggle-pill').classList.toggle('translate-x-full', !isLogin);
    for (const tab of document.querySelectorAll('#auth-toggle [role="tab"]')) {
        const active = tab.dataset.mode === next;
        tab.setAttribute('aria-selected', String(active));
        tab.classList.remove(...TAB_ACTIVE, ...TAB_INACTIVE);
        tab.classList.add(...(active ? TAB_ACTIVE : TAB_INACTIVE));
    }

    showMessage('');
    window.scrollTo({ top: 0, behavior: 'instant' });
    try {
        history.replaceState(null, '', isLogin ? location.pathname : '#signup');
    } catch (e) { /* not fatal */ }
}

function initialMode() {
    const params = new URLSearchParams(location.search);
    return location.hash === '#signup' || params.get('mode') === 'signup' ? 'signup' : 'login';
}

// ------------------------------------------------------------------
// Password show / hide
// ------------------------------------------------------------------
function initPasswordToggles() {
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.pw-toggle');
        if (!btn) return;
        const input = $(btn.dataset.target);
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        btn.querySelector('.material-symbols-outlined').textContent = show ? 'visibility_off' : 'visibility';
    });
}

// ------------------------------------------------------------------
// Bottom-sheet pickers (course / gender)
// ------------------------------------------------------------------
const OPTION_CLASSES = 'w-full text-left px-4 py-3 rounded-xl text-[15px] font-medium text-on-surface dark:text-gray-100 hover:bg-surface-variant/30 dark:hover:bg-neutral-800 active:bg-surface-variant/50 transition-colors flex items-center justify-between';

function openSheet(id) {
    const sheet = $(id);
    sheet.classList.replace('hidden', 'flex');
    document.body.classList.add('overflow-hidden');
    document.activeElement?.blur(); // drop the keyboard if it is up
}

function closeSheets() {
    for (const id of ['sheet-course', 'sheet-gender']) {
        $(id).classList.replace('flex', 'hidden');
    }
    document.body.classList.remove('overflow-hidden');
}

function buildCourseSheet() {
    const list = $('sheet-course-list');
    list.replaceChildren();
    for (const group of COURSE_GROUPS) {
        const section = el('div', 'mb-5');
        section.append(el('h4', 'text-[12px] font-bold text-primary uppercase tracking-wider mb-2 sticky top-0 bg-surface dark:bg-[#1e1e1e] py-1 z-10', group.title));
        const column = el('div', 'space-y-1');
        for (const item of group.items) {
            const selected = item === selection.course;
            const btn = el('button', OPTION_CLASSES + (selected ? ' bg-primary/10 !text-primary font-bold' : ''));
            btn.type = 'button';
            btn.dataset.value = item;
            btn.append(el('span', '', item));
            if (selected) btn.append(el('span', 'material-symbols-outlined text-[20px]', 'check'));
            column.append(btn);
        }
        section.append(column);
        list.append(section);
    }
}

function buildGenderSheet() {
    const list = $('sheet-gender-list');
    list.replaceChildren();
    for (const g of GENDERS) {
        const selected = g.value === selection.gender;
        const btn = el('button', 'w-full text-left px-5 py-4 rounded-xl text-[15px] font-bold text-on-surface dark:text-gray-100 hover:bg-surface-variant/30 dark:hover:bg-neutral-800 active:bg-surface-variant/50 transition-colors border flex items-center justify-between '
            + (selected ? 'border-primary bg-primary/10' : 'border-surface-variant/50 dark:border-neutral-700'));
        btn.type = 'button';
        btn.dataset.value = g.value;
        btn.append(el('span', '', g.value), el('span', `material-symbols-outlined ${g.color} text-[22px]`, g.icon));
        list.append(btn);
    }
}

function setPickerLabel(labelId, buttonId, value, placeholder) {
    const label = $(labelId);
    label.textContent = value || placeholder;
    label.classList.toggle('text-on-surface-variant/50', !value);
    label.classList.toggle('dark:text-gray-500', !value);
    clearInvalid($(buttonId));
}

function initPickers() {
    $('signup-course-btn').addEventListener('click', () => { buildCourseSheet(); openSheet('sheet-course'); });
    $('signup-gender-btn').addEventListener('click', () => { buildGenderSheet(); openSheet('sheet-gender'); });

    $('sheet-course-list').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-value]');
        if (!btn) return;
        selection.course = btn.dataset.value;
        setPickerLabel('signup-course-label', 'signup-course-btn', selection.course, 'Select your course');
        closeSheets();
    });

    $('sheet-gender-list').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-value]');
        if (!btn) return;
        selection.gender = btn.dataset.value;
        setPickerLabel('signup-gender-label', 'signup-gender-btn', selection.gender, 'Select');
        closeSheets();
    });

    for (const id of ['sheet-course', 'sheet-gender']) {
        $(id).addEventListener('click', (e) => {
            // backdrop tap or the X button
            if (e.target === $(id) || e.target.closest('[data-close-sheet]')) closeSheets();
        });
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });
}

// ------------------------------------------------------------------
// Log in
// ------------------------------------------------------------------
async function processSuccessfulLogin(session) {
    const loginButton = $('login-button');

    const { data: profile, error } = await sb
        .from('users')
        .select('id, is_deleted, is_deactivated')
        .eq('auth_user_id', session.user.id)
        .single();

    if (error || !profile) {
        console.error('Profile fetch error:', error);
        showMessage('Error validating account status.');
        setLoading(loginButton, false);
        return;
    }

    if (profile.is_deleted) {
        await sb.auth.signOut();
        showMessage('This account has been permanently deleted.');
        setLoading(loginButton, false);
        return;
    }

    if (profile.is_deactivated) {
        showReactivation(profile);
        setLoading(loginButton, false);
        return;
    }

    window.location.href = '../index.html';
}

function showReactivation(profile) {
    $('auth-toggle').classList.add('hidden');
    $('panel-login').classList.add('hidden');
    $('panel-signup').classList.add('hidden');
    $('auth-title').textContent = 'Account Paused';
    $('auth-subtitle').classList.add('hidden');
    showMessage('');

    const panel = $('panel-reactivate');
    panel.classList.replace('hidden', 'flex');

    $('reactivate-btn').onclick = async () => {
        const btn = $('reactivate-btn');
        btn.disabled = true;
        btn.textContent = 'Reactivating…';
        const { error } = await sb.from('users').update({ is_deactivated: false }).eq('id', profile.id);
        if (error) {
            console.error('Reactivation error:', error);
            btn.disabled = false;
            btn.textContent = 'Yes, Reactivate Account';
            showMessage('Could not reactivate your account. Please try again.');
            return;
        }
        window.location.href = '../index.html';
    };

    $('cancel-reactivate-btn').onclick = async () => {
        await sb.auth.signOut();
        window.location.reload();
    };
}

async function handleLogin(event) {
    event.preventDefault();
    showMessage('');

    const identifier = $('login-identifier').value.trim();
    const password = $('login-password').value;
    const button = $('login-button');

    if (!identifier) return fail('login-identifier', 'Please enter your email or Student ID.');
    if (!password) return fail('login-password', 'Please enter your password.');
    if (!requireClient()) return;

    setLoading(button, true);

    try {
        if (identifier.includes('@')) {
            // Email login
            const { data, error } = await sb.auth.signInWithPassword({ email: identifier, password });
            if (error) {
                console.error('Login error:', error);
                showMessage(error.message || 'Invalid email or password.');
                setLoading(button, false);
                return;
            }
            if (data?.session) {
                await processSuccessfulLogin(data.session);
                return;
            }
        } else {
            // Student ID login via Edge Function
            const { data, error } = await sb.functions.invoke('hyper-endpoint', {
                body: { studentId: identifier, password },
            });
            if (error) {
                console.error('Function error:', error);
                showMessage('Server error. Try again.');
                setLoading(button, false);
                return;
            }
            if (data?.error) {
                showMessage(data.error);
                setLoading(button, false);
                return;
            }
            if (data?.session) {
                const { error: sessionError } = await sb.auth.setSession(data.session);
                if (sessionError) {
                    console.error('Session error:', sessionError);
                    showMessage('Login failed. Try again.');
                    setLoading(button, false);
                    return;
                }
                await processSuccessfulLogin(data.session);
                return;
            }
        }

        showMessage('Unexpected error occurred.');
        setLoading(button, false);
    } catch (err) {
        console.error('Login error:', err);
        showMessage('Something went wrong.');
        setLoading(button, false);
    }
}

// ------------------------------------------------------------------
// Sign up
// ------------------------------------------------------------------
function readSignupForm() {
    return {
        fullName: $('signup-fullname').value.trim(),
        email: $('signup-email').value.trim(),
        password: $('signup-password').value,
        studentId: $('signup-studentid').value.trim(),
        mobile: $('signup-mobile').value.trim(),
        course: selection.course,
        gender: selection.gender,
        terms: $('signup-terms').checked,
    };
}

// Returns [elementId, message] for the first problem, or null.
function validateSignup(v) {
    if (v.fullName.length < 2) return ['signup-fullname', 'Please enter your full name.'];
    if (!EMAIL_RE.test(v.email)) return ['signup-email', 'Please enter a valid email address.'];
    if (v.password.length < 6) return ['signup-password', 'Password must be at least 6 characters.'];
    if (!v.studentId) return ['signup-studentid', 'Please enter your Student ID.'];
    if (!v.gender) return ['signup-gender-btn', 'Please select your gender.'];
    if (!v.course) return ['signup-course-btn', 'Please select your course.'];
    if (v.mobile.replace(/\D/g, '').length < 10) return ['signup-mobile', 'Please enter a valid mobile number.'];
    if (!v.terms) return ['signup-terms', 'You must agree to the Privacy Policy and Terms.'];
    return null;
}

let redirecting = false;

// The users row is created from the sign-up metadata by a database trigger.
// It is normally there instantly; give it a moment so index.html never boots
// before the profile exists.
async function waitForProfile(authUserId) {
    for (let i = 0; i < 5; i++) {
        try {
            const { data } = await sb.from('users').select('id').eq('auth_user_id', authUserId).maybeSingle();
            if (data) return true;
        } catch (e) { /* retry */ }
        await new Promise((r) => setTimeout(r, 400));
    }
    return false;
}

async function handleSignup(event) {
    event.preventDefault();
    showMessage('');

    const v = readSignupForm();
    const problem = validateSignup(v);
    if (problem) return fail(problem[0], problem[1]);
    if (!requireClient()) return;

    const button = $('signup-button');
    setLoading(button, true);

    try {
        const { data, error } = await sb.auth.signUp({
            email: v.email,
            password: v.password,
            options: {
                data: {
                    full_name: v.fullName,
                    college_name: COLLEGE_NAME,
                    student_id: v.studentId,
                    course: v.course,
                    mobile: v.mobile,
                    gender: v.gender,
                },
            },
        });

        if (error) {
            console.error('Signup error:', error);
            showMessage(error.message || 'Failed to create account.');
            return;
        }

        const user = data?.user;
        if (!user) {
            showMessage('Something went wrong during signup.');
            return;
        }

        // With email confirmation on, Supabase answers an already-registered
        // address with a fake user whose identities array is empty.
        if (Array.isArray(user.identities) && user.identities.length === 0) {
            showMessage('An account with this email already exists. Try logging in instead.');
            return;
        }

        // Signed up => signed in. With "Confirm email" OFF in Supabase, signUp
        // already returns a session. If this project still returns none, sign
        // in right away with the password they just chose so they never have
        // to log in by hand after creating an account.
        let session = data.session;
        if (!session) {
            const { data: signIn, error: signInError } = await sb.auth.signInWithPassword({
                email: v.email,
                password: v.password,
            });
            if (signInError) {
                console.warn('Auto sign-in after signup failed:', signInError);
                // Only reachable while Supabase email confirmation is still ON.
                $('login-identifier').value = v.email;
                setMode('login');
                showMessage('Account created! Please confirm your email, then log in.', 'success');
                return;
            }
            session = signIn?.session;
        }

        if (session) {
            // A brand-new account must never inherit a previous user's cached profile.
            try { localStorage.removeItem('ecampus_profile_cache'); } catch (e) { /* not fatal */ }
            redirecting = true; // keep the button in its loading state until the page changes
            showMessage('Account created! Taking you in…', 'success');
            await waitForProfile(session.user.id);
            window.location.replace('../index.html');
            return;
        }

        $('login-identifier').value = v.email;
        setMode('login');
        showMessage('Account created! Please log in.', 'success');
    } catch (err) {
        console.error('Signup process error:', err);
        showMessage('An unexpected error occurred.');
    } finally {
        if (!redirecting) setLoading(button, false);
    }
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
async function checkUserSession() {
    if (!sb) return;
    try {
        const { data } = await sb.auth.getSession();
        if (data?.session) await processSuccessfulLogin(data.session);
    } catch (err) {
        console.error('Session check error:', err);
    }
}

function syncStatusBar() {
    // Keep the native status-bar icons readable on this screen too
    // (main.js only does this once the main app has loaded).
    try {
        const dark = document.documentElement.classList.contains('dark');
        window.Capacitor?.Plugins?.SystemBars?.setStyle({ style: dark ? 'DARK' : 'LIGHT' });
    } catch (e) { /* not running inside the native shell */ }
}

function boot() {
    for (const tab of document.querySelectorAll('#auth-toggle [role="tab"]')) {
        tab.addEventListener('click', () => { if (tab.dataset.mode !== mode) setMode(tab.dataset.mode); });
    }

    // Clear a field's error highlight as soon as the user edits it.
    for (const form of [$('login-form'), $('signup-form')]) {
        form.addEventListener('input', (e) => clearInvalid(e.target));
        form.addEventListener('change', (e) => clearInvalid(e.target));
    }

    $('login-form').addEventListener('submit', handleLogin);
    $('signup-form').addEventListener('submit', handleSignup);

    initPasswordToggles();
    initPickers();
    syncStatusBar();

    // Links like login.html#signup that arrive while the page is already open.
    window.addEventListener('hashchange', () => {
        const wanted = initialMode();
        if (wanted !== mode) setMode(wanted);
    });

    if (initialMode() === 'signup') setMode('signup');
    checkUserSession();
}

// This module uses top-level await (the defensive Supabase import above), so
// DOMContentLoaded may already have fired by the time we get here.
if (!forceUpdateShown) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
}
