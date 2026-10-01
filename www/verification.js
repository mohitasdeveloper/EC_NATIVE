import { supabase } from './supabase.js';
import { showToast } from './ui.js';

let currentUser = null;
let currentImageBlob = null;
let previewObjectUrl = null;
let listenersBound = false;

// Live camera state
let cameraStream = null;
let cameraFacing = 'environment';
let cameraMode = 'live';        // 'live' | 'review'
let capturedBlob = null;
let capturedUrl = null;

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------
// Prefill from the user's profile
// ------------------------------------------------------------------
// A field is only (re)filled while it is empty or still holds the value we
// filled in last time, so anything the student has typed/picked is never
// overwritten when the profile refreshes in the background.
const lastPrefilled = {};

function prefillForm(profile) {
    if (!profile) return;
    const values = {
        'verify-name': profile.full_name,
        'verify-student-id': profile.student_id,
        'verify-course': profile.course
    };
    for (const [id, raw] of Object.entries(values)) {
        const el = $(id);
        if (!el) continue;
        const next = raw == null ? '' : String(raw).trim();
        if (el.value === '' || el.value === lastPrefilled[id]) {
            el.value = next;
            lastPrefilled[id] = next;
        }
    }
}

// main.js calls this whenever the profile is refreshed / edited.
window.prefillVerificationForm = (profile) => prefillForm(profile || currentUser);

export function initVerification(profile) {
    currentUser = profile;

    const header = document.querySelector('header');
    const nav = document.querySelector('nav');
    const mainContent = $('main-content');

    if (header) header.style.display = 'none';
    if (nav) nav.style.display = 'none';
    if (mainContent) mainContent.style.display = 'none';

    const view = $('view-verification');
    if (view) {
        view.classList.remove('hidden');
        view.classList.add('flex');
    }

    // Everything the profile already knows is filled in for the student.
    prefillForm(profile);

    renderState(profile.verification_status);

    if (listenersBound) return;
    listenersBound = true;

    bindIdCardControls();
    bindCameraControls();

    const submitBtn = $('submit-verification-btn');
    if (submitBtn) submitBtn.addEventListener('click', submitVerification);

    document.querySelectorAll('.verify-signout-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            await supabase.auth.signOut();
            window.location.replace('auth/login.html');
        });
    });
}

function renderState(status) {
    const formState = document.getElementById('verify-state-form');
    const pendingState = document.getElementById('verify-state-pending');
    
    if (formState) formState.classList.add('hidden');
    if (pendingState) pendingState.classList.add('hidden');
    
    // 🚀 CRASH-PROOF FIX: If status is 'pending', show pending. Otherwise, default to showing the form.
    if (status === 'pending') {
        if (pendingState) {
            pendingState.classList.remove('hidden');
            pendingState.classList.add('flex');
        }
    } else {
        if (formState) {
            formState.classList.remove('hidden');
            formState.classList.add('flex');
        }
        if (status === 'rejected') fetchRejectionReason();
    }
}

async function fetchRejectionReason() {
    try {
        const { data } = await supabase.from('student_verifications').select('rejection_reason').eq('user_id', currentUser.id).single();
        if (data && data.rejection_reason) {
            const alertBox = document.getElementById('verify-reject-alert');
            const reasonText = document.getElementById('verify-reject-reason');
            if (alertBox && reasonText) {
                alertBox.classList.remove('hidden');
                reasonText.textContent = data.rejection_reason;
            }
        }
    } catch (e) { console.error(e); }
}

// ------------------------------------------------------------------
// ID card image: upload or live camera
// ------------------------------------------------------------------
function placeholderMarkup() {
    return `
        <span class="material-symbols-outlined text-[32px] mb-2" id="verify-img-icon">add_photo_alternate</span>
        <span class="text-sm font-medium" id="verify-img-text">Tap to upload clear photo</span>`;
}

function clearIdImage() {
    currentImageBlob = null;
    if (previewObjectUrl) { URL.revokeObjectURL(previewObjectUrl); previewObjectUrl = null; }
    const upload = $('id-card-upload');
    const fallback = $('id-card-capture-fallback');
    if (upload) upload.value = '';
    if (fallback) fallback.value = '';
    const container = $('id-card-preview-container');
    if (container) container.innerHTML = placeholderMarkup();
}

