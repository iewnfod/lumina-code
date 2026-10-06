# Lumina Code Mobile

> **⚠️ WIP — 已暂停（2026-10-06）**：移动端暂不是主线，此分支封存现场。
> 硬件/环境：Mate 80 Pro 真机（API 26，已签名安装）。**卡在最后一步：真机黑屏**。
>
> 已跑通：完整工具链（分支 CLI/ohrs/SDK 链接）→ Rust 交叉编译 → 签名 HAP →
> 安装 → 启动 → napi 胶衣（`mobile` cfg 是关键坑：tauri-build 必须 patch 到
> 分支，否则 `#[ability]` 不生成，.so 无 init/render → 白屏）→ ArkWeb 引擎
> 初始化 → webview 存活（进程稳定，chromium 日志正常）。
>
> 卡点：webview 已创建但**从未向 dev server 发起请求**（vite 日志无手机 IP），
> 页面不加载 → 纯黑。已排除：网络层（手机可 ping 通桌面且 ufw 已放行）、
> JS 崩溃（错误浮层已装，无输出）、kv 水合挂起（已加 3s 超时）。
>
> 下次续作的排查方向：
> 1. **devUrl 疑点**：怀疑 CLI dev 流程的 config overlay 没有传进 rust 构建
>    （.so 内嵌的可能是 localhost:1421 而非 LAN IP → 手机连自己 → 黑屏）。
>    验证方法：把 `tauri.conf.json` 的 devUrl 硬编码为 LAN IP 重装（试过一次
>    但被中断未验证完）；或从 .so 里解出内嵌 URL。
> 2. `setWebDebuggingAccess(true)` 已加进 EntryAbility 但 9222 socket 未出现，
>    可研究 HAR 的 webview controller 路径。
> 3. tauri-plugin-log 在 ohos 上初始化即 SIGABRT（已二分定位，**勿加回**），
>    桌面共享代码若需要日志，走 hilog 或条件编译。

Lumina Code 的移动客户端（鸿蒙优先）：连接自部署的 lumina-server，浏览桌面端
镜像上来的会话与工作区动态，并向已有会话转发 prompt（agent 始终跑在桌面）。

- 前端：仓库根 package 的**第二 vite 入口**（`mobile/index.html` →
  `src/mobile/`），复用桌面端的 transcript 渲染组件与设计 tokens。
- 壳：`mobile/src-tauri`，Tauri `feat/open-harmony` 分支（patch 见下）。
- 本目录不含前端代码；`src/mobile/` 在仓库根的 src 下。

## 工具链（一次性安装，全部实测验证）

```bash
# 1. ohos rust targets
rustup target add aarch64-unknown-linux-ohos x86_64-unknown-linux-ohos

# 2. feat/open-harmony 分支的 tauri-cli（npm 的 @tauri-apps/cli 无 ohos 子命令）
cargo install tauri-cli --git https://github.com/tauri-apps/tauri --branch feat/open-harmony

# 3. ohrs（ohos-rs 构建工具，tauri 的 ohos 构建通过它驱动交叉编译）
cargo install ohrs

# 4. 系统级符号链接（需要 sudo，两条都是 cargo-mobile2 的路径推导所必需）：
#    a) OHOS_HOME 需要带 API 版本层（openharmony/26），DevEco 平铺布局没有——
#       在 SDK 目录内补一个指向自身的版本符号链接
sudo ln -sfn /opt/devecostudio/sdk/default/openharmony /opt/devecostudio/sdk/default/openharmony/26
#    b) ohpm 的计算路径固定为 <DEVECO_SDK_HOME>/ohpm/bin/ohpm（duct 对相对路径
#       程序名不做 PATH 查找，回退路径结构性失效）——把 DevEco 的 ohpm 链过去
sudo ln -sfn /opt/devecostudio/tools/ohpm /opt/devecostudio/sdk/ohpm
```

每次构建/运行所需的环境变量（可放进 shell rc）：

