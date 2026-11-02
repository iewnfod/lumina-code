# Lumina Code Mobile

Lumina Code 的移动客户端（v2 —— **桌面树接管 + lumina-code-server 隧道**）：手机上跑
的就是桌面 App 的完整 UI 树，opencode API 流量经自部署的 lumina-code-server 隧道
到达桌面端。手机只需可达 server（公网/内网均可），获得 100% 功能——实时 SSE
流式输出、全功能 composer、模型切换、设置。

```
手机 App（桌面 UI 树）
  ↕ HTTPS（Bearer = lumina 设备 token）
lumina-code-server  /api/tunnel/opencode/**（透传代理 + SSE fan-out）
  ↕ 长轮询指令 / POST 响应 / POST 事件
桌面 App（useServerTunnel → 127.0.0.1 本地 opencode，注入本地密码）
```

- **鉴权两段式**：手机侧 Bearer 设备 token（server 验），桌面侧注入本地
  Basic——opencode 密码永不离开桌面。隧道授予完整 opencode 控制面，凭据可在
  网页 console 吊销；TLS 归反向代理（见 server/README.md）。
- **桌面在线是前提**：桌面端须在 Settings → Server 打开「远程访问（隧道）」；
  离线时手机侧 503 → 连接错误态。每账号一条隧道，第二个桌面顶替第一个
  （世代栅栏，旧的自动退位）。事件流断线后重连会 re-seed 已跟踪会话自愈。
- **v1 的镜像/relay 消费端已删**（SessionList/Session/ComposerBar/ActivityPanel
  自制界面）：网页 console 的镜像浏览与 relay 循环保留（服务其他客户端），
  移动端不再是其消费者。

## 结构

- 前端：仓库根 package 的**第二 vite 入口**（`mobile/index.html` →
  `src/mobile/`）：`kv.ts`（localStorage 水合门 + `__LUMINA_MOBILE__` 旗标）→
  `App.tsx`（登录门 → 挂载真正的桌面 `App`）。桌面树的移动门控都在桌面代码
  里：`isMobileApp()`（lib/platform.ts）驱动 useOpencode 的远程分支、sidebar
  抽屉（TitleBar 汉堡）、隐藏统计面板/窗口控件/Server 设置页。
- 壳：`mobile/src-tauri`，**纯 crates.io stable**（`=` 钉版对齐桌面 lock/npm，
  见下）；插件 log/opener/os/dialog/notification/store（store 即
  tauri-plugin-store —— 持久化 state/state.json 的落盘通道；原先给 ArkWeb
  localStorage 兜底的 kv_load/kv_set 已随之删除）。
- 桌面端：`src/hooks/useServerTunnel.ts` + `src/opencode/tunnelClient.ts`
  （纯核心，node-testable）。
- server 端：`server/src/lib/tunnel.ts` + `server/src/app/api/tunnel/**`。

## 构建与运行

```bash
pnpm dev:mobile            # 浏览器开发 UI（http://localhost:1421）
pnpm build:mobile          # → dist-mobile/
cargo check --manifest-path mobile/src-tauri/Cargo.toml   # host 检查

# Android（SDK/NDK/环境见下）
cd mobile/src-tauri && cargo tauri android init   # 首次；gen/android 提交
cargo tauri android build --debug                 # APK/AAB
cargo tauri android dev                           # 模拟器热载

# 注意：gradle 的 rustBuild 任务会回调 tauri CLI（android-studio-script），
# 该回调走 `pnpm exec tauri`（见 gen/android/buildSrc/BuildTask.kt）——npm CLI
# 是 N-API 模块、没有独立的 cargo-tauri 可执行文件，走 pnpm 保证回调用的就是
# 根 package.json 钉的同一个 CLI 版本。前提：仓库根跑过 `pnpm install`（构建
# 本来就需要）；顶层用 `cargo tauri` 驱动也行，但内外两层 CLI 版本可能不同。

# iOS：需 macOS（Linux 上 cc-rs 过不了 xcrun）；cargo tauri ios init/build
```

### Android 工具链（一次性）

Android Studio（platform + build-tools）+ NDK (side by side) + cmdline-tools +
`rustup target add aarch64-linux-android armv7-linux-androideabi
i686-linux-android x86_64-linux-android`；环境变量 `ANDROID_HOME=$HOME/Android/Sdk`
（NDK 自动取 `ndk/` 最新，或显式 `NDK_HOME`）。日志：`adb logcat`。

