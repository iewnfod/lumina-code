# Lumina Code

A Tauri + React desktop GUI for [OpenCode](https://opencode.ai/v2/docs/).

## Development

```sh
pnpm install
pnpm fetch:opencode   # download the pinned OpenCode server sidecar (~200 MB, once per version bump)
pnpm tauri dev
```

The app bundles its own OpenCode server binary (pinned to 2.0.11, see
`scripts/fetch-opencode.mjs`), mirroring the official OpenCode desktop app:
configuration, credentials, and sessions under `~/.config/opencode` and
`~/.local/share/opencode` are shared with any opencode you run yourself;
only the binary version is controlled. The bundled server's self-updater is
disabled — upgrades happen by re-pinning the version and shipping an app
update. Set `OPENCODE_BIN` to point dev at a different binary.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
