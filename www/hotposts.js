import { supabase } from './supabase.js';
import { showToast, popupMenuItem } from './ui.js';
import { timeAgo, saveHotpostsToCache, getHotpostsFromCache } from './utils.js';
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_HOTPOSTS_PRESET, CLOUDINARY_VIDEO_CLOUD_NAME, CLOUDINARY_VIDEO_PRESET } from './config.js';
import { getHotposts, invalidateHotpostsCache, getBlockedUserIds, getAcceptedConnections, createNotification } from './data-layer.js';

// ==========================================
// STATE MANAGEMENT & FONT ENGINE
// ==========================================
let hotpostsByUser = new Map();
let currentUser = null;
let sessionViewedPostIds = new Set();
let isUploadingBackground = false; 
let myConnectionIds = new Set(); // who I can reply to (connections-only, like DMs)

const HOTPOST_SKELETON = `
    <div class="flex flex-col items-center gap-1.5 shrink-0">
        <div class="w-[80px] h-[80px] rounded-full shimmer-bg shadow-sm"></div>
        <div class="w-12 h-2.5 rounded-full shimmer-bg mt-1"></div>
    </div>
`.repeat(6);

const ACTIVITY_SKELETON = `
    <div class="flex items-center gap-3 p-3 animate-pulse">
        <div class="w-10 h-10 rounded-full shimmer-bg shrink-0"></div>
        <div class="flex-1 space-y-2">
            <div class="h-3.5 shimmer-bg rounded-md w-1/2"></div>
            <div class="h-2.5 shimmer-bg rounded-md w-1/3"></div>
        </div>
    </div>
`.repeat(5);

// 🚀 NATIVE ZERO-LOAD FONT STACKS (Matches Instagram Styles)
const TEXT_FONTS = [
    { name: 'Classic', value: 'Georgia, serif' },
    { name: 'Modern', value: 'system-ui, -apple-system, sans-serif' },
    { name: 'Neon', value: '"Arial Rounded MT Bold", Arial, sans-serif' },
    { name: 'Typewriter', value: '"Courier New", Courier, monospace' },
    { name: 'Strong', value: 'Impact, Charcoal, sans-serif' },
    { name: 'Elegant', value: '"Palatino Linotype", "Book Antiqua", Palatino, serif' },
    { name: 'Headline', value: '"Arial Black", Gadget, sans-serif' },
    { name: 'Simple', value: 'Arial, Helvetica, sans-serif' },
    { name: 'Editor', value: '"Lucida Console", Monaco, monospace' },
    { name: 'Fancy', value: '"Brush Script MT", "Lucida Handwriting", cursive' },
    { name: 'Comic', value: '"Comic Sans MS", "Comic Sans", cursive' },
    { name: 'Memo', value: '"Trebuchet MS", "Lucida Grande", sans-serif' }
];

const TEXT_COLORS = ['#FFFFFF', '#000000', '#FF3B30', '#34C759', '#007AFF', '#FFD60A', '#FF9F0A', '#BF5AF2', '#32ADE6'];

let currentTextFont = TEXT_FONTS[0].value;
let currentTextColor = '#FFFFFF';
let currentTextBg = false;
let currentTextAlign = 'center'; // 🚀 Added Alignment State

// 🚀 Calculates perfect contrast (Black or White) for Text Backgrounds
function getContrastYIQ(hexcolor){
    hexcolor = hexcolor.replace("#", "");
    if (hexcolor.length === 3) hexcolor = hexcolor.split('').map(c => c+c).join('');
    var r = parseInt(hexcolor.substr(0,2),16);
    var g = parseInt(hexcolor.substr(2,2),16);
    var b = parseInt(hexcolor.substr(4,2),16);
    var yiq = ((r*299)+(g*587)+(b*114))/1000;
    return (yiq >= 128) ? '#000000' : '#FFFFFF';
}

let currentCameraStream = null;
let currentFacingMode = 'environment';
let currentPhotoBlob = null;
let baseImageObj = null; 
let currentPreviewObjectURL = null; // 🚀 FIX: Added to track memory leaks
// 🚀 NEW: Video Recording Engine States
let currentMediaType = 'image';
let mediaRecorder = null;
let recordedChunks = [];
let recordingTimer = null;
let isRecording = false;

let videoZoomScale = 1;
let initialVideoPinchDist = 0;

let recordedMimeType = 'video/webm';

// 🚀 NEW: sound state. Instagram-style: default unmuted, remembered for the session,
// falls back to muted (with a "tap for sound" hint) only if the browser blocks autoplay.
let viewerMuted = false;

let imgTransform = { scale: 1, x: 0, y: 0 }; 
let isDraggingBg = false;
let bgDragStartX = 0, bgDragStartY = 0;
let initialBgScale = 1;

const FILTER_LIST = [
    { name: 'NORMAL', css: 'none', cloudinaryEffect: '' },
    // 🚀 NEW: Cloudinary equivalents for baking filters into published VIDEOS server-side —
    // no client re-encode, so none of the canvas/MediaRecorder instability applies. These are
    // close approximations of the CSS preview, not pixel-identical (different algorithms) —
    // in particular COOL's hue shift is a reasonable approximation, not an exact CSS match,
    // since Cloudinary doesn't document an exact degrees-per-unit mapping for e_hue.
    { name: 'VIVID', css: 'saturate(1.6) contrast(1.1)', cloudinaryEffect: 'e_saturation:60/e_contrast:10' },
    { name: 'WARM', css: 'sepia(0.4) saturate(1.2) contrast(1.1)', cloudinaryEffect: 'e_sepia:40/e_saturation:15/e_contrast:10' },
    { name: 'COOL', css: 'hue-rotate(180deg) saturate(1.2)', cloudinaryEffect: 'e_hue:50/e_saturation:15' },
    { name: 'B&W', css: 'grayscale(1) contrast(1.2)', cloudinaryEffect: 'e_grayscale/e_contrast:20' },
    { name: 'FADE', css: 'contrast(0.85) brightness(1.1) saturate(0.75)', cloudinaryEffect: 'e_contrast:-15/e_brightness:10/e_saturation:-25' },
    { name: 'BRIGHT', css: 'brightness(1.15) saturate(1.1)', cloudinaryEffect: 'e_brightness:15/e_saturation:10' },
    { name: 'MOODY', css: 'brightness(0.9) contrast(1.2) saturate(0.85)', cloudinaryEffect: 'e_brightness:-10/e_contrast:20/e_saturation:-15' },
    { name: 'CLASSIC', css: 'sepia(0.15) contrast(1.05)', cloudinaryEffect: 'e_sepia:15/e_contrast:5' },
    { name: 'NOIR', css: 'grayscale(1) contrast(1.4) brightness(0.9)', cloudinaryEffect: 'e_grayscale/e_contrast:35/e_brightness:-10' }
];
let currentFilterIndex = 0;
// 🚀 NEW: a small static snapshot of the actual shot, used so each filter carousel swatch
// shows a real (if tiny) preview of what that filter does to *this* photo/video, Instagram-style.
let filterThumbnailDataUrl = null;

// 🚀 NEW: draws a small square thumbnail from whatever was just captured/picked (image or
// video element both work — video uses videoWidth/Height, image uses natural/plain width/Height).
function generateFilterThumbnail(sourceEl) {
    try {
        const size = 88;
        const c = document.createElement('canvas');
        c.width = size; c.height = size;
        const ctx = c.getContext('2d');
        const sw = sourceEl.videoWidth || sourceEl.naturalWidth || sourceEl.width;
        const sh = sourceEl.videoHeight || sourceEl.naturalHeight || sourceEl.height;
        if (!sw || !sh) return null;
        const scale = Math.max(size / sw, size / sh);
        const dw = sw * scale, dh = sh * scale;
        ctx.drawImage(sourceEl, (size - dw) / 2, (size - dh) / 2, dw, dh);
        return c.toDataURL('image/jpeg', 0.6);
    } catch (e) {
        console.error('Filter thumbnail generation failed:', e);
        return null;
    }
}

// 🚀 NEW: builds the filter carousel — one tappable swatch per filter, each showing the
// actual shot with that filter applied, with the active one highlighted.
function renderFilterCarousel() {
    const track = document.getElementById('hotpost-filter-carousel');
    if (!track) return;

    if (!filterThumbnailDataUrl) { track.innerHTML = ''; return; }

    track.innerHTML = FILTER_LIST.map((f, i) => `
        <button data-filter-index="${i}" class="filter-swatch-btn shrink-0 flex flex-col items-center gap-1.5 active:scale-95 transition-transform">
            <div class="w-14 h-14 rounded-xl overflow-hidden ${i === currentFilterIndex ? 'ring-2 ring-white' : 'ring-1 ring-white/30'} bg-cover bg-center"
                 style="background-image:url('${filterThumbnailDataUrl}'); filter:${f.css};"></div>
            <span class="text-[10px] font-bold ${i === currentFilterIndex ? 'text-white' : 'text-white/60'}">${f.name}</span>
        </button>
    `).join('');

    track.querySelectorAll('.filter-swatch-btn').forEach(btn => {
        btn.addEventListener('click', () => applyFilter(parseInt(btn.dataset.filterIndex, 10)));
    });
}

// 🚀 NEW: single source of truth for changing filters — used by both the carousel tap and
// the existing swipe gesture, so the two controls never fall out of sync with each other.
function applyFilter(index) {
    currentFilterIndex = index;
    const filter = FILTER_LIST[index];
    const targetEl = document.getElementById(currentMediaType === 'video' ? 'hotpost-preview-video' : 'hotpost-preview-img');
    targetEl.style.filter = filter.css;
    renderFilterCarousel();
}

let textElements = [];
let activeTextId = null;
let activeTextIdForTouch = null;
let textTouchStartTime = 0;
let initialPinchDist = 0;
let initialTextScale = 1.0;
let textInitialObjX = 0, textInitialObjY = 0;

let isDrawMode = false;
let isDrawing = false;
let currentDoodleColor = '#FFFFFF'; 
let currentDoodleWidth = 6; 
let doodlePaths = []; 
let currentPath = [];

let currentViewerState = {
    userId: null, userOrder: [], userIndex: -1, postIndex: 0,
    storyTimer: null, storyDuration: 5000, animationStartTime: 0, remainingDuration: 0,
};