### 签名与 CI 发布（Release 流水线）

- **版本随桌面端同步**：`mobile/src-tauri/{tauri.conf.json, Cargo.toml,
  Cargo.lock}` 三处（无 package.json——前端是仓库根的第二个 vite 入口）由
  `scripts/bump-version.sh` 常设收编，与 webkit/CEF 两个 shell 一起从同一
  tag 发布。Android 的 versionName/versionCode 由 tauri 构建时从 conf 版本
  自动派生（`major*1000000 + minor*1000 + patch`，写入构建时生成的
  `gen/android/app/tauri.properties`），`--check` 十一个文件全绿即三端对齐。
- **Release 流水线**：`.github/workflows/release.yml` 的 `publish-android`
  job 在每次 release 发布时构建 **arm64-only APK**
  （`pnpm exec tauri android build --apk --target aarch64`，在 `mobile/`
  目录下执行）并上传为 `Lumina.Code_<ver>_android-arm64.apk`。
- **签名**（APK 不签名无法安装）：`gen/android/app/build.gradle.kts` 里的
  条件 signingConfig 读取 `gen/android/keystore.properties`（已被模板
  gitignore）：
  ```properties
  storeFile=lumina-release.jks
  storePassword=<storepass>
  keyAlias=lumina
  keyPassword=<keypass>
  ```
  本地构建时手写该文件即可；CI 从四个 secrets 生成它。**一次性设置**（密钥
  库丢失 = 老用户无法覆盖升级，务必备份 `.jks`）：
  ```bash
  keytool -genkey -v -keystore lumina-release.jks \
    -keyalg RSA -keysize 2048 -validity 10000 -alias lumina \
    -storepass <password> -keypass <password>
  gh secret set ANDROID_KEYSTORE_BASE64 < <(base64 -w0 lumina-release.jks)
  gh secret set ANDROID_KEYSTORE_PASSWORD   # -storepass 的值
  gh secret set ANDROID_KEY_ALIAS           # 例如 lumina
  gh secret set ANDROID_KEY_PASSWORD        # 同一个密码（见下）
  ```
  **PKCS12 密码约束**（live-observed）：现代 keytool 默认输出 PKCS12，不支持
  key 密码 ≠ store 密码——`-keypass` 传不同值会被静默忽略。两个 secret 必须是
  同一个密码，否则 gradle 报 `Given final block not properly padded`。
  secrets 缺失时 android job 会**快速失败**并打印上述指引——宁可发布红着，
  不上传一个装不上的 unsigned APK。

### E2E 冒烟（无需跑桌面 App）

```bash
# 1. 起 lumina-code-server + sidecar
LUMINA_DATA_DIR=/tmp/e2e pnpm --filter lumina-code-server dev
OPENCODE_SERVER_PASSWORD=pw ./src-tauri/binaries/opencode serve --port 4312 \
  --hostname 127.0.0.1 --cors 'http://localhost:1421'
# 2. 注册账号拿 token（POST /api/auth/register）
# 3. 假桌面（协议同 tunnelClient.ts）
LUMINA_URL=http://127.0.0.1:4600 LUMINA_TOKEN=... \
OPENCODE_URL=http://127.0.0.1:4312 OPENCODE_PASSWORD=pw \
  node scripts/tunnel-fake-desktop.mjs
# 4. 模拟器登录 http://10.0.2.2:4600 → 完整桌面 UI → 发 prompt → 流式回复
```

## 已知坑（全部 live-observed）

- **`app.windows` 必须有 `main` 条目**：空列表 = setup() 不建 webview = 白屏
  但进程存活、无 chromium 日志。
- **Tailwind 内容检测跟随 vite root**：mobile 构建的 root 是 `mobile/`，桌面树
  的工具类（h-screen/text-sm/…）会静默缺失（表现为 36px 高的 UI / 排版崩坏
  ——这也是 v1「markdown css 没加载」的真正根因）。修复：main.css 显式
  `@source "./**/*.{ts,tsx}"`。
- **html/body 内联样式会毒害继承**：index.html 里 splash 时代的
  `color:#e8e8ee` 被整个 app 树继承 → 浅色主题浅底浅字不可读。html/body 只
  放布局样式，颜色放 `#splash` 自身。
