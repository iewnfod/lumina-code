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
    super.onCreate(want, launchParam);
  }

  async onWindowStageCreate(windowStage: window.WindowStage): Promise<void> {
    const window = windowStage.getMainWindowSync();
    await window.setWindowLayoutFullScreen(false);
    super.onWindowStageCreate(windowStage);
  }
}
