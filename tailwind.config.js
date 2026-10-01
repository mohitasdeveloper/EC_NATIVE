/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  // Scans every HTML page and JS file that renders markup with Tailwind
  // classes, so the compiled build contains every class actually used
  // anywhere in the app (index, auth pages, bafs planner, and all the
  // JS modules that build HTML strings at runtime).
  content: [
    "./www/**/*.html",
    "./www/**/*.js",
  ],
  theme: {
    extend: {
      // Ported 1:1 from the old cdn.tailwindcss.com runtime config in
      // index.html so nothing visually changes.
      colors: {
        "on-surface-variant": "#3f4a3c",
        "surface-dim": "#d9dadb",
        "on-tertiary": "#ffffff",
        "inverse-primary": "#78dc77",
        "outline": "#6f7a6b",
        "surface-container": "#edeeef",
        "surface-container-high": "#e7e8e9",
        "error-container": "#ffdad6",
        "surface": "#f8f9fa",
        "on-background": "#191c1d",
        "surface-container-low": "#f3f4f5",
        "on-secondary": "#ffffff",
        "inverse-on-surface": "#f0f1f2",
        "surface-bright": "#f8f9fa",
        "error": "#ba1a1a",
        "background": "#f8f9fa",
        "secondary": "#4858ab",
        "surface-container-lowest": "#ffffff",
        "on-primary": "#ffffff",
        "surface-tint": "#006e1c",
        "on-error": "#ffffff",
        "on-surface": "#191c1d",
        "inverse-surface": "#2e3132",
        "surface-variant": "#e1e3e4",
        "surface-container-highest": "#e1e3e4",
        "primary": "#006e1c"
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"]
      }
    },
  },
  plugins: [
    require("@tailwindcss/forms"),
    require("@tailwindcss/container-queries"),
  ],
};
