# Lumina Code Mobile

Lumina Code 的移动客户端（v2 —— **桌面树接管 + lumina-server 隧道**）：手机上跑
的就是桌面 App 的完整 UI 树，opencode API 流量经自部署的 lumina-server 隧道
到达桌面端。手机只需可达 server（公网/内网均可），获得 100% 功能——实时 SSE
流式输出、全功能 composer、模型切换、设置。

```
手机 App（桌面 UI 树）
  ↕ HTTPS（Bearer = lumina 设备 token）
lumina-server  /api/tunnel/opencode/**（透传代理 + SSE fan-out）
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
  见下）；插件 log/opener/os/dialog/notification；kv_load/kv_set 命令。
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

# iOS：需 macOS（Linux 上 cc-rs 过不了 xcrun）；cargo tauri ios init/build
```

### Android 工具链（一次性）

Android Studio（platform + build-tools）+ NDK (side by side) + cmdline-tools +
`rustup target add aarch64-linux-android armv7-linux-androideabi
i686-linux-android x86_64-linux-android`；环境变量 `ANDROID_HOME=$HOME/Android/Sdk`
（NDK 自动取 `ndk/` 最新，或显式 `NDK_HOME`）。日志：`adb logcat`。

### E2E 冒烟（无需跑桌面 App）

```bash
# 1. 起 lumina-server + sidecar
LUMINA_DATA_DIR=/tmp/e2e pnpm --filter lumina-server dev
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

## 待打磨（已知，不阻塞）

- composer 工具栏窄屏三行堆叠的间距/收缩。
- 状态栏配色未跟随 app 主题。
- 隧道无事件 replay buffer（重连靠 re-seed 自愈）；无多桌面仲裁（顶替制）。

---

## HarmonyOS（封存，未完成）

状态：**WIP 已暂停（2026-10-06）**，现场完整保留在 `feat/mobile-ohos` 分支
（官方 `feat/open-harmony` 分支四件 `[patch.crates-io]` + vendored
openharmony-ability + DevEco 工程，卡在真机黑屏——webview 已创建但不向 dev
server 发请求；排查方向与全部工具链坑见该分支 `mobile/README.md`）。该支持
至今不在任何 crates.io 稳定发布里。恢复时注意：本分支 lib.rs 注册了
tauri-plugin-log（iOS/Android 正常），ohos 上它初始化即 SIGABRT，需 cfg 掉。
