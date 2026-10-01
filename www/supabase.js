// supabase.js
// window.supabase comes from ./vendor/supabase.js (copied out of node_modules by
// `npm run build`, see scripts/vendor.js) — bundled with the app, so it is there
// offline. If it is missing the build step was skipped; say so clearly instead of
// a cryptic "Cannot read properties of undefined".
if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    throw new Error('supabase-js not loaded: vendor/supabase.js is missing — run `npm install && npm run build`.');
}

const SUPABASE_URL = "https://rreczghlcgsrcmfjpzdo.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_TsYRWSpXaEnvopMDdzd36Q_N4TbMymz";

export const supabase = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);
