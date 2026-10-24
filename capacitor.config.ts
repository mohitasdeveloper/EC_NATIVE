import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mohit.ecampus',
  appName: 'ECampus',
  webDir: 'www',

  // 🚀 FIX: no more `server.url`. That setting made the app skip its own
  // bundled files and navigate to the live website over the network on
  // every single launch — which is *the* root cause of the slow/stuck
  // splash (launch time = however long that page takes to load, plus
  // every render-blocking script on it) and the offline crash (a fresh
  // install with no connection had nothing local to fall back to). The
  // app now boots instantly from the bundled `www/` folder every time,
  // works fully offline, and still talks to Supabase/Cloudinary for data
  // exactly as before — only the page-loading mechanism changed. Web
  // updates now ship with a new app build instead of instantly, which is
  // the trade-off for that reliability.

  plugins: {
    SplashScreen: {
      // 🚀 FIX: was launchShowDuration: 0, which hid the native splash
      // almost immediately — before the WebView had anything to show —
      // leaving a blank/black screen underneath for however long boot
      // took. Auto-hide is now off; main.js calls SplashScreen.hide()
      // itself once the app has actually finished loading (see the
      // hideSplash() calls in www/main.js), with an 8s safety cap so it
      // can never get stuck open either.
      launchAutoHide: false,
      backgroundColor: "#ffffff",
      androidSplashResourceName: "splash",
      androidScaleType: "CENTER_CROP"
    },

    // Edge-to-edge (targetSdk 35+): have Capacitor inject the real status/
    // gesture-bar heights as --safe-area-inset-* CSS variables. The app reads
    // them through --sat / --sab (see www/tailwind-src.css). Android WebView
    // < 140 reports wrong values from env(safe-area-inset-*), so env() alone
    // is not reliable there.
    //
    // @capacitor/status-bar was REMOVED: its setBackgroundColor() /
    // setOverlaysWebView() call the window APIs that Play Console flags as
    // "deprecated APIs for edge-to-edge". The coloured strip behind the
    // status bar is drawn by the web layer (.status-bar-guard), and icon
    // colour is switched with SystemBars.setStyle() (see main.js / auth.js).
    SystemBars: {
      insetsHandling: "css"
    },

    Keyboard: {
      resize: "body",
      resizeOnFullScreen: true
    },

    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"]
    }
  }
};

export default config;
