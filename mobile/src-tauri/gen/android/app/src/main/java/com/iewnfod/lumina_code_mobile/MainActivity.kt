package com.iewnfod.lumina_code_mobile

import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // TauriActivity hard-disables wry's back routing (handleBackNavigation
  // = false → NO OnBackPressedCallback is ever registered, the system
  // back gesture/button falls through to the activity default = finish,
  // exiting the app on any back). Re-enable it so back drives the
  // WEBVIEW HISTORY instead — the frontend's back-level stack
  // (src/lib/backStack.ts) pushes one history entry per open "page
  // level" (modals, the settings second-level page, the drawer,
  // popover menus, the expanded stats overlay), so canGoBack() is true
  // exactly while a level is open: goBack() → popstate closes the top
  // level; at the root the callback defers to the default behavior
  // (finish) — the Android convention for "back at the top".
  override val handleBackNavigation: Boolean = true

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // The webview must never paint under the system bars. Android
    // WebView does not reliably surface env(safe-area-inset-*) to page
    // CSS (many WebView builds report 0 regardless of viewport-fit),
    // so the REAL insets are applied as native padding on the content
    // view — system bars AND display cutout, live on rotation. The
    // page's own CSS must therefore NOT add env() padding on top
    // (mobile.css keeps its layout rules layout-only).
    //
    // The IME rides the same contract: with edge-to-edge (and
    // targetSdk 35+, where the system no longer resizes the window for
    // the keyboard AT ALL), the webview would otherwise stay
    // full-height and the composer sit BEHIND the keyboard. The bottom
    // padding takes max(bars, ime) — NOT the sum: while the keyboard
    // is up the nav-bar insets keep reporting, and adding both would
    // double-lift the content. The content view shrinking here is all
    // the page needs: its column flow is pure CSS (scroller flex-1 +
    // composer shrink-0), so the composer rises above the keyboard
    // with no JS involvement (useTranscriptScroll's ResizeObserver
    // re-pins the transcript bottom on the shrink).
    val content: View = findViewById(android.R.id.content)
    fun applyInsets(insets: WindowInsetsCompat) {
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      content.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
    }
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      applyInsets(insets)
      WindowInsetsCompat.CONSUMED
    }
    // NO WindowInsetsAnimationCallback here, deliberately (live-observed
    // 2026-10-17): re-applying the padding per animation frame resizes
    // the WebView per frame, and WebView resizes are NOT synchronous
    // with its compositor — the surface buffer is scaled between frames
    // and the whole layout flickers between the final and mid-animation
    // states. The single application when the IME settles reads as one
    // clean jump instead. Do not re-add for native-view smoothness; for
    // a WebView the jump IS the correct trade.
  }

  // ---- Native chrome sync (the safe-area bands' background) ----
  //
  // The padded content view leaves the system-bar bands painted by the
  // WINDOW background (the theme's windowBackground = lumina_window_bg,
  // kept in sync with src/lib/theme.ts). Two things can desync it, both
  // handled below:
  //
  // 1. System day/night switch. The manifest swallows the uiMode config
  //    change (android:configChanges — the webview must not re-create),
  //    so on a system theme switch the activity is NOT recreated, the
  //    decor view never re-resolves its windowBackground, and
  //    enableEdgeToEdge's one-shot system-bar icon appearance goes
  //    stale (dark icons on the now-dark background would be
  //    unreadable). Re-apply both here.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applySystemBarAppearance(night = newConfig.isNightMode())
    window.setBackgroundDrawable(
      ColorDrawable(getColor(R.color.lumina_window_bg))
    )
    // A manual in-app theme override (see onWebViewCreate below) is
    // re-pushed by the frontend right after this fires — its effect
    // depends on the resolved system theme too, so the override color
    // re-wins without any native bookkeeping.
  }

  // 2. The in-app theme preference (General settings: light/dark/system)
  //    can DISAGREE with the system theme — the static resource follows
  //    the system, the webview chrome follows the preference. The
  //    frontend pushes its resolved chrome base (src/App.tsx InnerApp)
  //    through this tiny bridge so the bands always match the app
  //    chrome, whatever the preference. Called on a JavaBridge thread;
  //    the window may only be touched on the UI thread. Content is
  //    local and trusted, and the interface only ever exists in this
  //    app's own pages — no external URLs are loaded into this webview.
  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun setChromeBackground(colorHex: String, dark: Boolean) {
        runOnUiThread {
          val color = try {
            Color.parseColor(colorHex)
          } catch (_: IllegalArgumentException) {
            // Not a parseable #rrggbb — fall back to the theme resource.
            getColor(R.color.lumina_window_bg)
          }
          window.setBackgroundDrawable(ColorDrawable(color))
          applySystemBarAppearance(night = dark)
        }
      }
    }, "__luminaNative")
  }

  private fun applySystemBarAppearance(night: Boolean) {
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.isAppearanceLightStatusBars = !night
    controller.isAppearanceLightNavigationBars = !night
  }
}

private fun Configuration.isNightMode(): Boolean =
  (uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