- **版本 `=` 钉死**（caret 表达不了"留在 2.11"，`^2.11`=`<3.0.0` 会跳最新
  minor 触发 CLI 的 npm parity 拒绝；fresh lock 会解出 tauri 2.11.6 +
  tauri-runtime 2.12 的互不兼容组合——恢复法：以桌面 Cargo.lock 为种子
  `cp src-tauri/Cargo.lock mobile/src-tauri/Cargo.lock && cargo check`）。
- **`beforeBuildCommand` 在仓库根执行**（写 `pnpm run build:mobile`）。
- 边缘到边缘：MainActivity 默认 enableEdgeToEdge，标题栏需 safe-area padding
  （mobile.css 的 `#root > div` 规则）。
- **软键盘（IME）同样走 native padding**：targetSdk 35+ 的 edge-to-edge 下系统
  根本不为键盘缩放窗口——MainActivity 的 insets listener 取
  `max(bars.bottom, ime.bottom)` 作底边 padding（取 max 不相加：键盘弹出时
  导航栏 insets 仍在报告）。**刻意不挂 `WindowInsetsAnimationCompat` 逐帧回调**
  （live-observed：逐帧 padding = 逐帧 resize WebView，而 WebView 的尺寸变化
  滞后于合成器，动画期间 surface buffer 被缩放凑数，整个布局在最终/中间状态
  间闪烁）；padding 在键盘落定时一次性生效，表现为干净的一跳。manifest
  的 `adjustResize` 只为 pre-35 设备禁掉 adjustPan（全屏窗 +
  decorFitsSystemWindows(false) 下 pan 会与 padding 叠成双重抬升），35+ 上被
  忽略。页面侧零 JS：composer 列是纯 CSS 流，缩放后自然抬升；
  useTranscriptScroll 的 ResizeObserver 负责把 transcript 重新贴底。

## 待打磨（已知，不阻塞）

- composer 工具栏窄屏三行堆叠的间距/收缩。
- 状态栏配色未跟随 app 主题。
- 隧道无事件 replay buffer（重连靠 re-seed 自愈）；无多桌面仲裁（顶替制）。

---

## HarmonyOS（已恢复，`feat/mobile-ohos` 分支）

状态：**同步 master 后原生运行打通（2026-11-02）**——真机（Mate 80 Pro，
API 26）上登录 lumina-code-server → frp 直连桌面 opencode → v2 桌面树主界面
（会话列表/composer）完整渲染，dev 与内嵌两种加载模式均验证可用。

该支持仍不在任何 crates.io 稳定发布里（官方 `feat/open-harmony` 分支四件
`[patch.crates-io]` + vendored openharmony-ability + DevEco 工程）。

### 2026-11-02 同步与修复记录

1. **分支同步**：master 的 103 个提交合入（v1 relay 架构遗骸随之清理，
   `mobile/src-tauri` 融合为 master 的 0.7.1 插件集 + ohos patch 块）。
   冲突矩阵：共享文件一律取 master；ohos 资产（gen/ohos、vendor）保留。
2. **插件按 target 拆分**（`Cargo.toml` 的
   `[target.'cfg(not(target_env = "ohos"))'.dependencies]` +
   `lib.rs` 的同名 cfg）：ohos 上只装 **store + opener**。tauri-plugin-log
   在 ohos 初始化即 SIGABRT（v1 二分实锤，勿加回）；os/dialog/notification
   携带未验证的 linux 路径原生依赖，直接排除出 ohos 解析图。**注意 ohos
   target 的 `target_os` 是 `"linux"`，ohos 专属 cfg 一律用
   `target_env = "ohos"`**。npm 侧对应插件的 import 全部有降级
   （invoke 失败 → catch → fallback）。
3. **capabilities 按平台拆分**：ohos 图里没有的插件，其权限也无法通过
   tauri-build 的 ACL 校验（`Permission log:default not found`）。
   `default.json` 显式列非 ohos 平台（linux/windows/macOS/android/iOS）
   + 全量权限；`ohos.json` 走 `platforms: ["openHarmony"]`（分支的 Target
   serde 序列化值，camelCase）+ 最小权限集。