const CLOUDINARY_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
// 🚀 NEW: hotpost videos upload to a separate Cloudinary account/preset (see config.js) —
// the main account was hitting a video-specific limit that images don't count against.
const CLOUDINARY_VIDEO_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_VIDEO_CLOUD_NAME}/video/upload`;

export function initHotposts(user) {
    currentUser = user;
    setupEventListeners();
    fetchHotposts();
}

function setupEventListeners() {
    document.getElementById('close-hotpost-camera-btn')?.addEventListener('click', attemptCloseCamera);
    document.getElementById('switch-hotpost-camera-btn')?.addEventListener('click', switchCamera);
    document.getElementById('flash-toggle-btn')?.addEventListener('click', toggleFlash);
    document.getElementById('submit-hotpost-btn')?.addEventListener('click', submitHotpost);

    document.getElementById('add-text-hotpost-btn')?.addEventListener('click', () => {
        document.querySelectorAll('.text-widget').forEach(el => el.classList.remove('active'));
        activeTextId = null;
        activeTextIdForTouch = null;
        activateTextTool(null);
    });
    
    document.getElementById('doodle-hotpost-btn')?.addEventListener('click', toggleDrawMode);
    document.getElementById('undo-doodle-btn')?.addEventListener('click', undoLastDoodle);
    
    document.querySelectorAll('.doodle-color-btn').forEach(btn => {
        btn.addEventListener('click', (e) => setDoodleColor(e.target.dataset.color));
    });

    document.getElementById('cancel-text-btn')?.addEventListener('click', () => {
        document.getElementById('hotpost-text-editor-overlay').classList.replace('flex', 'hidden');
    });
    document.getElementById('done-text-btn')?.addEventListener('click', saveTextFromUI);
    
    document.getElementById('toggle-text-bg-btn')?.addEventListener('click', () => {
        currentTextBg = !currentTextBg;
        updateTextUIPreview();
    });

    document.getElementById('toggle-text-align-btn')?.addEventListener('click', (e) => {
        const btn = e.currentTarget.querySelector('span');
        if (currentTextAlign === 'center') {
            currentTextAlign = 'left';
            btn.textContent = 'format_align_left';
        } else if (currentTextAlign === 'left') {
            currentTextAlign = 'right';
            btn.textContent = 'format_align_right';
        } else {
            currentTextAlign = 'center';
            btn.textContent = 'format_align_center';
        }
        updateTextUIPreview();
    });

    const colorPicker = document.getElementById('text-color-picker');
    if (colorPicker) {
        colorPicker.innerHTML = TEXT_COLORS.map(color => `
            <button class="w-8 h-8 rounded-full shrink-0 border-2 ${color === '#FFFFFF' ? 'border-gray-300' : 'border-transparent'} shadow-sm transition-transform active:scale-90 text-color-btn" data-color="${color}" style="background-color: ${color};"></button>
        `).join('');
        colorPicker.querySelectorAll('.text-color-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                currentTextColor = e.currentTarget.dataset.color; 
                updateTextUIPreview();
            });
        });
    }

    const fontPicker = document.getElementById('text-font-picker');
    if (fontPicker) {
        fontPicker.innerHTML = TEXT_FONTS.map((font, index) => `
            <button class="px-4 py-1.5 rounded-full shrink-0 bg-white/20 text-white font-bold text-sm transition-transform active:scale-90 text-font-btn" data-fontindex="${index}" style="font-family: ${font.value.replace(/"/g, "'")}">${font.name}</button>
        `).join('');
        fontPicker.querySelectorAll('.text-font-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = e.currentTarget.dataset.fontindex; 
                currentTextFont = TEXT_FONTS[idx].value;
                updateTextUIPreview();
            });
        });
    }
    
    setupVideoZoomPhysics();
    setupEditorTouchPhysics();
    setupViewerTouchPhysics();

    document.getElementById('close-hotpost-viewer-btn')?.addEventListener('click', closeHotpostViewer);
    document.getElementById('hotpost-viewer-mute-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const vidEl = document.getElementById('hotpost-viewer-video');
        vidEl.muted = !vidEl.muted;
        viewerMuted = vidEl.muted; // remember the choice for the rest of this viewing session
        e.currentTarget.querySelector('span').textContent = vidEl.muted ? 'volume_off' : 'volume_up';
        if (!vidEl.muted) document.getElementById('hotpost-tap-for-sound')?.classList.add('hidden');
    });
    document.getElementById('hotpost-reply-btn')?.addEventListener('click', handleReplyToHotpost);
    document.getElementById('hotpost-like-btn')?.addEventListener('click', handleLikeHotpost);

    const navNext = document.getElementById('hotpost-nav-next');
    const navPrev = document.getElementById('hotpost-nav-prev');
    const replyInput = document.getElementById('hotpost-reply-input');
    
    let storyTouchTimer = null;
    let isStoryHolding = false;
    let lastTapTime = 0;

    const handleStoryPointerDown = (e) => {
        pauseStory();
        isStoryHolding = false;

        const currentTime = new Date().getTime();
        const tapLength = currentTime - lastTapTime;
        
        if (tapLength < 300 && tapLength > 0) {
            clearTimeout(storyTouchTimer);
            if (currentViewerState.userId !== currentUser.id) {
                // 🚀 FIX: this used to call the same toggle function as the heart button, so
                // double-tapping an already-liked story would silently unlike it. Instagram's
                // double-tap only ever likes — never toggles off.
                likeStoryFromDoubleTap();
                window.showDoubleTapHeart(e.clientX, e.clientY);
            }
            lastTapTime = 0; 
            return;
        }
        lastTapTime = currentTime;

        storyTouchTimer = setTimeout(() => {
            isStoryHolding = true;
            window.toggleViewerUI(false); 
        }, 200);
    };

    const handleStoryPointerUp = (e) => {
        clearTimeout(storyTouchTimer);
        resumeStory();
        
        if (isStoryHolding) {
            window.toggleViewerUI(true); 
        } else {
            if (e.target.id === 'hotpost-nav-next') nextStory();
            if (e.target.id === 'hotpost-nav-prev') prevStory();
        }
        isStoryHolding = false;
    };

    [navNext, navPrev].forEach(el => {
        if (el) {
            el.addEventListener('pointerdown', handleStoryPointerDown);
            el.addEventListener('pointerup', handleStoryPointerUp);
            el.addEventListener('pointerleave', () => {
                clearTimeout(storyTouchTimer);
                if (isStoryHolding) window.toggleViewerUI(true);
                resumeStory();
                isStoryHolding = false;
            });
        }
    });
    
    replyInput?.addEventListener('focus', pauseStory);
    replyInput?.addEventListener('blur', resumeStory);

    document.getElementById('hotpost-activity-btn')?.addEventListener('click', openActivityPanel);
    document.getElementById('activity-backdrop-close')?.addEventListener('click', closeActivityPanel);
    
    document.getElementById('delete-hotpost-action-btn')?.addEventListener('click', () => {
        showCustomConfirm("Delete Hotpost?", "This will permanently remove this post from your story.", executeDeleteHotpost);
    });

    // ---------------------------------------------------------
    // 🚀 NEW LOGIC FROM STEP 2A: MUTE BUTTON AND CAPTURE PHYSICS
    // ---------------------------------------------------------

    // 🚀 NEW: Mute/Unmute Video Preview
    document.getElementById('hotpost-mute-btn')?.addEventListener('click', (e) => {
        const vidEl = document.getElementById('hotpost-preview-video');
        const icon = e.currentTarget.querySelector('span');
        vidEl.muted = !vidEl.muted;
        icon.textContent = vidEl.muted ? 'volume_off' : 'volume_up';
    });

// 🚀 Absolute Bulletproof Touch/Mouse Hybrid Physics
    const captureBtn = document.getElementById('capture-hotpost-btn');
    let pressTimer = null;
    let isPressing = false;
    let isRecordingVideo = false;
    let startCaptureY = 0;
    let initialCaptureZoom = 1;

    const startPress = (e) => {
        if (e.type === 'touchstart' && e.cancelable) e.preventDefault(); 
        if (isPressing) return;
        isPressing = true;
        isRecordingVideo = false;

        // 🚀 NEW: Premium haptic "click" when touching the button
        if (navigator.vibrate) navigator.vibrate(50); 

        if (e.touches) {
            startCaptureY = e.touches[0].clientY;
            initialCaptureZoom = videoZoomScale;
        }

        pressTimer = setTimeout(() => { 
            if (isPressing) {
                isRecordingVideo = true;
                // 🚀 FIX: starting the recorder in the same tick as the vibration call meant
                // the phone's vibration motor (mechanically right next to the mic on most
                // devices) was getting physically picked up in the first ~150ms of audio.
                // Fire the confirmation haptic, then wait for it to actually finish before
                // the mic starts being recorded.
                if (navigator.vibrate) navigator.vibrate([50, 50, 50]); 
                setTimeout(() => { if (isRecordingVideo && isPressing) startRecording(); }, 180);
            }
        }, 300); 
    };
    
    const movePress = (e) => {
        if (!isPressing) return;
        if (e.cancelable) e.preventDefault();
        
        if (e.touches) {
            const currentY = e.touches[0].clientY;
            const deltaY = startCaptureY - currentY; 
            updateCameraZoom(initialCaptureZoom + (deltaY * 0.015));
        }
    };

    const endPress = (e) => {
        if (e.type === 'touchend' || e.type === 'touchcancel') {
            if (e.cancelable) e.preventDefault();
        }
        
        if (!isPressing) return;
        isPressing = false;
        clearTimeout(pressTimer);
        
        if (isRecordingVideo) {
            stopRecording(); 
            if (navigator.vibrate) navigator.vibrate(50); // Haptic stop
        } else {
            capturePhoto(); 
        }
        isRecordingVideo = false;
    };

    if (captureBtn) {
        captureBtn.addEventListener('touchstart', startPress, { passive: false });
        captureBtn.addEventListener('touchmove', movePress, { passive: false }); 
        captureBtn.addEventListener('touchend', endPress, { passive: false });
        captureBtn.addEventListener('touchcancel', endPress, { passive: false });
        
        captureBtn.addEventListener('mousedown', startPress);
        captureBtn.addEventListener('mouseup', endPress);
        captureBtn.addEventListener('mouseleave', endPress);
    }
    // ---------------------------------------------------------

    // 🚀 NEW: Bulletproof Gallery Input (Memory Safe, Handles Images & Videos)
    document.getElementById('hotpost-gallery-input')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Clean up old memory before processing the new file
        if (currentPreviewObjectURL) {
            URL.revokeObjectURL(currentPreviewObjectURL);
            currentPreviewObjectURL = null;
        }

        if (file.type.startsWith('video/')) {
            // 🚀 FIX: 30MB was rejecting completely ordinary phone clips. Cloudinary's free-plan
            // unsigned upload ceiling is ~100MB — cap there instead, matching what will actually work.
            if (file.size > 100 * 1024 * 1024) return showToast('Video is too large (max 100MB). Try a shorter clip.', 'error');
            
            currentMediaType = 'video';
            currentPhotoBlob = file;
            currentPreviewObjectURL = URL.createObjectURL(file);
            
            const videoEl = document.getElementById('hotpost-preview-video');
            videoEl.src = currentPreviewObjectURL;
            
            // 🚀 FIX: Use onloadeddata for strict mobile compatibility instead of metadata
            videoEl.onloadeddata = () => {
                filterThumbnailDataUrl = generateFilterThumbnail(videoEl);
                showPreviewUI();
                playWithSoundFallback(videoEl, 'hotpost-mute-btn');
                initDoodleCanvas();
            };
        } else {
            currentMediaType = 'image';
            const reader = new FileReader();
            reader.onload = (event) => {
                currentPhotoBlob = file;
                baseImageObj = new Image();
                baseImageObj.onload = () => {
                    document.getElementById('hotpost-preview-img').src = event.target.result;
                    imgTransform = { scale: 1, x: 0, y: 0 }; 
                    document.getElementById('hotpost-preview-img').style.transform = `translate(0px, 0px) scale(1)`;
                    filterThumbnailDataUrl = generateFilterThumbnail(baseImageObj);
                    showPreviewUI();
                    initDoodleCanvas();
                };
                baseImageObj.src = event.target.result;
            };
            reader.readAsDataURL(file);
        }
        
        e.target.value = '';
    });

    // 🚀 NEW: Hardware Volume Button Shutter (Pro Feature)
    window.addEventListener('keydown', (e) => {
        const cameraModal = document.getElementById('modal-hotpost-camera');
        const previewUI = document.getElementById('preview-ui');
        
        // Only trigger if Camera is open AND we are NOT in the review screen
        if (!cameraModal.classList.contains('hidden') && previewUI.classList.contains('hidden')) {
            if (e.key === 'VolumeUp' || e.key === 'VolumeDown') {
                e.preventDefault(); // Stop the phone volume slider from showing up
                if (!isRecordingVideo) {
                    if (navigator.vibrate) navigator.vibrate(50);
                    capturePhoto();
                }
            }
        }
    });
}

function showCustomConfirm(title, message, onConfirm) {
    pauseStory();
    const modal = document.getElementById('modal-confirm-action');
    if(!modal) return;
    
    document.getElementById('confirm-action-title').textContent = title;
    document.getElementById('confirm-action-message').textContent = message;
    
    modal.classList.replace('hidden', 'flex');
    
    const confirmBtn = document.getElementById('confirm-action-yes');
    const cancelBtn = document.getElementById('confirm-action-no');
    
    const newConfirmBtn = confirmBtn.cloneNode(true);
    const newCancelBtn = cancelBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
    
    newCancelBtn.addEventListener('click', () => {
        modal.classList.replace('flex', 'hidden');
        resumeStory();
    });
    
    newConfirmBtn.addEventListener('click', () => {
        modal.classList.replace('flex', 'hidden');
        onConfirm();
    });
}

function attemptCloseCamera() {
    if (currentPhotoBlob) {
        showCustomConfirm("Discard Hotpost?", "If you go back now, you will lose your edits.", () => {
            resetCameraUI();
            closeCameraModal(true); 
        });
    } else {
        closeCameraModal(true);
    }
}

// ==========================================
// CAMERA ENGINE
// ==========================================
async function openCameraModal() {
    if (!window.checkVerification('post a story')) return; // 🚀 Soft Restrict Check

    const modal = document.getElementById('modal-hotpost-camera');
    const video = document.getElementById('hotpost-camera-feed');
    modal.classList.replace('hidden', 'flex');
    resetCameraUI();
    toggleCameraStatusBar(true);

    if (currentCameraStream) currentCameraStream.getTracks().forEach(track => track.stop());

    try {
        // 🚀 FIX: Reduced resolution to 720p. 1080p causes severe real-time encoding lag on mobile devices!
        // 🚀 FIX: browser-default audio processing (echo cancellation / noise suppression / AGC)
        // adds real processing latency on a lot of Android devices and is a common independent
        // cause of audio drift — turn it off and record the raw mic signal instead.
        currentCameraStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: currentFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
        video.srcObject = currentCameraStream;
        video.muted = true; 
        
        videoZoomScale = 1;
        isHardwareZoomActive = false;
        video.style.transform = currentFacingMode === 'user' ? `scaleX(-1) scale(1)` : `scale(1)`;
    } catch (err) {
        showToast('Camera or Microphone access denied.', 'error');
        closeCameraModal(true);
    }
}

function closeCameraModal(force = false) {
    const modal = document.getElementById('modal-hotpost-camera');

    // 🚀 FIX: hiding the modal (below) doesn't stop an already-playing <video> — its audio
    // keeps coming through the speakers. This used to only get paused in resetCameraUI(),
    // which doesn't run until the entire background upload finishes (seconds later for video).
    // Stop it immediately instead.
    const previewVideo = document.getElementById('hotpost-preview-video');
    if (previewVideo) previewVideo.pause();
    
    // IMPROVED: Cleanup camera stream properly
    if (currentCameraStream) {
        try {
            currentCameraStream.getTracks().forEach(track => {
                track.stop();
            });
            currentCameraStream = null;
        } catch (e) {
            console.error("Error stopping camera stream:", e);
        }
    }

    // IMPROVED: Cleanup video recording
    if (mediaRecorder && isRecording) {
        try {
            mediaRecorder.stop();
            isRecording = false;
        } catch (e) {
            console.error("Error stopping recording:", e);
        }
    }

    if (recordingTimer) {
        clearInterval(recordingTimer);
        recordingTimer = null;
    }

    // IMPROVED: Cleanup preview URL
    if (currentPhotoBlob) {
        try {
            if (currentPreviewObjectURL) {
                URL.revokeObjectURL(currentPreviewObjectURL);
                currentPreviewObjectURL = null;
            }
            currentPhotoBlob = null;
        } catch (e) {
            console.error("Error revoking object URL:", e);
        }
    }

    modal.classList.replace('flex', 'hidden');
    toggleCameraStatusBar(false);
}

let isFlashOn = false;

function switchCamera() {
    currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
    isFlashOn = false; // 🚀 Front cameras don't have a flash — reset so state can't lie
    const flashIcon = document.querySelector('#flash-toggle-btn span');
    if (flashIcon) flashIcon.textContent = 'flash_off';
    openCameraModal();
}

// 🚀 NEW: torch/flash toggle. Only works where the browser exposes MediaStreamTrack torch
// control — Android Chrome on the rear camera, generally. iOS Safari doesn't expose torch
// control via getUserMedia at all, so this tells the person plainly rather than doing nothing.
function toggleFlash() {
    if (!currentCameraStream) return;
    const track = currentCameraStream.getVideoTracks()[0];
    const capabilities = track.getCapabilities ? track.getCapabilities() : {};

    if (!capabilities.torch) {
        showToast('Flash isn\'t available on this camera/device.', 'info');
        return;
    }

    isFlashOn = !isFlashOn;
    track.applyConstraints({ advanced: [{ torch: isFlashOn }] }).catch(() => {
        isFlashOn = !isFlashOn; // revert on failure
        showToast('Could not toggle flash.', 'error');
    });

    const flashIcon = document.querySelector('#flash-toggle-btn span');
    if (flashIcon) flashIcon.textContent = isFlashOn ? 'flash_on' : 'flash_off';
}

function setupVideoZoomPhysics() {
    const video = document.getElementById('hotpost-camera-feed');
    let initialY = 0;
    let initialZoom = 1;
    let lastTapTime = 0; // 🚀 For tracking double-taps
    let lastTouchCount = 0;

    const getPinchDistance = (touches) => {
        return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    };

    // 🚀 FIX: re-anchor the gesture baseline whenever the finger count changes mid-gesture
    // (e.g. lifting one finger after a pinch to keep panning with the other). Previously the
    // baseline stayed stuck at whatever it was from the very first touch, so zoom would jump.
    const recalibrate = (touches) => {
        if (touches.length === 2) {
            initialVideoPinchDist = getPinchDistance(touches);
            initialZoom = videoZoomScale;
        } else if (touches.length === 1) {
            initialY = touches[0].clientY;
            initialZoom = videoZoomScale;
        }
    };

    video.addEventListener('touchstart', (e) => {
        if (document.getElementById('preview-ui').classList.contains('hidden')) {
            recalibrate(e.touches);
            lastTouchCount = e.touches.length;
        }
    }, { passive: true });

    video.addEventListener('touchmove', (e) => {
        if (document.getElementById('preview-ui').classList.contains('hidden')) {
            if (e.cancelable) e.preventDefault();

            if (e.touches.length !== lastTouchCount) {
                recalibrate(e.touches);
                lastTouchCount = e.touches.length;
                return; // wait for the next move to compute a delta against the new baseline
            }

            if (e.touches.length === 2) {
                const currentDist = getPinchDistance(e.touches);
                updateCameraZoom(initialZoom * (currentDist / initialVideoPinchDist));
            } else if (e.touches.length === 1) {
                const currentY = e.touches[0].clientY;
                const deltaY = initialY - currentY; 
                updateCameraZoom(initialZoom + (deltaY * 0.015));
            }
        }
    }, { passive: false });

    // 🚀 NEW: Double-Tap to Flip Camera Muscle Memory
    video.addEventListener('touchend', (e) => {
        if (document.getElementById('preview-ui').classList.contains('hidden')) {
            lastTouchCount = e.touches.length;
            if (e.touches.length > 0) recalibrate(e.touches);

            const currentTime = new Date().getTime();
            const tapLength = currentTime - lastTapTime;
            
            // 🚀 FIX: only counts as a double-tap once ALL fingers are up — otherwise releasing
            // one finger from a pinch could accidentally flip the camera.
            if (tapLength < 300 && tapLength > 0 && e.changedTouches.length === 1 && e.touches.length === 0) {
                switchCamera();
                if (navigator.vibrate) navigator.vibrate(50); // Haptic tick
            }
            lastTapTime = currentTime;
        }
    }, { passive: true });
}

let isHardwareZoomActive = false;

function updateCameraZoom(newScale) {
    videoZoomScale = Math.max(1.0, Math.min(4.0, newScale));
    const video = document.getElementById('hotpost-camera-feed');
    
    if (currentCameraStream) {
        const track = currentCameraStream.getVideoTracks()[0];
        const capabilities = track.getCapabilities ? track.getCapabilities() : {};
        
        if (capabilities.zoom) {
            isHardwareZoomActive = true;
            const min = capabilities.zoom.min || 1;
            const max = capabilities.zoom.max || 4;
            const targetZoom = min + ((videoZoomScale - 1) / 3) * (max - min);
            
            track.applyConstraints({ advanced: [{ zoom: targetZoom }] }).catch(e => console.warn(e));
            
            // Clear software zoom so it doesn't double-zoom
            if(video) video.style.transform = currentFacingMode === 'user' ? `scaleX(-1)` : `scale(1)`;
            return;
        }
    }
    
    // Fallback: Pure software CSS zoom
    isHardwareZoomActive = false;
    if(video) {
        video.style.transform = currentFacingMode === 'user' 
            ? `scaleX(-1) scale(${videoZoomScale})` 
            : `scale(${videoZoomScale})`;
    }
}

function capturePhoto() {
    if (!currentCameraStream) return;

    const video = document.getElementById('hotpost-camera-feed');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');

    if (currentFacingMode === 'user') {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
    }

    // Capture raw frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
        currentPhotoBlob = blob;
        currentMediaType = 'image';
        baseImageObj = new Image();
        baseImageObj.onload = () => {
            const previewImg = document.getElementById('hotpost-preview-img');
            previewImg.src = URL.createObjectURL(blob);
            
            // 🚀 Carry over software zoom. If hardware zoom worked, image is ALREADY zoomed (scale 1).
            const reviewScale = isHardwareZoomActive ? 1 : videoZoomScale;
            imgTransform = { scale: reviewScale, x: 0, y: 0 };
            previewImg.style.transform = `translate(0px, 0px) scale(${reviewScale})`;
            
            filterThumbnailDataUrl = generateFilterThumbnail(baseImageObj);
            showPreviewUI();
            initDoodleCanvas();
        };
        baseImageObj.src = URL.createObjectURL(blob);
    }, 'image/webp', 0.9);
}
let animationFrameId = null;
function startRecording() {
    if (!currentCameraStream) return;
    isRecording = true;
    recordedChunks = [];
    currentMediaType = 'video';
    
    const innerCircle = document.getElementById('capture-inner-circle');
    innerCircle.classList.remove('bg-white');
    innerCircle.style.backgroundColor = '#a855f7'; 
    innerCircle.classList.add('scale-75'); 
    
    const ring = document.getElementById('capture-progress-ring');
    ring.classList.remove('opacity-0');
    
    const circle = ring.querySelector('circle');
    circle.style.transition = 'none';
    circle.style.strokeDashoffset = '239';
    void circle.offsetWidth; 
    
    circle.style.transition = 'stroke-dashoffset 30s linear';
    circle.style.strokeDashoffset = '0';

   // 🚀 STABILITY FIX (re-confirmed): canvas-based recording (canvas.captureStream() + a
    // combined audio track) causes real audio/video lag and can fail to produce a postable
    // file on real devices — this is why a previous pass of this code already avoided it.
    // Record the raw hardware stream directly.
    let streamToRecord = currentCameraStream;

    // 🚀 FIX: software (non-hardware) zoom can't be captured by the raw stream, so rather than
    // letting the user film zoomed-in and be surprised the output isn't, disable it up front —
    // hardware zoom (the common case on modern phones) is unaffected and still fully captured.
    if (!isHardwareZoomActive && videoZoomScale > 1) {
        videoZoomScale = 1;
        const video = document.getElementById('hotpost-camera-feed');
        if (video) video.style.transform = currentFacingMode === 'user' ? `scaleX(-1) scale(1)` : `scale(1)`;
        showToast('Digital zoom isn\'t available for video on this device.', 'info');
    }

   // 🚀 FIX: Increased bitrate to 4 Mbps for much higher local video quality
    let options = { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 4000000 };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = { mimeType: 'video/mp4', videoBitsPerSecond: 4000000 }; 
    }
    try { 
        mediaRecorder = new MediaRecorder(streamToRecord, options); 
    } catch(e) { 
        mediaRecorder = new MediaRecorder(streamToRecord); 
    }
    // 🚀 remember the *actual* mimeType we recorded with, so upload filename/extension
    // and Cloudinary delivery match reality instead of always claiming ".mp4".
    recordedMimeType = mediaRecorder.mimeType || options.mimeType;

    mediaRecorder.ondataavailable = (e) => { 
        if (e.data && e.data.size > 0) recordedChunks.push(e.data); 
    };
    
    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
        currentPhotoBlob = blob;
        
        if (currentPreviewObjectURL) URL.revokeObjectURL(currentPreviewObjectURL);
        currentPreviewObjectURL = URL.createObjectURL(blob);
        
        const videoEl = document.getElementById('hotpost-preview-video');
        videoEl.src = currentPreviewObjectURL;
        
        videoEl.onloadeddata = () => {
            // Whatever zoom is in the recording (hardware zoom, or none) is already in the raw
            // pixels — the editor starts flat, and further pinch-zoom here still works as before.
            imgTransform = { scale: 1, x: 0, y: 0 };
            videoEl.style.transform = `translate(0px, 0px) scale(1)`;

            filterThumbnailDataUrl = generateFilterThumbnail(videoEl);
            showPreviewUI();
            playWithSoundFallback(videoEl, 'hotpost-mute-btn');
            initDoodleCanvas();
        }
    };
    
    mediaRecorder.start(500); 
    recordingTimer = setTimeout(() => { if (isRecording) stopRecording(); }, 30000); 
}

function stopRecording() {
    isRecording = false;
    clearTimeout(recordingTimer);
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    
    // UI Reset
    const innerCircle = document.getElementById('capture-inner-circle');
    innerCircle.style.backgroundColor = ''; 
    innerCircle.classList.add('bg-white');
    innerCircle.classList.remove('scale-75');
    
    const ring = document.getElementById('capture-progress-ring');
    if (ring) {
        ring.classList.add('opacity-0');
        const circle = ring.querySelector('circle');
        circle.style.transition = 'none';
        circle.style.strokeDashoffset = '239';
    }
}

function resetCameraUI() {
    if (currentPreviewObjectURL) {
        URL.revokeObjectURL(currentPreviewObjectURL);
        currentPreviewObjectURL = null;
    }

    document.getElementById('hotpost-camera-feed').classList.remove('hidden');
    document.getElementById('hotpost-preview-container').classList.add('hidden');
    document.getElementById('capture-ui').classList.remove('hidden');
    document.getElementById('preview-ui').classList.add('hidden');
    document.getElementById('switch-hotpost-camera-btn').classList.remove('hidden');
    document.getElementById('flash-toggle-btn')?.classList.remove('hidden');
    if (isFlashOn && currentCameraStream) {
        currentCameraStream.getVideoTracks()[0]?.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
    }
    isFlashOn = false;
    const flashIcon = document.querySelector('#flash-toggle-btn span');
    if (flashIcon) flashIcon.textContent = 'flash_off';
    document.getElementById('editor-tools-container').classList.add('hidden');
    document.getElementById('hotpost-mute-btn').classList.add('hidden'); 
    document.getElementById('undo-doodle-btn').classList.add('hidden'); 
    
    currentPhotoBlob = null;
    currentMediaType = 'image'; 
    videoZoomScale = 1;
    isHardwareZoomActive = false;
    filterThumbnailDataUrl = null;
    const video = document.getElementById('hotpost-camera-feed');
    if(video) video.style.transform = currentFacingMode === 'user' ? `scaleX(-1) scale(1)` : `scale(1)`;

    imgTransform = { scale: 1, x: 0, y: 0 };
    const previewImg = document.getElementById('hotpost-preview-img');
    const previewVideo = document.getElementById('hotpost-preview-video');
    
    if(previewImg) {
        previewImg.style.transform = `translate(0px, 0px) scale(1)`;
        previewImg.style.filter = FILTER_LIST[0].css;
        previewImg.classList.add('hidden');
    }
    if(previewVideo) {
        previewVideo.pause();
        previewVideo.removeAttribute('src'); 
        previewVideo.load();
        previewVideo.classList.add('hidden');
        previewVideo.style.filter = FILTER_LIST[0].css;
    }
    
    currentFilterIndex = 0;
    isDrawMode = false;
    doodlePaths = [];
    
    const colorPicker = document.getElementById('doodle-color-picker');
    if (colorPicker) { colorPicker.classList.add('hidden'); colorPicker.classList.remove('flex'); }
    document.getElementById('doodle-size-slider')?.classList.add('hidden');
    
    const doodleBtn = document.getElementById('doodle-hotpost-btn');
    if (doodleBtn) { doodleBtn.classList.remove('bg-white', 'text-black'); doodleBtn.classList.add('bg-black/40', 'text-white'); }
    
    document.querySelectorAll('.text-widget').forEach(el => el.remove());
    textElements = []; activeTextId = null; activeTextIdForTouch = null;

    // Reset Capture Button State
    const innerCircle = document.getElementById('capture-inner-circle');
    if(innerCircle) {
        innerCircle.style.backgroundColor = ''; 
        innerCircle.classList.add('bg-white');
        innerCircle.classList.remove('scale-75');
    }
    const ring = document.getElementById('capture-progress-ring');
    if (ring) {
        ring.classList.add('opacity-0');
        const circle = ring.querySelector('circle');
        if(circle) {
            circle.style.transition = 'none';
            circle.style.strokeDashoffset = '239';
        }
    }
}
// 🚀 NEW: Instagram-style sound handling — try unmuted first, only fall back to muted
// if the browser's autoplay policy actually blocks it, and reflect the real state in
// whatever mute button (if any) belongs to this video element.
function playWithSoundFallback(videoEl, muteBtnId) {
    const btn = muteBtnId ? document.getElementById(muteBtnId) : null;
    const setIcon = (muted) => {
        if (!btn) return;
        const span = btn.querySelector('span');
        if (span) span.textContent = muted ? 'volume_off' : 'volume_up';
    };

    videoEl.muted = false;
    const playPromise = videoEl.play();
    if (!playPromise || typeof playPromise.then !== 'function') { setIcon(false); return; }

    playPromise.then(() => setIcon(false)).catch(() => {
        videoEl.muted = true;
        setIcon(true);
        videoEl.play().catch(e => console.error('Playback blocked even muted:', e));
    });
}

function showPreviewUI() {
    document.getElementById('hotpost-camera-feed').classList.add('hidden');
    document.getElementById('hotpost-preview-container').classList.remove('hidden');
    document.getElementById('capture-ui').classList.add('hidden');
    document.getElementById('preview-ui').classList.remove('hidden');
    document.getElementById('preview-ui').classList.add('flex');
    document.getElementById('switch-hotpost-camera-btn').classList.add('hidden');
    document.getElementById('flash-toggle-btn')?.classList.add('hidden');
    document.getElementById('editor-tools-container').classList.remove('hidden');
    document.getElementById('editor-tools-container').classList.add('flex');
    
   if (currentMediaType === 'video') {
        document.getElementById('hotpost-preview-img').classList.add('hidden');
        const vidEl = document.getElementById('hotpost-preview-video');
        vidEl.classList.remove('hidden');
        
        // 🚀 Default to unmuted (matches Instagram); playWithSoundFallback only mutes if the
        // browser's autoplay policy actually blocks unmuted playback.
        const muteBtn = document.getElementById('hotpost-mute-btn');
        muteBtn.classList.remove('hidden');
        muteBtn.querySelector('span').textContent = 'volume_up';
    } else {
        document.getElementById('hotpost-preview-video').classList.add('hidden');
        document.getElementById('hotpost-preview-img').classList.remove('hidden');
        document.getElementById('hotpost-mute-btn').classList.add('hidden');
    }

    renderFilterCarousel();
}


// ==========================================
// EDITOR: FONT & TEXT ENGINE
// ==========================================
function activateTextTool(textId = null) {
    activeTextId = typeof textId === 'string' ? textId : null;
    
    const overlay = document.getElementById('hotpost-text-editor-overlay');
    const textarea = document.getElementById('hotpost-in-ui-textarea');
    
    overlay.classList.replace('hidden', 'flex');
    
    // 🚀 ALWAYS let the user type with full width, we shrink it when they hit "Done"
    textarea.style.width = '85vw'; 

    if (activeTextId) {
        const textObj = textElements.find(t => t.id === activeTextId);
        textarea.value = textObj ? textObj.content : '';
        currentTextFont = textObj.font || TEXT_FONTS[0].value;
        currentTextColor = textObj.color || '#FFFFFF';
        currentTextBg = textObj.hasBg || false;
        currentTextAlign = textObj.align || 'center';
    } else {
        textarea.value = '';
        currentTextFont = TEXT_FONTS[0].value;
        currentTextColor = '#FFFFFF';
        currentTextBg = false;
        currentTextAlign = 'center';
    }

    const alignBtnSpan = document.querySelector('#toggle-text-align-btn span');
    if (alignBtnSpan) alignBtnSpan.textContent = `format_align_${currentTextAlign}`;

    const adjustHeight = () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
    };
    textarea.removeEventListener('input', adjustHeight);
    textarea.addEventListener('input', adjustHeight);

 updateTextUIPreview();
    
    // 🚀 FIX: Call focus synchronously so mobile browsers don't block the keyboard
    textarea.focus();
    adjustHeight(); 
}

// 🚀 RESTORED MISSING FUNCTION: Handles Live UI Updates for Fonts, Alignment & Colors
function updateTextUIPreview() {
    const textarea = document.getElementById('hotpost-in-ui-textarea');
    
    // Force Font & Alignment updates overriding stubborn CSS
    textarea.style.setProperty('font-family', currentTextFont.replace(/"/g, "'"), 'important');
    textarea.style.setProperty('text-align', currentTextAlign, 'important');
    
    const isNeon = currentTextFont === TEXT_FONTS[2].value;

    if (currentTextBg) {
        textarea.style.setProperty('background-color', currentTextColor, 'important');
        textarea.style.setProperty('color', getContrastYIQ(currentTextColor), 'important');
        textarea.style.setProperty('text-shadow', 'none', 'important');
        textarea.style.setProperty('padding', '10px', 'important');
        textarea.style.setProperty('border-radius', '12px', 'important');
    } else {
        textarea.style.setProperty('background-color', 'transparent', 'important');
        textarea.style.setProperty('padding', '0', 'important');
        textarea.style.setProperty('color', currentTextColor, 'important');
        
        if (isNeon) {
            textarea.style.setProperty('text-shadow', `0 0 10px ${currentTextColor}, 0 0 20px ${currentTextColor}`, 'important');
        } else {
            textarea.style.setProperty('text-shadow', '0 4px 16px rgba(0,0,0,0.9)', 'important');
        }
    }
    
    // Update Button Selection States
    document.querySelectorAll('.text-color-btn').forEach(btn => {
        btn.style.transform = btn.dataset.color === currentTextColor ? 'scale(1.2)' : 'scale(1)';
        btn.style.border = btn.dataset.color === currentTextColor ? '2px solid white' : (btn.dataset.color === '#FFFFFF' ? '2px solid #ccc' : '2px solid transparent');
    });

    document.querySelectorAll('.text-font-btn').forEach(btn => {
        const idx = btn.dataset.fontindex;
        const isSelected = TEXT_FONTS[idx].value === currentTextFont;
        btn.style.backgroundColor = isSelected ? 'white' : 'rgba(255,255,255,0.2)';
        btn.style.color = isSelected ? 'black' : 'white';
    });

    const bgBtn = document.getElementById('toggle-text-bg-btn');
    if (bgBtn) {
        bgBtn.style.backgroundColor = currentTextBg ? 'white' : 'transparent';
        bgBtn.style.color = currentTextBg ? 'black' : 'white';
    }
}

function saveTextFromUI() {
    const textarea = document.getElementById('hotpost-in-ui-textarea');
    // Strip invisible trailing spaces that ruin alignment
    const content = textarea.value.split('\n').map(line => line.trimEnd()).join('\n').trim();
    
    if (content) {
        if (activeTextId) {
            const textObj = textElements.find(t => t.id === activeTextId);
            if (textObj) {
                textObj.content = content;
                textObj.font = currentTextFont;
                textObj.color = currentTextColor;
                textObj.hasBg = currentTextBg;
                textObj.align = currentTextAlign;
            }
        } else {
            const newId = 'text-' + Date.now();
            textElements.push({ 
                id: newId, 
                content: content, 
                x: 0.5, 
                y: 0.5, 
                scale: 1.0,
                font: currentTextFont,
                color: currentTextColor,
                hasBg: currentTextBg,
                align: currentTextAlign
            });
            activeTextId = newId; 
        }
    } else if (activeTextId) {
        textElements = textElements.filter(t => t.id !== activeTextId);
    }
    
    renderTextElements();
    document.getElementById('hotpost-text-editor-overlay').classList.replace('flex', 'hidden');
}

function renderTextElements() {
    const container = document.getElementById('hotpost-preview-container');
    container.querySelectorAll('.text-widget').forEach(el => el.remove());

    textElements.forEach(tObj => {
        const isActive = activeTextId === tObj.id;
        const widget = document.createElement('div');
        widget.className = `text-widget ${isActive ? 'active' : ''}`;
        widget.id = tObj.id;
        widget.style.left = `${tObj.x * 100}%`;
        widget.style.top = `${tObj.y * 100}%`;
        widget.style.transform = `translate(-50%, -50%) scale(${tObj.scale})`;

        const isNeon = tObj.font === TEXT_FONTS[2].value;
        let bgCSS = '';
        let shadowCSS = '';
        
        // Dynamic Padding for Backgrounds
        const paddingCSS = tObj.hasBg ? 'padding: 4px 12px; border-radius: 8px;' : 'padding: 0;';

        if (tObj.hasBg) {
            bgCSS = `background-color: ${tObj.color}; color: ${getContrastYIQ(tObj.color)}; ${paddingCSS}`;
            shadowCSS = `text-shadow: none;`;
        } else {
            bgCSS = `color: ${tObj.color};`;
            if (isNeon) {
                shadowCSS = `text-shadow: 0 0 10px ${tObj.color}, 0 0 20px ${tObj.color};`;
            } else {
                shadowCSS = `text-shadow: 0 4px 16px rgba(0,0,0,0.9);`;
            }
        }

        // Flexbox mapping aligns the individual lines perfectly
        const alignMap = { left: 'flex-start', center: 'center', right: 'flex-end' };
        const flexAlign = alignMap[tObj.align || 'center'];

        // Split text into lines so backgrounds don't bleed across empty spaces
        const linesHTML = tObj.content.split('\n').map(line => {
            const safeLine = line === '' ? '&#8203;' : line.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            return `<span style="${bgCSS} ${shadowCSS} display: inline-block; max-width: 85vw; word-wrap: break-word; white-space: pre-wrap; margin-bottom: 4px;">${safeLine}</span>`;
        }).join('');

        widget.innerHTML = `
            <div class="text-widget-box" style="display: flex; flex-direction: column; align-items: ${flexAlign}; max-width: 85vw; width: max-content;">
                <div class="text-handle handle-tl" data-action="delete"><span class="material-symbols-outlined text-[18px]">close</span></div>
                <div class="text-handle handle-tr" data-action="edit"><span class="material-symbols-outlined text-[16px]">edit</span></div>
                <div class="text-handle handle-bl" data-action="duplicate"><span class="material-symbols-outlined text-[16px]">content_copy</span></div>
                <div class="text-handle handle-br" data-action="scale"><span class="material-symbols-outlined text-[18px]">open_in_full</span></div>
                <div class="text-widget-content" style="display: flex; flex-direction: column; align-items: ${flexAlign}; font-size: 24px; font-family: ${tObj.font.replace(/"/g, "'")}; text-align: ${tObj.align || 'center'}; line-height: 1.3;">
                    ${linesHTML}
                </div>
            </div>
        `;
        container.appendChild(widget);
    });
}

function initDoodleCanvas() {
    setTimeout(() => {
        const canvas = document.getElementById('hotpost-doodle-canvas');
        const container = document.getElementById('hotpost-preview-container');
        // 🚀 FIX: Fallback to innerWidth/innerHeight prevents the 0x0 hidden container bug
        canvas.width = container.clientWidth || window.innerWidth;
        canvas.height = container.clientHeight || window.innerHeight;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }, 150); // Give the container slightly more time to paint before fetching width
}

function toggleDrawMode() {
    isDrawMode = !isDrawMode;
    const colorPicker = document.getElementById('doodle-color-picker');
    const slider = document.getElementById('doodle-size-slider');
    const penBtn = document.getElementById('doodle-hotpost-btn');
    const undoBtn = document.getElementById('undo-doodle-btn'); // 🚀 NEW
    
    if (isDrawMode) {
        colorPicker.classList.remove('hidden');
        colorPicker.classList.add('flex', 'z-[200]'); 
        slider.classList.remove('hidden');
        slider.classList.add('z-[200]');
        penBtn.classList.replace('bg-black/40', 'bg-white');
        penBtn.classList.replace('text-white', 'text-black');
        if (undoBtn) undoBtn.classList.remove('hidden'); // Show Undo
    } else {
        colorPicker.classList.add('hidden');
        colorPicker.classList.remove('flex', 'z-[200]');
        slider.classList.add('hidden');
        slider.classList.remove('z-[200]');
        penBtn.classList.replace('bg-white', 'bg-black/40');
        penBtn.classList.replace('text-black', 'text-white');
        if (undoBtn) undoBtn.classList.add('hidden'); // Hide Undo
    }
}

function setDoodleColor(color) {
    currentDoodleColor = color;
    document.querySelectorAll('.doodle-color-btn').forEach(btn => btn.classList.remove('scale-125'));
    const activeBtn = document.querySelector(`.doodle-color-btn[data-color="${color}"]`);
    if(activeBtn) activeBtn.classList.add('scale-125');
}

function undoLastDoodle() {
    if (doodlePaths.length > 0) {
        doodlePaths.pop();
        redrawDoodleCanvas();
    }
}

function redrawDoodleCanvas() {
    const canvas = document.getElementById('hotpost-doodle-canvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    doodlePaths.forEach(pathObj => {
        ctx.lineWidth = pathObj.width || 6;
        ctx.strokeStyle = pathObj.color;
        ctx.shadowColor = pathObj.color;
        ctx.shadowBlur = 4;
        ctx.beginPath();
        pathObj.points.forEach((point, index) => {
            if (index === 0) ctx.moveTo(point.x, point.y);
            else ctx.lineTo(point.x, point.y);
        });
        ctx.stroke();
    });
}

function setupEditorTouchPhysics() {
    const container = document.getElementById('hotpost-preview-container');
    
    let touchMode = 'idle'; 
    let startX = 0, startY = 0;
    let widgetCenterX = 0, widgetCenterY = 0;
    let hasMovedSignificantly = false; // 🚀 NEW: Touch tolerance
    let lastBgTouchCount = 0; // 🚀 FIX: lets pinch-zoom hand off to single-finger pan mid-gesture

    const getPinchDistance = (touches) => {
        return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    };

    container.addEventListener('touchstart', (e) => {
        hasMovedSignificantly = false; // Reset threshold

        if (isDrawMode) {
            touchMode = 'draw';
            isDrawing = true;
            const rect = container.getBoundingClientRect();
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            currentPath = [{ x: startX - rect.left, y: startY - rect.top }];
            return;
        }

        const handle = e.target.closest('.text-handle');
        const widget = e.target.closest('.text-widget');

        if (handle) {
            e.stopPropagation(); 
            touchMode = handle.dataset.action; 
            activeTextIdForTouch = widget.id;
            activeTextId = widget.id;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;

            if (touchMode === 'delete') {
                textElements = textElements.filter(t => t.id !== activeTextIdForTouch);
                activeTextId = null;
                const widgetEl = document.getElementById(activeTextIdForTouch);
                if (widgetEl) widgetEl.remove();
                touchMode = 'idle';
            } else if (touchMode === 'edit') {
                activateTextTool(activeTextIdForTouch); 
                touchMode = 'idle';
            } else if (touchMode === 'duplicate') {
                const tObj = textElements.find(t => t.id === activeTextIdForTouch);
                const newId = 'text-' + Date.now();
                textElements.push({...tObj, id: newId, y: tObj.y + 0.08});
                activeTextId = newId;
                renderTextElements(); 
                touchMode = 'idle';
            } else if (touchMode === 'scale') {
                const tObj = textElements.find(t => t.id === activeTextIdForTouch);
                initialTextScale = tObj.scale;
                const rect = container.getBoundingClientRect();
                widgetCenterX = rect.left + (rect.width * tObj.x);
                widgetCenterY = rect.top + (rect.height * tObj.y);
                initialPinchDist = Math.hypot(startX - widgetCenterX, startY - widgetCenterY);
            }
            return;
        }
        
        if (widget) {
            e.stopPropagation();
            const wasAlreadyActive = widget.classList.contains('active');
            touchMode = 'drag_text';
            activeTextIdForTouch = widget.id;
            activeTextId = widget.id; 
            
            document.querySelectorAll('.text-widget').forEach(el => el.classList.remove('active'));
            widget.classList.add('active');

            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            
            widget.dataset.wasActive = wasAlreadyActive;
            widget.dataset.dragged = 'false';

            const tObj = textElements.find(t => t.id === activeTextIdForTouch);
            if(tObj) {
                textInitialObjX = tObj.x;
                textInitialObjY = tObj.y;
            }
            return;
        }
        
        activeTextId = null;
        activeTextIdForTouch = null;
        document.querySelectorAll('.text-widget').forEach(el => el.classList.remove('active'));

        if (e.touches.length === 2) {
            touchMode = 'zoom_bg';
            initialPinchDist = getPinchDistance(e.touches);
            initialBgScale = imgTransform.scale;
            lastBgTouchCount = 2;
            return;
        }

        if (e.touches.length === 1) {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            touchMode = imgTransform.scale > 1.0 ? 'pan_bg' : 'swipe';
            bgDragStartX = startX;
            bgDragStartY = startY;
            lastBgTouchCount = 1;
        }
    }, { passive: false });

    container.addEventListener('touchmove', (e) => {
        if (e.cancelable) e.preventDefault(); 
        if (touchMode === 'idle') return;

        const currentX = e.touches[0].clientX;
        const currentY = e.touches[0].clientY;
        const rect = container.getBoundingClientRect();

        // 🚀 FIX: pinch-zooming the background and lifting (or adding) a finger mid-gesture
        // used to freeze — the mode was set once at touchstart and never revisited. Hand off
        // between zoom_bg and pan_bg live instead of requiring a full release + re-touch.
        if ((touchMode === 'zoom_bg' || touchMode === 'pan_bg' || touchMode === 'swipe') && e.touches.length !== lastBgTouchCount) {
            if (e.touches.length === 2) {
                touchMode = 'zoom_bg';
                initialPinchDist = getPinchDistance(e.touches);
                initialBgScale = imgTransform.scale;
            } else if (e.touches.length === 1) {
                touchMode = imgTransform.scale > 1.0 ? 'pan_bg' : 'swipe';
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
                bgDragStartX = startX;
                bgDragStartY = startY;
            }
            lastBgTouchCount = e.touches.length;
            return; // wait for the next move to compute a delta against the new baseline
        }

        // 🚀 NEW: 10px Deadzone to prevent accidental jitter
        if (Math.abs(currentX - startX) > 10 || Math.abs(currentY - startY) > 10) {
            hasMovedSignificantly = true;
        }

        if (touchMode === 'scale') {
            const tObj = textElements.find(t => t.id === activeTextIdForTouch);
            const currentDist = Math.hypot(currentX - widgetCenterX, currentY - widgetCenterY);
            const scaleChange = currentDist / initialPinchDist;
            // Smoother scaling limit
            tObj.scale = Math.max(0.4, Math.min(8.0, initialTextScale * scaleChange)); 
            
            const widgetEl = document.getElementById(activeTextIdForTouch);
            if(widgetEl) widgetEl.style.transform = `translate(-50%, -50%) scale(${tObj.scale})`;
            return;
        }

        if (touchMode === 'drag_text' && activeTextIdForTouch && hasMovedSignificantly) {
            const widgetEl = document.getElementById(activeTextIdForTouch);
            if (widgetEl) widgetEl.dataset.dragged = 'true';

            const tObj = textElements.find(t => t.id === activeTextIdForTouch);
            if (tObj) {
                const deltaX = (currentX - startX) / rect.width;
                const deltaY = (currentY - startY) / rect.height;
                // Allow dragging slightly off-screen without breaking layout
                tObj.x = Math.max(-0.5, Math.min(1.5, textInitialObjX + deltaX)); 
                tObj.y = Math.max(-0.5, Math.min(1.5, textInitialObjY + deltaY));
                
                if(widgetEl) {
                    widgetEl.style.left = `${tObj.x * 100}%`;
                    widgetEl.style.top = `${tObj.y * 100}%`;
                }
            }
            return;
        } 

       if (touchMode === 'zoom_bg' && e.touches.length === 2) {
            const currentDist = getPinchDistance(e.touches);
            const scaleChange = currentDist / initialPinchDist;
            imgTransform.scale = Math.max(1.0, Math.min(4.0, initialBgScale * scaleChange));
            if (imgTransform.scale === 1.0) { imgTransform.x = 0; imgTransform.y = 0; }
            
            const transformStr = `translate(${imgTransform.x}px, ${imgTransform.y}px) scale(${imgTransform.scale})`;
            document.getElementById('hotpost-preview-img').style.transform = transformStr;
            document.getElementById('hotpost-preview-video').style.transform = transformStr;
            return;
        }

        if (touchMode === 'pan_bg' && hasMovedSignificantly) {
            imgTransform.x += currentX - bgDragStartX;
            imgTransform.y += currentY - bgDragStartY;
            bgDragStartX = currentX;
            bgDragStartY = currentY;
            
            const transformStr = `translate(${imgTransform.x}px, ${imgTransform.y}px) scale(${imgTransform.scale})`;
            document.getElementById('hotpost-preview-img').style.transform = transformStr;
            document.getElementById('hotpost-preview-video').style.transform = transformStr;
            return;
        }
        
        if (touchMode === 'draw' && isDrawing) {
            currentPath.push({ x: currentX - rect.left, y: currentY - rect.top });
            const ctx = document.getElementById('hotpost-doodle-canvas').getContext('2d');
            ctx.lineJoin = "round"; ctx.lineCap = "round"; 
            ctx.lineWidth = currentDoodleWidth; 
            ctx.strokeStyle = currentDoodleColor; ctx.shadowColor = currentDoodleColor; ctx.shadowBlur = 4;
            
            ctx.beginPath();
            const prev = currentPath[currentPath.length - 2];
            const curr = currentPath[currentPath.length - 1];
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(curr.x, curr.y);
            ctx.stroke();
        }
    }, { passive: false });
    
    container.addEventListener('touchend', (e) => {
        if (touchMode === 'drag_text' && activeTextIdForTouch) {
            const widgetEl = document.getElementById(activeTextIdForTouch);
            // Open editor ONLY if they tapped it without dragging significantly
            if (widgetEl && widgetEl.dataset.wasActive === 'true' && widgetEl.dataset.dragged === 'false') {
                activateTextTool(activeTextIdForTouch);
            }
        }

        if (touchMode === 'draw' && isDrawing) {
            isDrawing = false;
            if (currentPath.length > 1) doodlePaths.push({ color: currentDoodleColor, width: currentDoodleWidth, points: [...currentPath] });
            currentPath = [];
        }
        else if (touchMode === 'swipe' && !isDrawMode && hasMovedSignificantly) {
            const endX = e.changedTouches[0].clientX;
            const deltaX = endX - startX;

            // 🚀 NEW: Increased swipe threshold so users don't accidentally switch filters
            if (Math.abs(deltaX) > 80) { 
                const newIndex = deltaX < 0
                    ? (currentFilterIndex + 1) % FILTER_LIST.length
                    : (currentFilterIndex - 1 + FILTER_LIST.length) % FILTER_LIST.length;
                applyFilter(newIndex);
                showFilterToast(FILTER_LIST[newIndex].name);
            }
        }
        
        if (e.touches.length === 0) {
            touchMode = 'idle';
        }
    }, { passive: true });
}


function showFilterToast(name) {
    const toast = document.getElementById('filter-name-toast');
    toast.textContent = name;
    toast.classList.remove('hidden');
    toast.style.animation = 'none';
    toast.offsetHeight; 
    toast.style.animation = 'fadeOutUp 1s ease-out forwards';
}

// 🚀 NEW: pushes live status text ("Processing… 40%", "Uploading… 72%") onto the
// dashboard's "Uploading..." circle instead of it just spinning with no feedback.
function setUploadStatusLabel(text) {
    const label = document.getElementById('hotpost-upload-status-label');
    if (label) label.textContent = text;
}

// 🚀 NEW: uploads with real progress (fetch has no upload-progress event; XHR does),
// so the "Uploading…" circle can show an actual percentage instead of just spinning.
function uploadToCloudinary(url, formData, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
            try {
                const data = JSON.parse(xhr.responseText);
                if (data.error) reject(new Error(data.error.message));
                else resolve(data);
            } catch (err) { reject(new Error('Unexpected response from upload server.')); }
        };
        xhr.onerror = () => reject(new Error('Network error during upload.'));
        xhr.send(formData);
    });
}

// 🚀 NEW: bakes the chosen filter + any editor pinch-zoom/pan into the actual video pixels,
// the same way photos already get baked — previously these were preview-only and silently
// dropped at publish time. Only called when the user actually changed something (see caller),
// so the common case (no filter, no extra zoom) stays on the fast, lossless raw-upload path.
async function reencodeVideoWithEffects(sourceBlob, screenW, screenH, onProgress) {
    const sourceVideo = document.createElement('video');
    sourceVideo.muted = true; // local playback only — captureStream() still carries real audio
    sourceVideo.playsInline = true;
    sourceVideo.src = URL.createObjectURL(sourceBlob);

    if (typeof sourceVideo.captureStream !== 'function') {
        URL.revokeObjectURL(sourceVideo.src);
        return sourceBlob; // Browser can't do this — fall back to the raw (unfiltered) clip.
    }

    await new Promise((resolve, reject) => {
        sourceVideo.onloadedmetadata = resolve;
        sourceVideo.onerror = () => reject(new Error('Could not read recorded video.'));
    });

    const MAX_HEIGHT = 1280;
    const scaleFactor = MAX_HEIGHT / screenH;
    const finalWidth = Math.round(screenW * scaleFactor);
    const finalHeight = MAX_HEIGHT;

    const canvas = document.createElement('canvas');
    canvas.width = finalWidth;
    canvas.height = finalHeight;
    const ctx = canvas.getContext('2d');
    ctx.filter = FILTER_LIST[currentFilterIndex].css === 'none' ? 'none' : FILTER_LIST[currentFilterIndex].css;

    const vidAspect = sourceVideo.videoWidth / sourceVideo.videoHeight;
    const screenAspect = finalWidth / finalHeight;
    let drawW, drawH;
    if (vidAspect > screenAspect) { drawH = finalHeight; drawW = finalHeight * vidAspect; }
    else { drawW = finalWidth; drawH = finalWidth / vidAspect; }

    const drawFrame = () => {
        ctx.save();
        ctx.translate(finalWidth / 2, finalHeight / 2);
        ctx.scale(imgTransform.scale, imgTransform.scale);
        ctx.translate(imgTransform.x * scaleFactor, imgTransform.y * scaleFactor);
        ctx.drawImage(sourceVideo, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
    };

    const canvasStream = canvas.captureStream(30);
    sourceVideo.captureStream().getAudioTracks().forEach(t => canvasStream.addTrack(t));

    let options = { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 4000000 };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) options = { mimeType: 'video/webm', videoBitsPerSecond: 4000000 };
    const recorder = new MediaRecorder(canvasStream, options);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const resultBlob = await new Promise((resolve, reject) => {
        let rafId = null;
        recorder.onstop = () => {
            cancelAnimationFrame(rafId);
            URL.revokeObjectURL(sourceVideo.src);
            resolve(new Blob(chunks, { type: recorder.mimeType }));
        };
        recorder.onerror = (e) => reject(e.error || new Error('Re-encode failed.'));

        sourceVideo.onended = () => { if (recorder.state !== 'inactive') recorder.stop(); };
        sourceVideo.play().then(() => {
            recorder.start(250);
            const loop = () => {
                if (sourceVideo.ended || sourceVideo.paused) return;
                drawFrame();
                if (onProgress && sourceVideo.duration) {
                    onProgress(Math.min(99, Math.round((sourceVideo.currentTime / sourceVideo.duration) * 100)));
                }
                rafId = requestAnimationFrame(loop);
            };
            loop();
        }).catch(reject);
    });

    recordedMimeType = resultBlob.type || recordedMimeType;
    return resultBlob;
}

// ==========================================
// BACKGROUND UPLOADING ENGINE (Image & Video)
// ==========================================
async function submitHotpost() {
    if (!currentPhotoBlob) return;

    // 🚀 FIX: THE ACTUAL BUG. closeCameraModal() below (called to return to the dashboard for
    // background upload) wipes currentPhotoBlob to null as routine cleanup. Images never hit
    // this because they get re-baked from a separate baseImageObj further down — but video
    // uploads the original blob directly, so every single video post was throwing "Cannot read
    // properties of null (reading 'type')" the moment it tried to read it. Capture it locally
    // first, before it gets wiped.
    const capturedBlob = currentPhotoBlob;
    // 🚀 Same defensive pattern as capturedBlob above — read it before any async work runs.
    const capturedFilterIndex = currentFilterIndex;

    const visibilityBtn = document.getElementById('hotpost-send-visibility');
    const rewatchBtn = document.getElementById('hotpost-rewatch-toggle');
    const visibility = visibilityBtn ? visibilityBtn.dataset.val : 'everyone';
    const allowRewatch = rewatchBtn ? rewatchBtn.dataset.val === 'true' : true; 

    const previewContainer = document.getElementById('hotpost-preview-container');
    const screenW = previewContainer.clientWidth;
    const screenH = previewContainer.clientHeight;

    isUploadingBackground = true;
    renderHotpostCircles(); 
    closeCameraModal(true);
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    try {
        let finalMediaUrl = '';
        let finalOverlayUrl = null; // 🚀 NEW: Track overlay separately
        
        // --- HELPER: DRAWS TEXT & DOODLES ---
        const drawOverlaysToCanvas = (ctx, finalWidth, finalHeight, scaleFactor) => {
            const doodleCanvas = document.getElementById('hotpost-doodle-canvas');
            if (doodlePaths.length > 0) ctx.drawImage(doodleCanvas, 0, 0, finalWidth, finalHeight);

            textElements.forEach(tObj => {
                ctx.save(); 
                const baseFontSize = 24; 
                ctx.font = `800 ${baseFontSize}px ${tObj.font}`;
                ctx.textBaseline = "middle";
                
                const paragraphs = tObj.content.split('\n');
                let wrappedLines = [];
                const uiMaxWidth = screenW * 0.85;
                
                paragraphs.forEach(paragraph => {
                    if (!paragraph) { wrappedLines.push(''); return; }
                    const words = paragraph.split(' ');
                    let currentLine = '';
                    for (let i = 0; i < words.length; i++) {
                        const testLine = currentLine + words[i] + ' ';
                        const metrics = ctx.measureText(testLine);
                        if (metrics.width > uiMaxWidth && currentLine.length > 0) {
                            wrappedLines.push(currentLine.trimEnd());
                            currentLine = words[i] + ' ';
                        } else {
                            currentLine = testLine;
                        }
                    }
                    wrappedLines.push(currentLine.trimEnd());
                });

                let longestLineW = 0;
                wrappedLines.forEach(l => {
                    const w = ctx.measureText(l).width;
                    if (w > longestLineW) longestLineW = w;
                });

                const finalX = finalWidth * tObj.x;
                const finalY = finalHeight * tObj.y;

                ctx.translate(finalX, finalY);
                ctx.scale(scaleFactor * tObj.scale, scaleFactor * tObj.scale);

                const isNeon = tObj.font === TEXT_FONTS[2].value;
                const lineHeight = baseFontSize * 1.3; 
                const totalHeight = wrappedLines.length * lineHeight;
                const startY = -(totalHeight / 2) + (lineHeight / 2);

                ctx.textAlign = tObj.align || 'center';
                let textDrawX = 0;
                if (tObj.align === 'left') textDrawX = -(longestLineW / 2);
                if (tObj.align === 'right') textDrawX = (longestLineW / 2);

                if (tObj.hasBg) {
                    ctx.fillStyle = tObj.color;
                    ctx.shadowColor = "transparent";
                    ctx.shadowBlur = 0;
                    wrappedLines.forEach((line, index) => {
                        if(!line) return; 
                        const lineW = ctx.measureText(line).width;
                        const lineY = startY + (index * lineHeight);
                        const px = 12; 
                        const py = 6;  
                        let bgStartX = 0;
                        if (tObj.align === 'center') bgStartX = -lineW/2 - px;
                        if (tObj.align === 'left') bgStartX = textDrawX - px;
                        if (tObj.align === 'right') bgStartX = textDrawX - lineW - px;
                        ctx.beginPath();
                        ctx.roundRect(bgStartX, lineY - (lineHeight/2) - py, lineW + (px*2), lineHeight + (py*2), 8);
                        ctx.fill();
                    });
                    ctx.fillStyle = getContrastYIQ(tObj.color);
                } else {
                    ctx.fillStyle = tObj.color;
                    if (isNeon) {
                        ctx.shadowColor = tObj.color;
                        ctx.shadowBlur = 10;
                    } else {
                        ctx.shadowColor = "rgba(0,0,0,0.9)";
                        ctx.shadowBlur = 10; 
                    }
                }

                wrappedLines.forEach((line, index) => {
                    const lineY = startY + (index * lineHeight);
                    if (!tObj.hasBg && isNeon) ctx.fillText(line, textDrawX, lineY); 
                    ctx.fillText(line, textDrawX, lineY); 
                });

                ctx.restore(); 
            });
        };

        // --- MEDIA PROCESSING PIPELINE ---
        if (currentMediaType === 'video') {
            
            const hasOverlays = textElements.length > 0 || doodlePaths.length > 0;

            if (hasOverlays) {
                const overlayBlob = await new Promise((resolve) => {
                    const canvas = document.createElement('canvas');
                    const MAX_HEIGHT = 1280;
                    const scaleFactor = MAX_HEIGHT / screenH;
                    canvas.width = screenW * scaleFactor;
                    canvas.height = MAX_HEIGHT;
                    const ctx = canvas.getContext('2d');
                    
                    drawOverlaysToCanvas(ctx, canvas.width, canvas.height, scaleFactor);
                    canvas.toBlob(resolve, 'image/png'); 
                });

                const overlayForm = new FormData();
                overlayForm.append('file', overlayBlob, 'overlay.png');
                overlayForm.append('upload_preset', CLOUDINARY_HOTPOSTS_PRESET);

                const overData = await uploadToCloudinary(CLOUDINARY_URL, overlayForm);
                
                // 🚀 NEW: Save raw URL directly instead of passing to Cloudinary
                finalOverlayUrl = overData.secure_url; 
            }

            // 🚀 PAUSED: re-encoding via canvas.captureStream() + MediaRecorder uses the same
            // technique that just caused real audio/video lag and failed posts in the live
            // recorder above — disabling here too rather than assume it's safe in this call
            // site until it's verified separately. Video filter/zoom stay preview-only for now
            // (the preview itself is now accurate — see the filter-swipe fix — it just doesn't
            // get baked into the published file). The follow-up plan is to bake these in via
            // Cloudinary's own server-side video transformations instead of any client re-encode.
            const needsReencode = false;
            let videoBlobToUpload = capturedBlob;
            if (needsReencode) {
                setUploadStatusLabel('Processing…');
                try {
                    videoBlobToUpload = await reencodeVideoWithEffects(capturedBlob, screenW, screenH, (pct) => {
                        setUploadStatusLabel(`Processing… ${pct}%`);
                    });
                } catch (e) {
                    console.error('Video re-encode failed, publishing the original clip instead:', e);
                    videoBlobToUpload = capturedBlob; // Don't block publishing over a cosmetic step.
                }
            }

            // 🚀 FIX: filename/extension now matches the blob's real format (recorded webm vs.
            // a gallery-picked mp4/mov) instead of always hardcoding ".mp4" regardless of content.
            const actualMime = videoBlobToUpload.type || recordedMimeType || '';
            const ext = actualMime.includes('webm') ? 'webm' : actualMime.includes('quicktime') ? 'mov' : 'mp4';

            const vidForm = new FormData();
            vidForm.append('file', videoBlobToUpload, `hotpost.${ext}`);
            vidForm.append('upload_preset', CLOUDINARY_VIDEO_PRESET);
            
            setUploadStatusLabel('Uploading…');
            const vidData = await uploadToCloudinary(CLOUDINARY_VIDEO_URL, vidForm, (pct) => {
                setUploadStatusLabel(`Uploading… ${pct}%`);
            });

          // 🚀 FIX: Added f_auto (was missing here, though the image path already had it) so
          // Cloudinary serves each viewer's browser its own best-supported container/codec
          // instead of always delivering whatever container we happened to record in.
          // 🚀 NEW: bake the chosen filter in server-side (see FILTER_LIST.cloudinaryEffect) —
          // no client re-encode, so none of the video-lag instability applies here.
          // Content effects are chained first, quality/format delivery flags last (closest to
          // the file) — Cloudinary's typical convention for chained transformations.
            const filterEffect = FILTER_LIST[capturedFilterIndex].cloudinaryEffect;
            const videoTransform = filterEffect ? `${filterEffect}/q_auto,vc_auto,f_auto` : `q_auto,vc_auto,f_auto`;
            finalMediaUrl = vidData.secure_url.replace('/upload/', `/upload/${videoTransform}/`);
            console.log('[Hotpost] Video delivery URL:', finalMediaUrl);
        } else {
            // ORIGINAL IMAGE BAKE LOGIC
            const finalBlob = await new Promise((resolve, reject) => {
                try {
                    const bakeCanvas = document.createElement('canvas');
                    const MAX_HEIGHT = 1280;
                    const scaleFactor = MAX_HEIGHT / screenH;
                    const finalWidth = screenW * scaleFactor;
                    const finalHeight = MAX_HEIGHT;

                    bakeCanvas.width = finalWidth;
                    bakeCanvas.height = finalHeight;
                    const ctx = bakeCanvas.getContext('2d');

                    ctx.save();
                    ctx.translate(finalWidth / 2, finalHeight / 2);
                    ctx.scale(imgTransform.scale, imgTransform.scale);
                    ctx.translate(imgTransform.x * scaleFactor, imgTransform.y * scaleFactor);
                    
                    if (FILTER_LIST[capturedFilterIndex].css !== 'none') {
                        ctx.filter = FILTER_LIST[capturedFilterIndex].css;
                    }
                    
                    const imgAspect = baseImageObj.width / baseImageObj.height;
                    const screenAspect = finalWidth / finalHeight;
                    let drawW, drawH;
                    
                    if (imgAspect > screenAspect) {
                        drawH = finalHeight;
                        drawW = finalHeight * imgAspect;
                    } else {
                        drawW = finalWidth;
                        drawH = finalWidth / imgAspect;
                    }
                    
                    ctx.drawImage(baseImageObj, -drawW / 2, -drawH / 2, drawW, drawH);
                    ctx.restore();

                    drawOverlaysToCanvas(ctx, finalWidth, finalHeight, scaleFactor);
                    
                    bakeCanvas.toBlob(resolve, 'image/webp', 0.65); 
                } catch (err) {
                    reject(err);
                }
            });

            const formData = new FormData();
            formData.append('file', finalBlob, 'hotpost.webp');
            formData.append('upload_preset', CLOUDINARY_HOTPOSTS_PRESET);

            setUploadStatusLabel('Uploading…');
            const data = await uploadToCloudinary(CLOUDINARY_URL, formData, (pct) => {
                setUploadStatusLabel(`Uploading… ${pct}%`);
            });
            
            finalMediaUrl = data.secure_url.replace('/upload/', '/upload/q_auto:eco,f_auto/');
        }

        // --- SAVE TO SUPABASE ---
        const { data: newHotpost, error } = await supabase.from('hotposts').insert({
            user_id: currentUser.id,
            media_url: finalMediaUrl,
            caption: finalOverlayUrl, // 🚀 NEW: Save overlay in caption column
            media_type: currentMediaType, 
            visibility: visibility,
            allow_rewatch: allowRewatch
        }).select('id').single();

        if (error) throw error;

        if (currentUser.role === 'page' && newHotpost) {
            await supabase.rpc('notify_page_followers', {
                p_page_id: currentUser.id, p_type: 'page_new_hotpost',
                p_message: 'added a new hotpost.', p_target_id: newHotpost.id
            });
        }

        showToast('Hotpost published!', 'success');

        // 🚀 FIX: Invalidate cached hotposts so the new post shows up immediately
        invalidateHotpostsCache(currentUser.id);

    } catch (error) {
        console.error("Hotpost Compile Error:", error);
        // 🚀 FIX: show what actually failed instead of guessing a category — needed to
        // actually pin down the remaining post failures instead of another blind guess.
        const msg = (error && error.message) || String(error) || 'Unknown error';
        showToast(`Post failed: ${msg}`, 'error');
    } finally {
        isUploadingBackground = false;
        resetCameraUI(); 
        fetchHotposts(); 
    }
}

window.toggleRewatchSetting = function() {
    const btn = document.getElementById('hotpost-rewatch-toggle');
    const icon = document.getElementById('rewatch-icon');
    
    if(btn.dataset.val === 'false') {
        btn.dataset.val = 'true';
        icon.textContent = 'all_inclusive';
        showToast('Rewatch Allowed (Post will stay for 24hrs)', 'info');
    } else {
        btn.dataset.val = 'false';
        icon.textContent = 'looks_one';
        showToast('Play Once (Post disappears after viewing)', 'info');
    }
};

window.toggleVisibilitySetting = function() {
    const btn = document.getElementById('hotpost-send-visibility');
    const icon = document.getElementById('visibility-icon');
    if(btn.dataset.val === 'everyone') {
        btn.dataset.val = 'connections';
        icon.textContent = 'stars';
        btn.classList.replace('bg-black/50', 'bg-green-500/80');
    } else {
        btn.dataset.val = 'everyone';
        icon.textContent = 'public';
        btn.classList.replace('bg-green-500/80', 'bg-black/50');
    }
};

// ==========================================
// DASHBOARD VIEW & CIRCLES
// ==========================================
async function fetchHotposts() {
    const container = document.querySelector('#hotposts-container');
    if (!container) return;

    if (!isUploadingBackground) {
        container.innerHTML = HOTPOST_SKELETON;
    }

    // OFFLINE MODE
    if (!navigator.onLine) {
        try {
            const cachedHotposts = await getHotpostsFromCache();

            if (cachedHotposts.length > 0) {
                hotpostsByUser = new Map(
                    cachedHotposts.map(item => [item.user_id, item.data])
                );
                renderHotpostCircles();
            } else {
                container.innerHTML =
                    `<div class="py-4 text-center text-xs text-on-surface-variant">
                        No saved hotposts
                    </div>`;
            }
        } catch (e) {
            console.error("Offline hotposts error:", e);
            container.innerHTML =
                `<div class="py-4 text-center text-xs text-error">
                    Failed to load cached hotposts
                </div>`;
        }
        return;
    }

    try {
        // Load hotposts through the data layer
        const data = await getHotposts(currentUser.id);

        const unviewedData = data.filter(post => {
            if (post.user_id === currentUser.id) return true;

            const hasViewed = post.hotpost_views.some(
                v => v.viewer_id === currentUser.id
            );

            if (!hasViewed) return true;
            if (hasViewed && post.allow_rewatch) return true;

            return false;
        });

        hotpostsByUser.clear();

        for (const post of unviewedData) {
            const userId = post.users.id;

            if (!hotpostsByUser.has(userId)) {
                hotpostsByUser.set(userId, {
                    user: post.users,
                    posts: [],
                    viewed: true
                });
            }

            const hasViewed = post.hotpost_views.some(
                v => v.viewer_id === currentUser.id
            );

            if (!hasViewed && post.user_id !== currentUser.id) {
                hotpostsByUser.get(userId).viewed = false;
            }

            hotpostsByUser.get(userId).posts.unshift({
                ...post,
                users: undefined
            });
        }

        renderHotpostCircles();

        // Save to offline cache
        const cacheArray = Array.from(hotpostsByUser.entries()).map(
            ([userId, data]) => ({
                user_id: userId,
                data: data
            })
        );

        await saveHotpostsToCache(cacheArray);

    } catch (e) {
        console.error("Hotposts fetch error:", e);

        container.innerHTML =
            `<div class="py-4 text-center text-xs text-error">
                Failed to load hotposts: ${e.message}
            </div>`;
    }
}

function renderHotpostCircles() {
    const container = document.querySelector('#view-dashboard .flex.gap-4.overflow-x-auto');
    if (!container) return;
    container.innerHTML = ''; 

    const addCircle = document.createElement('div');
    const myData = hotpostsByUser.get(currentUser.id);
    const hasMyPosts = myData && myData.posts.length > 0;

    // 🚀 FIX: This used to always render a plain "Create" circle AND, separately, a
    // "My Hotposts" circle whenever you already had an active story — two side-by-side
    // avatars of yourself, which just isn't how Instagram (or anyone) does this and ate
    // extra tray space for no reason. Now there's a single self-slot: it shows your story
    // ring once you have posts (tap it to view them), with a small "+" badge always
    // overlaid so adding another is still one tap away — same as the real thing.
    addCircle.className = `hotpost-circle flex flex-col items-center gap-1.5 shrink-0 transition-transform relative z-20 ${isUploadingBackground ? 'pointer-events-none opacity-80' : 'cursor-pointer active:scale-95'}`;

    if (isUploadingBackground) {
        addCircle.innerHTML = `
            <div class="w-[80px] h-[80px] relative flex items-center justify-center pointer-events-none shadow-sm">
                <div class="absolute inset-0 rounded-full hotpost-uploading-ring"></div>
                <div class="w-[74px] h-[74px] rounded-full border-2 border-white dark:border-[#121212] overflow-hidden bg-gray-100 dark:bg-neutral-800 z-10">
                    <img src="${currentUser.profile_img_url}" class="w-full h-full object-cover opacity-60">
                </div>
            </div>
            <span id="hotpost-upload-status-label" class="text-[11px] font-bold text-on-surface-variant dark:text-gray-400">Uploading...</span>
        `;
    } else if (hasMyPosts) {
        const ringClass = myData.viewed ? 'from-gray-300 to-gray-400' : 'from-gray-400 to-gray-600';
        addCircle.innerHTML = `
            <div class="w-[80px] h-[80px] rounded-full p-[2.5px] bg-gradient-to-tr ${ringClass} shadow-sm relative">
                <div class="w-full h-full rounded-full border-2 border-white dark:border-neutral-900 overflow-hidden bg-gray-100 dark:bg-neutral-800">
                    <img src="${currentUser.profile_img_url}" class="w-full h-full object-cover">
                </div>
                <button id="hotpost-add-more-btn" class="absolute bottom-0 right-0 w-7 h-7 bg-primary text-white rounded-full border-[2.5px] border-white dark:border-[#121212] flex items-center justify-center z-30 shadow-sm active:scale-90 transition-transform" aria-label="Add to your Hotposts">
                    <span class="material-symbols-outlined text-[16px] font-bold">add</span>
                </button>
            </div>
            <span class="text-[11px] font-bold text-gray-900 dark:text-gray-100">My Hotposts</span>
        `;
        addCircle.addEventListener('click', () => openHotpostViewer(currentUser.id));
        addCircle.querySelector('#hotpost-add-more-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openCameraModal();
        });
    } else {
        addCircle.innerHTML = `
            <div class="w-[80px] h-[80px] rounded-full p-[2.5px] bg-transparent shadow-sm relative">
                <div class="w-full h-full rounded-full border-2 border-surface-variant dark:border-neutral-700 overflow-hidden bg-gray-100 dark:bg-neutral-800">
                    <img src="${currentUser.profile_img_url}" class="w-full h-full object-cover opacity-60">
                </div>
                <div class="absolute bottom-0 right-0 w-7 h-7 bg-primary text-white rounded-full border-[2.5px] border-white dark:border-[#121212] flex items-center justify-center z-30 shadow-sm">
                    <span class="material-symbols-outlined text-[16px] font-bold">add</span>
                </div>
            </div>
            <span class="text-[11px] font-bold text-gray-900 dark:text-gray-100">Create</span>
        `;
        addCircle.addEventListener('click', openCameraModal);
    }
    container.appendChild(addCircle);

    // Keep the profile-page avatar's story ring in sync with the tray any time
    // the tray itself re-renders (new post, marked viewed, initial fetch, etc.)
    // — not just when you happen to switch to the Profile tab afterward.
    if (typeof window.updateMyProfileAvatarRing === 'function') window.updateMyProfileAvatarRing();

    const otherUserIds = Array.from(hotpostsByUser.keys()).filter(id => id !== currentUser.id);
    otherUserIds.sort((a, b) => (hotpostsByUser.get(a).viewed || false) - (hotpostsByUser.get(b).viewed || false));

    otherUserIds.forEach(userId => {
        const data = hotpostsByUser.get(userId);
        const user = data.user;
        const circle = document.createElement('div');
        circle.className = 'hotpost-circle flex flex-col items-center gap-1.5 shrink-0 cursor-pointer active:scale-95 transition-transform relative z-10';

        // 🚀 FIX: was a generic yellow-orange-red gradient — now matches Instagram's actual
        // signature gradient, consistent with the recording ring and upload ring elsewhere.
        const ringClass = data.viewed ? 'from-gray-300 to-gray-400' : 'from-[#833ab4] via-[#fd1d1d] to-[#fcb045]';

        circle.innerHTML = `
            <div class="w-[80px] h-[80px] rounded-full p-[2.5px] bg-gradient-to-tr ${ringClass} shadow-sm">
                <div class="w-full h-full rounded-full border-2 border-white dark:border-neutral-900 overflow-hidden bg-gray-100 dark:bg-neutral-800">
                    <img src="${user.profile_img_url}" class="w-full h-full object-cover">
                </div>
            </div>
            <span class="text-[11px] font-bold text-gray-900 dark:text-gray-100">${user.full_name.split(' ')[0]}</span>
        `;
        circle.addEventListener('click', () => openHotpostViewer(userId));
        container.appendChild(circle);
    });

    setTimeout(() => {
        if (window.requestIdleCallback) {
            window.requestIdleCallback(preloadHotpostImages);
        } else {
            preloadHotpostImages();
        }
    }, 1000); 
}

function preloadHotpostImages() {
    // 🚀 FIX: Only preload the first 3 users' stories to prevent network thread bottlenecking!
    let count = 0;
    
    for (const [userId, data] of hotpostsByUser.entries()) {
        if (count >= 3) break; // Stop after 3 users
        
        if (data.posts && data.posts.length > 0) {
            const firstPost = data.posts[0];
            
            // Skip preloading if it's a video to save bandwidth
            if (firstPost.media_type === 'video' || firstPost.media_url.includes('.mp4') || firstPost.media_url.includes('.webm')) {
                continue;
            }

            const optimizedUrl = typeof window.optimizeImageUrl === 'function' 
                ? window.optimizeImageUrl(firstPost.media_url, 'hotpost') 
                : firstPost.media_url;
            
            const img = new Image();
            img.src = optimizedUrl;
            count++;
        }
    }
}
// ==========================================
// VIEWER ENGINES & PHYSICS
// ==========================================
function setupViewerTouchPhysics() {
    const viewer = document.getElementById('modal-view-hotpost');
    const viewerContent = document.getElementById('hotpost-viewer-content');
    const activityModal = document.getElementById('modal-story-details');
    const activitySheet = document.getElementById('modal-story-details-sheet');
    
    let viewerStartY = 0;
    let isDraggingViewer = false;

    let panelStartY = 0;
    let isDraggingPanel = false;
    let isPanelScrollable = false;

    viewer?.addEventListener('touchstart', (e) => {
        if (!activityModal.classList.contains('hidden')) return;
        
        // 🚀 CRITICAL FIX: Tell the drag engine to ignore touches on the Avatar & Name!
        const isIgnoredTarget = 
            e.target.closest('button:not(#hotpost-activity-btn)') || 
            e.target.closest('input') || 
            e.target.closest('#hotpost-viewer-avatar') || 
            e.target.closest('#hotpost-viewer-name');
            
        if (isIgnoredTarget) return;
        
        viewerStartY = e.touches[0].clientY;
        isDraggingViewer = true;
        if (viewerContent) viewerContent.style.transition = 'none'; 
    }, { passive: true });
    
    viewer?.addEventListener('touchmove', (e) => {
        if (!isDraggingViewer) return;
        const deltaY = e.touches[0].clientY - viewerStartY;

        if (deltaY > 0) {
            const progress = Math.min(deltaY / window.innerHeight, 1);
            if (viewerContent) {
                viewerContent.style.transform = `translateY(${deltaY * 0.8}px) scale(${1 - (progress * 0.15)})`;
            }
            if (e.cancelable) e.preventDefault(); 
        } 
    }, { passive: false });

    viewer?.addEventListener('touchend', (e) => {
        if (!isDraggingViewer) return;
        isDraggingViewer = false;
        
        const deltaY = e.changedTouches[0].clientY - viewerStartY;
        const isActivityBtn = e.target.closest('#hotpost-activity-btn');
        
        const screenHeight = window.innerHeight;
        const startedAtBottom = viewerStartY > (screenHeight * 0.7);

        if (viewerContent) viewerContent.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)';

        if (deltaY < -40 && currentViewerState.userId === currentUser.id && (startedAtBottom || isActivityBtn)) {
            if (viewerContent) viewerContent.style.transform = ''; 
            openActivityPanel();
        } 
        else if (deltaY > 100) {
            closeHotpostViewer();
        } 
        else {
            if (viewerContent) viewerContent.style.transform = '';
        }
    }, { passive: true });

    activitySheet?.addEventListener('touchstart', (e) => {
        const scrollArea = e.target.closest('.overflow-y-auto');
        if (scrollArea && scrollArea.scrollTop > 0) {
            isPanelScrollable = true;
            isDraggingPanel = false;
        } else {
            isPanelScrollable = false;
            panelStartY = e.touches[0].clientY;
            isDraggingPanel = true;
            activitySheet.style.transition = 'none'; 
            if (viewerContent) viewerContent.style.transition = 'none';
        }
    }, { passive: true });

    activitySheet?.addEventListener('touchmove', (e) => {
        if (isPanelScrollable || !isDraggingPanel) return;
        const deltaY = e.touches[0].clientY - panelStartY;
        
        if (deltaY > 0) {
            activitySheet.style.transform = `translateY(${deltaY}px)`;
            const progress = deltaY / window.innerHeight;
            if(viewerContent) {
                viewerContent.style.transform = `scale(${0.92 + (0.08 * progress)}) translateY(${2 - (2 * progress)}vh)`;
                viewerContent.style.opacity = 0.4 + (0.6 * progress);
            }
            if (e.cancelable) e.preventDefault(); 
        }
    }, { passive: false });

    activitySheet?.addEventListener('touchend', (e) => {
        if (isPanelScrollable || !isDraggingPanel) return;
        isDraggingPanel = false;
        
        const deltaY = e.changedTouches[0].clientY - panelStartY;
        
        activitySheet.style.transition = 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)'; 
        if(viewerContent) {
            viewerContent.style.transition = 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s ease, border-radius 0.4s ease';
        }
        
        if (deltaY > 120) {
            closeActivityPanel();
        } 
        else {
            activitySheet.style.transform = `translateY(0px)`;
            if (viewerContent) {
                viewerContent.style.transform = '';
                viewerContent.style.opacity = '';
                viewerContent.classList.add('viewer-pushed-back');
            }
        }
    }, { passive: true });
}

async function openHotpostViewer(userId, targetPostId = null) {
    const userData = hotpostsByUser.get(userId);
    if (!userData || userData.posts.length === 0) {
        if (targetPostId) showToast('This Hotpost is no longer available.', 'error');
        return;
    }
    if (targetPostId && !userData.posts.some(p => p.id === targetPostId)) {
        showToast('This Hotpost is no longer available.', 'error');
        return;
    }

    // Refresh who I'm connected to — gates the reply box (connections-only,
    // same rule as DMs). Cache-backed in data-layer.js, so this is cheap
    // on repeat opens.
    try {
        const connections = await getAcceptedConnections(currentUser.id);
        myConnectionIds = new Set(connections.map(c => c.id));
    } catch (e) {
        console.error('Error loading connections for story replies:', e);
    }

    const allUserIds = Array.from(hotpostsByUser.keys())
        .filter(id => id !== currentUser.id)
        .sort((a, b) => (hotpostsByUser.get(a).viewed || false) - (hotpostsByUser.get(b).viewed || false));

    if (userId === currentUser.id) allUserIds.unshift(currentUser.id);

    const clickedUserIndex = allUserIds.indexOf(userId);
    currentViewerState.userOrder = [
        ...allUserIds.slice(clickedUserIndex),
        ...allUserIds.slice(0, clickedUserIndex)
    ];

    // 🚀 SMART INDEXING: jump to a specific post if requested (e.g. tapping
    // a story-reply preview in a chat), else start at the first unviewed
    let startPostIndex = 0;
    if (targetPostId) {
        const idx = userData.posts.findIndex(p => p.id === targetPostId);
        if (idx !== -1) startPostIndex = idx;
    } else if (userId !== currentUser.id) {
        const firstUnviewedIndex = userData.posts.findIndex(p => {
            const hasViewed = p.hotpost_views?.some(v => v.viewer_id === currentUser.id) || sessionViewedPostIds.has(p.id);
            return !hasViewed; // Return true if NOT viewed
        });
        if (firstUnviewedIndex !== -1) startPostIndex = firstUnviewedIndex;
    }

    document.getElementById('modal-view-hotpost').classList.replace('hidden', 'flex');
    toggleCameraStatusBar(true); 
    playUserStories(0, startPostIndex); 
}

function closeHotpostViewer() {
    document.getElementById('modal-view-hotpost').classList.replace('flex', 'hidden');
    clearTimeout(currentViewerState.storyTimer);

    // 🚀 FIX: Force pause video, wipe source, and unload to kill background audio
    const vidEl = document.getElementById('hotpost-viewer-video');
    if (vidEl) {
        vidEl.pause();
        vidEl.removeAttribute('src'); 
        vidEl.load(); 
    }

    document.getElementById('hotpost-viewer-mute-btn')?.classList.add('hidden');
    document.getElementById('hotpost-tap-for-sound')?.classList.add('hidden');

    const activeBar = document.querySelector('#hotpost-progress-bars .progress-bar-inner.active');
    if (activeBar) activeBar.style.animation = 'none';
    
    const viewerContent = document.getElementById('hotpost-viewer-content');
    if (viewerContent) {
        viewerContent.style.transform = '';
        viewerContent.style.opacity = '';
        viewerContent.style.transition = '';
        viewerContent.classList.remove('viewer-pushed-back');
    }
    
    processStoryDisappear();
    toggleCameraStatusBar(false);
}

function processStoryDisappear() {
    const lastViewedUser = currentViewerState.userId;
    if (lastViewedUser && lastViewedUser !== currentUser.id) {
        const userData = hotpostsByUser.get(lastViewedUser);
        if (userData) {
            userData.posts = userData.posts.filter(p => {
                const viewed = p.hotpost_views?.some(v => v.viewer_id === currentUser.id) || sessionViewedPostIds.has(p.id);
                return !viewed || p.allow_rewatch;
            });
            
            if (userData.posts.length === 0) {
                hotpostsByUser.delete(lastViewedUser);
            } else {
                userData.viewed = true; 
            }
            renderHotpostCircles();
        }
    }
}

function playUserStories(userIndex, postIndex = 0) {
    if (userIndex >= currentViewerState.userOrder.length) {
        closeHotpostViewer();
        return;
    }

    currentViewerState.userIndex = userIndex;
    currentViewerState.postIndex = postIndex;
    currentViewerState.userId = currentViewerState.userOrder[userIndex];

    const userData = hotpostsByUser.get(currentViewerState.userId);
    const post = userData.posts[currentViewerState.postIndex];

    const progressContainer = document.getElementById('hotpost-progress-bars');
    
    progressContainer.innerHTML = userData.posts.map((p, index) => `
        <div class="flex-1 bg-white/30 rounded-full overflow-hidden">
            <div class="progress-bar-inner h-full bg-white rounded-full ${index < postIndex ? 'w-full' : 'w-0'}" data-index="${index}"></div>
        </div>
    `).join('');

    const isMyStory = currentViewerState.userId === currentUser.id;
    const canReply = !isMyStory && myConnectionIds.has(currentViewerState.userId);

    document.getElementById('hotpost-reply-container').style.display = isMyStory ? 'none' : 'flex';
    document.getElementById('hotpost-reply-input').style.display = canReply ? 'block' : 'none';
    document.getElementById('hotpost-reply-btn').style.display = canReply ? 'flex' : 'none';
    document.getElementById('hotpost-activity-btn').style.display = isMyStory ? 'flex' : 'none';
    // 🚀 NEW: Instagram shows the actual view count directly on your own story (e.g. "24
    // views") rather than a generic "ACTIVITY" label you have to tap to find out.
    if (isMyStory) {
        const label = document.getElementById('hotpost-activity-btn-label');
        label.textContent = 'Activity';
        supabase.from('hotpost_views').select('id', { count: 'exact', head: true })
            .eq('hotpost_id', post.id).eq('is_deleted', false)
            .then(({ count }) => { label.textContent = `${count || 0} view${count === 1 ? '' : 's'}`; });
    }
    
    const visIcon = document.getElementById('hotpost-viewer-visibility');
    if (post.visibility === 'connections') {
        visIcon.textContent = 'stars';
        visIcon.classList.add('text-green-400');
        visIcon.classList.remove('text-white/80');
    } else {
        visIcon.textContent = 'public';
        visIcon.classList.remove('text-green-400');
        visIcon.classList.add('text-white/80');
    }

    // 🚀 FIX: this always reset to the unliked (outline) icon regardless of whether the
    // current user had actually already liked this specific post — reopening or navigating
    // back to a liked story always looked unliked. Now it reflects the real state.
    const likeBtnIcon = document.querySelector('#hotpost-like-btn span');
    if(likeBtnIcon) {
        const alreadyLiked = (post.hotpost_likes || []).some(l => l.user_id === currentUser.id);
        likeBtnIcon.style.fontVariationSettings = alreadyLiked ? "'FILL' 1" : "'FILL' 0";
        likeBtnIcon.classList.toggle('text-red-500', alreadyLiked);
    }

    const getTickHtmlLocal = (tickType) => window.getTickHtml ? window.getTickHtml(tickType) : '';

    const avatarEl = document.getElementById('hotpost-viewer-avatar');
    const nameEl = document.getElementById('hotpost-viewer-name');
    
    const openProfileHandler = (e) => {
        e.preventDefault();  
        e.stopPropagation(); 
        closeHotpostViewer(); 
        setTimeout(() => {
            if (typeof window.viewUserProfile === 'function') {
                window.viewUserProfile(userData.user.id);
            }
        }, 150); 
    };

    if (avatarEl) {
        avatarEl.src = userData.user.profile_img_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(userData.user.full_name)}&background=e1e3e4`;
        avatarEl.onclick = openProfileHandler;
        avatarEl.classList.add('cursor-pointer', 'active:scale-90', 'transition-transform', 'relative', 'z-[100]', 'pointer-events-auto');
    }
    
    if (nameEl) {
        if (isMyStory) {
            nameEl.innerHTML = `Your Hotpost`;
        } else {
            nameEl.innerHTML = `${userData.user.full_name} ${getTickHtmlLocal(userData.user.tick_type)}`;
        }
        nameEl.onclick = openProfileHandler;
        nameEl.classList.add('cursor-pointer', 'active:scale-95', 'transition-opacity', 'relative', 'z-[100]', 'pointer-events-auto');
    }
    
    document.getElementById('hotpost-viewer-time').textContent = timeAgo(post.created_at);

    clearTimeout(currentViewerState.storyTimer);
    const activeBar = progressContainer.querySelector(`.progress-bar-inner[data-index="${postIndex}"]`);
    if (activeBar) {
        activeBar.style.animation = 'none';
        activeBar.style.width = '0%';
    }

    const imgEl = document.getElementById('hotpost-viewer-image');
    const vidEl = document.getElementById('hotpost-viewer-video');
    const overlayEl = document.getElementById('hotpost-viewer-overlay'); // 🚀 NEW
    
    imgEl.style.opacity = '0';
    imgEl.style.transition = 'opacity 0.2s ease';
    vidEl.style.opacity = '0';
    vidEl.style.transition = 'opacity 0.2s ease';
    overlayEl.style.opacity = '0'; // 🚀 NEW
    
    imgEl.classList.add('hidden');
    vidEl.classList.add('hidden');
    overlayEl.classList.add('hidden'); // 🚀 NEW
    overlayEl.src = '';
    
    vidEl.pause();
    vidEl.onloadeddata = null;
    vidEl.ontimeupdate = null;
    vidEl.onended = null;
    
    if (post.media_type === 'video' || post.media_url.includes('.mp4') || post.media_url.includes('.webm')) {
        vidEl.classList.remove('hidden');
        vidEl.src = post.media_url; 
        
        // 🚀 NEW: Stack the overlay if it exists
        if (post.caption) {
            overlayEl.src = post.caption;
            overlayEl.classList.remove('hidden');
        }
        
        vidEl.onloadeddata = () => {
            vidEl.style.opacity = '1';
            if (post.caption) overlayEl.style.opacity = '1'; // Show overlay
            recordView(post.id);

            // 🚀 FIX: default to unmuted (Instagram-style) and remember the choice for the
            // rest of the session. If the browser actually blocks unmuted autoplay, fall back
            // to muted and show a "tap for sound" hint instead of silently failing to play.
            const muteBtn = document.getElementById('hotpost-viewer-mute-btn');
            const tapHint = document.getElementById('hotpost-tap-for-sound');
            muteBtn.classList.remove('hidden');
            tapHint.classList.add('hidden');

            vidEl.muted = viewerMuted;
            const setIcon = () => { muteBtn.querySelector('span').textContent = vidEl.muted ? 'volume_off' : 'volume_up'; };
            setIcon();

            const playPromise = vidEl.play();
            if (playPromise && typeof playPromise.catch === 'function') {
                playPromise.catch(() => {
                    vidEl.muted = true;
                    viewerMuted = true;
                    setIcon();
                    tapHint.classList.remove('hidden');
                    vidEl.play().catch(e => console.error('Story playback blocked even muted:', e));
                });
            }

            if (activeBar) activeBar.classList.add('active');
        };

        vidEl.ontimeupdate = () => {
            if (activeBar && vidEl.duration) {
                const percentage = (vidEl.currentTime / vidEl.duration) * 100;
                activeBar.style.width = `${percentage}%`;
            }
        };

        vidEl.onended = () => {
            if (activeBar) activeBar.style.width = '100%';
            nextStory();
        };

    } else {
        imgEl.classList.remove('hidden');
        document.getElementById('hotpost-viewer-mute-btn')?.classList.add('hidden');
        document.getElementById('hotpost-tap-for-sound')?.classList.add('hidden');
        const optimizedUrl = typeof window.optimizeImageUrl === 'function' ? window.optimizeImageUrl(post.media_url, 'hotpost') : post.media_url;
        
        imgEl.onload = () => {
            imgEl.style.opacity = '1';
            recordView(post.id);
            
            currentViewerState.storyDuration = 5000; 
            currentViewerState.remainingDuration = currentViewerState.storyDuration;
            
            if (activeBar) {
                activeBar.style.animation = `fill-progress ${currentViewerState.storyDuration}ms linear forwards`;
                activeBar.classList.add('active');
            }
            
            currentViewerState.animationStartTime = performance.now();
            currentViewerState.storyTimer = setTimeout(nextStory, currentViewerState.storyDuration);
        };
        imgEl.src = optimizedUrl;
    }
}

