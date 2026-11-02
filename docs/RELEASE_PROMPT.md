# 任务：为 Lumina Code 生成 Release Note

从 git tag `<上一个 tag>`（例如 v0.7.1）到当前 HEAD 生成一份 GitHub Release Note，遵循项目既定的标准格式（完整样例见文末，v0.8.0 的实际输出）。

## 步骤

1. 运行以下命令收集信息：
    - `git tag --sort=-creatordate` — 确认所有 tag，检查区间内是否存在中间 tag
    - `git log <上一个 tag>..HEAD --format="%h %s (%an)" --no-decorate` — 获取 commit 列表
    - `gh release view <上一个 tag> --json assets --jq '.assets[].name'` — 确认 release 资产的实际命名规则（Downloads 表格链接由此推出）
    - 对语义不清晰的 commit，用 `git show <hash> --stat --format="%B"` 查看改动范围和详情
    - 对重大特性，可查看关键文件了解功能实际行为
2. 如果区间内有未发布的中间 tag（如测试版本），需特别处理：跳过该 tag 本身，但要说明跳过的原因
3. 分类所有 commit，并过滤噪音：
    - **跳过**：版本号 commit（`update: vX.Y.Z`）、纯 merge commit、测试性 docs
    - **归入分类**：其余按功能、修复、杂项归类
4. 将同一领域的多个 commit 合并为一条 bullet（例如同一功能的多个 fix 合并成一条，设备适配类小修并入主特性条目）
5. 区分贡献者：主仓库提交不需要署名；PR 合并的提交在条目末尾标注 `(by @GitHub用户名)`

## 风格规则（核心）

- **极简**：每个 bullet 一句话概括"现在能做什么 / 修了什么"，不说废话。
- 不写实现细节、内部机制、验证设备、along-the-way 的小修清单。
- 不解释为什么改，只说行为变化。
- 技术名词（工具名、定界符、快捷键）保留原文。
- 输出**英文**。

## 输出格式

无总标题（GitHub release 标题即版本号），四个 section 依序排列，结尾 Full Changelog：

```
### ✨ Features
- **加粗的功能名** — 一句话说明现在能做什么

### 🐛 Bug Fixes
- 一句话说明修了什么问题（可带一句影响场景）

### 🔧 Chores
- 一句话说明构建/CI/流程变更

### 📦 Downloads
（表格，见下）

**Full Changelog**: https://github.com/iewnfod/lumina-code/compare/v<prev>...v<next>
```

### Downloads 表格

按操作系统一行，格式 `| Operating System | Downloads |`，每种产物一个 markdown 链接（链接文字如 `.deb amd64`），包管理器行内嵌包名链接：

| Operating System | Downloads |
|---|---|
| **Linux** (webkit) | .deb amd64/arm64 · .rpm x86_64/aarch64 · AppImage amd64/aarch64 · AUR `lumina-code-bin` · COPR `lumina-code` |
| **Linux** (CEF) | .deb amd64/arm64 · .rpm x86_64/aarch64 · AUR `lumina-code-cef-bin` · COPR `lumina-code-cef`（无 AppImage） |
| **Windows** x64 | Setup .exe · .msi |
| **macOS** | Apple Silicon .dmg · Intel .dmg |
| **Android** (arm64) | .apk |
| **HarmonyOS** (arm64) | .hap |

- 下载链接指向 `https://github.com/iewnfod/lumina-code/releases/download/v<ver>/<asset>`。
- 资产名按上一个 release 的实际命名推出：`.deb`/`.AppImage`/`.apk`/`.hap` 用下划线（`Lumina.Code_<ver>_…`），`.rpm` 用连字符（`Lumina.Code-<ver>-1.…`），CEF 变体前缀 `Lumina.Code.CEF`。
- 表格后固定两条注脚（blockquote）：

  > The mobile versions require self deployed server to connect to your desktop.

  > HarmonyOS version needs to sign manually before install.

- 不再写长篇 CEF 变体说明段：CEF 已是表格里独立一行，由用户自选，无需重复渲染引擎/实验性等背景。

## 特殊场景

- **版本号不确定**：从 commit 历史推断下一个版本号（遵循 semver：新特性 → minor，纯修复 → patch）
- **区间包含跳过的 tag**（如测试版 v0.1.3）：在标题下加一行斜体说明 `*vX.Y.Z was an internal test build and has been skipped.*`
- **无新 commit**：明确回复"区间内没有新提交"

## 样例

v0.8.0 的实际输出（链接为该版本真实资产）：

```markdown
### ✨ Features

- **HarmonyOS support (experimental)** — The full desktop UI now runs natively on HarmonyOS (API 26).
- **Read PDF documents** — `read_document` now accepts `.pdf`, extracting text to markdown via an inlined pdf.js engine.
- **Math rendering in markdown** — `$…$` / `$$…$$` (plus `\(...\)` / `\[...\]`) render through KaTeX.
- **Folder icons** — Directory listings now show Material folder icons.

### 🐛 Bug Fixes

- Fixed the sidebar "new session" button not switching back to the staged directory, which could land the next session in the previous project's folder.
- Fixed the daily-mode agent picker listing developer agents; it now offers only the daily assistant.

### 🔧 Chores

- Added the HarmonyOS release workflow as a separate pipeline, isolated so the ohos toolchain can never block a release.
- Removed dead v1 relay/sync code.

### 📦 Downloads

| Operating System | Downloads |
|---|---|
| **Linux** (webkit) | [.deb amd64](…) · [.deb arm64](…) · [.rpm x86_64](…) · [.rpm aarch64](…) · [AppImage amd64](…) · [AppImage aarch64](…) · AUR [`lumina-code-bin`](https://aur.archlinux.org/packages/lumina-code-bin) · COPR [`lumina-code`](https://copr.fedorainfracloud.org/coprs/iewnfod/lumina-code/package/lumina-code) |
| **Linux** (CEF) | [.deb amd64](…) · [.deb arm64](…) · [.rpm x86_64](…) · [.rpm aarch64](…) · AUR [`lumina-code-cef-bin`](https://aur.archlinux.org/packages/lumina-code-cef-bin) · COPR [`lumina-code-cef`](https://copr.fedorainfracloud.org/coprs/iewnfod/lumina-code/package/lumina-code-cef) |
| **Windows** x64 | [Setup .exe](…) · [.msi](…) |
| **macOS** | [Apple Silicon .dmg](…) · [Intel .dmg](…) |
| **Android** (arm64) | [.apk](…) |
| **HarmonyOS** (arm64) | [.hap](…) |

> The mobile versions require self deployed server to connect to your desktop.

> HarmonyOS version needs to sign manually before install.

**Full Changelog**: https://github.com/iewnfod/lumina-code/compare/v0.7.1...v0.8.0
```
