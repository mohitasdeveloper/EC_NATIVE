#!/usr/bin/env python3
"""
get-fonts.py
============
Downloads the exact Inter, Courgette and Material Symbols Outlined font
files ECampus needs, and writes them into this /fonts folder with the
filenames fonts.css already expects.

Why this script exists: it reproduces, byte-for-byte, what your browser
would have fetched from the Google Fonts CDN links that used to sit in
index.html - just saved to disk once instead of being fetched (and
depended on) at runtime.

Usage (needs internet access - run this on your own machine, not inside
a locked-down sandbox):

    cd fonts
    python3 get-fonts.py

Optional (recommended) - shrink the icon font from ~3000 glyphs down to
only the ~145 icons this app actually uses:

    pip install fonttools brotli uharfbuzz
    python3 get-fonts.py --subset

Requires only the standard library for the plain download; --subset
additionally requires fonttools (+ uharfbuzz, so the ligature-based icon
names like "home" / "notifications" resolve correctly when subsetting).
"""
import argparse
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

# Same User-Agent Chrome sends - needed so Google Fonts serves woff2
# (variable-font) files instead of falling back to ttf/woff for
# unrecognized clients.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# Identical query strings to the <link> tags that used to be in index.html.
INTER_COURGETTE_CSS_URL = (
    "https://fonts.googleapis.com/css2?"
    "family=Inter:wght@300;400;500;600;700;800&family=Courgette&display=swap"
)
MATERIAL_SYMBOLS_CSS_URL = (
    "https://fonts.googleapis.com/css2?"
    "family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=block"
)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def fetch_text(url):
    return fetch(url).decode("utf-8")


def parse_font_faces(css_text):
    """
    Splits a Google Fonts css2 response into individual @font-face blocks,
    tagging each with the /* subset */ comment that precedes it (if any).
    Returns a list of dicts: {subset, font-family, font-weight, src_url}
    """
    blocks = []
    # Split on the "/* subset */" comments Google inserts between blocks,
    # falling back to just scanning all @font-face{...} blocks if there
    # are no subset comments (e.g. the icon font response).
    parts = re.split(r"/\*\s*([\w-]+)\s*\*/", css_text)
    if len(parts) == 1:
        chunks = [(None, css_text)]
    else:
        chunks = [(None, parts[0])] if parts[0].strip() else []
        for i in range(1, len(parts), 2):
            chunks.append((parts[i], parts[i + 1]))

    for subset, chunk in chunks:
        for m in re.finditer(r"@font-face\s*{([^}]*)}", chunk, re.S):
            body = m.group(1)
            fam = re.search(r"font-family:\s*'([^']+)'", body)
            wght = re.search(r"font-weight:\s*(\d+)", body)
            src = re.search(r"url\((https://fonts\.gstatic\.com/[^)]+)\)\s*format\('woff2'\)", body)
            if fam and src:
                blocks.append({
                    "subset": subset,
                    "font-family": fam.group(1),
                    "font-weight": wght.group(1) if wght else None,
                    "src_url": src.group(1),
                })
    return blocks


def pick_latin(blocks, family, weight=None):
    candidates = [b for b in blocks if b["font-family"] == family and
                  (weight is None or b["font-weight"] == str(weight))]
    if not candidates:
        return None
    # Prefer the block explicitly marked "latin" (not "latin-ext" etc).
    for b in candidates:
        if b["subset"] == "latin":
            return b
    # No subset comments at all (single-block response) -> just use it.
    if len(candidates) == 1:
        return candidates[0]
    # Fallback: first candidate.
    return candidates[0]


def download_to(url, path):
    print(f"  downloading {url}")
    data = fetch(url)
    with open(path, "wb") as f:
        f.write(data)
    print(f"  -> {path} ({len(data):,} bytes)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--subset", action="store_true",
                     help="Subset the icon font down to icons-used.txt with fonttools")
    args = ap.parse_args()

    print("Fetching Inter + Courgette CSS...")
    ic_css = fetch_text(INTER_COURGETTE_CSS_URL)
    ic_blocks = parse_font_faces(ic_css)

    for weight, fname in [(300, "inter-300.woff2"), (400, "inter-400.woff2"),
                           (500, "inter-500.woff2"), (600, "inter-600.woff2"),
                           (700, "inter-700.woff2"), (800, "inter-800.woff2")]:
        block = pick_latin(ic_blocks, "Inter", weight)
        if not block:
            print(f"  !! could not find Inter weight {weight} in the response", file=sys.stderr)
            continue
        download_to(block["src_url"], os.path.join(HERE, fname))

    courgette = pick_latin(ic_blocks, "Courgette", 400)
    if courgette:
        download_to(courgette["src_url"], os.path.join(HERE, "courgette-400.woff2"))
    else:
        print("  !! could not find Courgette in the response", file=sys.stderr)

    print("Fetching Material Symbols Outlined CSS...")
    ms_css = fetch_text(MATERIAL_SYMBOLS_CSS_URL)
    ms_blocks = parse_font_faces(ms_css)
    ms_block = pick_latin(ms_blocks, "Material Symbols Outlined")
    if not ms_block:
        print("  !! could not find Material Symbols Outlined in the response", file=sys.stderr)
        sys.exit(1)

    target = os.path.join(HERE, "material-symbols-outlined.woff2")
    full_tmp = os.path.join(HERE, "_material-symbols-outlined-full.woff2")
    download_to(ms_block["src_url"], full_tmp)

    if args.subset:
        print("Subsetting icon font to icons-used.txt ...")
        try:
            from fontTools import subset  # noqa: F401
        except ImportError:
            print("  !! fonttools not installed - run: pip install fonttools brotli uharfbuzz",
                  file=sys.stderr)
            os.replace(full_tmp, target)
        else:
            icons_file = os.path.join(HERE, "icons-used.txt")
            args_list = [
                full_tmp,
                f"--text-file={icons_file}",
                "--unicodes=*",
                "--layout-features=liga",
                "--no-hinting",
                "--flavor=woff2",
                f"--output-file={target}",
            ]
            from fontTools.subset import main as pyftsubset_main
            pyftsubset_main(args_list)
            os.remove(full_tmp)
            print(f"  -> {target}")
    else:
        os.replace(full_tmp, target)

    print("\nDone. All font files are now in", HERE)


if __name__ == "__main__":
    main()
