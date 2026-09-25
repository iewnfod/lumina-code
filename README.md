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
  * Linux: `.deb`, `.rpm` and AppImage (x86_64 & arm64)
  * Windows: NSIS installer (x64)
  * macOS: `.dmg` (Apple silicon & Intel)

## Features

### Conversation
* Streaming transcript with collapsible reasoning and folded runs of tool calls
* Every tool call is a card — shell, file edits with inline git diffs (multi-file patches included), reads, grep, web fetch/search, subagents…
* Per-turn duration footers, plus a usage ring showing context-window share, token breakdown, cache hit rate and cost

### Plan-first workflow
* Ask for a plan: the assistant switches itself into plan mode and submits the plan for your approval — an approval card pins above the composer
* Approving hands the same session over to build mode; rejecting sends it back for revision
* The approved task checklist then tracks progress live (pending / in-progress / completed / blocked), and the plan is archived as markdown under `.lumina/plans/`

### Sessions & projects
* Sidebar groups sessions by project directory, with busy dots, pending-answer badges and relative ages
* Pick the working directory before the first message; composer drafts, model and mode survive session switches
* Sessions live in the shared OpenCode store, so conversations started in the CLI show up here too

### Composer
* `@` file mentions and `/` commands (including your own custom OpenCode commands) with autocomplete
* Attach images even to text-only models — they are routed through a vision model you configure
* Model picker across all configured providers and variants, thinking-depth control, and a build/plan mode switch

### Staying in control
* Permission cards for sensitive actions — shell commands, file edits, web access, folders outside the project — with allow-once / always-allow / reject
* Server-asked questions rendered as answerable forms; stop a running turn at any time

### Workspace activity panel
* One panel beside the conversation: plan progress, the project's working-copy git diff (drill into per-file diffs), background terminals with live output, and subagents with their streaming transcripts

### Models & preferences
* Connect providers via API key or browser OAuth; add custom OpenAI-compatible providers; hide models you don't use
* English / 简体中文 following the system, light & dark themes, custom interface and code fonts with independent sizes

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
| Typecheck + build frontend | `pnpm build` |
| Unit tests (pure frontend logic) | `pnpm test` |
| Release bundle | `pnpm tauri build` |
| Backend check | `cargo check --manifest-path src-tauri/Cargo.toml` |
| Regenerate file-type icons | `pnpm gen:icons` |

* `pnpm fetch:opencode` is a **prerequisite** for `tauri dev` / `tauri build`: Tauri's `externalBin` (`src-tauri/binaries/opencode`) must exist or the bundle step fails.
* Point dev at a different server binary: `OPENCODE_BIN=/path/to/opencode pnpm tauri dev`.
* The server version is pinned in three places that must move together: `OPENCODE_VERSION` in `scripts/fetch-opencode.mjs`, `EXPECTED_OPENCODE_VERSION` in `src-tauri/src/opencode/mod.rs`, and the exact-pinned `@opencode-ai/sdk` in `package.json`.
* See [AGENTS.md](./AGENTS.md) for the full architecture guide.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## License

[MPL-2.0](./LICENSE)