```bash
export OHOS_HOME=/opt/devecostudio/sdk/default/openharmony/26
export PATH="/opt/devecostudio/tools/bin:/opt/devecostudio/tools/node/bin:$PATH"
```

## 构建与运行

```bash
# Web 端开发（浏览器里调 UI，连真实 lumina-server）
pnpm dev:mobile          # http://localhost:1421

# 鸿蒙构建（Rust 交叉编译 + HAP 组装）
cd mobile/src-tauri && cargo tauri ohos build --debug
# 产物：gen/ohos/entry/build/default/outputs/default/entry-default-unsigned.hap

# 真机运行（hdc 连接设备后）
cd mobile/src-tauri && cargo tauri ohos dev
```

## 已知坑（全部实测踩过）

- **真机安装必须签名**：`cargo tauri ohos build --debug` 产出的是
  `entry-default-unsigned.hap`，模拟器能装，**零售真机会拒绝**
  （`code:9568320 no signature file`）。解决：用 DevEco Studio 打开
  `mobile/src-tauri/gen/ohos`，File → Project Structure → Signing
  Configs 勾选 "Automatically generate signature" 并登录华为开发者
  账号（一次性）；之后 CLI 构建/`ohos dev` 都会带签名。改过签名
  配置后如遇诡异报错，`hvigorw --stop-daemon` 清守护进程缓存。
- **版本必须钉死**：`mobile/src-tauri/Cargo.toml` 里 tauri 是 `=2.11.5`，并把
  tauri/wry/tao 三件 `[patch.crates-io]` 到 `feat/open-harmony` 分支。
  `^` 语义会被 crates.io 更新的版本绕过 patch——实测坑到两次：crates.io 出了
  wry 0.56.1 导致 wry patch 失效（表现为 ohos 编译去拉 webkit2gtk 的 gtk 全家
  桶然后死在 pkg-config/glib），所以还有一条 `wry = "=0.56.0"` 的直接依赖把解
  析钉在 patch 版本上。该 patch 只作用于 mobile 自己的 workspace，
  webkit/CEF 两个 shell 不受影响。
- **openharmony-ability 需要 vendor**：分支 wry 依赖 harmony-contrib 的
  openharmony-ability（git-only），其 HEAD 已删掉 `webview` feature，且 cargo
  拒绝同源 patch——按 wry 分支自己的 Cargo.lock 把 rev `295a276a`（v0.3.0）
  vendor 到 `mobile/vendor/openharmony-ability`，path patch 进图。随 wry 分支
  一起更新。
- **beforeBuildCommand 在仓库根执行**（不是 src-tauri 目录），所以直接写
  `pnpm run build:mobile`。
- **hvigor 守护进程缓存环境变量**：改过 DEVECO_SDK_HOME/OHOS_HOME 后旧守护
  进程会一直报 "Invalid value of 'DEVECO_SDK_HOME'"——`hvigorw --stop-daemon`
  后重试。
- **API 26+ 的版本串格式是 `"26.0.0"`**（不是 `"6.0.0(26)"` 也不是 `"26"`；
  API 10-25 才用 `"5.0.0(12)"` 形式）。gen/ohos/build-profile.json5 已按
  本机 SDK（API 26）配置。
- **ArkWeb 的 localStorage 为 null**（tauri:// 自定义 scheme 下）：`src/mobile/kv.ts`
  在 app bundle import 之前装内存 shim（Rust 侧 kv_load/kv_set 落盘到 app 数据目录）。
- **ohos 无 home_dir**：日志插件只配 Stdout target（hdc hilog 可见）。

## 分支合入主线后

上游把 ohos 合进正式 release 时：删除 Cargo.toml 的 `[patch.crates-io]` 块和
wry 直接钉死依赖，把 `=2.11.5` 松绑到该 release，npm CLI 换回稳定版，并清理
上面两条 sudo 符号链接即可。