function setIdImage(file) {
    const container = $('id-card-preview-container');
    if (!file || !container) return;

    currentImageBlob = file;
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = URL.createObjectURL(file);

    container.classList.remove('border-error', 'dark:border-error');
    container.innerHTML = '';

    const img = document.createElement('img');
    img.src = previewObjectUrl;
    img.alt = 'College ID preview';
    img.className = 'w-full h-full object-contain rounded-xl';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove photo');
    remove.className = 'absolute top-2 right-2 bg-black/60 text-white rounded-full p-1 hover:bg-black/80 transition-colors z-10';
    remove.innerHTML = '<span class="material-symbols-outlined text-[18px]">close</span>';
    remove.addEventListener('click', (e) => { e.stopPropagation(); clearIdImage(); });

    container.append(img, remove);
}

function bindIdCardControls() {
    const upload = $('id-card-upload');
    const fallback = $('id-card-capture-fallback');
    const container = $('id-card-preview-container');

    const onPicked = (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) setIdImage(file);
    };
    if (upload) upload.addEventListener('change', onPicked);
    if (fallback) fallback.addEventListener('change', onPicked);

    // Tapping the empty box = upload from gallery (same as before)
    if (container) container.addEventListener('click', () => { if (!currentImageBlob && upload) upload.click(); });

    const galleryBtn = $('id-card-gallery-btn');
    if (galleryBtn && upload) galleryBtn.addEventListener('click', () => upload.click());

    const cameraBtn = $('id-card-camera-btn');
    if (cameraBtn) cameraBtn.addEventListener('click', openCamera);
}

// ------------------------------------------------------------------
// Live camera capture
// ------------------------------------------------------------------
function setCameraMode(mode) {
    cameraMode = mode;
    const live = mode === 'live';
    $('verify-camera-feed')?.classList.toggle('hidden', !live);
    $('verify-camera-guide')?.classList.toggle('hidden', !live);
    $('verify-camera-hint')?.classList.toggle('hidden', !live);
    $('verify-camera-switch')?.classList.toggle('invisible', !live);
    $('verify-camera-shutter')?.classList.toggle('hidden', !live);
    $('verify-camera-still')?.classList.toggle('hidden', live);

    const review = $('verify-camera-review-controls');
    if (review) {
        review.classList.toggle('hidden', live);
        review.classList.toggle('flex', !live);
    }
    const title = $('verify-camera-title');
    if (title) title.textContent = live ? 'Capture your College ID' : 'Check the photo';
}

function stopStream() {
    if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
    }
    const video = $('verify-camera-feed');
    if (video) video.srcObject = null;
}

async function startStream() {
    stopStream();
    const video = $('verify-camera-feed');
    if (!video) return;

    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: cameraFacing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false
        });
        video.srcObject = cameraStream;
        // The selfie camera preview is mirrored; the saved photo never is.
        video.style.transform = cameraFacing === 'user' ? 'scaleX(-1)' : '';
        await video.play().catch(() => {});
    } catch (err) {
        console.error('Verification camera error:', err);
        closeCamera();
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
            showToast('Camera permission is off. Allow it in your phone settings, or upload a photo instead.', 'error');
        } else {
            // No usable camera stream — hand off to the phone's own camera app.
            const fallback = $('id-card-capture-fallback');
            if (fallback) fallback.click();
            else showToast('Could not open the camera. Please upload a photo instead.', 'error');
        }
    }
}

function discardCapture() {
    capturedBlob = null;
    if (capturedUrl) { URL.revokeObjectURL(capturedUrl); capturedUrl = null; }
    const still = $('verify-camera-still');
    if (still) still.removeAttribute('src');
}

async function openCamera() {
    const modal = $('modal-verify-camera');
    if (!modal) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const fallback = $('id-card-capture-fallback');
        if (fallback) fallback.click();
        return;
    }

    discardCapture();
    setCameraMode('live');
    modal.classList.replace('hidden', 'flex');
    await startStream();
}

function closeCamera() {
    stopStream();
    discardCapture();
    const modal = $('modal-verify-camera');
    if (modal) modal.classList.replace('flex', 'hidden');
}
window.closeVerifyCamera = closeCamera;

