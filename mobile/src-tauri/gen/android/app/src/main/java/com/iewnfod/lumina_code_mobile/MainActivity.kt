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
    val content: View = findViewById(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