function nextStory() {
    const currentUserData = hotpostsByUser.get(currentViewerState.userId);
    
    // If current user has more stories, play next
    if (currentViewerState.postIndex < currentUserData.posts.length - 1) {
        playUserStories(currentViewerState.userIndex, currentViewerState.postIndex + 1);
    } 
    // Move to the next user in the queue
    else {
        processStoryDisappear();
        const nextUserIndex = currentViewerState.userIndex + 1;
        
        if (nextUserIndex < currentViewerState.userOrder.length) {
            const nextUserId = currentViewerState.userOrder[nextUserIndex];
            const nextUserData = hotpostsByUser.get(nextUserId);

            // 🚀 FIX: Instagram Logic - Find the first unviewed post for the next user
            let startPostIndex = 0;
            if (nextUserId !== currentUser.id) {
                const firstUnviewedIndex = nextUserData.posts.findIndex(p => {
                    return !p.hotpost_views?.some(v => v.viewer_id === currentUser.id) && !sessionViewedPostIds.has(p.id);
                });
                
                // If they have unviewed posts, start there.
                if (firstUnviewedIndex !== -1) {
                    playUserStories(nextUserIndex, firstUnviewedIndex);
                } else {
                    // If all are viewed, completely skip this user and check the next one
                    currentViewerState.userIndex = nextUserIndex; 
                    nextStory(); 
                }
            } else {
                playUserStories(nextUserIndex, 0); // Always play own stories from beginning
            }
        } else {
            closeHotpostViewer();
        }
    }
}

