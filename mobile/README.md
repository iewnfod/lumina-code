# Lumina Code Mobile

Lumina Code 的移动客户端：连接自部署的 lumina-server，浏览桌面端镜像上来的
会话与工作区动态，并向已有会话转发 prompt（agent 始终跑在桌面）。当前主线
是 **iOS / Android（Tauri 2 stable）**；HarmonyOS 的第一次尝试封存在
`feat/mobile-ohos` 分支（见文末）。

- 前端：仓库根 package 的**第二 vite 入口**（`mobile/index.html` →
  `src/mobile/`），复用桌面端的 transcript 渲染组件与设计 tokens。
- 壳：`mobile/src-tauri`，**纯 crates.io 稳定依赖**（`tauri = "2"`，无任何
  git patch / vendored crate —— 与 webkit 桌面壳同一条版本线）。
- 本目录不含前端代码；`src/mobile/` 在仓库根的 src 下。

## 应用内是什么

- **登录**（LoginScreen）：lumina-server 地址 + 用户名/密码 → 设备 token
  持久化（`src/mobile/connection.ts`，createPersistedStore）。
- **会话列表**（SessionListScreen）：`GET /api/sync/sessions` 镜像列表 +
  手动刷新。
- **会话页**（SessionScreen）：只读 transcript（桌面 `TranscriptList` 整链
  复用）+ 3s 轮询快照 + 工作区活动面板（计划 todos / 后台终端 / 子代理 +
  镜像 diff，`activity.ts` 纯推导与桌面统计卡同源）+ ComposerBar 转发
  prompt（`POST /api/relay/prompt`，at-least-once，桌面端
  `useServerRelay` 消费注入）。
- **kv shim**（`src/mobile/kv.ts`）：webview localStorage 不可用时从 Rust
  侧 kv_load 水合 + write-behind（iOS/Android 上 localStorage 可用，探测
  通过即 no-op —— 命令保留，无害）。

## 构建与运行

```bash
# Web 端开发（浏览器里调 UI，连真实 lumina-server；桌面 dev 用 1420 不冲突）
pnpm dev:mobile          # http://localhost:1421

# 前端产物（CI 校验同一命令）
pnpm build:mobile        # → dist-mobile/

# Rust 壳类型检查（host，无需任何 SDK；先 build:mobile 出 dist 占位）
cargo check --manifest-path mobile/src-tauri/Cargo.toml
```

### Android

前置（一次性）：

1. Android Studio（SDK Manager 里装好 platform + build-tools）；
2. **NDK (Side by side)** —— Rust 交叉编译必需；
3. **Android SDK Command-line Tools**（tauri CLI 探测/补装组件用）；
4. Rust target：`rustup target add aarch64-linux-android
   armv7-linux-androideabi i686-linux-android x86_64-linux-android`；
5. 环境变量（shell rc）：`ANDROID_HOME=$HOME/Android/Sdk`（NDK 会自动取
   `ndk/` 下最新版，或显式 `NDK_HOME=$ANDROID_HOME/ndk/<ver>`）。

```bash
cd mobile/src-tauri
cargo tauri android init     # 生成 gen/android（工程源需提交）
cargo tauri android dev      # 模拟器/真机热载开发
cargo tauri android build --debug   # APK
cargo tauri android build    # AAB（发布，需签名配置）
```

日志：`adb logcat`（tauri-plugin-log 的 Stdout target 在 Android 上被
插件自动路由到 logcat）。

### iOS（需要 macOS）

本仓库在 Linux 上只能做到 `cargo check --target aarch64-apple-ios` 的
早期阶段（cc-rs 需要 `xcrun` 即 Xcode 工具链，构建必须 macOS）。在 Mac
上：装 Xcode + `rustup target add aarch64-apple-ios`，然后

```bash
cd mobile/src-tauri
cargo tauri ios init         # 生成 gen/ios（工程源需提交）
cargo tauri ios dev          # 模拟器
cargo tauri ios build        # 需签名
```

## 已知边界

- **`beforeBuildCommand` 在仓库根执行**（不是 src-tauri 目录），所以直接写
  `pnpm run build:mobile`。
