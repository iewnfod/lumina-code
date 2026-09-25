<p align="center">
  <a href="./src/assets/Code%20Icon.svg">
    <img src="./src/assets/Code%20Icon.svg" width="120" height="120" alt="logo">
  </a>
  <h3 align="center">Lumina Code</h3>
</p>
<p align="center">
  <a href="./README_zh.md">简体中文</a> | <a href="./README.md">English</a>
</p>

基于 Tauri 与 React 构建的 [OpenCode](https://opencode.ai/v2/docs/) 跨平台桌面图形客户端。应用内置指定版本的 OpenCode 服务器，并在界面背后管理其完整生命周期 —— 安装即用，无需配置 CLI；同时与你已有的 `opencode` 共享配置、凭证与会话。

## 安装

* Arch Linux（使用 AUR 助手，如 `paru` 或 `yay`）：
```shell
paru -S lumina-code-bin
# 或：yay -S lumina-code-bin
```
* Fedora（通过 COPR）：
```shell
dnf copr enable iewnfod/lumina-code
dnf install lumina-code
```
* 其他平台 —— 从 [releases](https://github.com/iewnfod/lumina-code/releases) 下载安装包：
  * Linux：`.deb`、`.rpm` 与 AppImage（x86_64 与 arm64）
  * Windows：NSIS 安装器（x64）
  * macOS：`.dmg`（Apple silicon 与 Intel）

## 功能

### 对话
* 流式转录视图：推理过程可折叠，连续的工具调用自动收纳
* 每个工具调用都是一张卡片 —— Shell、带内联 git diff 的文件编辑（含多文件补丁）、读取、grep、网页抓取/搜索、子代理……
* 每轮任务显示耗时脚注；用量环展示上下文窗口占比、token 明细、缓存命中率与费用

### 先规划后构建
* 让它先做方案：助手会自行切换到规划模式，并提交计划等待批准 —— 批准卡片固定在输入框上方
* 批准后将同一会话移交构建模式；驳回则退回修改
* 批准后的任务清单实时跟踪进度（待办 / 进行中 / 已完成 / 受阻），计划本身以 markdown 归档到项目的 `.lumina/plans/` 下

### 会话与项目
* 侧栏按项目目录分组，带忙碌指示、待答复角标与相对时间
* 发送第一条消息前即可选择工作目录；输入框草稿、模型与模式在会话切换间保留
* 会话存放在共享的 OpenCode 存储中，CLI 里开始的对话在这里也能看到

### 输入框
* `@` 文件提及与 `/` 命令（包括你自己定义的 OpenCode 命令），带自动补全
* 纯文本模型也能处理图片附件 —— 图片会经由你配置的视觉模型代为识别
* 覆盖全部已配置提供商及变体的模型选择器、思考深度调节、构建/规划模式切换

### 全程可控
* 敏感操作弹出权限卡片 —— Shell 命令、文件编辑、网络访问、项目外目录 —— 可选仅此一次 / 始终允许 / 拒绝
* 服务端提问渲染为可填写的表单；随时可以中止正在运行的一轮任务

### 工作区活动面板
* 对话旁侧的单一面板：计划进度、项目工作区 git diff（可下钻到单文件差异）、带实时输出的后台终端，以及可查看流式转录的子代理

### 模型与偏好
* 通过 API key 或浏览器 OAuth 接入提供商；添加自定义 OpenCode 兼容提供商；隐藏不用的模型
* English / 简体中文 跟随系统，明暗双主题，界面字体与代码字体可分别自定义字号

## 内置的 OpenCode 服务器

Lumina Code 将指定版本的 OpenCode 服务器二进制（当前为 v2.0.11）作为 sidecar 打包，并负责其生命周期 —— 启动、鉴权、事件流与关闭。这与 OpenCode 官方桌面应用的形态一致：`~/.config/opencode` 与 `~/.local/share/opencode` 下的配置、凭证和会话与你自用的 opencode 完全共享，只有二进制版本受应用控制。内置服务器的自动更新已禁用 —— 升级通过重新钉扎版本并发布应用更新完成。

应用还会在全局 `opencode.json` 中安装一个轻量的 `lumina-tools` 插件 —— 它提供常驻的规划模式工具与可配置的识图工具。

## 开发

```sh
pnpm install
pnpm fetch:opencode   # 下载钉扎版本的 OpenCode 服务器 sidecar（约 200 MB，每次版本更新下载一次）
pnpm tauri dev
```

| 用途 | 命令 |
| --- | --- |
| 运行应用 | `pnpm tauri dev` |
| 类型检查 + 构建前端 | `pnpm build` |
| 单元测试（纯前端逻辑） | `pnpm test` |
| 发布打包 | `pnpm tauri build` |
| 后端检查 | `cargo check --manifest-path src-tauri/Cargo.toml` |
| 重新生成文件类型图标 | `pnpm gen:icons` |

* `pnpm fetch:opencode` 是 `tauri dev` / `tauri build` 的**前置条件**：Tauri 的 `externalBin`（`src-tauri/binaries/opencode`）必须存在，否则打包失败。
* 让开发环境指向其他服务器二进制：`OPENCODE_BIN=/path/to/opencode pnpm tauri dev`。
* 服务器版本钉扎在三处，必须一同变更：`scripts/fetch-opencode.mjs` 的 `OPENCODE_VERSION`、`src-tauri/src/opencode/mod.rs` 的 `EXPECTED_OPENCODE_VERSION`、以及 `package.json` 中精确钉扎的 `@opencode-ai/sdk`。
* 完整架构指南见 [AGENTS.md](./AGENTS.md)。

## 推荐的 IDE 配置

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## 许可证

[MPL-2.0](./LICENSE)