function prevStory() {
    if (currentViewerState.postIndex > 0) {
        playUserStories(currentViewerState.userIndex, currentViewerState.postIndex - 1);
    } else if (currentViewerState.userIndex > 0) {
        const prevUserIndex = currentViewerState.userIndex - 1;
        const prevUserData = hotpostsByUser.get(currentViewerState.userOrder[prevUserIndex]);
        playUserStories(prevUserIndex, prevUserData.posts.length - 1);
    }
}

function pauseStory() {
    clearTimeout(currentViewerState.storyTimer);
    const vidEl = document.getElementById('hotpost-viewer-video');
    
    // Pause video playback (which stops the JS progress bar automatically)
    if (!vidEl.classList.contains('hidden')) {
        vidEl.pause();
    }
    
    const activeBar = document.querySelector('#hotpost-progress-bars .progress-bar-inner.active');
    if (activeBar) {
        // Pause CSS animation ONLY if it's an image
        if (activeBar.style.animationName && activeBar.style.animationName !== 'none') {
            const elapsedTime = performance.now() - currentViewerState.animationStartTime;
            currentViewerState.remainingDuration -= elapsedTime;
            activeBar.style.animationPlayState = 'paused';
        }
    }
}

function resumeStory() {
    if (document.getElementById('modal-view-hotpost').classList.contains('hidden')) return;
    if (!document.getElementById('modal-story-details').classList.contains('hidden')) return; 

    const vidEl = document.getElementById('hotpost-viewer-video');
    
    // Resume video playback
    if (!vidEl.classList.contains('hidden')) {
        vidEl.play();
    } else {
        // Resume image CSS animation
        const activeBar = document.querySelector('#hotpost-progress-bars .progress-bar-inner.active');
        if (activeBar && activeBar.style.animationName && activeBar.style.animationName !== 'none') {
            activeBar.style.animationPlayState = 'running';
        }
        
        currentViewerState.animationStartTime = performance.now(); 
        clearTimeout(currentViewerState.storyTimer);
        currentViewerState.storyTimer = setTimeout(nextStory, currentViewerState.remainingDuration);
    }
}
    