- **`app.windows` 必须有一个 `main` 条目**：tauri 的 `setup()` 只按
  conf 的 windows 列表创建 webview，移动端也没有隐式兜底 —— 空列表
  （从 ohos 分支 conf 继承的写法）表现为**白屏但进程存活、logcat 无
  chromium 输出、Rust 无日志**（live-observed 2026-10-17，模拟器取证）。
  width/height 在移动端被忽略，webview 铺满 activity。
- **版本对齐是 `=` 精确钉死**：tauri CLI 在移动构建时强制 crate↔npm 的
  major/minor 一致，而 package.json 与桌面壳共享 —— 所以 Cargo.toml 里
  tauri/插件全部 `=` 钉到桌面 lock 的版本（caret 表达不了"留在 2.11"：
  `^2.11` 意为 `<3.0.0`，新解析会跳最新 minor 触发 CLI 拒绝，实测
  `^2.11` → tauri 2.12.4 vs npm api 2.11.1）。**同理，删 Cargo.lock 后
  重新解析会把 tauri 子树解到互不兼容的最新组合**（tauri 2.11.6 +
  tauri-runtime 2.12 编译失败）——恢复方法：`cp src-tauri/Cargo.lock
  mobile/src-tauri/Cargo.lock && cargo check`，以桌面 lock 为起点最小
  增删（实测有效，子树回到 2.11.3/2.11.4/0.55.1/0.35.3）。升级时与
  package.json、桌面 lock 三方一起动。
- 移动端不内嵌 OpenCode：没有 sidecar、没有本地文件访问 —— 数据全部来自
  lumina-server 的镜像/relay API（模型密钥、git 仓库、代码文件都在桌面）。
- 桌面 `pnpm build` 的 tsc 严格检查覆盖 `src/mobile/`（tsconfig include
  是整个 `src`）；`pnpm test` 的 glob 同样收录 `src/mobile/*.test.ts`。

---

## HarmonyOS（封存，未完成）

> 状态：**WIP 已暂停（2026-10-06）**，现场完整保留在 `feat/mobile-ohos`
> 分支。当时方案：官方 `feat/open-harmony` 分支的 tauri/wry/tao/tauri-build
> 四件 `[patch.crates-io]`（基于 tauri =2.11.5 / wry 0.56.0）+ vendored
> `openharmony-ability`（rev 295a276a）+ DevEco 工程（gen/ohos）。**该支持
> 至今不在任何 crates.io 稳定发布里**（stable 线 2.12.x，3.0 仍 alpha），
> 所以本分支的移动壳不含这些 patch —— 恢复鸿蒙时从该分支找回。

当时的进度与坑（详见该分支 `mobile/README.md`，均已实测）：

- 跑通：工具链（分支 CLI/ohrs/SDK 符号链接）→ Rust 交叉编译 → 签名 HAP →
  安装 → napi 胶衣（**`mobile` cfg 是关键坑**：tauri-build 必须 patch 到
  分支，否则 `#[ability]` 不生成，.so 无 init/render → 白屏）→ ArkWeb 引擎
  初始化 → webview 存活。
- **卡点：真机黑屏** —— webview 已创建但从不向 dev server 发请求。排查
  方向：① CLI dev 流程的 config overlay 疑似没传进 rust 构建（.so 内嵌
  localhost:1421 而非 LAN IP）——把 `tauri.conf.json` 的 devUrl 硬编码为
  LAN IP 重装验证；② `setWebDebuggingAccess(true)` 加了但 9222 socket 未
  出现。
- **tauri-plugin-log 在 ohos 上初始化即 SIGABRT**（二分定位；勿加回 ——
  桌面共享代码需要日志时走 hilog 或条件编译。注意本分支的 lib.rs 在
  iOS/Android 上注册了该插件，恢复鸿蒙时需 cfg 掉）。
- 其余：版本必须 `=` 钉死否则 crates.io 新版绕过 patch；真机安装必须
  DevEco 自动签名；API 26+ 版本串是 `"26.0.0"`；ArkWeb 的 localStorage
  为 null（kv shim 的由来）；ohos 无 home_dir。

上游把 ohos 合进正式 release 后：从 `feat/mobile-ohos` 找回 gen/ohos 与
签名配置，删除该分支 Cargo.toml 的 patch 块与 vendor，`tauri = "2"` 松绑
到该 release 即可收敛为同一份壳。
