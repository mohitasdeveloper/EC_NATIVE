export const CLOUDINARY_CLOUD_NAME = 'dctc2vtcc';

// Preset for the main "Hotposts" feature
export const CLOUDINARY_HOTPOSTS_PRESET = 'ecampus_hotposts';

// Preset for user profile avatars
export const CLOUDINARY_AVATARS_PRESET = 'ecampus_avatars';

// 🚀 NEW: Hotpost VIDEOS specifically go to a separate Cloudinary account (images/avatars
// stay on the main account above). Set this up because the main account was hitting a
// video-specific limit, which is why videos were failing to post while images kept working.
export const CLOUDINARY_VIDEO_CLOUD_NAME = 'dzlmvd3kd';
export const CLOUDINARY_VIDEO_PRESET = 'videos';