// ==========================================
// ENGAGEMENT & ACTIVITY
// ==========================================
async function recordView(hotpostId) {
    if (currentViewerState.userId === currentUser.id) return;
    if (sessionViewedPostIds.has(hotpostId)) return;
    // 🚀 FIX: a plain insert 409-conflicts every time a post that was already viewed in an
    // earlier session gets viewed again (your live DB has a unique constraint on
    // hotpost_id+viewer_id not reflected in schema.sql). Upsert with ignoreDuplicates treats
    // "already viewed" as a harmless no-op instead of erroring.
    const { error } = await supabase.from('hotpost_views')
        .upsert({ hotpost_id: hotpostId, viewer_id: currentUser.id }, { onConflict: 'hotpost_id,viewer_id', ignoreDuplicates: true });
    if (!error) sessionViewedPostIds.add(hotpostId); 
}

// 🚀 FIX: this used to unconditionally INSERT a new row on every single call — no check for
// existing state and no unlike. Your live DB actually has a unique constraint on
// hotpost_id+user_id (confirmed by the 409 conflicts you hit), so the "like" path now uses a
// single upsert instead of select-then-insert/update — that avoids the conflict outright
// instead of racing against it.
async function handleLikeHotpost(event) {
    event.stopPropagation(); 
    if (!window.checkVerification('like stories')) return; // 🚀 Soft Restrict Check
    
    const icon = event.currentTarget.querySelector('span');
    const post = hotpostsByUser.get(currentViewerState.userId).posts[currentViewerState.postIndex];
    const wasLiked = icon.classList.contains('text-red-500');

    // Optimistic UI update
    icon.style.fontVariationSettings = wasLiked ? "'FILL' 0" : "'FILL' 1";
    icon.classList.toggle('text-red-500', !wasLiked);

    try {
        if (wasLiked) {
            // 🚀 FIX: this call's result was never checked — a failed unlike (RLS, network,
            // anything) silently left the UI showing "unliked" while the DB row was untouched,
            // which is exactly why it reverted on refresh.
            const { error } = await supabase.from('hotpost_likes').update({ is_deleted: true })
                .eq('hotpost_id', post.id).eq('user_id', currentUser.id).eq('is_deleted', false);
            if (error) throw error;
        } else {
            const { error } = await supabase.from('hotpost_likes')
                .upsert({ hotpost_id: post.id, user_id: currentUser.id, is_deleted: false }, { onConflict: 'hotpost_id,user_id' });
            if (error) throw error;
            // hotpost_like notification: handled by the DB trigger on_hotpost_like /
            // trg_hotpost_like — fixed (see migration_fix_hotpost_like_trigger_v12.sql)
            // to also fire on the re-like-after-unlike case, which is an UPDATE via
            // this upsert, not a fresh INSERT.
        }
        invalidateHotpostsCache(currentUser.id); // so reopening reflects the real state
    } catch (e) {
        console.error('Like toggle failed:', e);
        // Revert the optimistic update on failure
        icon.style.fontVariationSettings = wasLiked ? "'FILL' 1" : "'FILL' 0";
        icon.classList.toggle('text-red-500', wasLiked);
        showToast('Could not update like.', 'error');
    }
}