4. **登录后白屏根因**：plugin-os 的 js `platform()` **同步读**
   `window.__TAURI_OS_PLUGIN_INTERNALS__`（Rust 插件 init script 注入的
   全局）——ohos 上插件缺席 → undefined.platform → 同步 throw →
   React 在 InnerApp 首渲染（useGlass → isLinux）整树崩溃。
   修复：`src/lib/platform.ts` 的 `osPlatform()` try/catch 防御，
   undefined 读作 not-macos/not-linux（ohos 语义恰好正确：ArkWeb 是
   Chromium，glass 保持开启）。
5. **v1 黑屏结论**：v1 卡点"webview 从不向 dev server 发请求"在同步后
   **不复现**——`cargo tauri ohos dev`（CLI 2.11.4）构建安装的 dev 版
   页面成功从 vite 加载（tauri://localhost 页面框架 + `@fs` 代理路径 +
   HMR 连接正常），内嵌版（`ohos build`，frontendDist 打进 HAP）同样
   渲染正常。二分证据：内嵌 HAP 有画面 → 壳层（napi 胶水/ArkWeb/插件）
   全通，v1 现象归因于当时代的 dev 流程，现已消解。
 6. **桌面应用名 "label"**：鸿蒙桌面图标下的名字取 **ability** 的
    label（entry 模块 string.json 的 `EntryAbility_label`），不是
    AppScope 的 app_name——DevEco 模板占位值 `"label"` 就这么上了桌面。
    同修 `module_desc`/`EntryAbility_desc` 占位符（应用详情会露出）。
 7. **图标 = DevEco 模板默认**：`tauri icon` 不覆盖 gen/ohos，模板的
    蓝网格 startIcon + 蓝白分层对从未被替换。仓库根
    `pnpm gen:ohos-icons`（scripts/gen-ohos-icons.mjs，需系统
    ImageMagick）从 `mobile/src-tauri/icons/icon.png`（1024 master，
    即电脑版同一设计）重生成 AppScope/entry 两套分层对 + 144px
    startIcon，产物提交（gen:icons 教义）。**当前刻意原样复用桌面
    master、零移动端处理**（专用图标设计后再在脚本里加缩放/分层）；
    background 层取 master 平均底色（分层清单引用它，系统超椭圆
    裁切露边用）。
 8. **持久化静默全丢（最严重）**：CDP 实锤——ArkWeb 的 localStorage
    为 **null**，`plugin:store|save` 报 `Operation not permitted
    (os error 1)`。根因：feat/open-harmony 的 tauri 在 ohos 上走
    `path/desktop.rs`（`path/mod.rs` 只按 android 切分，ohos 的
    target_os 是 "linux"）→ `dirs::data_dir()` XDG 推导 →
    `/storage/Users/currentUser/.local/share/<identifier>`（设备上
    不存在且不可写）。而 `load` 成功（缺文件=新 store）→ 前端
    `initPersistedState` 误判 file 档健康 → 所有写盘 fire-and-forget
    失败且无 log 插件可诉 → 每次重启登录态/设置归零。**修复桥接**
    （无需 patch tauri）：EntryAbility.onCreate 在 `super.onCreate()`
    **之前**动态 import 自己的 so，调 `set_sandbox_dirs`（lib.rs 的
    `#[napi]` 导出，napi-ohos 已是依赖）传入
    `this.context.filesDir/cacheDir`，Rust 侧 set
    `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME` 指向沙箱——
    `dirs` 每次调用重读环境变量、store 惰性解析路径，故早于 webview
    创建的一次注入即可全程生效；state 文件落在
    `<filesDir>/com.iewnfod.lumina-code-mobile/state/state.json`
    （与桌面同构）。上游修好 ohos path 后此桥接保留无害（指向同一
    沙箱目录）。ArkTS 两个坑：动态 import 的目标必须走**变量**
    （模板字符串内联会被编译器当包名解析报
    `pkgContextInfo` 错），`await import()` 结果须显式标
    `ESObject`（strict 禁 any/unknown）——写法照抄 RustAbility.ets。
 9. **壳窗口背景对齐安卓**（2026-11-02）：启动/运行时窗口背景此前是
    DevEco 模板默认（base `#FFFFFF` / dark `#000000`，启动闪白/闪黑）。
    对齐安卓 `lumina_window_bg` 的玻璃表面等效色：`resources/{base,dark}/
    element/color.json` 的 `start_window_background` → `#F0F0F0`/`#282828`
    （启动窗，资源系统自动跟系统深浅），EntryAbility 保存 mainWindow 并
    在 `onWindowStageCreate`（super 之后——`setWindowBackgroundColor`
    按 d.ts 约定须在 loadContent 生效后调用）与
    `onConfigurationUpdate`（先 super：RustAbility 把它转发给 Rust
    lifecycle，断了会切死原生侧）按 `colorMode` 重应用。ColorMode 枚举
    是 `NOT_SET=-1 / DARK=0 / LIGHT=1`（与直觉相反）；API 是同步 throws
    （BusinessError 1300002，try/catch 而非 Promise catch）——SDK 文档
    明确 phone/tablet 生效，编译器 "unavailable to phone" 警告系
    `string | ColorMetrics`（since 18）联合签名的标签误报。**已知限制**：
    安卓 `__luminaNative.setChromeBackground`（应用内主题偏好推送）在
    鸿蒙无实现途径——ArkWeb 的 javaScriptProxy 必须挂在 Web 组件上，
    而 Web 组件在 @ohos-rs/ability HAR 内部构建；壳背景跟随**系统**
    主题（前端 `useChromeThemeSync` 的 optional chaining 自动 no-op）。
    四处同步：安卓 values/values-night、MainActivity fallback、
    EntryAbility 常量、start_window_background 资源。
