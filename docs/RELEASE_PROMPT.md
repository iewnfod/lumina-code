# 任务：为 Lumina Code 生成 Release Note

从 git tag `<上一个 tag>`（例如 v0.1.0）到当前 HEAD 生成一份 GitHub Release Note，遵循项目既定的标准格式。

## 步骤

1. 运行以下命令收集信息：
    - `git tag --sort=-creatordate` — 确认所有 tag，检查区间内是否存在中间 tag
    - `git log <上一个 tag>..HEAD --format="%h %s (%an)" --no-decorate` — 获取 commit 列表
    - 对语义不清晰的 commit，用 `git show <hash> --stat --format="%B"` 查看改动范围和详情
    - 对重大特性，可查看关键文件了解功能实际行为
2. 如果区间内有未发布的中间 tag（如测试版本），需特别处理：跳过该 tag 本身，但要说明跳过的原因
3. 分类所有 commit，并过滤噪音：
    - **跳过**：版本号 commit（`update: vX.Y.Z`）、纯 merge commit、测试性 docs
    - **归入分类**：其余按功能、修复、性能、样式、杂项、文档归类
4. 将同一领域的多个 commit 合并为一条 bullet（例如同一功能的多个 fix 合并成一条）
5. 区分贡献者：主仓库提交不需要署名；PR 合并的提交在条目末尾标注 `(by @GitHub用户名)`

## 输出格式
```
### ✨ Features
- **加粗的功能名** — 详细说明，包含实际使用场景和关键细节

### ⚡ Performance
- 性能改进的具体数据或场景

### 🐛 Bug Fixes
- 修复内容及影响场景

### 🎨 Polish
- UI 样式和交互细节优化

### 🔧 Chores
- CI、构建、发布流程变更

**Full Changelog**: https://github.com/iewnfod/lumina-code/compare/${上个版本号}...${新的版本号}
```

## 写作规则

- 输出**英文**
- 每个 bullet 的第一句是完整句子，说明"改了什么、对用户意味着什么"
- 不逐条翻译 commit message，要按用户价值重组
- 修复类条目说明"之前的问题是什么"，特性类条目说明"现在能做什么"
- 技术细节（协议名、命令名、快捷键）保留原文，如 `Ctrl+Shift+F`、`~/.ssh/config`
- 每条 bullet 不宜超过 3 行

## 特殊场景

- **版本号不确定**：从 commit 历史推断下一个版本号（遵循 semver：新特性 → minor，纯修复 → patch）
- **区间包含跳过的 tag**（如测试版 v0.1.3）：在标题下加一行斜体说明 `*vX.Y.Z was an internal test build and has been skipped.*`
- **无新 commit**：明确回复"区间内没有新提交"

## 样例
一份合格的 Release Note 样例如下：
```markdown
### ✨ Features

- **Plan workflow with approval gate** — Sessions can now run a structured plan → approve → execute loop: the plan agent submits {title, plan, todos} via plan_submit, an approval card pins above the composer (approve = switch to build + save the plan document under .lumina/plans/, reject = interrupt for revision), and execution reports progress through task_complete with strict next-task validation
- **Vision tool (识图)** — When the selected model lacks image input, attached images are diverted to disk and a text-only model can ask a configured vision model about them through a transient helper session — no more failed sends on vision-incapable models
- **Workspace stats panel** — A stats card now sits beside the conversation as a real flex sibling: plan progress checklist, working-copy diff with inline git-diff drill-down, background terminals with live output, and subagent transcripts — all keyed by directory so same-directory session switches keep it mounted

### 🐛 Bug Fixes

- Fixed transcript rows re-animating on scroll-up history loads; only tail-appended live content now enters with the fade
- Fixed the session surface flash on cross-directory switches — the successor enters only after its first frame has content

### 🔧 Chores

- Added GitHub Actions CI (frontend + backend) and the Release → AUR/COPR publish pipeline

**Full Changelog**: https://github.com/iewnfod/lumina-code/compare/v0.1.0...v0.2.0
```
