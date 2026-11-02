/**
 * The app's @Entry page — the HarmonyOS twin of Android's back
 * navigation (MainActivity.handleBackNavigation), plus a port of the
 * @ohos-rs/ability HAR's DefaultXComponent assembly (the HAR has
 * supported custom pages since 0.0.2: RustAbility.defaultPage = false
 * skips its internal MainPage and the app provides the page itself —
 * see EntryAbility.onWindowStageCreate).
 *
 * WHY a custom page: the HAR's MainPage has no onBackPress, so the
 * system back gesture (swipe-back / back key) fell straight through to
 * the OS default (move to background) and the webview's history never
 * participated. The frontend's back-level stack (src/lib/backStack.ts,
 * active on every mobile platform via isMobileApp()) pushes one history
 * entry per open "page level" (modals, the settings second-level page,
 * the drawer, popover menus, the expanded stats overlay) — exactly like
 * Android's wry routing (canGoBack() ? goBack() : finish), the
 * onBackPress below drives the same semantics through ArkWeb:
 *
 *   accessBackward()  ≡ canGoBack() — true while the webview history
 *                       has a backward entry (pushState entries count:
 *                       they are real history entries in Chromium terms)
 *   backward()        ≡ goBack() — history back → popstate →
 *                       backStackHandlePop closes the TOP level
 *   return false      ≡ finish — at the root the system default runs
 *                       (targetSdk 12+: move to background, the
 *                       HarmonyOS convention for "back at the top")
 *
 * The controller hand-off: helper.createWebview pre-creates a native
 * WebviewController per webview, records it in webControllers and
 * passes it through WebviewInitData.controller — the field addWebview
 * itself fills the same way when unset — because that reference is what
 * onBackPress needs and what the stock DefaultXComponent keeps private.
 */
import { NodeContent } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';
import process from '@ohos.process';
import webview from '@ohos.web.webview';
import {
  RustWebviewNodeController,
  WebviewStyle,
} from '@ohos-rs/ability';

const DOMAIN = 0x0000;
const TAG = 'LuminaPage';

@Entry
@Component
struct LuminaPage {
  // The Rust render slot + webview node host — the DefaultXComponent
  // assembly (the HAR exports RustWebviewNodeController for exactly
  // this custom-page use).
  private rootSlot = new NodeContent();
  private webviewNodes = new RustWebviewNodeController(this.getUIContext());
  // Every webview's native controller, pre-created in createWebview
  // and handed to addWebview via WebviewInitData.controller — the
  // handle onBackPress needs. The app is single-webview; the array
  // only future-proofs the probe loop.
  private webControllers: webview.WebviewController[] = [];

  // ArkHelper (the HAR's type is not exported; the Rust render() reads
  // the same {exit, createWebview} shape — EntryAbility's ESObject
  // interop precedent).
  private helper: ESObject = {
    exit: (code: number) => {
      const pro = new process.ProcessManager();
      pro.exit(code)
    },
    createWebview: (data: ESObject) => {
      const initScripts: ScriptItem[] = (data?.initializationScripts || []).map((i: string) => {
        return {
          script: i,
          scriptRules: ['*']
        } as ScriptItem
      })
      // Pre-create and remember the controller — the whole reason this
      // page exists (the stock DefaultXComponent lets addWebview create
      // it internally, unreachable).
      const nativeController = new webview.WebviewController(data?.id);
      this.webControllers.push(nativeController);

      // ESObject keeps the declared-but-unexported controller field of
      // WebviewInitData out of the type checker's way: addWebview
      // itself assigns a plain web_webview.WebviewController to the
      // same field when none is given, so a native instance is the
      // supported shape.
      const init: ESObject = {
        webTag: data?.id,
        url: data?.url,
        html: data?.html,
        headers: data?.headers,
        style: (data.style || {}) as WebviewStyle,
        javascriptEnable: data?.javascriptEnable ?? true,
        userAgent: data?.userAgent,
        devtools: data?.devtools,
        autoplay: data?.autoplay,
        initializationScripts: initScripts,
        onDragAndDrop: data?.onDragAndDrop,
        onDownloadStart: data?.onDownloadStart,
        onDownloadEnd: data?.onDownloadEnd,
        onNavigationRequest: data?.onNavigationRequest,
        onTitleChange: data?.onTitleChange,
        controller: nativeController,
      };

      // transparent only be set when backgroundColor is null.
      if (data?.transparent && !init.style?.backgroundColor) {
        init.style!.backgroundColor = Color.Transparent;
      }
      const ret = this.webviewNodes.addWebview(init)

      ret.controller.setBackgroundColor = (color: string) => {
        init.style!.backgroundColor = color;
        const node = this.webviewNodes.getWebviewNode(ret.webTag);
        node?.update(init)
      }

      ret.controller.setVisible = (visible: boolean) => {
        init.style!.visible = visible ? 'visible' : 'hidden';
        const node = this.webviewNodes.getWebviewNode(ret.webTag);
        node?.update(init)
      }

      // Return controller and use controller to control webview behavior
      return ret.controller;
    },
  }

  @StorageProp("moduleName") name: string = "";
  @StorageProp("loadMode") loadMode: "async" | "sync" = "async";

  async aboutToAppear(): Promise<void> {
    const moduleName = `lib${this.name}.so`;
    let module: ESObject;
    if (this.loadMode === "async") {
      module = await import(moduleName);
    } else {
      module = loadNativeModule(moduleName);
    }

    module.default.render(this.helper, this.rootSlot);
  }

  // The system back gesture (swipe-back / back key) closes the TOP page
  // level while the webview history has a backward entry; at the root
  // false lets the system default run (move to background).
  onBackPress(): boolean {
    for (const controller of this.webControllers) {
      try {
        if (controller.accessBackward()) {
          controller.backward();
          return true;
        }
      } catch (e) {
        // 17100001: the controller is not associated with a Web
        // component (yet) — treat this webview as not consumable and
        // keep probing.
        const err = e as BusinessError;
        hilog.warn(DOMAIN, TAG, `back probe failed: ${err.code} ${err.message}`);
      }
    }
    return false;
  }

  build() {
    Stack() {
      ContentSlot(this.rootSlot)
      Row() {
        Column() {
          NodeContainer(this.webviewNodes)
            .height("100%")
            .width("100%")
        }
        .width('100%')
      }
      .height('100%')
    }
  }
}
