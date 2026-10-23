<p align="center">
  <a href="./src/assets/Code%20Icon.svg">
    <img src="./src/assets/Code%20Icon.svg" width="120" height="120" alt="logo">
  </a>
  <h3 align="center">Lumina Code</h3>
</p>
<p align="center">
  <a href="./README_zh.md">简体中文</a> | <a href="./README.md">English</a>
</p>

A cross-platform desktop GUI for [OpenCode](https://opencode.ai/v2/docs/), built with Tauri and React. It bundles its own pinned OpenCode server and manages it behind the UI — install and chat, no CLI setup required — while sharing configuration, credentials and sessions with any `opencode` you already run.

## Installation

* Arch Linux (with an AUR helper like `paru` or `yay`):
```shell
paru -S lumina-code-bin
# or: yay -S lumina-code-bin
```
* Fedora (via COPR):
```shell
dnf copr enable iewnfod/lumina-code
dnf install lumina-code
```
* Other platforms — download an installer from [releases](https://github.com/iewnfod/lumina-code/releases):
  * Linux: `.deb`, `.rpm` and AppImage (x86_64 & arm64) — plus a parallel-installable CEF/Chromium flavor (`.deb`/`.rpm`) for setups where WebKitGTK misbehaves
  * Windows: NSIS installer (x64)
  * macOS: `.dmg` (Apple silicon & Intel)
  * Android: arm64 APK — pair it with the [remote-access setup](#mobile--remote-access) below

## Features

### Conversation
* Streaming transcript with collapsible reasoning and folded runs of tool calls
* Every tool call is a card — shell, file edits with inline git diffs (multi-file patches included), reads, grep, web fetch/search, subagents…
* Per-turn footers pair duration with an edit summary — files changed with +/− counts, one click drills into the diff
* Usage ring showing context-window share, token breakdown, cache hit rate and cost
* Click an attachment chip to preview it inline — images render, text and code files show as highlighted source

### Plan-first workflow
* Ask for a plan: the assistant switches itself into plan mode and submits the plan for your approval — an approval card pins above the composer
* Approving hands the same session over to build mode; rejecting sends it back for revision
* The approved task checklist then tracks progress live (pending / in-progress / completed / blocked)
* When every task is done, the assistant submits a completion report: accept it to archive the plan or reject it to send the work back — acceptance is always your call, never the model's own claim
* Plan documents live under `.lumina/tasks/` in the project (plan, report, checklist, versioned history); accepting archives them into `.lumina/archived/`

### Sessions & projects
* Sidebar groups sessions by project directory, with busy dots, pending-answer badges, relative ages and per-session branch chips
* Pick the working directory before the first message — or pin the session to a git branch and it runs in an isolated worktree while your main checkout stays untouched; the title bar always shows the current branch
* Composer drafts, model and mode survive session switches
* Sessions live in the shared OpenCode store: ones started by other `opencode` clients (TUI, CLI) import with one click, and ones created by your other Lumina Code windows or the mobile app join the sidebar automatically

### Composer
* `@` file mentions and `/` commands (including your own custom OpenCode commands) with autocomplete
* Attach images even to text-only models — they are routed through a vision model you configure
* Model picker across all configured providers and variants, thinking-depth control, and a build/plan mode switch
* Prompts typed while a run is in flight are queued server-side — reorder them by drag, edit or remove them, or stop the run and send them at once; the queue survives restarts and syncs across your devices

### Staying in control
* Permission cards for sensitive actions — shell commands, file edits, web access, folders outside the project — with allow-once / always-allow / reject
* Server-asked questions rendered as answerable forms; stop a running turn at any time
* Edit any earlier prompt: the conversation rewinds to it — file changes from the rewound turns are undone too — and the edited version is resent
* Desktop notifications in three tiers (off / run ends only / every attention event), muted while you're watching the session that needs you

### Workspace activity panel
* One panel beside the conversation: plan progress, the project's working-copy git diff (drill into per-file diffs), background terminals with live output, and subagents with their streaming transcripts
* Branch-bound sessions add a sync section: commits-ahead and dirty-file drift, plus a one-click fast-forward write-back to your local branch (divergence is detected and left to you)

### Models & preferences
* Connect providers via API key or browser OAuth (device-flow verification codes shown in-app); add custom OpenAI-compatible providers; hide models you don't use
* Toggle plugins and MCP servers on and off in-app — the server hot-reloads — and read any MCP server's recent log without leaving the app
* A custom system prompt, set once in General settings, rides every request
* English / 简体中文 following the system, light & dark themes, custom interface and code fonts with independent sizes
* On GNOME, join the Blur my Shell whitelist for a translucent window with real compositor blur; other desktops fall back to opaque automatically

### Mobile & remote access
* Self-host the companion [lumina-code-server](./server/README.md): one Docker Compose stack — user accounts, a web console and the routing end of the tunnel
* Flip on remote access in the desktop's Server settings; the desktop then holds an outbound route — nothing of yours listens on the public internet
* The Android app (arm64 APK in releases) signs into the same server and connects straight to your desktop: the full desktop UI, real streaming, phone or tablet layout
* The agent never leaves your machine — code, model credentials and git repos stay on the desktop, and the server only brokers the connection

## The bundled OpenCode server

Lumina Code ships a pinned OpenCode server binary (currently v2.0.11) as a sidecar and owns its lifecycle — spawn, auth, event stream, shutdown. This mirrors the official OpenCode desktop app: configuration, credentials, and sessions under `~/.config/opencode` and `~/.local/share/opencode` are shared with any opencode you run yourself; only the binary version is controlled. The bundled server's self-updater is disabled — upgrades happen by re-pinning the version and shipping an app update.

The app also installs a small `lumina-tools` plugin into your global `opencode.json` — it provides the always-on plan-mode tool and the configurable vision tool.

## Development

```sh
pnpm install
pnpm fetch:opencode   # download the pinned OpenCode server sidecar (~200 MB, once per version bump)
pnpm tauri dev
```

| Purpose | Command |
| --- | --- |
| Run the app | `pnpm tauri dev` |
| Run the app (experimental CEF/Chromium shell, Linux) | `pnpm dev:cef` |
| Typecheck + build frontend | `pnpm build` |
| Unit tests (pure frontend logic) | `pnpm test` |
| Release bundle | `pnpm tauri build` |
| Release bundle (CEF shell) | `pnpm build:cef` |
| Companion server dev / build / test | `pnpm server:dev` / `pnpm server:build` / `pnpm server:test` |
| Mobile web bundle dev / build | `pnpm dev:mobile` / `pnpm build:mobile` |
| Backend check | `cargo check --manifest-path src-tauri/Cargo.toml` |
| Regenerate file-type icons | `pnpm gen:icons` |

* `pnpm fetch:opencode` is a **prerequisite** for `tauri dev` / `tauri build` — and even for `cargo check`: the server ships as a Tauri resource (`src-tauri/binaries/opencode`) that must exist or the build script fails. `pnpm fetch:frp` feeds the same mechanism for the bundled `frpc` (remote access) and is equally required before local bundles.
* The CEF shell is a second app crate (`cef/`) running the same frontend on Tauri v3 alpha with bundled Chromium — for Linux setups where WebKitGTK misbehaves. It needs the shared CEF distribution under `~/.local/share/cef/`.
* The mobile app reuses the repo's frontend as a second Vite entry (`mobile/`); Android builds need the SDK/NDK — see [mobile/README.md](./mobile/README.md).
* Point dev at a different server binary: `OPENCODE_BIN=/path/to/opencode pnpm tauri dev`.
* The server version is pinned in three places that must move together: `OPENCODE_VERSION` in `scripts/fetch-opencode.mjs`, `EXPECTED_OPENCODE_VERSION` in `src-tauri/src/opencode/mod.rs`, and the exact-pinned `@opencode-ai/sdk` in `package.json`.
* See [AGENTS.md](./AGENTS.md) for the full architecture guide.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## License

[MPL-2.0](./LICENSE)