10. **webview 系统深色跟随（vendor tao）**（2026-11-02）：前端
    `useSystemTheme` 走 tauri 的 `window.theme()`/`onThemeChanged`（不是
    prefers-color-scheme），而 tao feat/open-harmony 的 ohos backend
    `Window::theme()` **硬编码 `Theme::Light`**、`ConfigChanged` arm 只
    转发 ScaleFactorChanged 丢弃 colorMode——系统深色永远到不了前端。
    修复：tao checkout（feat 分支 813572f）vendor 到 `mobile/vendor/tao`
    （1.4M，rsync 去 .git/examples/tests；同 openharmony-ability 的 path
    patch 先例），`[patch.crates-io]` tao 行 git → path。vendor 内**仅两处**
    LUMINA 改动（源码有 LUMINA 注释）：`theme()` 读
    `app.config().color_mode`（EventLoop 加 `last_theme: Cell` 字段），
    `ConfigChanged` arm 在真实深浅跃迁时补发 `WindowEvent::ThemeChanged`
    （语言/字号变化不重发）——tauri-runtime-wry → `tauri://theme-changed`
    → 前端 onThemeChanged 的既有映射全部复用，前端零改动。另一坑：系统
    只在**变化**时回调 `onConfigurationUpdate`，深色系统冷启动 Rust config
    停在 NoSet——EntryAbility.onCreate 末尾主动调一次
    `this.onConfigurationUpdate(this.context.config)` 种子（Rust 侧先更新
    `app.configuration` 再发事件，事件循环未就绪也只丢事件不丢值，
    `theme()` 查询兜底正确）。随 wry/tauri 分支升级时 vendor 需 re-sync
    并重放两处改动（Cargo.toml patch 注释同）。

### 调试通道（本次排查的取证利器）

EntryAbility 已开 `webview.WebviewController.setWebDebuggingAccess(true)`
（v1 时代 9222 不出现；**现在可用**——dev 与内嵌构建都行）：

```bash
PID=$(hdc shell pidof com.iewnfod.lumina_code_mobile | tr -d '\r\n ')
hdc fport tcp:9222 localabstract:webview_devtools_remote_$PID
curl -s http://127.0.0.1:9222/json/list   # 拿 webSocketDebuggerUrl
```

之后用任何 CDP 客户端连 `ws://127.0.0.1:9222/devtools/page/<id>`：
`Runtime.evaluate` 直接在 webview 里跑诊断（表单状态/fetch 连通性探测），
`Runtime.exceptionThrown` 抓 React 崩溃堆栈（本次白屏根因就是这么抓到的
——hilog 里看不到前端异常，因为 app 代码不走 console）。

### 工具链（一次性安装，v1 实测踩坑记录，仍然适用）

