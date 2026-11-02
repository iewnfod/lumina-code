import { RustAbility } from '@ohos-rs/ability'
import Want from '@ohos.app.ability.Want'
import { AbilityConstant } from '@kit.AbilityKit';
import window from '@ohos.window';
import webview from '@ohos.web.webview';

export default class EntryAbility extends RustAbility {
  // change to dynamic library name
  public moduleName: string = "lumina_code_mobile_lib"
  public defaultPage: boolean = true;
  public mode: 'xcomponent' | 'webview' = 'webview'

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
  }

  async onWindowStageCreate(windowStage: window.WindowStage): Promise<void> {
    const window = windowStage.getMainWindowSync();
    await window.setWindowLayoutFullScreen(false);
    super.onWindowStageCreate(windowStage);
  }
}