function takePhoto() {
    const video = $('verify-camera-feed');
    if (!video || !video.videoWidth || !video.videoHeight) {
        return showToast('Camera is still starting. Try again in a moment.', 'info');
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
        if (!blob) return showToast('Could not capture the photo. Please try again.', 'error');
        discardCapture();
        capturedBlob = blob;
        capturedUrl = URL.createObjectURL(blob);
        const still = $('verify-camera-still');
        if (still) still.src = capturedUrl;
        stopStream();               // release the camera while the student reviews
        setCameraMode('review');
    }, 'image/jpeg', 0.92);
}

function useCapturedPhoto() {
    if (!capturedBlob) return;
    const file = new File([capturedBlob], `id-card-${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
    setIdImage(file);
    closeCamera();
}

async function retakePhoto() {
    discardCapture();
    setCameraMode('live');
    await startStream();
}

function bindCameraControls() {
    $('verify-camera-close')?.addEventListener('click', closeCamera);
    $('verify-camera-shutter')?.addEventListener('click', takePhoto);
    $('verify-camera-use')?.addEventListener('click', useCapturedPhoto);
    $('verify-camera-retake')?.addEventListener('click', retakePhoto);
    $('verify-camera-switch')?.addEventListener('click', async () => {
        cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
        await startStream();
    });

    // Don't keep the camera running while the app is in the background.
    document.addEventListener('visibilitychange', () => {
        const modal = $('modal-verify-camera');
        if (!modal || modal.classList.contains('hidden') || cameraMode !== 'live') return;
        if (document.hidden) stopStream();
        else startStream();
    });
}

async function submitVerification() {
    const nameInput = document.getElementById('verify-name');
    const idInput = document.getElementById('verify-student-id');
    const courseInput = document.getElementById('verify-course');
    const imageContainer = document.getElementById('id-card-preview-container');

    if (!nameInput || !idInput || !courseInput || !imageContainer) return;

    const legalName = nameInput.value.trim();
    const studentId = idInput.value.trim();
    const course = courseInput.value.trim();
    
    [nameInput, idInput, courseInput, imageContainer].forEach(el => el.classList.remove('border-error', 'dark:border-error'));

    let hasError = false;
    if (!legalName) { nameInput.classList.add('border-error', 'dark:border-error'); hasError = true; }
    if (!studentId) { idInput.classList.add('border-error', 'dark:border-error'); hasError = true; }
    if (!course) { courseInput.classList.add('border-error', 'dark:border-error'); hasError = true; }
    
    if (hasError) return showToast('Please fill out all highlighted text fields.', 'error');

    if (!currentImageBlob) {
        imageContainer.classList.add('border-error', 'dark:border-error');
        return showToast('Please upload a photo of your College ID.', 'error');
    }

    const btn = document.getElementById('submit-verification-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="material-symbols-outlined animate-spin text-[24px]">progress_activity</span>`;
    }

    try {
        const compressedId = typeof window.compressImage === 'function' ? await window.compressImage(currentImageBlob, 1080, 0.7) : currentImageBlob;
        
        const idFileName = `${currentUser.id}_id_${Date.now()}.${compressedId.name.split('.').pop()}`;
        const { error: idUploadError } = await supabase.storage.from('verifications').upload(idFileName, compressedId, { upsert: true });
        if (idUploadError) throw new Error(`ID Upload Failed: ${idUploadError.message}`);
        
        const idUrl = supabase.storage.from('verifications').getPublicUrl(idFileName).data.publicUrl;

        const { error: dbError } = await supabase.from('student_verifications').upsert({
            user_id: currentUser.id,
            legal_name: legalName,
            student_id: studentId,
            course: course,
            id_card_url: idUrl,
            status: 'pending'
        }, { onConflict: 'user_id' });
        
        if (dbError) throw dbError;

        const { error: userError } = await supabase.from('users').update({ verification_status: 'pending' }).eq('id', currentUser.id);
        if (userError) throw userError;

        showToast('Verification submitted successfully.', 'success');
        clearIdImage();
        renderState('pending');
        // Let the rest of the app (e.g. the BAFs gate) see the new 'pending' status right away.
        if (typeof window.refreshMyProfile === 'function') window.refreshMyProfile();

    } catch (error) {
        showToast(error.message || 'Failed to submit verification. Please try again.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = 'Submit for Verification';
        }
    }
}
