// scripts/vendor.js — copy third-party browser libraries out of node_modules
// into www/vendor so the app never needs a CDN at startup.
//
// Why: index.html used to load supabase-js, Quill, html2canvas and Font Awesome
// from CDNs. Offline, window.supabase was undefined, ./supabase.js threw while
// evaluating, and because main.js imports it the ENTIRE app failed to start.
// Now everything ships inside the app bundle. Runs as part of `npm run build`.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www', 'vendor');

const FILES = [
  ['@supabase/supabase-js/dist/umd/supabase.js', 'supabase.js'],
  ['quill/dist/quill.min.js', 'quill.min.js'],
  ['quill/dist/quill.snow.css', 'quill.snow.css'],
  ['quill-mention/dist/quill.mention.min.js', 'quill.mention.min.js'],
  ['quill-mention/dist/quill.mention.min.css', 'quill.mention.min.css'],
  ['html2canvas/dist/html2canvas.min.js', 'html2canvas.min.js'],
  ['@fortawesome/fontawesome-free/css/all.min.css', 'fontawesome/css/all.min.css'],
];
// Font Awesome loads its icon fonts from ../webfonts relative to the CSS.
const FA_WEBFONTS = '@fortawesome/fontawesome-free/webfonts';

let failed = false;
function copy(srcRel, destRel) {
  const src = path.join(root, 'node_modules', srcRel);
  const dest = path.join(out, destRel);
  if (!fs.existsSync(src)) {
    console.error('vendor: MISSING ' + srcRel);
    failed = true;
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('vendor: ' + destRel + ' (' + Math.round(fs.statSync(dest).size / 1024) + ' KB)');
}

fs.rmSync(out, { recursive: true, force: true });
FILES.forEach(([s, d]) => copy(s, d));

const fontsDir = path.join(root, 'node_modules', FA_WEBFONTS);
if (fs.existsSync(fontsDir)) {
  fs.readdirSync(fontsDir)
    .filter((f) => f.endsWith('.woff2'))
    .forEach((f) => copy(FA_WEBFONTS + '/' + f, 'fontawesome/webfonts/' + f));
} else {
  console.error('vendor: MISSING ' + FA_WEBFONTS);
  failed = true;
}

if (failed) {
  console.error('vendor: some files are missing — run `npm install` first (or a package layout changed).');
  process.exit(1);
}
