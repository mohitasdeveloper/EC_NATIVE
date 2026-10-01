# /fonts — self-hosted fonts

This folder holds the fonts ECampus used to load from
`fonts.googleapis.com` at runtime. `fonts.css` (already wired into
`index.html` and precached by `sw.js`) expects these files to exist here:

```
fonts.css
inter-300.woff2
inter-400.woff2
inter-500.woff2
inter-600.woff2
inter-700.woff2
inter-800.woff2
courgette-400.woff2
material-symbols-outlined.woff2
```

## ⚠️ The `.woff2` files are not in this zip yet

Everything *except* the actual font binaries is done: the CSS, the
`index.html` link swap, and the `sw.js` precache list/cache-version bump
are all in place and ready. The one thing I could not do myself is fetch
the real Google-hosted font files — the sandbox this was built in has no
outbound network access for binary downloads (it can browse text/HTML
for research, but can't pull down arbitrary binary files like fonts), so
there was no way to get the genuine bytes onto disk here without either
leaving this step to you or writing fake placeholder files, which would
have quietly shipped a broken font in the zip. Downloading them takes
about 10 seconds on a normal machine, so:

## Get the real files (pick one)

**Option A — run the included script (recommended, exact match):**

```bash
cd fonts
python3 get-fonts.py
```

This fetches the *same* CSS2 endpoints the old `<link>` tags pointed at
(same weights, same variable-font axes for the icon font), so the result
is byte-identical to what your browser used to load — just saved locally
instead of fetched every time. Needs only the Python standard library.

Add `--subset` to additionally shrink the icon font from ~3,000 glyphs
down to just the ~145 icons this app actually uses (see
`icons-used.txt`), which makes it a much smaller precache download:

```bash
pip install fonttools brotli uharfbuzz
python3 get-fonts.py --subset
```

(`uharfbuzz` matters here — Material Symbols icons are implemented as
ligatures, e.g. the text "home" gets substituted for the home glyph, and
`uharfbuzz` is what lets `fonttools` correctly figure out which ligature
rules to keep for the icon names you actually use.)

**Option B — manual, via Google's own tools:**

1. Go to [fonts.google.com](https://fonts.google.com), select **Inter**
   (weights 300/400/500/600/700/800) and **Courgette**, and use "Get
   font" → "Download all". Convert the `.ttf` files to `.woff2` (e.g.
   with [CloudConvert](https://cloudconvert.com/ttf-to-woff2) or the
   `fonttools` CLI: `fonttools varLib.instancer` / `woff2_compress`).
2. For the icon font, go to [fonts.google.com/icons](https://fonts.google.com/icons),
   pick **Material Symbols Outlined**, and use the "Variable font" /
   Google Fonts CDN download option, or grab the pre-built variable
   `.woff2` from the
   [google/material-design-icons](https://github.com/google/material-design-icons)
   repo (`variablefont/MaterialSymbolsOutlined[FILL,GRAD,opsz,wght].woff2`).
3. Rename the files to match the list at the top of this file and drop
   them into this folder.

Once the files are in place, nothing else needs to change — reload the
app (or bump `CACHE_NAME` in `sw.js` again if you already installed the
service worker once without the fonts present) and the icons/text will
be precached and available offline from the very first load.