// 🚀 NEW: double-tap only ever LIKES (matches Instagram — it never unlikes on double-tap,
// even if already liked, it's a no-op rather than a toggle-off).
async function likeStoryFromDoubleTap() {
    const icon = document.querySelector('#hotpost-like-btn span');
    if (!icon || icon.classList.contains('text-red-500')) return; // already liked — no-op

    icon.style.fontVariationSettings = "'FILL' 1";
    icon.classList.add('text-red-500');

    const post = hotpostsByUser.get(currentViewerState.userId).posts[currentViewerState.postIndex];
    try {
        // 🚀 FIX: upsert instead of a plain insert, for the same reason as handleLikeHotpost above.
        const { error } = await supabase.from('hotpost_likes')
            .upsert({ hotpost_id: post.id, user_id: currentUser.id, is_deleted: false }, { onConflict: 'hotpost_id,user_id' });
        if (error) throw error;
        invalidateHotpostsCache(currentUser.id);
        // hotpost_like notification: same DB trigger as handleLikeHotpost above.
    } catch (e) {
        console.error('Double-tap like failed:', e);
        icon.style.fontVariationSettings = "'FILL' 0";
        icon.classList.remove('text-red-500');
    }
}

async function handleReplyToHotpost(event) {
    event.stopPropagation(); 
    if (!window.checkVerification('reply to stories')) return; // 🚀 Soft Restrict Check
    
    const input = document.getElementById('hotpost-reply-input');
    const content = input.value.trim();
    if (!content) return;

    const userData = hotpostsByUser.get(currentViewerState.userId);
    const post = userData.posts[currentViewerState.postIndex];
    const replyBtn = document.getElementById('hotpost-reply-btn');
    const originalHtml = replyBtn.innerHTML;

    replyBtn.disabled = true;
    replyBtn.innerHTML = `<span class="material-symbols-outlined animate-spin text-white">progress_activity</span>`;

    // Story replies are just DMs now (Instagram-style) — this goes through
    // the same messages_insert_connected_sender RLS policy as any other
    // message, so it's already only possible between connections.
    const { error } = await supabase.from('messages').insert({
        sender_id: currentUser.id,
        receiver_id: userData.user.id,
        content: content,
        hotpost_reply_id: post.id
    });

    if (error) {
        const isRlsBlock = error.code === '42501' || /row-level security/i.test(error.message || '');
        showToast(isRlsBlock ? "You can only reply to a connection's story." : 'Failed to send reply.', 'error');
        replyBtn.disabled = false;
        replyBtn.innerHTML = originalHtml;
    } else {
        showToast('Reply sent!', 'success');
        input.value = '';
        if (typeof window.refreshMessages === 'function') window.refreshMessages();

        // 🚀 hotpost_reply notification — story replies are DMs under the hood, so
        // they were never reaching the notifications table at all (only the message
        // itself was sent). Keeping this as its own distinct type — not the generic
        // new_message/"New Chat" push — since the edge function already has a
        // richer, reply-content-aware treatment for it.
        createNotification({ userId: userData.user.id, senderId: currentUser.id, type: 'hotpost_reply', message: content, targetId: post.id });

        replyBtn.classList.add('!bg-green-500', 'border-transparent');
        replyBtn.innerHTML = `<span class="material-symbols-outlined text-white">check</span>`;
        setTimeout(() => {
            replyBtn.disabled = false;
            replyBtn.classList.remove('!bg-green-500', 'border-transparent');
            replyBtn.innerHTML = originalHtml;
            resumeStory();
        }, 1500);
    }
}

