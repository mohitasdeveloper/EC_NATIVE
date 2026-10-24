# www/img

Put `study-icon.png` here (the BAFs App's Mini Apps circle icon). `www/mini-apps.js` loads `img/study-icon.png`
first and only falls back to the hosted URL if the file is missing.

If it isn't committed, the CI build downloads it into this folder before packaging the APK
(see "Bundle Mini Apps icon" in `.github/workflows/android-build.yml`), so releases still carry it.
