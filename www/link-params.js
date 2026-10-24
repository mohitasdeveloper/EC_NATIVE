// ============================================================
// LINK PARAMS — the viewer's details appended to links opened through
// window.openServiceLink (main.js): event "View Link" buttons, featured links,
// and every Page Mini App.
// ============================================================
// Base set (all links):  student_id, name, theme
// Full set (Mini Apps):  student_id, name, course, dp_url, theme
//
//   https://app.example.com/?student_id=5490&name=Mohit%20Mali&course=TYBAF
//        &dp_url=https://i.ibb.co/0jDkVxfB/study-icon.png&theme=dark
//
// * student_id is the numeric student id + STUDENT_ID_OFFSET (id "1" -> 5490), the
//   scheme the linked mini-apps already decode.
// * A param is simply left out when the profile doesn't have it.
// * Anything already in the target URL's query string is kept; only the keys
//   above are replaced.
// * Spaces are %20 (not +), and ":" "/" are left readable inside values, so the
//   output looks exactly like the example above. Both are legal in a query
//   string and any standards-following parser decodes them.

export const STUDENT_ID_OFFSET = 5489;

const OWN_KEYS = ['student_id', 'name', 'course', 'dp_url', 'theme'];

const enc = (v) => encodeURIComponent(v).replace(/%3A/gi, ':').replace(/%2F/gi, '/');

/**
 * @param {string} url      absolute http(s) URL
 * @param {object} profile  the viewer's users row (student_id, full_name, course, profile_img_url)
 * @param {{ full?: boolean, dark?: boolean }} [opts]  full: add course + dp_url; dark: theme=dark
 * @returns {string} the URL with the params added (the input unchanged if it can't be parsed)
 */
export function withUserParams(url, profile, opts = {}) {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return url; }

    const mine = [];
    const numericId = parseInt(profile?.student_id, 10);
    if (!isNaN(numericId)) mine.push(['student_id', String(numericId + STUDENT_ID_OFFSET)]);
    if (profile?.full_name) mine.push(['name', profile.full_name]);
    if (opts.full) {
        if (profile?.course) mine.push(['course', profile.course]);
        if (profile?.profile_img_url) mine.push(['dp_url', profile.profile_img_url]);
    }
    mine.push(['theme', opts.dark ? 'dark' : 'light']);

    const kept = [...parsed.searchParams.entries()].filter(([k]) => !OWN_KEYS.includes(k));
    parsed.search = '?' + [...kept, ...mine].map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
    return parsed.toString();
}