async function toggleCameraStatusBar(isCameraOpen) {
    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        try {
            const StatusBar = window.Capacitor.Plugins.StatusBar;
            if (!StatusBar) return;
            
            if (isCameraOpen) {
                await StatusBar.setBackgroundColor({ color: '#000000' });
                await StatusBar.setStyle({ style: 'DARK' });
            } else {
                const isDark = document.documentElement.classList.contains('dark');
                await StatusBar.setBackgroundColor({ color: isDark ? '#121212' : '#f8f9fa' });
                await StatusBar.setStyle({ style: isDark ? 'DARK' : 'LIGHT' });
            }
        } catch (e) { console.log('Status bar override bypassed.'); }
    }
}

function openActivityPanel() {
    pauseStory();
    const modal = document.getElementById('modal-story-details');
    const sheet = document.getElementById('modal-story-details-sheet');
    const viewerContent = document.getElementById('hotpost-viewer-content');
    
    if (viewerContent) {
        viewerContent.style.transition = 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s ease, border-radius 0.4s ease';
        viewerContent.style.transform = '';
        viewerContent.style.opacity = '';
        viewerContent.classList.add('viewer-pushed-back');
    }

    modal.classList.replace('hidden', 'flex');
    setTimeout(() => sheet.style.transform = `translateY(0px)`, 10);

    const post = hotpostsByUser.get(currentUser.id).posts[currentViewerState.postIndex];
    fetchStoryViewers(post.id);
}

