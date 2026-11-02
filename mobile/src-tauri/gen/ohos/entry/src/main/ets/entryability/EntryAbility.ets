import { RustAbility } from '@ohos-rs/ability'
import Want from '@ohos.app.ability.Want'
import { AbilityConstant, Configuration, ConfigurationConstant } from '@kit.AbilityKit';
import window from '@ohos.window';
import webview from '@ohos.web.webview';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';

const DOMAIN = 0x0000;
const TAG = 'EntryAbility';

// The whole-app background: the OPAQUE equivalent of the chrome's glass
// surface. NOT the raw chrome bases (#fafafa light / #1a1a1a dark,
// src/lib/theme.ts) but their glassSurfaceEquivalent composite
// (src/lib/glass.ts) — the chrome the background sits behind renders as
// the glass tint over the base, so the opaque window must match that
// composite, not the base. The web frontend deliberately leaves html/body
// unpainted (src/mobile.css), so this window background is also the color
// the user sees while the webview loads. Mirrors Android's
// lumina_window_bg (gen/android .../values{,-night}/colors.xml + the
// splash override). Keep the four places in sync: the Android resources,
// MainActivity's parse-failure fallback, these constants, and the
// start_window_background color resources.
const CHROME_BG_LIGHT = '#F0F0F0';
const CHROME_BG_DARK = '#282828';

export default class EntryAbility extends RustAbility {
  // change to dynamic library name
  public moduleName: string = "lumina_code_mobile_lib"
  // The HAR's internal MainPage (loaded via loadContentByName when
  // defaultPage is true) has NO onBackPress — the system back gesture
  // fell through to the OS default (move to background) and the
  // webview's history never participated. false skips it;
  // onWindowStageCreate loads OUR page (pages/LuminaPage) instead,
  // whose onBackPress drives the webview history — the HarmonyOS twin
  // of Android's MainActivity.handleBackNavigation (see LuminaPage.ets).
  public defaultPage: boolean = false;
  public mode: 'xcomponent' | 'webview' = 'webview'

  private mainWindow: window.Window | null = null;

  async onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): Promise<void> {
    // Remote DevTools (chrome://inspect / hdc fport tcp:9222
    // localabstract:webview_devtools_remote_<pid>) — dev builds only;
    // the HAR only enables the engine, not remote access.
    webview.WebviewController.setWebDebuggingAccess(true);

    // Feed the sandbox dirs to Rust BEFORE tauri boots: on ohos the tauri
    // path resolver falls back to the desktop XDG derivation
    // ($HOME/.local/share — read-only on device), which sends every
    // plugin-store save to EPERM and persistence dies silently. The Rust
    // side redirects the XDG vars at these dirs; the dynamic import is the
    // same module instance RustAbility's super.onCreate() loads (cached).
    // ESObject is the ArkTS escape hatch for dynamic JS interop — the same
    // typing RustAbility.ets itself uses for the imported module. The import
    // target must go through a VARIABLE (the HAR's own trick): a template
    // literal inline makes the compiler try to resolve it as a package name.
    const packageName = `lib${this.moduleName}.so`;
    let module: ESObject = await import(packageName);
    module.default.setSandboxDirs(this.context.filesDir, this.context.cacheDir);

    await super.onCreate(want, launchParam);

    // Seed the Rust side with the INITIAL system configuration. The system
    // only delivers onConfigurationUpdate on CHANGES — a cold start into an
    // already-dark system would otherwise leave the Rust app config at
    // NoSet forever, and tao's Window::theme() (which tauri's
    // window.theme()/onThemeChanged — and through them the web frontend's
    // useSystemTheme — read) would answer Light for a dark system. The
    // lifecycle is up (super.onCreate just built it); the window doesn't
    // exist yet, so the background half of our own handler is a no-op here.
    this.onConfigurationUpdate(this.context.config);
  }

  async onWindowStageCreate(windowStage: window.WindowStage): Promise<void> {
    this.mainWindow = windowStage.getMainWindowSync();
    await this.mainWindow.setWindowLayoutFullScreen(false);
    await super.onWindowStageCreate(windowStage);
    // defaultPage = false above skipped the HAR's internal page load —
    // load OUR page here. Same ordering as the stock path: AFTER super
    // (the Rust window lifecycle must be up before the page's
    // aboutToAppear calls render()), and BEFORE applyWindowBackground —
    // setWindowBackgroundColor only takes effect once the window has
    // content (its own d.ts contract). The system bars decorate
    // themselves in non-fullscreen layout and follow the system theme
    // on their own — unlike Android there is no system-bar appearance
    // to manage here.
    try {
      await windowStage.loadContent('pages/LuminaPage');
    } catch (e) {
      const err = e as BusinessError;
      hilog.error(DOMAIN, TAG, `loadContent(pages/LuminaPage) failed: ${err.code} ${err.message}`);
    }
    this.applyWindowBackground(this.context.config.colorMode);
  }

  // System day/night switch (also fires for language/font changes — the
  // re-apply is idempotent and cheap, no need to diff). super FIRST:
  // RustAbility forwards this to the Rust lifecycle (tauri-ohos), and
  // skipping it would cut the native side off. The in-app theme override
  // Android receives via the __luminaNative JS bridge has NO ohos twin —
  // ArkWeb's javaScriptProxy must attach to the Web component, which the
  // @ohos-rs/ability HAR builds internally; the shell background therefore
  // follows the SYSTEM theme on ohos (the frontend's useChromeThemeSync
  // call is an optional-chaining no-op there).
  onConfigurationUpdate(newConfig: Configuration): void {
    super.onConfigurationUpdate(newConfig);
    this.applyWindowBackground(newConfig.colorMode);
  }

  private applyWindowBackground(colorMode: ConfigurationConstant.ColorMode | undefined): void {
    // Mind the enum order (ConfigurationConstant.ColorMode): NOT_SET = -1,
    // DARK = 0, LIGHT = 1 — anything but DARK (incl. NOT_SET/undefined)
    // reads as light, matching the base (non-dark) color resources.
    const color: string = colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK
      ? CHROME_BG_DARK
      : CHROME_BG_LIGHT;
    try {
      this.mainWindow?.setWindowBackgroundColor(color);
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, `setWindowBackgroundColor(${color}) failed: ${err.code} ${err.message}`);
    }
  }
}