```bash
# 1. ohos rust targets
rustup target add aarch64-unknown-linux-ohos x86_64-unknown-linux-ohos

# 2. feat/open-harmony 分支的 tauri-cli（npm 的 @tauri-apps/cli 无 ohos 子命令）
cargo install tauri-cli --git https://github.com/tauri-apps/tauri --branch feat/open-harmony

# 3. ohrs（ohos-rs 构建工具，tauri 的 ohos 构建通过它驱动交叉编译）
cargo install ohrs

# 4. 系统级符号链接（需要 sudo，两条都是 cargo-mobile2 的路径推导所必需）：
#    a) OHOS_HOME 需要带 API 版本层（openharmony/26），DevEco 平铺布局没有
sudo ln -sfn /opt/devecostudio/sdk/default/openharmony /opt/devecostudio/sdk/default/openharmony/26
#    b) ohpm 的计算路径固定为 <DEVECO_SDK_HOME>/ohpm/bin/ohpm
sudo ln -sfn /opt/devecostudio/tools/ohpm /opt/devecostudio/sdk/ohpm
```

每次构建/运行所需的环境变量（可放进 shell rc）：

```bash
export OHOS_HOME=/opt/devecostudio/sdk/default/openharmony/26
export PATH="/opt/devecostudio/tools/bin:/opt/devecostudio/tools/node/bin:$PATH"
```

历史坑（v1 实测，构建异常时先对照这里）：

- **真机安装必须签名**：`ohos build --debug` 产出的 unsigned HAP 零售真机
  拒收（`code:9568320`）。用 DevEco 打开 `gen/ohos` → Project Structure →
  Signing Configs 勾自动签名（一次性，本机已配好）；之后 CLI 构建都带签名。
  诡异报错先 `hvigorw --stop-daemon` 清守护进程缓存。
- **版本必须钉死**：`Cargo.toml` 的 tauri `=2.11.5`（feat/open-harmony 分支
  的发布版本，2026-11-02 复核）+ `[patch.crates-io]` 四件 + `wry = "=0.56.0"`
  直接依赖把解析钉在 patch 版本上——`^` 语义会被 crates.io 新版绕过 patch
  （实测两次：wry 0.56.1 使 ohos 编译拉 webkit2gtk 全家桶死在 pkg-config）。
- **openharmony-ability 需要 vendor**：分支 wry 依赖 harmony-contrib 的
  openharmony-ability（git-only），其 HEAD 已删 `webview` feature，cargo 拒
  同源 patch——rev `295a276a`（v0.3.0）vendor 在 `mobile/vendor/`，path
  patch 进图。随 wry 分支一起更新。**tao 同样 vendor**（见上 device
  fix 10：ohos 主题支持是 stub，两处 LUMINA 补丁），`[patch.crates-io]`
  的 tao 行指向 `../vendor/tao`。
- **`beforeBuildCommand` 在仓库根执行**（不是 src-tauri 目录）。
- **API 26+ 的版本串是 `"26.0.0"`**（API 10-25 才用 `"5.0.0(12)"` 形式）。
- **hvigor 守护进程缓存环境变量**：改过 DEVECO_SDK_HOME/OHOS_HOME 后旧
  守护进程一直报 "Invalid value of 'DEVECO_SDK_HOME'"——stop-daemon 重试。
- 上游把 ohos 合进正式 release 时：删 `[patch.crates-io]` 块和 wry 钉死
  依赖，`=` 松绑到该 release，npm CLI 换回稳定版，清理两条 sudo 符号链接。

### 已知残留

- dev 构建偶尔抛 `Cannot read properties of undefined (reading
  'runCallback')`（vite/react-refresh HMR runtime 的 teardown 噪音，无害，
  仅 dev 模式）。
- ohos 上 os/dialog/notification 插件缺席的降级影响：登录设备标签退化为
  裸 "mobile"（无 hostname）；附件选择器与系统通知不可用。若要恢复，
  在 Cargo.toml 的 ohos target 段逐个加回 + `ohos.json` 补权限 +
  真机验证（log 永远不加）。
- 构建命令：`cargo tauri ohos build --debug` / `cargo tauri ohos dev`（需
  上面的 OHOS_HOME 环境变量；裸跑 `cargo check --target
  aarch64-unknown-linux-ohos` 还需要 `OHOS_NDK_HOME=$OHOS_HOME/native`）。