function closeActivityPanel() {
    const modal = document.getElementById('modal-story-details');
    const sheet = document.getElementById('modal-story-details-sheet');
    const viewerContent = document.getElementById('hotpost-viewer-content');
    
    sheet.style.transform = `translateY(100%)`;
    modal.style.pointerEvents = 'none'; 
    
    if (viewerContent) {
        viewerContent.style.transition = 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s ease, border-radius 0.4s ease';
        viewerContent.style.transform = '';
        viewerContent.style.opacity = '';
        viewerContent.classList.remove('viewer-pushed-back');
    }

    setTimeout(() => {
        modal.classList.replace('flex', 'hidden');
        modal.style.pointerEvents = 'auto'; 
        resumeStory();
    }, 400); 
}

let currentViewersPostId = null;
let currentViewersPage = 0;
let currentViewersLikedIds = new Set();
const VIEWERS_PER_PAGE = 30;

async function fetchStoryViewers(hotpostId, isLoadMore = false) {
    const list = document.getElementById('hotpost-viewers-list');
    
    if (!isLoadMore) {
        currentViewersPostId = hotpostId;
        currentViewersPage = 0;
        list.innerHTML = ACTIVITY_SKELETON; 
        
        const oldBtn = document.getElementById('load-more-viewers-btn');
        if (oldBtn) oldBtn.remove();
        
        // Fetch the total count quickly for the header
        supabase.from('hotpost_views').select('id', { count: 'exact', head: true }).eq('hotpost_id', hotpostId).eq('is_deleted', false)
            .then(({ count }) => {
                document.getElementById('hotpost-activity-count').textContent = count || 0;
            });
    } else {
        const loadBtn = document.getElementById('load-more-viewers-btn');
        if (loadBtn) loadBtn.innerHTML = `<span class="material-symbols-outlined animate-spin">progress_activity</span>`;
    }

    try {
        const from = currentViewersPage * VIEWERS_PER_PAGE;
        const to = from + VIEWERS_PER_PAGE - 1;

        // 🚀 FIX: Instagram shows one unified "viewed by" list with a heart next to anyone
        // who also liked it — fetch both in parallel instead of keeping them in separate tabs.
        const [viewersRes, likesRes] = await Promise.all([
            supabase.from('hotpost_views')
                .select('viewed_at, users!hotpost_views_viewer_id_fkey(id, full_name, profile_img_url, tick_type)')
                .eq('hotpost_id', currentViewersPostId).eq('is_deleted', false).order('viewed_at', { ascending: false })
                .range(from, to),
            // Likes set is only needed once (not per page) — cheap since it's just IDs.
            isLoadMore ? Promise.resolve({ data: null }) : supabase.from('hotpost_likes')
                .select('user_id').eq('hotpost_id', currentViewersPostId).eq('is_deleted', false)
        ]);

        if (viewersRes.error) throw viewersRes.error;
        const data = viewersRes.data;

        if (!isLoadMore) {
            if (likesRes.error) throw likesRes.error;
            currentViewersLikedIds = new Set((likesRes.data || []).map(l => l.user_id));
        }
        
        if (!isLoadMore && data.length === 0) { 
            list.innerHTML = `
                <div class="flex flex-col items-center justify-center py-14 text-center gap-2">
                    <span class="material-symbols-outlined text-[36px] text-on-surface-variant/40 dark:text-gray-600">visibility</span>
                    <p class="text-sm font-semibold text-on-surface-variant dark:text-gray-400">No views yet</p>
                    <p class="text-[12.5px] text-on-surface-variant/70 dark:text-gray-500">When people view this Hotpost, they'll show up here.</p>
                </div>`; 
            return; 
        }
        
        const getTick = (type) => window.getTickHtml ? window.getTickHtml(type) : '';

        const viewersHtml = data.map(v => {
            const liked = currentViewersLikedIds.has(v.users.id);
            const safeName = (v.users.full_name || '').replace(/'/g, "\\'");
            return `
            <div onclick="window.closeActivityPanel(); window.closeHotpostViewer(); setTimeout(() => window.viewUserProfile('${v.users.id}'), 150);" class="flex items-center justify-between gap-2 py-2.5 px-2 hover:bg-surface-variant/10 dark:hover:bg-neutral-800/30 rounded-xl cursor-pointer active:scale-[0.98] transition-all">
                <div class="flex items-center gap-3.5 min-w-0">
                    <img src="${v.users.profile_img_url}" class="w-11 h-11 rounded-full object-cover border border-surface-variant/30 shrink-0">
                    <p class="text-[14.5px] font-extrabold text-on-surface dark:text-gray-100 flex items-center gap-1 truncate">${v.users.full_name} ${getTick(v.users.tick_type)}</p>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    ${liked ? `<span class="material-symbols-outlined text-red-500 text-[16px] mr-1" style="font-variation-settings: 'FILL' 1;">favorite</span>` : ''}
                    <p class="text-[12px] font-medium text-on-surface-variant dark:text-gray-500 mr-1">${timeAgo(v.viewed_at)}</p>
                    <button onclick="event.stopPropagation(); window.openViewerOptions('${v.users.id}', '${safeName}');" class="w-8 h-8 flex items-center justify-center rounded-full text-on-surface-variant dark:text-gray-400 hover:bg-surface-variant/40 dark:hover:bg-neutral-700/50 active:scale-90 transition-all" aria-label="More options">
                        <span class="material-symbols-outlined text-[19px]">more_vert</span>
                    </button>
                </div>
            </div>
        `;}).join('');

        if (!isLoadMore) {
            list.innerHTML = viewersHtml;
        } else {
            const oldBtn = document.getElementById('load-more-viewers-btn');
            if (oldBtn) oldBtn.remove();
            list.insertAdjacentHTML('beforeend', viewersHtml);
        }

        if (data.length === VIEWERS_PER_PAGE) {
            currentViewersPage++;
            list.insertAdjacentHTML('beforeend', `
                <button id="load-more-viewers-btn" onclick="window.fetchStoryViewers(null, true)" class="w-full py-3 mt-2 mb-4 text-sm font-bold text-primary bg-primary/10 rounded-xl active:scale-95 transition-transform flex justify-center items-center">
                    Load More
                </button>
            `);
        }

    } catch (e) { 
        console.error(e);
        if (!isLoadMore) {
            list.innerHTML = `
                <div class="flex flex-col items-center justify-center py-14 text-center gap-2">
                    <span class="material-symbols-outlined text-[32px] text-error/70">error_outline</span>
                    <p class="text-sm font-semibold text-error">Failed to load viewers</p>
                    <button onclick="window.fetchStoryViewers('${currentViewersPostId}')" class="mt-1 px-4 py-2 text-[13px] font-bold text-primary bg-primary/10 rounded-xl active:scale-95 transition-transform">
                        Try again
                    </button>
                </div>`;
        } else {
            const oldBtn = document.getElementById('load-more-viewers-btn');
            if(oldBtn) oldBtn.innerHTML = "Error loading. Tap to retry.";
        }
    }
}
window.fetchStoryViewers = fetchStoryViewers;

// 🚀 Per-viewer "⋯" menu — quick actions on a single row of the "who viewed" list
// (Instagram-style: view profile / message them directly / report), instead of the
// row only being tappable as a whole with no other affordance.
window.openViewerOptions = function(userId, fullName) {
    const canMessage = myConnectionIds.has(userId);
    let buttons = popupMenuItem('person', 'View profile', `window.closeActionSheet(); window.closeActivityPanel(); window.closeHotpostViewer(); setTimeout(() => window.viewUserProfile('${userId}'), 150);`);
    if (canMessage) {
        buttons += popupMenuItem('chat_bubble', 'Message', `window.closeActionSheet(); window.closeActivityPanel(); window.closeHotpostViewer(); setTimeout(() => window.openConversation('${userId}'), 150);`);
    }
    buttons += popupMenuItem('flag', 'Report', `window.closeActionSheet(); window.openReportModal('${userId}', '${fullName}');`, true);
    window.openActionSheet(buttons);
};

async function executeDeleteHotpost() {
    const post = hotpostsByUser.get(currentUser.id).posts[currentViewerState.postIndex];
    closeActivityPanel(); 
    closeHotpostViewer();
    const { error } = await supabase.from('hotposts').update({ is_deleted: true }).eq('id', post.id);
    if (error) showToast('Failed to delete Hotpost.', 'error');
    else {
        // 🚀 FIX: publish already invalidates this cache so new posts show immediately —
        // delete was missing the same call, so the UI kept re-rendering the stale cached
        // list (still containing the just-deleted post) instead of the fresh one.
        invalidateHotpostsCache(currentUser.id);
        showToast('Hotpost deleted.', 'success');
        fetchHotposts();
    }
}

window.openHotpostCamera = openCameraModal;
window.openStoryDetailsModal = openActivityPanel;

window.openHotpostViewer = openHotpostViewer;
window.openHotpostFromReply = (ownerId, hotpostId) => openHotpostViewer(ownerId, hotpostId);
window.showMyHotposts = () => openHotpostViewer(currentUser.id);
// Used by populateProfileUI (main.js) to decide whether the profile-page avatar
// gets a story ring + tap-to-view, same data the tray itself uses — so it's
// only ever "wrong" for as long as the tray's own fetch hasn't completed yet.
window.getMyHotpostRingState = function() {
    if (!currentUser) return null;
    const myData = hotpostsByUser.get(currentUser.id);
    if (!myData || !myData.posts || myData.posts.length === 0) return null;
    return { viewed: !!myData.viewed };
};
window.refreshHotposts = fetchHotposts;

// 🚀 FIX: Expose these functions to the global window object
window.closeActivityPanel = closeActivityPanel;
window.closeHotpostViewer = closeHotpostViewer;
// ==========================================
// SAVE TO DEVICE ENGINE
// ==========================================
window.downloadCurrentMedia = function() {
    if (!currentPhotoBlob) {
        import('./ui.js').then(({ showToast }) => showToast('No media to save.', 'warning'));
        return;
    }
    
    const fileName = currentMediaType === 'video' ? `Hotpost_${Date.now()}.mp4` : `Hotpost_${Date.now()}.jpg`;
    
    try {
        // 🚀 ROUTE 1: Native Android App (Native Toast handles alert)
        if (window.AndroidDownloader && window.AndroidDownloader.saveBase64File) {
            const reader = new FileReader();
            reader.readAsDataURL(currentPhotoBlob);
            reader.onloadend = function() {
                window.AndroidDownloader.saveBase64File(reader.result, fileName);
            };
            return;
        }

        // 🚀 ROUTE 2: Web Browser / PWA (Browser fallback)
        const url = URL.createObjectURL(currentPhotoBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 3000);
        
        import('./ui.js').then(({ showToast }) => showToast('Saved to device!', 'success'));
    } catch (err) {
        console.error("Save Error:", err);
        import('./ui.js').then(({ showToast }) => showToast('Failed to save media.', 'error'));
    }
};
// ==========================================
// VIEWER UI HELPERS (Fades & Animations)
// ==========================================
window.toggleViewerUI = function(show) {
    // Select all the UI overlays that block the view
    const elementsToToggle = [
        document.getElementById('hotpost-progress-bars'),
        document.getElementById('close-hotpost-viewer-btn'),
        document.getElementById('hotpost-viewer-bottom-gradient'),
        document.querySelector('#hotpost-viewer-content .absolute.top-0.left-0.right-0.h-32'), // Top shadow
        document.querySelector('#hotpost-viewer-content .absolute.top-\\[max\\(1\\.5rem\\,calc\\(env\\(safe-area-inset-top\\)\\+1rem\\)\\)\\]') // User info
    ];

    elementsToToggle.forEach(el => {
        if (!el) return;
        el.style.transition = 'opacity 0.2s ease-in-out';
        el.style.opacity = show ? '1' : '0';
    });
};

window.showDoubleTapHeart = function(x, y) {
    const viewer = document.getElementById('hotpost-viewer-content');
    if (!viewer) return;

    const heart = document.createElement('span');
    heart.className = 'material-symbols-outlined absolute drop-shadow-2xl z-[100] pointer-events-none';
    heart.style.color = '#ff3040'; // 🚀 FIX: was text-white — Instagram's double-tap heart is red
    heart.style.fontVariationSettings = "'FILL' 1";
    heart.style.fontSize = '90px';
    heart.textContent = 'favorite';
    
    // Center the heart exactly where the user tapped
    heart.style.left = `${x - 45}px`;
    heart.style.top = `${y - 45}px`;
    heart.style.animation = 'storyDoubleTapHeart 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards';

    viewer.appendChild(heart);

    // Clean up DOM after animation
    setTimeout(() => heart.remove(), 800);
};

// CLEANUP FUNCTION FOR TAB SWITCHING
window.cleanupHotpostsTab = function() {
    try {
        // Close camera if open
        if (document.getElementById('modal-hotpost-camera')?.classList.contains('flex')) {
            closeCameraModal(true);
        }
        
        // Clear recorded chunks
        recordedChunks = [];
        isRecording = false;
        
        // Revoke any preview URLs
        if (currentPreviewObjectURL) {
            URL.revokeObjectURL(currentPreviewObjectURL);
            currentPreviewObjectURL = null;
        }
        
        console.debug("Hotposts tab cleanup complete");
    } catch (e) {
        console.error("Hotposts cleanup error:", e);
    }
};
