package com.iewnfod.lumina_code_mobile

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
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
}
