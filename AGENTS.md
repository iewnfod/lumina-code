# AGENTS.md

This document describes Lumina Code's architecture, design principles, and
the rules any AI (or human) contributor must follow so the codebase stays
high-cohesion / low-coupling and does not regress into duplication.

> Read this **before** making changes. If a change would violate a rule below,
> extract or refactor first rather than adding another copy.
> Before doing any large changes, AI should enter the plan mode of the harness
> tool instead of writing a spec document.

Lumina Code is a Tauri + React desktop GUI for [OpenCode](https://opencode.ai/v2/docs/).
It shares its chrome conventions with the sibling project `lumina-terminal`
(glass surfaces, motion presets, custom title bar, logging) — code ported
between the two keeps a comment noting its origin.

This project does not use tools like OpenSpec to record the changes in each session.
Instead, we use the plan mode in each harness, especially in large changes.
If you are an AI, you should enter the plan mode by yourself (if you are in lumina code, you should have this ability),
or ask the user to enter the plan mode for you.

---

## 1. Commands & Toolchain

| Purpose | Command |
|---------|---------|
| Install | `pnpm install` |
| Fetch pinned OpenCode server sidecar (~200 MB, once per version bump) | `pnpm fetch:opencode` (also: `--all` for every target / explicit Rust triples) |
| Fetch the sidecar into the CEF shell's binaries/ | `pnpm fetch:opencode:cef` (same args; sets `LUMINA_BINARIES_DIR`) |
| Fetch the pinned frpc resource sidecar (~13 MB, remote access) | `pnpm fetch:frp` (same args as fetch:opencode; `FRP_MIRROR=<prefix>` pins a GitHub mirror, mirror chain otherwise; `:cef` variant too) |
| Run the app (default webkit shell) | `pnpm tauri dev` |
| Run the app (CEF/Chromium shell, Linux) | `pnpm dev:cef` — needs `~/.local/share/cef/cef_linux_x86_64` (the shared CEF binary distribution; the first cold build downloads it into OUT_DIR otherwise — through a proxy if the direct route stalls) |
| Release-build the webkit shell | `pnpm tauri build` |
| Release-build the CEF shell | `pnpm build:cef` |
| Mobile web bundle dev / build (second vite entry, port 1421) | `pnpm dev:mobile` / `pnpm build:mobile` |
| Android release APK (local, arm64; needs SDK/NDK, see mobile/README.md) | `cd mobile && pnpm exec tauri android build --apk --target aarch64` |
| Typecheck + build frontend | `pnpm build` (`tsc && vite build`) |
| Unit tests (pure frontend logic) | `pnpm test` (`node --test "src/**/*.test.ts" "src/**/*.test.js"`) |
| Point dev at a different server binary | `OPENCODE_BIN=/path/to/opencode pnpm tauri dev` |
| Regenerate Material file-type icons (after bumping `material-icon-theme`) | `pnpm gen:icons` (output is committed) |
| Rebuild the office-tools plugin's vendored engines (after bumping `docx`/`pptxgenjs`) | `pnpm gen:office-vendor` (esbuild bundles into `src/plugins/officeToolsVendor/`, committed — CI never runs it) |

- `pnpm fetch:opencode` is a **prerequisite** for `tauri dev`/`tauri build`:
  the `resources` maps in `tauri.linux/macos/windows.conf.json` reference
  `src-tauri/binaries/opencode` (stable name, fetched per platform), and the
  file must exist or the bundle step — even `cargo check` — fails. Binaries
  are gitignored. The sidecar is also a hard
  dependency of the BUILD SCRIPT — `cargo check` alone fails without it, and
  every CI job fetches it first. `pnpm fetch:frp` feeds the SAME
  mechanism for `binaries/frpc` (remote access) — same CI prerequisite.
  Version note: the frpc pin (FRP_VERSION, GitHub releases) and the
  compose frps image tag MAY briefly differ — snowdreamtech's Docker
  Hub repository lags fatedier's releases (0.71.1 era: Hub had no
  0.71.1, compose pinned 0.71.0-alpine while frpc shipped 0.71.1);
  the cross-version login/auth is verified compatible (local
  end-to-end + production wss), resync both when the Hub catches up.
- There is no lint/format config; `pnpm build` is the
  guardrail — tsconfig is strict with `noUnusedLocals` /
  `noUnusedParameters` / `noFallthroughCasesInSwitch`, so unused imports and
  vars fail the build. Run it (and `pnpm test`) before claiming done.
- Rust backend: `cargo check` / `cargo build` via
  `--manifest-path src-tauri/Cargo.toml`. The lib crate is
  `lumina_code_lib` (needed if you ever add integration tests).

### CI & Release (GitHub Actions)

Mirrors lumina-terminal's pipeline (keep the two in sync when fixing one):

- **ci-frontend.yml** — every push/PR: `pnpm test` + `pnpm build` on
  ubuntu-latest.
- **ci-backend.yml** — every push/PR: `cargo check --locked` across
  Linux/Windows/macOS for the webkit shell, PLUS a `check-cef` job (ubuntu,
  gtk4 deps) for the CEF shell — the dual check keeps the single-source
  shared modules compiling under both tauri majors. Fetches the host
  sidecar (`LUMINA_BINARIES_DIR` for the CEF leg; tauri-build needs it even
  for check) and drops a placeholder `dist/index.html` for
  `generate_context!`.
- **release.yml** — on a **published GitHub release** (or manual dispatch
  with a `tag` input): builds the 5-target matrix (linux amd64/arm64,
  windows x64, macos amd64/arm64), fetching the sidecar for the exact
  matrix target first, and attaches bundles to the release. Hand-written
  release notes are snapshotted and echoed back so the concurrent matrix
  never overwrites them. No updater signing (the Tauri updater is not
  configured for this app). The `publish-android` job adds the mobile APK
  (`Lumina.Code_<ver>_android-arm64.apk`, arm64-only, version-synced via
  bump-version.sh) built with the CLI directly (tauri-action has no
  android mode) and signed through the four `ANDROID_KEYSTORE_*` secrets
  feeding the conditional signingConfig in
  mobile/src-tauri/gen/android/app/build.gradle.kts — the job fails fast
  with setup instructions when the secrets are missing rather than
  uploading an uninstallable unsigned APK; see mobile/README.md for the
  one-time keystore/secret setup.
- **pkg-trigger.yml → aur.yml / copr.yml** — after Release succeeds,
  republish the .deb/.rpm assets as `lumina-code-bin` (AUR) and `lumina-code`
  (Fedora COPR) from the `.aur/PKGBUILD` / `.copr/lumina-code.spec`
  templates. One-time repo secrets: `AUR_SSH_PRIVATE_KEY`, `COPR_CONFIG`
  (plus a manually created COPR project `iewnfod/lumina-code`).
- **docker-server.yml** — builds the lumina-code-server image and pushes it
  to Docker Hub (`docker.io/iewnfod/lumina-code-server`, multi-arch
  amd64+arm64 via QEMU — better-sqlite3 ships prebuilt musl bindings,
  the cross-build never compiles). The server rides the repo's ONE
  version line: `scripts/bump-version.sh` bumps `server/package.json`
  in lockstep with the app (twelve files total; the image tag itself
  still derives from the release tag). Two lanes: master pushes touching
  the image's inputs (server/, the workspace manifests, the workflow
  file) → `:edge`; published Releases → `:<version>` + `:latest`
  (version = the release tag, sans v). Deliberately NOT on the
  pkg-trigger dispatch chain — it needs no repo-API calls, so it
  triggers on the release event directly. One-time secrets:
  `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (Read & Write; plus the
  manually created Docker Hub repo, so visibility is an explicit
  choice).

Release notes are written by hand (see `docs/RELEASE_PROMPT.md`), then the
release publish fills in the assets. Asset names derive from productName
"Lumina Code" → `Lumina.Code_<ver>_amd64.deb`, `Lumina.Code-<ver>-1.x86_64.rpm`.

### The OpenCode version pin (three-way sync)

The bundled server version is pinned in **three places that must move
together**:

1. `OPENCODE_VERSION` in `scripts/fetch-opencode.mjs` (downloads the binary),
2. `EXPECTED_OPENCODE_VERSION` in `src-tauri/src/opencode.rs` (enforced at
   startup against the sidecar),
3. the exact-pinned `@opencode-ai/sdk` in `package.json` (types-only).

Bumping one without the others breaks the build or the startup check.

---

## 2. Source Map

### Frontend (`src/`)

```
src/
├── App.tsx                # Layout shell only: chrome (glass frame, sidebar,
│                          #   title bar) + OpenCode wiring via hooks
│                          #   (useOpencode, useSessionFlow) and the
│                          #   session ↔ welcome-screen swap (SessionSurface,
│                          #   also defined here). Split in two since the
│                          #   context refactor: InnerApp is the
│                          #   connection/theme shell (useOpencode + palette
│                          #   + the three providers below), AppBody
│                          #   consumes the contexts and hosts the flow +
│                          #   chrome. SESSION SURFACE CHOREOGRAPHY: the swap
│                          #   is SEQUENTIAL (lib/surfacePhases.ts, pure) —
│                          #   click starts the old surface's exit
│                          #   (.lum-surface-exit) AND the successor's store
│                          #   warm (ensureSessionSeeded) in parallel; the
│                          #   exit plays to completion; an unready
│                          #   successor shows the looping .lum-loading dots
│                          #   until its newest page has seeded
│                          #   (useSessionSeeded), then enters via .lum-enter
│                          #   with its FIRST FRAME already carrying content —
│                          #   the entrance starts exactly when there is
│                          #   something to reveal, so it covers the load
│                          #   whatever the latency. App() wraps InnerApp
│                          #   with useMaximized/usePaddingOffset/
│                          #   useDragRegionDoubleClick. Also owns the
│                          #   conversation surface geometry: the content is
│                          #   a FLEX ROW — conversation (flex-1, the swap
│                          #   inside it) + the workspace stats panel as a
│                          #   REAL sibling, KEYED BY DIRECTORY
│                          #   (same-directory session switches keep it
│                          #   mounted; cross-directory switches go
│                          #   through StatsCardSwap — the keyed remount
│                          #   gains a fade: the LEAVING card renders on
│                          #   as a frozen-snapshot ghost
│                          #   (.lum-card-hold, pinned top-right out of
│                          #   flow, its own entrance suppressed) while
│                          #   the successor mounts — float mode
│                          #   crossfades, wide-container mode reflows at
│                          #   once with the ghost fading over the
│                          #   corner; never on the welcome screen). App
│                          #   measures
│                          #   NOTHING: the row (.lum-row) is a CSS size
│                          #   CONTAINER — the column's width cap + gutters
│                          #   (.lum-column) and the stats panel's
│                          #   flow/float (.lum-stats) are container queries
│                          #   in main.css, and flex pushes the conversation
│                          #   left as the panel's width transitions. App
│                          #   also derives the ONE SurfaceColors palette
│                          #   (useSurfaceColors) and provides it via
│                          #   ColorsProvider (hooks/colors.tsx) + the
│                          #   --lum-wash hover vars on the root.
│                          #   AppBody's last child is the BOOT GATE
│                          #   (BootScreen) covering the whole chrome
│                          #   until the app is genuinely usable — see
│                          #   components/BootScreen.tsx.
├── main.tsx               # ReactDOM entry (React.StrictMode) + attachConsole
│                          #   + the persistence gate: initPersistedState()
│                          #   seeds the state file BEFORE the App bundle is
│                          #   dynamically imported (see lib/persistedStore.ts).
├── constants.ts           # CHROME_TITLE_BAR_HEIGHT
├── i18n/                  # en-us.ts (source of truth: keys ARE the English
│                          #   strings) + zh-cn.ts (partial OK; per-lookup fallback)
│
├── plugins/               # Plugin SOURCES shipped with the app (plain JS, no
│   ├── luminaTools.js     #   imports — a bare default export loads on server
│                          #   v2.0.11). The custom-tools host: Lumina Code
│                          #   ensures this file lives under the global config's
│                          #   `plugins/lumina-tools/` and is referenced from
│                          #   opencode.json's `plugins` array with per-tool
│                          #   options (see opencode/useLuminaTools.ts, the
│                          #   connect-time installer); the server hot-reloads
│                          #   on config change. TOOLS registry inside = one
│                          #   entry per tool (enabled/agentId/tool). v2.0.11
│                          #   facts encoded here: plugin tools default to
│                          #   CODE MODE exposure — `codemode: false` makes
│                          #   them NATIVE tools (verified live; the code-mode
│                          #   path has a step budget and degrades to
│                          #   hallucinated text when exhausted); the agent
│                          #   transform has no add() — restricted helper
│                          #   agents are defined in the config's `agents`
│                          #   section (written by opencode/toolPluginConfig.ts);
│                          #   the plugin ctx has no session delete — helper
│                          #   sessions carry metadata {source:
│                          #   "lumina-tools"} and the frontend deletes them
│                          #   (useSessions.ts); tool executors receive
│                          #   context.{sessionID, agent, signal}. Residents:
│                          #   vision (识图) — a text-only model asks a
│                          #   configured vision model about an image file via
│                          #   a transient helper session (askModel), gated on
│                          #   its model option; the description is
│                          #   FALLBACK-FIRST — a model that can already see
│                          #   inline image content must read it directly and
│                          #   NOT call the tool (priority decided by the
│                          #   model's own vision ability), the call being
│                          #   reserved for path-referenced images (the
│                          #   attachments note's name→path map) and workspace
│                          #   images it cannot view — and plan_mode (always-on
│                          #   while the plugin loads): the model switches ITS
│                          #   OWN session into OpenCode's Plan Mode (the
│                          #   builtin `plan` agent) via ctx.session.switchAgent
│                          #   — verified against v2.0.11 source: the runner
│                          #   re-resolves the agent EVERY step, so the step
│                          #   after the tool result already runs under plan;
│                          #   one-way by design, returning to build is the
│                          #   user's call (the composer's mode picker; the
│                          #   switch broadcasts session.agent.selected, which
│                          #   useSessions patches live). THE PLAN WORKFLOW
│                          #   (always-on): plan_submit / task_complete /
│                          #   plan_amend / work_submit close the loop
│                          #   around plan mode — the plan agent submits
│                          #   {title, plan, todos} and the executor
│                          #   BLOCKS as the approval gate (Route A):
│                          #   v2.0.11 has NO execution-time permission
│                          #   check for plugin tools (binary-verified:
│                          #   options.permission only filters tool
│                          #   VISIBILITY; asking is builtin-internal),
│                          #   so the gate is a poll loop — every 400ms
│                          #   the executor re-reads the session's
│                          #   agent; APPROVAL ARRIVES AS THE SWITCH
│                          #   itself (Lumina Code's approval card
│                          #   calls switchAgent "build"; the model's
│                          #   next step already runs under build),
│                          #   rejection as the executor's abort signal
│                          #   (the card interrupts), 10-min deadline
│                          #   otherwise. CAVEAT (live-observed
│                          #   2026-09-28): an interrupt does NOT
│                          #   reliably abort a plugin executor's
│                          #   context.signal — a rejected gate's
│                          #   executor can keep polling as a zombie, so
│                          #   both poll gates carry a per-session
│                          #   GENERATION FENCE (claimGate/gateIsCurrent):
│                          #   each new plan_submit/work_submit claim
│                          #   supersedes older loops, which exit at
│                          #   their next tick without touching disk.
│                          #   RESTART ORPHANS (live-observed 2026-09-30,
│                          #   opencode.db取证): the server persists a
│                          #   tool part as running AT CALL START and
│                          #   never settles it when the app dies
│                          #   mid-gate — the part stays frozen running
│                          #   in storage while its executor is gone.
│                          #   Because "approved" IS the agent switch,
│                          #   the folds on BOTH sides adopt agent-as-
│                          #   truth: a plan_submit frozen running under
│                          #   agent "build" counts as APPROVED
│                          #   (planStateFromEntries' agentNow param —
│                          #   todos read from the frozen part's input),
│                          #   unblocking task_complete/plan_amend/
│                          #   work_submit after recovery; under any
│                          #   other agent it is a genuinely waiting (or
│                          #   rejected) gate. The frontend twin:
│                          #   sessionActivity.ts's GateContext. The
│                          #   acceptance twin is the review MARKER
│                          #   itself (durable on disk) + the session-
│                          #   hook SWEEPER (sweepOrphanAcceptance): any
│                          #   marker readable while the session holds
│                          #   no live gate claim is by definition
│                          #   unconsumed — the sweeper archives the
│                          #   plan and clears it (fires on Lumina
│                          #   Code's orphan-acceptance wake prompt;
│                          #   hot-reload restarts kill the old
│                          #   instance's executors the same way, so a
│                          #   fresh instance's map cannot skip a marker
│                          #   that still has an owner). The GUI's
│                          #   recovery: ChatView renders the pending
│                          #   card in INTERRUPTED mode when the session
│                          #   is idle and delivers the verdict as a
│                          #   WAKE PROMPT (switchAgent + sendPrompt) —
│                          #   see gateDecisions.ts.
│                          #   Task titles must be SHORT
│                          #   (protocol text). Build then reports via
│                          #   task_complete {title} under STRICT
│                          #   validation (title must equal the NEXT
│                          #   open task's title, whitespace-normalized,
│                          #   no skipping/revisiting; blocked:true +
│                          #   reason is the honest exit), plan_amend
│                          #   {todos} replaces the remaining tail; once
│                          #   EVERY task is settled, work_submit
│                          #   {report} is the ACCEPTANCE gate — archival
│                          #   certifies "the user TESTED this", never
│                          #   the AI's own claim (same Route A shape:
│                          #   approval arrives as the marker file the
│                          #   WorkReviewCard writes, rejection as the
│                          #   interrupt). Validation state is DERIVED
│                          #   FROM THE TRANSCRIPT each call
│                          #   (ctx.session.context: last completed
│                          #   plan_submit + subsequent completed
│                          #   task_complete/plan_amend/work_submit
│                          #   parts — planStateFromEntries; no
│                          #   plugin-side mutable state; a COMPLETED
│                          #   work_submit marks the plan archived =
│                          #   terminal, later calls refuse; subagent
│                          #   child sessions self-scope-out, their
│                          #   transcripts hold no plan). Every result
│                          #   echoes the checklist (compaction
│                          #   self-healing). THE ON-DISK MIRROR
│                          #   (.lumina/tasks/<slug>/ under the
│                          #   SESSION's directory — resolved via
│                          #   ctx.session.get's location.directory,
│                          #   NEVER ctx.location which is the single
│                          #   plugin instance's CWD, live-verified):
│                          #   every plan/report SUBMISSION (approved or
│                          #   not) writes a history/<kind>-<ts>.md
│                          #   snapshot plus the newest plan.md /
│                          #   report.md — each file's header anchors it
│                          #   to its session id, so the fold stays
│                          #   stateless and resubmissions reuse (and
│                          #   version) their own directory while other
│                          #   sessions' same-title plans get -2
│                          #   siblings; tasks.md is HOST-maintained
│                          #   (generated from the structured todos,
│                          #   never parsed from plan markdown) and
│                          #   fully rewritten after approval and every
│                          #   progress event — its existence marks the
│                          #   directory as an APPROVED plan. All file
│                          #   ops run INSIDE the executors through
│                          #   dynamic `await import("node:fs")`
│                          #   (live-verified on v2.0.11 — the HTTP fs
│                          #   API has no delete/move, so the plugin is
│                          #   the only side that can archive); the
│                          #   pure naming/composition/zip helpers are
│                          #   named exports covered by
│                          #   src/plugins/luminaTools.test.js. On
│                          #   ACCEPTANCE the executor archives:
│                          #   plan.md + report.md + tasks.md + history/
│                          #   become one stored zip (hand-rolled, no
│                          #   deps) at .lumina/archived/<slug>.zip
│                          #   (tmp+rename atomic) and the task
│                          #   directory is removed. The acceptance
│                          #   marker itself lives at a FIXED path
│                          #   (.lumina/review/<sessionID>.json) both
│                          #   sides derive without knowing the task
│                          #   directory's collision suffix. setup() also
│                          #   rides the v2.0.11 session hook —
│                          #   ctx.session.hook("context", async e =>
│                          #   e.system.push) appends HOST_IDENTITY (the
│                          #   harness identity: "you run inside Lumina
│                          #   Code, the desktop GUI
│                          #   client for OpenCode — not the TUI") and the
│                          #   PLAN_WORKFLOW protocol to every model call
│                          #   (binary-verified; runtime-probed,
│                          #   degrades to tool descriptions when absent)
│                          #   — plus, for non-helper agents, a one-line
│                          #   digest of the directory's UNARCHIVED plans
│                          #   (tasks.md scan; activePlansNote — the
│                          #   callback is async and resolves the
│                          #   session's own directory, both
│                          #   live-verified), so a NEW session can
│                          #   resume a plan and a compacted context
│                          #   re-learns where the documents live. The
│                          #   SAME gate also carries the user's CUSTOM
│                          #   SYSTEM PROMPT (General settings): the
│                          #   plugin-level `systemPrompt` option,
│                          #   pushed after everything the server itself
│                          #   assembled (built-in prompt + AGENTS.md /
│                          #   instructions), skipped for lumina-*
│                          #   helper agents.
│   ├── officeTools.js     #   The OFFICE-TOOLS plugin host — a SEPARATE
│                          #   plugin from lumina-tools on purpose (that
│                          #   one is the OpenCode system-enhancement
│                          #   layer; this one is a domain capability:
│                          #   Word/PPT documents). Same plugin shape
│                          #   (bare default export with id, dynamic
│                          #   node:* imports, named exports for node
│                          #   tests — officeTools.test.js drives the
│                          #   builders end-to-end through the SAME
│                          #   vendor bundles). TWO TOOLS, both native
│                          #   (codemode: false): write_document — the
│                          #   official way to produce office
│                          #   deliverables: the model passes a
│                          #   STRUCTURED block list (docx:
│                          #   heading/paragraph/list/table/image; pptx:
│                          #   slides with layout title|titleContent|
│                          #   twoContent|blank + bullets/image/notes)
│                          #   and the plugin renders deterministically
│                          #   through the vendored npm engines (docx +
│                          #   pptxgenjs, esbuild-bundled to single-file
│                          #   ESM under officeToolsVendor/, installed
│                          #   beside the plugin as vendor/*.mjs) — never
│                          #   AI-written scripts; every write ALSO drops
│                          #   a structure SIDECAR at
│                          #   .lumina/docstruct/<name>.json ({version,
│                          #   source, file, format, size, generatedAt,
│                          #   blocks|slides} — the app's in-app preview
│                          #   reads it; the TS mirror is
│                          #   opencode/docstruct.ts) — and read_document
│                          #   — content extraction to markdown (sidecar
│                          #   fast path, else a hand-rolled zip reader
│                          #   over node:zlib + conservative OOXML
│                          #   regexes with a degraded raw-text fallback;
│                          #   reads may point outside the workspace,
│                          #   writes are confined to it —
│                          #   resolveDocumentPath's confine flag).
│                          #   SPIKE-VERIFIED 2026-10-23 on the bundled
│                          #   v2.0.11 sidecar: the Bun-compiled server
│                          #   resolves the plugin's DYNAMIC RELATIVE
│                          #   vendor imports (await import("./vendor/
│                          #   docx.mjs")) against the installed plugin
│                          #   directory, and both engines generate valid
│                          #   documents (incl. CJK) from inside setup();
│                          #   write_document registers ONLY when the
│                          #   engines load, read_document always.
│                          #   Images: content-sniffed kind + PNG/JPEG
│                          #   header dimensions (imageDimensions),
│                          #   width-capped at 560px (imageBox); the
│                          #   docx default font pair is Calibri +
│                          #   Microsoft YaHei (Word/WPS both ship it).
│   └── officeToolsVendor/ #   GENERATED by scripts/build-plugin-vendor.mjs
│                          #   (pnpm gen:office-vendor; committed — the
│                          #   gen:icons doctrine; CI never rebuilds).
│                          #   docx.mjs (456 KB) + pptxgenjs.mjs (392 KB),
│                          #   both esbuild ESM with node:* externals so
│                          #   the server runtime provides the builtins.
│                          #   devDps: docx, pptxgenjs, esbuild (MIT).
│
├── opencode/              # THE domain layer — everything talking to the server
│   ├── api.ts             # OpencodeApi: hand-rolled typed REST client (fetch +
│   │                      #   basic auth, `{"data": …}` envelope unwrap).
│   │                      #   UPLOAD_TIMEOUT_MS: requestRaw takes an optional
│   │                      #   abort deadline (AbortController + timer, no
│   │                      #   AbortSignal.timeout engine dependency) —
│   │                      #   sendPrompt and the divert's writeBinaryFile
│   │                      #   pass 120s: they carry the base64 attachment
│   │                      #   bodies, the mobile frp route's biggest
│   │                      #   uploads, and a dropped tunnel would park the
│   │                      #   fetch forever (reads as an endless send).
│   │                      #   Hand-rolled on purpose: the SDK's generated
│   │                      #   client drifts from the installed v2.0.x server
│   │                      #   (paths & body encoding); the SDK is imported
│   │                      #   types-only. Server quirks documented inline:
│   │                      #   messages `limit` caps at 200; session create sends
│   │                      #   `location.directory` (a flat `directory` is silently
│   │                      #   ignored) and ACCEPTS `metadata` (curl-verified
│   │                      #   v2.0.11, echoed + listed — the cross-instance
│   │                      #   whitelist stamp, see sessionRegistry.CLIENT_SOURCE);
│   │                      #   `?roots=true` doesn't work (root sessions are
│   │                      #   filtered client-side); questions are forms on this
│   │                      #   server generation; GET /api/session/active seeds busy
│   │                      #   state predating the event stream. Also the session
│   │                      #   REVERT trio (stage/clear/commit — the
│   │                      #   edit-last-message primitive, v2.0.11): staging
│   │                      #   at message M undoes the file changes of the
│   │                      #   turns after M immediately, committing deletes
│   │                      #   M AND everything after it, and clearing
│   │                      #   re-applies the undone files. Plus the binary
│   │                      #   fs/read (readFileBlob → Blob, same
│   │                      #   location-confined shape as readTextFile)
│   │                      #   feeding the attachment-chip image previews.
│   │                      #   Plus sessionTurnDiff — the per-TURN diff
│   │                      #   (GET /api/session/{id}/diff?from=<userMsg>,
│   │                      #   binary-verified v2.0.11) feeding the run
│   │                      #   footers' edit summaries: snapshot-based, so
│   │                      #   subagent/bash edits count and the `from`
│   │                      #   must be a USER message id (a turn spans
│   │                      #   prompt → next idle; steered prompts join
│   │                      #   the same turn). Plus the BRANCH/WORKTREE
│   │                      #   trio feeding the title-bar chip and the
│   │                      #   branch-bound sessions (all curl-verified
│   │                      #   v2.0.11): listBranches (GET /api/vcs/branch
│   │                      #   — markerless list, same warmup-empty-first-
│   │                      #   call race as vcsDiff) and
│   │                      #   listWorktrees/createWorktree/removeWorktree
│   │                      #   (/api/worktree, projectID-addressed; create
│   │                      #   checks out DETACHED at the branch tip, remove
│   │                      #   refuses dirty worktrees unless force — see
│   │                      #   worktreeSessions for why removal is never
│   │                      #   automatic). Current branch = readTextFile of
│   │                      #   .git/HEAD + gitInfo.parseGitHead. PLUS the
│   │                      #   SHELL EXECUTION PRIMITIVE feeding the worktree
│   │                      #   write-back (worktreeSync.ts): spawnShell
│   │                      #   (POST /api/shell — single command string via
│   │                      #   the user's LOGIN SHELL, argv-style args
│   │                      #   silently ignored, curl-verified) + awaitShell
│   │                      #   (polls the shell RECORD until exited; the
│   │                      #   exit code comes from data.exit — echoing $?
│   │                      #   would be a bashism under fish). PLUS THE
│   │                      #   SESSION INBOX trio feeding the interrupt
│   │                      #   sweep AND the queued-prompt mirror
│   │                      #   (source-verified v2.0.11):
│   │                      #   listSessionInbox (GET /api/session/{id}/inbox
│   │                      #   — the PERSISTED pending input table, rows
│   │                      #   ordered by enqueued_seq; a prompt POSTed
│   │                      #   mid-run without `delivery` parks there as
│   │                      #   a steer row until a step boundary promotes
│   │                      #   it, while delivery:"queue" rows are the
│   │                      #   SERVER-NATIVE queued prompts — invisible
│   │                      #   to the running turn, auto-drained as fresh
│   │                      #   turns when it ends, and readable by every
│   │                      #   client; see promptQueue.ts) +
│   │                      #   cancelSessionInbox (DELETE
│   │                      #   /api/session/{id}/inbox/{inboxID} — no-op
│   │                      #   on already-delivered rows; emits
│   │                      #   session.inbox.cancelled) — the server's
│   │                      #   interrupt endpoint does NOT clear the
│   │                      #   inbox, so "stop means stop" needs the sweep
│   │                      #   (useSessionMessages.interrupt). sendPrompt
│   │                      #   takes an optional delivery:"queue" — the
│   │                      #   POST RESPONSE IS the inbox row (id +
│   │                      #   delivery + payload, curl-verified), which
│   │                      #   is what lets the optimistic queue row
│   │                      #   adopt the server id without text matching.
│   ├── configFiles.ts     # globalConfigTarget — where the global opencode.json
│   │                      #   lives, derived from GET /api/config (pure; shared
│   │                      #   by the settings config editor and the attachment
│   │                      #   divert). node-testable via its consumers.
│   ├── appMode.ts         # THE DAILY/DEV MODE SPLIT. A persistedStore
│   │                      #   ("lumina-code:app-mode", the useThemePreference
│   │                      #   pattern) remembering which half of the app the
│   │                      #   user is in — default "daily" (the product's
│   │                      #   non-developer stance), the last choice kept
│   │                      #   across restarts. THE GIT GATE: dev's features
│   │                      #   all assume a git machine (branch pickers,
│   │                      #   worktrees, diffs), so a machine WITHOUT git
│   │                      #   gets NO dev mode at all — probeGitAvailability
│   │                      #   runs `git --version` through the server's
│   │                      #   shell API once per connection (spawnShell, the
│   │                      #   worktreeSync precedent; the command is legal
│   │                      #   in every login-shell dialect incl. PowerShell),
│   │                      #   records the verdict in a module store, and
│   │                      #   useAppMode() FORCES "daily" on a CONFIRMED
│   │                      #   absence (an UNKNOWN probe keeps the stored
│   │                      #   choice — a flaked probe must not yank a
│   │                      #   restored dev session to the welcome screen;
│   │                      #   the switcher renders only on confirmed true).
│   │                      #   SESSION-SIDE: modeMetadata is the creation-time
│   │                      #   stamp (beside CLIENT_SOURCE, create-only
│   │                      #   metadata) and sessionMode derives it back —
│   │                      #   unstamped sessions (pre-mode builds, TUI/CLI
│   │                      #   strangers, imports) read as "dev".
│   │                      #   node-testable (storage-stub + query re-import).
│   ├── defaultWorkspace.ts # THE DAILY WORKSPACE: ~/Documents/LuminaWorkspace
│   │                      #   — the mode's fixed working directory (a
│   │                      #   non-developer never picks folders).
│   │                      #   defaultWorkspacePath (pure join, trailing-slash
│   │                      #   tolerant), resolveDefaultWorkspace (GET
│   │                      #   /api/location = the spawned server's cwd =
│   │                      #   $HOME), ensureDefaultWorkspace — the first send
│   │                      #   materializes the folder by seeding README.md +
│   │                      #   AGENTS.md through experimental/fs/write
│   │                      #   (creates parents); each file is written ONLY on
│   │                      #   a 404 read (never overwrites; a FAILED read is
│   │                      #   not "absent" — the readOrNull contract), and the
│   │                      #   AGENTS.md IS the daily mode's behavioral half:
│   │                      #   the server reads it for every session in the
│   │                      #   directory, no app-level mode system needed.
│   │                      #   node-testable (fake api).
│   ├── useLuminaTools.ts  # The custom-tools plugin's install half:
│   │                      #   ensureLuminaToolsPlugin(api, options?) writes the
│   │                      #   plugin file + the config entry (diff-gated — the
│   │                      #   server hot-reloads on every config write), and
│   │                      #   useLuminaToolsInstall (AppBody, once per
│   │                      #   connection) keeps both current so the always-on
│   │                      #   plan_mode tool exists from the first prompt on.
│   │                      #   Passing options REPLACES the stored
│   │                      #   options wholesale (per-tool namespaces AND
│   │                      #   plugin-level fields like the General tab's
│   │                      #   systemPrompt — save sites spread the
│   │                      #   read-back current options first);
│   │                      #   omitting them preserves what's configured.
│   │                      #   Failures log and degrade to "tool absent".
│   ├── toolPluginConfig.ts # Pure custom-tools config logic (moved out of
│   │                      #   components/settings when useLuminaTools needed
│   │                      #   it — layering, §3.1): the lumina-tools plugin
│   │                      #   entry upsert/read-back/entry-present probe in
│   │                      #   the global opencode.json's `plugins` array
│   │                      #   (per-tool options + the PLUGIN-LEVEL
│   │                      #   systemPrompt — the General tab's custom
│   │                      #   system prompt, set/cleared through
│   │                      #   withSystemPrompt; foreign entries preserved;
│   │                      #   the entry is ALWAYS written now — plan_mode
│   │                      #   ships always-on) + the restricted helper agents
│   │                      #   in the config's `agents` section (v2.0.11 has
│   │                      #   no plugin-side agent add) + the vision-capable
│   │                      #   model filter. NOTE: the plan workflow's
│   │                      #   approval gate deliberately has NO config
│   │                      #   rule — plugin tools have no execution-time
│   │                      #   permission check on v2.0.11 (see the
│   │                      #   plugin source's Route A poll gate).
│   │                      #   node-testable.
│   ├── pluginConfigShared.ts # The plugins-array mechanics shared by every
│   │                      #   Lumina plugin installer (extracted when
│   │                      #   officePluginConfig needed the same moves):
│   │                      #   parseRoot/pluginsSection/findOwnEntry/
│   │                      #   upsertPluginEntry (foreign entries
│   │                      #   preserved verbatim; options embedded only
│   │                      #   when given) PLUS the config WRITE LOCK
│   │                      #   (serializeConfigWrite — a promise chain
│   │                      #   serializing every read→merge→write batch:
│   │                      #   the lumina-tools and office-tools
│   │                      #   connect-time installers race on the same
│   │                      #   file, and interleaved batches would
│   │                      #   clobber each other's entries). Consumed
│   │                      #   by toolPluginConfig + useLuminaTools +
│   │                      #   officePluginConfig + useOfficeTools.
│   │                      #   node-testable (through its consumers +
│   │                      #   officePluginConfig.test.ts's lock cases).
│   ├── officePluginConfig.ts # Pure office-tools config logic (the simple
│   │                      #   twin of toolPluginConfig — the plugin reads
│   │                      #   no options and defines no helper agents):
│   │                      #   entry upsert/read-back/entry-present over
│   │                      #   the shared mechanics. node-testable
│   │                      #   (officePluginConfig.test.ts, incl. the
│   │                      #   dual-installer coexistence shape).
│   ├── useOfficeTools.ts  # The office-tools plugin's install half (the
│   │                      #   useLuminaTools pattern): ensureOfficeTools
│   │                      #   Plugin writes index.js + vendor/docx.mjs +
│   │                      #   vendor/pptxgenjs.mjs (each diff-gated
│   │                      #   against the committed sources pulled in
│   │                      #   via ?raw) plus the config entry, the whole
│   │                      #   batch under the shared write lock;
│   │                      #   useOfficeToolsInstall (AppBody, beside
│   │                      #   useLuminaToolsInstall) keeps all current
│   │                      #   so write_document/read_document exist from
│   │                      #   the first prompt on. Failures degrade to
│   │                      #   "tool absent" (logged).
│   ├── docstruct.ts       # The frontend half of the office-tools SIDECAR
│   │                      #   contract (see the plugin source — this TS
│   │                      #   module is its mirror): block/slide types,
│   │                      #   lenient parseDocstruct (unknown version /
│   │                      #   foreign source / missing arrays → null =
│   │                      #   "no preview"; unknown block TYPES kept —
│   │                      #   the renderer skips them, forward-compatible
│   │                      #   with a newer plugin), isOfficeDocument,
│   │                      #   docstructSidecarPath (the same join the
│   │                      #   plugin performs) and docstructStale (byte-
│   │                      #   count mismatch = edited in Word since).
│   │                      #   node-testable (docstruct.test.ts).
│   ├── pluginsMcp.ts    # Pure read/merge logic for the Plugins & MCP
│   │                      #   manager (useExtensions.ts +
│   │                      #   components/ExtensionsModal.tsx). All
│   │                      #   verified live + against source on v2.0.11:
│   │                      #   the MCP toggle is `mcp.servers.<name>
│   │                      #   .disabled` (legacy `mcp.<name>.enabled`)
│   │                      #   in the DECLARING document; the plugin
│   │                      #   toggle is a `"-<pluginId>"` REMOVE
│   │                      #   directive in the `plugins` array (matches
│   │                      #   the plugin's DECLARED id, never its
│   │                      #   package path; directives apply across
│   │                      #   documents in priority order, later wins —
│   │                      #   so a directive lands in the highest
│   │                      #   document that DECLARES the plugin, else
│   │                      #   the global one for auto-discovered
│   │                      #   locals). A disabled plugin is INVISIBLE to
│   │                      #   GET /api/plugin — the disabled rows come
│   │                      #   from the directives (disabledPluginIds).
│   │                      #   mcpServerTypes derives local/remote labels
│   │                      #   (the status endpoint carries no type).
│   │                      #   Both writes HOT-RELOAD. node-testable
│   │                      #   (pluginsMcp.test.ts).
│   ├── useExtensions.ts # The manager's STATEFUL half (mounted in
│   │                      #   ExtensionsModal): loads /api/plugin +
│   │                      #   /api/mcp + /api/config, refreshes on
│   │                      #   plugin.updated / mcp.status.changed /
│   │                      #   config.updated (one debounced re-pull per
│   │                      #   burst), and performs the toggles — read
│   │                      #   raw document → merge → fs/write, with
│   │                      #   optimistic rows, refusal reasons
│   │                      #   (jsonc / no-document / read / merge /
│   │                      #   write) surfaced per row and every error
│   │                      #   logged. Also exposes the global config
│   │                      #   directory (the log reader's shell cwd).
│   ├── mcpLogs.ts       # ONE MCP server's log, read out of the
│   │                      #   machine-wide opencode main log
│   │                      #   (<XDG_DATA_HOME || ~/.local/share>/
│   │                      #   opencode/log/opencode.log — the ONLY
│   │                      #   data source; verified on v2.0.11 AND
│   │                      #   v2.1-dev: no per-MCP log API/event, the
│   │                      #   MCP protocol's logging notifications are
│   │                      #   never captured). The file is 50MB→25MB
│   │                      #   compacted and fs/read has no ranges, so
│   │                      #   the read rides the SHELL API (the
│   │                      #   worktreeSync.ts precedent): server-side
│   │                      #   `grep -F -s 'server=<name>' | tail -n
│   │                      #   200`, ~200 newest lines back. SHELL
│   │                      #   DIALECT SAFETY (live-observed: this dev
│   │                      #   machine's login shell is fish, which
│   │                      #   rejects POSIX VAR=value and ${VAR:-x}) —
│   │                      #   every command sticks to the fish/POSIX/
│   │                      #   PowerShell common subset (quoted
│   │                      #   commands, `;`, `|`, bare $VAR), so the
│   │                      #   data-dir resolution is its own two-line
│   │                      #   probe (echo $XDG_DATA_HOME; echo $HOME)
│   │                      #   and the grep takes an ABSOLUTE path with
│   │                      #   zero expansion; grep exit 1 ("no match")
│   │                      #   is the empty state, exit 2+/spawn-fail
│   │                      #   falls back to the PowerShell pipeline.
│   │                      #   Probe cached per modal session
│   │                      #   (ExtensionsModal's dataDirRef). Pure
│   │                      #   halves node-testable (mcpLogs.test.ts).
│   ├── visionAttachments.ts # The vision tool's sending half (pure planning +
│   │                      #   one api-bound writer): when the model a prompt is
│   │                      #   bound for lacks image input (catalog
│   │                      #   capabilities.input; unknown = keep inline, zero
│   │                      #   regression), image attachments are NOT inlined as
│   │                      #   prompt parts but written under the global
│   │                      #   config's attachments/ (api.writeBinaryFile) and a
│   │                      #   one-line note is appended to the prompt mapping
│   │                      #   each image's ORIGINAL name to its saved path (a
│   │                      #   JSON {name, path} array — the disk name sanitizes
│   │                      #   CJK away, so the note is the model's only way to
│   │                      #   match "看看 截图.png" to a file) — the model then
│   │                      #   calls the vision tool on them. The note is
│   │                      #   PROTOCOL, hidden from the user: UserBubble
│   │                      #   strips it (splitAttachmentNote, pure — also
│   │                      #   parses the legacy comma-joined format) and shows
│   │                      #   the diverted images as attachment chips instead;
│   │                      #   editResend re-appends the original note so an
│   │                      #   edited prompt keeps its image paths. A failed
│   │                      #   write falls back to inline. THE DIVERT TARGET'S
│   │                      #   RESILIENCE: the config-directory probe
│   │                      #   (GET /api/config) runs once per app run with
│   │                      #   ONE silent retry, every success is remembered
│   │                      #   durably (persistedStore
│   │                      #   "lumina-code:config-directory"), and a dead
│   │                      #   probe falls back to the remembered directory
│   │                      #   across cold starts — on the mobile frp route
│   │                      #   the probe is a full round-trip and its
│   │                      #   transient failure used to degrade a
│   │                      #   text-only model's images to inline, which the
│   │                      #   provider then rejects (live-observed
│   │                      #   glm-5.3: "this model does not support image
│   │                      #   input"); a stale remembrance self-corrects
│   │                      #   (fs/write creates parents, the vision tool
│   │                      #   reads the path just written, the next healthy
│   │                      #   probe re-pins). Only a dead probe with
│   │                      #   NOTHING remembered falls back to inline.
│   │                      #   Wired into BOTH send
│   │                      #   paths (ChatView.handleSend,
│   │                      #   useSessionFlow.sendFirst). node-testable
│   │                      #   (the divert cases re-import the module per
│   │                      #   query — fresh per-run memo + a shared
│   │                      #   localStorage stub re-seeding each instance's
│   │                      #   persisted store).
│   ├── chatMessages.ts     # The transcript's message VIEW MODEL — split from
│   │                      #   types.ts (the pure wire types stay there):
│   │                      #   Assistant*Part, ChatUserMessage (with the
│   │                      #   LOCAL-ONLY localKey/sendFailed/command fields
│   │                      #   of the optimistic UI), the ChatMessage union,
│   │                      #   the type guards + nextLocalId() (the
│   │                      #   collision-proofed `local-*` id every
│   │                      #   optimistic row mints — two sends in one
│   │                      #   Date.now() millisecond used to collide).
│   │                      #   types.ts re-exports it all (34 imports
│   │                      #   unchanged).
│   ├── eventStream.ts     # SSE transport: OpencodeEvent envelope +
│   │                      #   streamServerEvents (fetch-based; the Authorization
│   │                      #   header rules out native EventSource) with backoff
│   │                      #   reconnect.
│   ├── types.ts           # Wire types hand-defined from live observation of server
│   │                      #   v2.0.x (NOT the SDK's shapes) + ChatMessage model +
│   │                      #   PendingCommand + EventMap keyed by bus event type.
│   ├── messageStore.ts    # Pure per-session message reducer: applyEvent (bus →
│   │                      #   list), applySeedPage/applyOlderPage (server merges that
│   │                      #   never truncate streamed content). Clone-on-write —
│   │                      #   untouched messages keep identity so memoized rows
│   │                      #   skip re-render. node-testable.
│   │                      #   THE invariant: streamed reasoning/text deltas exist ONLY
│   │                      #   on the event bus (the server persists a part when it
│   │                      #   ENDS, carrying "" until then), so a list must never be
│   │                      #   rebuilt from a server snapshot alone.
│   │                      #   INTERRUPT SETTLE: v2.0.11 emits NO per-tool
│   │                      #   settle event when a run is interrupted
│   │                      #   (only session.step.failed + the run-level
│   │                      #   session.execution.interrupted), so the
│   │                      #   reducer settles in-flight tool parts on
│   │                      #   the run-level event — without it a running
│   │                      #   part (e.g. a blocking plan_submit) hangs
│   │                      #   every derived pending state (approval
│   │                      #   cards, tool rows) until a re-seed.
│   │                      #   TOOL.PROGRESS MERGE: session.tool.progress
│   │                      #   is the ONLY bus signal carrying a running
│   │                      #   subagent's child metadata.sessionID
│   │                      #   (fires at spawn; tool.called has no
│   │                      #   metadata and the server PERSISTS the
│   │                      #   running part with metadata:{} — both
│   │                      #   binary-verified via live probes), so the
│   │                      #   reducer merges its metadata into
│   │                      #   unsettled SUBAGENT parts only: a
│   │                      #   foreground SHELL's progress also carries a
│   │                      #   shellID its settled state will NOT keep
│   │                      #   (only background shells keep one), and
│   │                      #   merging it would flash foreground commands
│   │                      #   through the terminals list. The seed merge
│   │                      #   backs this up: equal-rank tool parts take
│   │                      #   the page's state EXCEPT its empty
│   │                      #   metadata never wipes a local child link
│   │                      #   (mergePart's metadata rescue) — else every
│   │                      #   re-seed mid-run would hide the subagent
│   │                      #   from the stats panel again.
│   │                      #   SUBAGENT LINK BACKFILL: the progress
│   │                      #   frame is ONE-SHOT (spawn) and the
│   │                      #   server's running snapshot has no child
│   │                      #   id, so any client that MISSED the frame
│   │                      #   (remote SSE gap, cold start into a
│   │                      #   session that is already running — the
│   │                      #   MOBILE norm; desktop loopback SSE
│   │                      #   essentially never drops it) can never
│   │                      #   link the part from the stream alone.
│   │                      #   needsSubagentBackfill (cheap scan) +
│   │                      #   backfillSubagentLink re-link it from the
│   │                      #   SESSION LIST (parentID reverse lookup):
│   │                      #   conservative one-to-one — exactly one
│   │                      #   unlinked running part ∧ exactly one
│   │                      #   candidate child (parentID match, not
│   │                      #   referenced by any part's metadata, not a
│   │                      #   lumina-tools helper, created at/after
│   │                      #   the calling part — the time bound
│   │                      #   rejects an errored earlier turn's
│   │                      #   orphaned child, since error settle
│   │                      #   carries NO metadata); ambiguity keeps
│   │                      #   the list unchanged rather than guess.
│   │                      #   Wired into EVERY seed path by
│   │                      #   useSessionMessages (requestSeed →
│   │                      #   backfillSubagentLinks), so the remote
│   │                      #   reconnect heal re-runs it per gap.
│   │                      #   EDIT-LAST-MESSAGE: dropFromBoundary + the
│   │                      #   session.revert.committed event case truncate a
│   │                      #   list at the first id >= boundary (the TUI's
│   │                      #   cache rule; `local-` bubbles sort before
│   │                      #   `msg_` ids and survive) — the revert commit
│   │                      #   emits no per-message removal events.
│   ├── pendingCommands.ts # Pure registry of pending slash-command submissions
│   │                      #   (compact `/name args` forms stamped onto the
│   │                      #   confirming enqueue event; per-session FIFO + undo).
│   ├── sessionStopping.ts # The per-session STOPPING marker (module store +
│   │                      #   useSyncExternalStore binding, the
│   │                      #   useSessionMessages snapshot pattern):
│   │                      #   OpenCode's interrupt is NOT instantaneous —
│   │                      #   the POST returns once the abort is REQUESTED,
│   │                      #   the run-end event only when it unwinds — so
│   │                      #   useSessionMessages.interrupt() marks the
│   │                      #   session the moment the button is pressed and
│   │                      #   the tail's working indicator force-shows
│   │                      #   "Stopping" through the gap. The bus fold
│   │                      #   (applyStoppingBusEvent, called from
│   │                      #   useSessions' global handler) settles it on
│   │                      #   execution.succeeded/failed/interrupted /
│   │                      #   started (superseded) / session.deleted; the
│   │                      #   interrupt call itself clears on a false
│   │                      #   response (idle session — no end event would
│   │                      #   come) or a throw. Event-vs-response order is
│   │                      #   safe both ways (clearing is idempotent, a
│   │                      #   true response never re-marks); a stale
│   │                      #   marker is inert — the indicator also needs
│   │                      #   busy, and the next execution.started clears.
│   │                      #   The marker ALSO fences sends: send() and
│   │                      #   editResend() refuse to POST while it is up
│   │                      #   (see useSessionMessages — a prompt landing
│   │                      #   during the stop's cleanup would restart the
│   │                      #   run server-side).
│   ├── planWorkflow.ts    # The plan workflow's transcript derivations —
│   │                      #   the FRONTEND MIRROR of the plugin's
│   │                      #   planStateFromEntries fold, split from
│   │                      #   sessionActivity.ts along domain lines:
│   │                      #   collectSessionTodos (the LAST plan_submit
│   │                      #   defines the list; task_complete/plan_amend/
│   │                      #   work_submit advance it), planApprovalPending
│   │                      #   / workApprovalPending (Route A's two gates
│   │                      #   over lastUnsettledPart), findPlanSubmitInput,
│   │                      #   GateContext. sessionActivity re-exports it
│   │                      #   (imports unchanged); keep in sync with the
│   │                      #   plugin source.
│   ├── promptQueue.ts    # The per-session QUEUED-PROMPT store — now a MIRROR
│   │                      #   of the SERVER's native queue (v2.0.11
│   │                      #   `delivery:"queue"`, curl-verified): prompts
│   │                      #   composed mid-run POST with delivery:"queue"
│   │                      #   and park in the server's PERSISTED inbox
│   │                      #   (session_pending table, enqueued_seq order)
│   │                      #   — every client of the server (desktop
│   │                      #   windows AND the mobile app) reads the same
│   │                      #   rows, and they survive app kills (the old
│   │                      #   in-memory queue never synced across
│   │                      #   devices, which was the bug). Division of
│   │                      #   labor (binary- + live-verified): PARKING —
│   │                      #   steer-mode drain never sees queue rows, so
│   │                      #   the running turn is untouched; FLUSH — the
│   │                      #   SERVER does it (the POST's wake lingers as
│   │                      #   pendingWake="input"; the run's natural end
│   │                      #   drains queue rows as fresh turns — multiple
│   │                      #   queued rows chain inside one successor
│   │                      #   execution); DISPLAY — rows render above the
│   │                      #   composer ONLY (messageStore's enqueued case
│   │                      #   skips delivery:"queue" user rows; the
│   │                      #   delivered frame appends the transcript
│   │                      #   message under the SAME id); STOP — the
│   │                      #   interrupt's inbox sweep cancels every
│   │                      #   pending row server-side. The store itself
│   │                      #   (module store + useSyncExternalStore, the
│   │                      #   sessionStopping pattern): seeded from GET
│   │                      #   /api/session/{id}/inbox on every
│   │                      #   requestSeed (mount / surface warm / the
│   │                      #   mobile SSE-reconnect heal), live-patched
│   │                      #   from the bus (applyQueueBusEvent in
│   │                      #   useSessions: enqueued/cancelled/delivered/
│   │                      #   session.deleted; the pending-command
│   │                      #   stamp is consumed HERE — messageStore
│   │                      #   leaves it for queue rows). In-flight POSTs
│   │                      #   render optimistically (local-* sending
│   │                      #   rows); the POST RESPONSE IS the inbox row
│   │                      #   (live-verified), so adoption is a straight
│   │                      #   id swap; a dead POST keeps a failed row
│   │                      #   (retry affordance). Queued COMMANDS ride
│   │                      #   as their expanded template text (the
│   │                      #   command endpoint takes no delivery
│   │                      #   parameter). REORDER (drag) has no server
│   │                      #   API — the commit REWRITES the queue
│   │                      #   (cancel + re-POST in the new order,
│   │                      #   useSessionMessages.rewriteQueuedOrder).
│   │                      #   "STOP AND SEND" (⚡) still never steers the
│   │                      #   running turn: the queue's content is
│   │                      #   snapshotted locally (the sweep deletes the
│   │                      #   server rows), the run interrupted, and
│   │                      #   ChatView's flush effect re-POSTs the batch
│   │                      #   in the first idle window — expedited first
│   │                      #   (click order), the rest in queue order
│   │                      #   (takeExpeditedBatch; the first POST
│   │                      #   executes immediately, the rest park and
│   │                      #   chain). "edit" loads text + attachments
│   │                      #   back into the composer via queuedRowToDraft
│   │                      #   (divert note stripped, saved images
│   │                      #   re-referenced as file:// chips; ChatInput's
│   │                      #   draftLoad prop — mention nodes degrade to
│   │                      #   plain @path text). Node-testable pure
│   │                      #   halves: mergeSeedRows / foldQueuedRows /
│   │                      #   planQueueRewrite / mergeExpeditedSnapshot
│   │                      #   (promptQueue.test.ts). KNOWN EDGE: after a
│   │                      #   SERVER restart, idle leftover queue rows
│   │                      #   have no wake — they drain with the user's
│   │                      #   next POST (seq order), acceptable.
│   ├── turnEdits.ts      # The per-turn EDIT SUMMARY store (module store +
│   │                      #   useSyncExternalStore, the sessionStopping
│   │                      #   pattern): one entry per (session, user
│   │                      #   message) holding the files that prompt's
│   │                      #   TURN changed + summed line counts, fetched
│   │                      #   from api.sessionTurnDiff (the server's
│   │                      #   SNAPSHOT-based per-turn diff — authoritative,
│   │                      #   includes subagent/bash edits no client-side
│   │                      #   fold over tool inputs can see). A turn's
│   │                      #   diff is immutable once the turn ended, so
│   │                      #   entries cache FOREVER with in-flight
│   │                      #   dedupe (RunFooter mounts trigger
│   │                      #   ensureTurnEdits); session.deleted drops a
│   │                      #   session's entries (applyTurnEditsBusEvent,
│   │                      #   folded from useSessions' global handler
│   │                      #   next to applyStoppingBusEvent). Snapshot-less
│   │                      #   projects (no git / snapshot:false) settle as
│   │                      #   error and the footer chip stays hidden — no
│   │                      #   snapshot data, no summary. summarizeTurnDiff
│   │                      #   is pure + node-testable (turnEdits.test.ts).
│   ├── connectionContext.tsx # THE CONTEXT SPLIT, base layer: ConnectionProvider
│   │                      #   + useConnection() distribute useOpencode's api/
│   │                      #   subscribe/status to anything needing a raw handle
│   │                      #   (settings' credential flows, composer file/command
│   │                      #   lookups, terminal output polling) — no more
│   │                      #   api/subscribe props threaded through every level.
│   ├── catalogContext.tsx # Settings-domain layer: CatalogProvider hosts
│   │                      #   useModelCatalog ONCE; useCatalog() feeds the
│   │                      #   composer pickers, ChatView's image-capability
│   │                      #   check and useSessionFlow's fallback pick.
│   │                      #   Separate from session data on purpose — the
│   │                      #   catalog changes on credential/config events,
│   │                      #   not with the session list.
│   ├── sessionDataContext.tsx # Session-domain layer: SessionDataProvider hosts
│   │                      #   useSessions + useSessionRequests ONCE;
│   │                      #   useSessionData() (list/busy/CRUD/pending
│   │                      #   asks + the IMPORT surfaces —
│   │                      #   foreignSessions/importSessions for
│   │                      #   ImportSessionsModal and the sidebar's
│   │                      #   count badge),
│   │                      #   useSessionTranscript(sessionId) (message store
│   │                      #   binding — mounting it still seeds an unseeded
│   │                      #   session), usePendingRequests(sessionId),
│   │                      #   useWorkspaceDiffOf/useSessionActivityOf (the
│   │                      #   stats card's scopes). Views stop caring whether
│   │                      #   data comes from the module caches or off the
│   │                      #   wire; the stores themselves are untouched.
│   │                      #   The surface choreography's readiness protocol
│   │                      #   builds on this provider (see ensureSessionSeeded).
│   ├── useOpencode.ts     # Server connection: invoke("opencode_start") → API client
│   │                      #   + auth token + event stream; subscribe() fans frames out
│   │                      #   to handlers. Server lifecycle is Rust-owned — the effect
│   │                      #   cleanup deliberately does NOT stop it, so StrictMode's
│   │                      #   mount/unmount/mount can't tear it down. "opencode-status"
│   │                      #   events surface async exits as {state:"error"}.
│   ├── sessionRegistry.ts # THE sidebar's session WHITELIST (the fix for
│   │                      #   the recurring "untitled session in the home
│   │                      #   dir" strangers): the ids of sessions created
│   │                      #   by THIS app's UI, persisted via the factory
│   │                      #   ("lumina-code:session-registry") — membership
│   │                      #   is granted at the creation choke-point
│   │                      #   (useSessions.create ← sendFirst), by USER
│   │                      #   IMPORT (useSessions.importSessions ←
│   │                      #   ImportSessionsModal, fed by
│   │                      #   importableSessions — the root sessions the
│   │                      #   server lists but the registry does not
│   │                      #   hold), and AUTOMATICALLY for sessions
│   │                      #   stamped {source: "lumina-code"} by ANY
│   │                      #   Lumina Code client (CLIENT_SOURCE +
│   │                      #   autoRegisterClientSessions — every create
│   │                      #   stamps it, the seed/relist folds register
│   │                      #   stamped strangers: another desktop window
│   │                      #   or the MOBILE app joins the sidebar without
│   │                      #   manual import; the whitelist isolates
│   │                      #   subagents + third-party OpenCode software,
│   │                      #   never Lumina Code's own instances), and
│   │                      #   revoked on every deletion path
│   │                      #   (useSessions.remove, the session.deleted
│   │                      #   event, seed-time prune); sessions created
│   │                      #   by anything else (TUI/CLI, other instances
│   │                      #   — OpenCode storage is shared) stay out of
│   │                      #   the sidebar until imported. Also the ROOT
│   │                      #   predicate (isRootSession: no parentID, not
│   │                      #   a lumina-tools helper — the server's
│   │                      #   ?roots=true does not work) shared by the
│   │                      #   sidebar view, the import candidates and
│   │                      #   the one-time ADOPTION. `null` = NOT YET
│   │                      #   ADOPTED (key absent / malformed — write(null)
│   │                      #   removes the key, the factory's absence
│   │                      #   semantics): the first successful session list
│   │                      #   after connect adopts the visible root
│   │                      #   sessions wholesale (one-time migration;
│   │                      #   upgrade-time strangers need one manual
│   │                      #   delete), after which even an EMPTY list
│   │                      #   persists as "[]". The seed also prunes ids
│   │                      #   the server no longer lists — but an empty
│   │                      #   server list prunes NOTHING (the documented
│   │                      #   transient-empty storage race must never wipe
│   │                      #   the registry; missingRegisteredIds guards).
│   │                      #   Plain-function accessors, no React binding
│   │                      #   (mutations always coincide with useSessions'
│   │                      #   own list updates); array order = registration
│   │                      #   order, the substrate for future pin /
│   │                      #   fixed-sort features. DirectoryPicker's
│   │                      #   quick-picks share the membership check
│   │                      #   (unionMembership). node-testable (storage-stub + dynamic-import
│   │                      #   pattern; parseRegistryRaw exported for the
│   │                      #   read-shape cases). This store is the LOCAL
│   │                      #   HALF of membership only — derivation is
│   │                      #   always local ∪ shared
│   │                      #   (sessionWhitelistSync.ts, the entry right
│   │                      #   below); the local layer doubles as the
│   │                      #   offline buffer and the lost-update healing
│   │                      #   source (each seed union-pushes it into the
│   │                      #   shared file), and the one-time ADOPTION
│   │                      #   prefers the shared file's ids (a fresh
│   │                      #   device starts with the SAME sidebar as
│   │                      #   every other client) before falling back
│   │                      #   to the visible roots.
│   ├── sessionWhitelistSync.ts # THE SERVER-SHARED half of the session
│   │                      #   whitelist (sessionRegistry.ts is the local
│   │                      #   half): one id array at <global config
│   │                      #   dir>/lumina/whitelist.json on the machine
│   │                      #   running the opencode server — membership
│   │                      #   every Lumina Code client (desktop windows,
│   │                      #   CEF shell, mobile) can read AND write via
│   │                      #   the same fs channel the lumina-tools
│   │                      #   installer uses (fs/read location-confined,
│   │                      #   experimental/fs/write absolute + creates
│   │                      #   parents, curl-verified v2.0.11). WHY a
│   │                      #   file: session metadata is create-only on
│   │                      #   v2.0.11 (PATCH /api/session/{id} silently
│   │                      #   drops a metadata field, only title sticks
│   │                      #   — live-verified), so the create-time
│   │                      #   CLIENT_SOURCE stamp can never be
│   │                      #   retrofitted onto existing sessions, and
│   │                      #   per-device registries diverge (import on
│   │                      #   one device never reached the others —
│   │                      #   the cross-device import-list mismatch).
│   │                      #   SEMANTICS: membership = local ∪ file,
│   │                      #   derived at every seed/relist; the file
│   │                      #   only GROWS by union (every writer reads
│   │                      #   fresh, unions, writes back — mergeWhitelist
│   │                      #   is the ONE write primitive) and only
│   │                      #   shrinks by server-confirmed deletion or
│   │                      #   dead-id compaction against the live
│   │                      #   session list (empty list compacts
│   │                      #   nothing — the same transient-empty guard
│   │                      #   as missingRegisteredIds). Direction
│   │                      #   guarantee: a sync race can delay one
│   │                      #   registration from appearing elsewhere
│   │                      #   (the victim's next seed re-pushes from
│   │                      #   its local layer and converges) but can
│   │                      #   NEVER remove a live session from a
│   │                      #   sidebar. Unknown read failures abort the
│   │                      #   pending write (no clobbering over the
│   │                      #   unknowable); the documented fs/read
│   │                      #   500-missing-dir quirk reads as absent;
│   │                      #   no config target degrades everything to
│   │                      #   local-only behavior. Exposes a
│   │                      #   synchronous snapshot serverWhitelistIds()
│   │                      #   (empty until the first read — the derive
│   │                      #   then equals the old local-only world).
│   │                      #   The pure halves (unionIds, the merge math
│   │                      #   over a fake api) are node-testable
│   │                      #   (sessionWhitelistSync.test.ts).
│   ├── useSessions.ts     # Sidebar list: a WHITELIST view over the server
│   │                      #   session list — only members of the local
│   │                      #   registry ∪ the shared whitelist file
│   │                      #   (sessionRegistry.ts +
│   │                      #   sessionWhitelistSync.ts) are listed. Seeded from
│   │                      #   GET /api/session, live-patched
│   │                      #   from the bus; root sessions only (subagent children carry
│   │                      #   parentID and would flood the list; the tools plugin's
│   │                      #   helper sessions hide via their {source:
│   │                      #   "lumina-tools"} metadata marker — still checked
│   │                      #   for the registry's ADOPTION filter — and are DELETED
│   │                      #   by this hook once their execution ends, plus a
│   │                      #   one-per-connection sweep of leftovers, because
│   │                      #   v2.0.11's plugin API has no session delete);
│   │                      #   session.agent.selected patches the mode in place
│   │                      #   (covers the model switching itself into Plan
│   │                      #   Mode via the plan_mode tool); busy set seeded from
│   │                      #   GET /api/session/active (a stale busy id blocks the
│   │                      #   composer forever — the seed must not resurrect ids watched
│   │                      #   end); create/remove/patch (optimistic model/agent; create also
│   │                      #   stamps metadata.mode beside CLIENT_SOURCE — which sidebar half
│   │                      #   the session belongs to, derived back by appMode.sessionMode)
│   │                      #   also grant/revoke the whitelist membership —
│   │                      #   and create STAMPS {source: CLIENT_SOURCE},
│   │                      #   the cross-instance marker whose stamped
│   │                      #   strangers the seed/relist folds auto-register
│   │                      #   (another window / the mobile app joins the
│   │                      #   sidebar live, no manual import).
│   │                      #   THE IMPORT HALF: foreignSessions — the same
│   │                      #   list's root-session complement (server roots
│   │                      #   NOT in the registry — TUI/CLI/other-instance
│   │                      #   sessions in the shared storage), maintained by
│   │                      #   the same seed/relist folds — feeds the import
│   │                      #   picker (ImportSessionsModal via the session-
│   │                      #   data context), and importSessions(ids) grants
│   │                      #   membership (registerSession + relist; the
│   │                      #   session itself already lives on the server —
│   │                      #   importing moves nothing but the whitelist
│   │                      #   entry; busy state is id-tracked globally and
│   │                      #   just works).
│   ├── useSessionMessages.ts # React binding over a MODULE-LEVEL store (one entry per
│   │                      #   session, surviving ChatView unmounts AND webview reloads
│   │                      #   — backgrounded sessions keep accumulating deltas; entries
│   │                      #   drop on session.deleted). One global bus handler applies
│   │                      #   events to every tracked session. Cursor-based loadOlder;
│   │                      #   `seeding` tells consumers whether an empty list is still
│   │                      #   loading. The messages state seeds from the store at FIRST
│   │                      #   RENDER (not first effect) — a session switched back to
│   │                      #   paints in the mounting commit. Exports
│   │                      #   subscribeSessionMessages/peekSessionMessages for the
│   │                      #   activity store's background freshness, plus
│   │                      #   useSessionMessagesSnapshot — a read-only
│   │                      #   useSyncExternalStore binding for consumers that
│   │                      #   outlive session switches (the stats card) — AND THE
│   │                      #   READINESS PROTOCOL of the surface choreography:
│   │                      #   ensureSessionSeeded(api, id) warms an unopened
│   │                      #   session's store without mounting its view (called at
│   │                      #   switch/hover time), useSessionSeeded(id) is its
│   │                      #   boolean useSyncExternalStore mirror, and a FAILED seed
│   │                      #   still sets seeded+notify (otherwise the loading phase
│   │                      #   would loop forever). Every seed path also runs
│   │                      #   backfillSubagentLinks — the missed-
│   │                      #   tool.progress recovery (a running subagent
│   │                      #   part re-linked from the session list's
│   │                      #   parentID; see messageStore's SUBAGENT LINK
│   │                      #   BACKFILL) — so a remote client heals a
│   │                      #   dropped child link at the next seed,
│   │                      #   including the SSE-reconnect reseed.
│   │                      #   prepareCommandSubmission pre-creates the entry so a
│   │                      #   first-send slash command keeps its enqueue frame;
│   │                      #   a session.model.selected event re-pulls the newest
│   │                      #   page — the model-switch marker it persists has no
│   │                      #   message frame, so the divider lands live.
│   │                      #   EDIT-LAST-MESSAGE: editResend(message,
│   │                      #   text, editFiles?) is the whole flow — stage
│   │                      #   the revert AT the message, commit (deletes
│   │                      #   it + the turn after, undoing their file
│   │                      #   changes), drop the range from the store
│   │                      #   EAGERLY (the confirming bus event is then
│   │                      #   a no-op), then re-send the edited text
│   │                      #   with the composer's staged attachments or
│   │                      #   the ORIGINAL ones (no vision-diversion
│   │                      #   rerun — the composer edits the note-free
│   │                      #   text, so the ORIGINAL message's note is
│   │                      #   parsed back out and re-appended, keeping
│   │                      #   a text-only model's image paths).
│   │                      #   A failed commit unwinds via clearRevert
│   │                      #   and returns false. FAILED-SEND SEMANTICS:
│   │                      #   a POST that dies (network, the mobile frp
│   │                      #   route, sendPrompt's 120s abort) does NOT
│   │                      #   drop the optimistic bubble — markOptimistic
│   │                      #   Failed keeps it as a sendFailed row whose
│   │                      #   UserBubble renders an always-visible
│   │                      #   "Failed to send" + retry (ChatView.
│   │                      #   handleRetrySend: drop the row, filesFrom
│   │                      #   Message rebuilds the attachments, deliver
│   │                      #   re-runs — the divert note already rides
│   │                      #   the stored text, so the re-divert pass
│   │                      #   appends no second note); the welcome
│   │                      #   screen's first send has no bubble yet, so
│   │                      #   sendFirst's failure goes through the
│   │                      #   exported appendFailedPrompt (a ready-made
│   │                      #   failed row straight into the new session's
│   │                      #   store). Self-healing duplicates are
│   │                      #   impossible: the enqueued event ADOPTS the
│   │                      #   failed row by text (a timeout whose POST
│   │                      #   actually landed), and a re-seed's merge
│   │                      #   drops local rows the page already carries.
│   │                      #   THE INTERRUPT SWEEP +
│   │                      #   SEND FENCE (v2.0.11, source-verified):
│   │                      #   the server's interrupt kills ONLY the
│   │                      #   in-flight execution — prompts POSTed
│   │                      #   mid-run (a raw steer — this client no
│   │                      #   longer produces them, see promptQueue's
│   │                      #   "stop and send") park in the PERSISTED session
│   │                      #   inbox as pending steer rows (a delivery-less
│   │                      #   POST defaults to steer; only a step boundary promotes them
│   │                      #   into the turn), and they SURVIVE the stop:
│   │                      #   a POST landing after the interrupt restarts
│   │                      #   the run as a successor execution, and rows
│   │                      #   left parked resurrect inside the NEXT turn's
│   │                      #   first promotion. interrupt() therefore (1)
│   │                      #   SWEEPS the inbox after the interrupt POST
│   │                      #   (list + DELETE every pending row — api.ts
│   │                      #   listSessionInbox/cancelSessionInbox; best-
│   │                      #   effort, logged) and (2) FENCES send()/
│   │                      #   editResend() on the stopping marker: a
│   │                      #   prompt whose POST would fire inside the
│   │                      #   stop window is dropped instead (stop means
│   │                      #   stop). messageStore drops the cancelled
│   │                      #   rows' ghost bubbles on
│   │                      #   session.inbox.cancelled. ALSO THE QUEUE
│   │                      #   ACTION SET (the server-native queue's
│   │                      #   client half, see promptQueue.ts):
│   │                      #   sendQueued (the busy-path POST with
│   │                      #   delivery:"queue" — optimistic row, the
│   │                      #   POST response adopts the server id, a
│   │                      #   dead POST keeps a retryable failed row),
│   │                      #   retryQueued / removeQueued (cancel +
│   │                      #   restore-on-failed-cancel) /
│   │                      #   deliverQueuedRows (the "stop and send"
│   │                      #   re-POST batch) / rewriteQueuedOrder (drag
│   │                      #   reorder = cancel + re-POST, no server
│   │                      #   reorder API); every requestSeed also seeds
│   │                      #   the queue mirror, and the bus handler
│   │                      #   appends a delivered queue row's transcript
│   │                      #   message from the row content it holds
│   │                      #   (appendUserMessage, id = the inboxID).
│   ├── useSessionFlow.ts  # App-level session flow: active session id + composer
│   │                      #   staging (pendingModel/pendingAgent/pendingDirectory
│   │                      #   seeded from lib/persist.ts, plus the NOT-persisted
│   │                      #   pendingBranch — the welcome picker's staged branch
│   │                      #   binding; a branch is staged per composition, a
│   │                      #   restart starts fresh), changeModel/changeAgent/
│   │                      #   changeStagedBranch/changeDirectory/newSession/
│   │                      #   deleteSession, sendFirst (create-then-deliver with
│   │                      #   the slash-command fallback; MODE-SPLIT directory rules — daily
│   │                      #   resolves + ensures the fixed LuminaWorkspace (opencode/
│   │                      #   defaultWorkspace.ts) and stamps its sessions, dev REQUIRES a
│   │                      #   staged project (no default — sendBlocked refuses a bare send)
│   │                      #   and creates the linked worktree for a staged branch; a branch-bound send
│   │                      #   FIRST creates the linked worktree via
│   │   │                  #   resolveBranchDirectory — POST /api/worktree with
│   │                      #   projectID from worktreeSessions, recorded in the
│   │                      #   worktree map, every failure falling back to the
│   │                      #   MAIN worktree with a log), newSession seeding a
│   │                      #   worktree session's successor on the MAIN repo
│   │                      #   (mainDirFor; an explicit folder "+" still takes
│   │                      #   the worktree dir literally — shared-checkout
│   │                      #   semantics on the pinned branch), and the
│   │                      #   cross-restart save. MODE-SWITCH MEMORY: each half remembers the
│   │                      #   session it had open when left (modeSessionsRef,
│   │                      #   null = welcome screen, persisted as ui-state
│   │                      #   daily/devSessionId) and switching back
│   │                      #   RESTORES it — only if it still exists and
│   │                      #   belongs to that half (else the welcome
│   │                      #   screen; the sync effect's ownership guard
│   │                      #   keeps the switch render's stale activeId out
│   │                      #   of the new half's entry). Consumes the context split
│   │                      #   (connection handles + catalog + the
│   │                      #   provider-hosted session list) — no parameters.
│   ├── useSessionRequests.ts # Pending server→user asks across ALL sessions (permission
│   │                      #   requests + forms), seeded from the list endpoints then
│   │                      #   bus-maintained; a pending ask blocks the session's
│   │                      #   execution server-side. Global, not per-session, so sidebar
│   │                      #   badges work for inactive sessions. The plan workflow's
│   │                      #   pending APPROVAL folds into the same pendingCounts via
│   │                      #   a module store over the message transcript
│   │                      #   (planApprovalPending + workApprovalPending
│   │                      #   — Route A's two gates; see
│   │                      #   PlanApprovalCard / WorkReviewCard) — same
│   │                      #   badge as questions. Deliberately STATUS-ONLY
│   │                      #   (no GateContext): a badge on a restart-
│   │                      #   orphaned gate draws the user to the session
│   │                      #   whose card waits in recovery mode — the card
│   │                      #   site (ChatView) reads the full context. Also
│   │                      #   exports peekGateFlags (the plan/work flags'
│   │                      #   read-only peek — the notification composer
│   │                      #   asks WHICH attention kind appeared;
│   │                      #   pendingCounts only carries counts).
│   │                      #   The optimistic reply/cancel settle is 404-TOLERANT:
│   │                      #   the server's reject/always replies CASCADE over the
│   │                      #   session's other pending asks (and grouped identical
│   │                      #   asks are answered with several replies), so a 404
│   │                      #   means "already settled" — no restore, or the card
│   │                      #   would zombie (api.requestRaw attaches the status).
│   ├── sessionActivity.ts # Pure stats-card derivations from a session's messages:
│   │                      #   SLIMMED: the plan-workflow folds live in
│   │                      #   planWorkflow.ts (re-exported here); this file
│   │                      #   keeps the tool-name predicates, toolParts /
│   │                      #   inputRecord / metaString low-level helpers and
│   │                      #   the shells/subagents/mutation collectors.
│   │                      #   background shells (tool-part metadata.shellID — only
│   │                      #   background results carry it) with their completion
│   │                      #   notifications (marker messages with metadata.source ===
│   │                      #   "shell"), subagent child sessions (part metadata.sessionID,
│   │                      #   deduped — continuation reuses the child id), each item
│   │                      #   stamped currentTurn (spawned/re-referenced at/after the
│   │                      #   last user message — the stats card hides COMPLETED items
│   │                      #   from earlier turns; running ones stay, filtered in
│   │                      #   useSessionActivity where running state is known), the
│   │                      #   mutation signature (file-mutation count + last confirmed
│   │                      #   user message id — streamed frames never move it), and
│   │                      #   the PLAN-WORKFLOW state: collectSessionTodos (the LAST
│   │                      #   plan_submit part defines the list — status "error" =
│   │                      #   rejected, no active plan; running = pendingApproval —
│   │                      #   and subsequent COMPLETED task_complete/plan_amend parts
│   │                      #   advance it, a COMPLETED work_submit marks it archived
│   │                      #   (terminal — acceptance happened); the FRONTEND MIRROR of
│   │                      #   the plugin's planStateFromEntries fold — keep the two
│   │                      #   in sync; the plan folds take an optional GATECONTEXT
│   │                      #   {agent, decided} — RESTART RECOVERY: a part frozen
│   │                      #   running under agent "build" reads as APPROVED (the
│   │                      #   switch IS the approval, mirroring the plugin's
│   │                      #   agentNow rule) and a locally recorded verdict
│   │                      #   (gateDecisions.ts, partId-keyed) settles a frozen
│   │                      #   gate the storage can't; payloads carry partId) +
│   │                      #   findPlanSubmitInput (locates a pending request's plan
│   │                      #   payload via its permission source part id, falling
│   │                      #   back to the last plan_submit; a located-but-malformed
│   │                      #   source never substitutes another plan) +
│   │                      #   planApprovalPending (the LAST plan_submit
│   │                      #   part while still running — Route A's
│   │                      #   pending-approval signal, driving the
│   │                      #   approval card) + workApprovalPending (its
│   │                      #   work_submit twin — the pending ACCEPTANCE,
│   │                      #   driving WorkReviewCard).
│   │                      #   node-testable.
│   ├── gateDecisions.ts # Locally recorded verdicts for RESTART-ORPHANED gate
│   │                      #   parts (the plan workflow's second recovery pillar
│   │                      #   beside agent-as-truth): a createPersistedStore
│   │                      #   ("lumina-code:gate-decisions", session → partId →
│   │                      #   "rejected"|"accepted") written by ChatView's
│   │                      #   orphan decision handlers and read by the
│   │                      #   sessionActivity folds via GateContext.decided, so
│   │                      #   a decided card never resurfaces after another
│   │                      #   restart. Plan APPROVALS need no record (the agent
│   │                      #   switch is server-persisted); work ACCEPTANCES are
│   │                      #   doubly durable as the review marker file. Entries
│   │                      #   are deliberately never cleaned (rare, inert for
│   │                      #   deleted sessions).
│   ├── notificationTriggers.ts # The desktop-notification DECISION layer (pure,
│   │                      #   node-testable — hooks/useNotifications.ts owns
│   │                      #   the subscribing/sending half): the three-tier
│   │                      #   mode (off / minimal = run ends only / full =
│   │                      #   run ends + every user-attention event), the
│   │                      #   focus-mute rule (suppress only while the
│   │                      #   window is focused AND the event belongs to
│   │                      #   the OPEN session — background sessions still
│   │                      #   notify), interrupted excluded BY TYPE (an
│   │                      #   interrupt can only be user-initiated from
│   │                      #   this window), attention-kind priority
│   │                      #   (work > plan > question > permission) and
│   │                      #   the i18n title keys + notifySubject (title →
│   │                      #   folderLabel(directory) → "Lumina Code").
│   ├── useSessionActivity.ts # Stats-card state, split by scope, both over
│   │                      #   MODULE-LEVEL stores (the useSessionMessages
│   │                      #   pattern): (1) the WORKSPACE DIFF — one entry
│   │                      #   per DIRECTORY (GET /api/vcs/diff?mode=working,
│   │                      #   HEAD vs the working copy, untracked included),
│   │                      #   shared by every session in the directory so a
│   │                      #   same-directory switch paints identical numbers
│   │                      #   with no re-entry. This REPLACED the per-session
│   │                      #   diff endpoint (GET /api/session/{id}/diff),
│   │                      #   which compares whole-worktree snapshot trees
│   │                      #   over the session's TIME WINDOW — sessions in
│   │                      #   one directory share one physical worktree and
│   │                      #   snapshot repo, so a sibling session's edits
│   │                      #   leaked into an idle session's "own" diff.
│   │                      #   (2) the active session's TERMINALS + SUBAGENTS
│   │                      #   (running shells seeded from GET /api/shell,
│   │                      #   patched by the global shell bus; collections
│   │                      #   from the message store via the read-only
│   │                      #   useSessionMessagesSnapshot binding — the card
│   │                      #   outlives same-directory session switches and
│   │                      #   must not show the previous session's rows for
│   │                      #   a frame). A message-store watcher re-pulls a
│   │                      #   directory's diff (debounced) when any of its
│   │                      #   sessions' mutation signatures move, so
│   │                      #   backgrounded sessions keep the numbers fresh.
│   │                      #   (3) the active session's plan-workflow TODOS —
│   │                      #   a pure collectSessionTodos fold over the same
│   │                      #   snapshot (identity-cached like the others), no
│   │                      #   endpoints or bus of its own.
│   │                      #   prefetchSessionActivity (sidebar hover, wired
│   │                      #   in App) warms the scopes ahead of the click.
│   │                      #   Derived arrays are identity-stable across
│   │                      #   streamed frames.
│   ├── workspaceDocuments.ts # THE DAILY SIDE of the workspace panel —
│   │                      #   what useSessionActivity's git diff is for dev,
│   │                      #   done for a plain folder of DOCUMENTS where
│   │                      #   line counts are meaningless. Scanning rides
│   │                      #   the SHELL API (fs routes can't list
│   │                      #   directories): one POSIX pass (`find <dir>
│   │                      #   -type f -not -path '*/.*' -exec wc -c {} +`
│   │                      #   — find hands paths to wc as argv, so spaces
│   │                      #   and CJK survive; legal in fish/POSIX alike)
│   │                      #   falling back to a PowerShell pipeline on
│   │                      #   failure (the mcpLogs dialect ladder). The
│   │                      #   ROLLING BASELINE: each scan diffs against the
│   │                      #   previous one — files that appeared or changed
│   │                      #   SIZE wear 新增/变更 chips (a docx is rewritten
│   │                      #   wholesale by python-docx, so a size delta IS
│   │                      #   the change signal), settling to a plain
│   │                      #   inventory on the next scan; deletes just drop
│   │                      #   off. Stateful half = the directory-keyed
│   │                      #   module store + useWorkspaceDocuments (the
│   │                      #   useWorkspaceDiff pattern; mounted via
│   │                      #   sessionDataContext's useWorkspaceDocumentsOf,
│   │                      #   refreshed on run-end bus events debounced +
│   │                      #   busy→idle). Pure halves (parseSizeLines —
│   │                      #   wc's total rows dropped, CRLF tolerated, cap
│   │                      #   MAX_DOC_ROWS; diffDocs; sortDocRows;
│   │                      #   humanSize) node-testable.
│   ├── useModelCatalog.ts # Providers/agents/models + server default, fetched per
│                          #   connection AND re-fetched whenever the bus reports
│                          #   credential.updated / config.updated (connecting a key
│                          #   in the model-config modal, writing custom providers…).
│                          #   Exposes catalogOnly (only the free Zen catalog = the
│                          #   picker's "no models configured" state). Free-catalog
│                          #   (OpenCode Zen) models hidden
│                          #   unless they're all the user has. Provider/agent reads
│                          #   RETRY on transient empties (a second opencode instance
│                          #   holding the shared storage lock) — an empty provider list
│                          #   must never leak into the filter (`every()` is vacuously
│                          #   true on [] and would unhide the free catalog).
│                          #   Also exposes loaded — the INITIAL load's
│                          #   settle flag (success or final failure;
│                          #   reset only on api identity change, NOT on
│                          #   revision refetches) feeding the boot gate
│                          #   (components/BootScreen.tsx).
│   ├── gitInfo.ts         # THE branch-parsing pure layer (node-testable):
│                          #   parseGitHead (a `.git/HEAD` text → branch name |
│                          #   detached sha — the server has NO current-branch
│                          #   endpoint; `/api/vcs/branch` is a markerless LIST,
│                          #   verified live), shapeBranchList (that list's raw
│                          #   entries interleave local branches, bare remote
│                          #   NAMES ("origin") and remote refs ("origin/x") —
│                          #   the prefix relation classifies them; local names
│                          #   may contain slashes, so the "/" split alone
│                          #   doesn't), shortSha, PLUS the default-branch
│                          #   pair feeding BranchPicker's 「主分支」chip:
│                          #   parseRemoteHead (`.git/refs/remotes/<remote>/HEAD`
│                          #   symref → the remote's default branch; symrefs
│                          #   are always loose files, so fs/read is reliable)
│                          #   and pickDefaultBranch (remote HEAD wins when
│                          #   local, else conventional main → master, else
│                          #   null — no chip rather than a guess). Feeds the
│                          #   title-bar chip and the picker's branch section.
│   ├── useDirectoryBranch.ts # The title bar's per-directory branch, cached in
│                          #   a MODULE store keyed by directory (the
│                          #   useSessionActivity directory-map pattern —
│                          #   same-directory session switches paint instantly):
│                          #   managed-worktree directories read their binding's
│                          #   branch (authoritative — server worktrees are
│                          #   DETACHED at the branch tip, their .git/HEAD is a
│                          #   sha), anything else fetches `.git/HEAD` through
│                          #   fs/read (REPO ROOTS only — a session in a repo
│                          #   subdirectory hides the chip honestly). Refreshes
│                          #   on directory change, window focus (the user may
│                          #   have checked out in their own terminal) and on
│                          #   worktree-record changes (a branch session just
│                          #   created).
│   ├── worktreeSessions.ts # THE branch-bound session bookkeeping: a
│                          #   persistedStore.ts map ("lumina-code:worktree-dirs")
│                          #   worktreeDir → {branch, mainDir} — the app's ONLY
│                          #   branch truth for managed worktrees (detached HEAD
│                          #   + the server's worktree list carries no branch on
│                          #   this build). Written by sendFirst when it
│                          #   creates a branch worktree (POST /api/worktree);
│                          #   read by useDirectoryBranch, the sidebar's
│                          #   PROJECT grouping + per-row branch chips
│                          #   (sessionGrouping/SessionFolder) and
│                          #   newSession's seeding (a
│                          #   worktree session's successor seeds the MAIN repo).
│                          #   Entries never cleaned — worktree REMOVAL is never
│                          #   automatic (a detached commit doesn't dirty the
│                          #   tree, so even force:false removal loses commits;
│                          #   cleanup is an explicit user action, future work).
│                          #   Also projectIdForDirectory (pure): resolve the
│                          #   worktree routes' projectID from GET /api/project
│                          #   — duplicate canonicals exist (observed live);
│                          #   prefer the vcs:"git" entry, newest first.
│   ├── worktreeSync.ts    # THE worktree→local-branch WRITE-BACK, pure
│   │                      #   planning + api-bound runner (types-only
│   │                      #   imports — node-testable, the
│   │                      #   sessionActivity pattern). Fixes the
│   │                      #   isolation trap: AI edits land in the
│   │                      #   worktree (uncommitted changes and/or
│   │                      #   detached-HEAD commits) while the LOCAL
│   │                      #   branch ref never moves, so the user's
│   │                      #   own checkout looks untouched. All git
│   │                      #   sequences curl-verified against server
│   │                      #   v2.0.11's shell API (POST /api/shell —
│   │                      #   see api.ts spawnShell): commit the dirty
│   │                      #   tree on the detached HEAD (`git add -A &&
│   │                      #   git commit`, fixed message, "nothing to
│   │                      #   commit" race tolerated), then advance the
│   │                      #   local branch — `git merge --ff-only` when
│   │                      #   the main checkout HOLDS the branch (ref +
│   │                      #   working copy together), `git branch -f`
│   │                      #   otherwise (linked worktrees share the
│   │                      #   object db). DIVERGENCE (branch tip not an
│   │                      #   ancestor of the wt HEAD, via
│   │                      #   merge-base --is-ancestor's exit code read
│   │                      #   off the shell RECORD — no $? bashism)
│   │                      #   REFUSES before touching anything: manual
│   │                      #   merge is the user's call, never an
│   │                      #   automatic one. probeWorktreeDrift is the
│   │                      #   read-only half (HEAD/tip shas, dirty
│   │                      #   count, commitsAhead, diverged);
│   │                      #   outcomes (up-to-date / synced / diverged
│   │                      #   / error incl. branch-missing) RETURN —
│   │                      #   the runner never throws.
│   └── useWorktreeSync.ts # The write-back's STATEFUL half (drift store
│                          #   + sync action, keyed by worktree
│                          #   directory — the turnEdits module-store
│                          #   pattern): one entry per MANAGED worktree
│                          #   dir holding the drift snapshot, the
│                          #   syncing flag and the last sync's outcome;
│                          #   probes are event-driven (mount via
│                          #   useWorktreeSyncOf, stats-panel expand, the
│                          #   active session's run end, every sync's
│                          #   own re-probe — never timers). Logs through
│                          #   the plugin logger at every outcome
│                          #   (§3.5); syncWorktreeNow guards re-entry.
│
├── lib/                   # Pure, framework-agnostic (NO React) — ported from
│   │                      #   lumina-terminal; keep in sync with its sibling when fixed.
│   ├── platform.ts        # isMacOS / isLinux
│   ├── glass.ts           # glassSurface / windowOutline — the ONLY place
│   │                      #   backdrop-filter is written (Wayland fallback lives
│   │                      #   here). THREE glass modes: supportsGlass → tint +
│   │      backdrop-filter; compositorBlur (GNOME + Blur my Shell, see
│   │      hooks/useBlurMyShell.ts) → the SAME translucent tint with NO
│   │      filter (the extension blurs behind the whole window in the
│   │      compositor); neither → opaque adjustColor fallback. A
│   │      lumina-code addition, deliberately diverged from lumina-terminal.
│   ├── color.ts           # color math (luminance, foreground, adjust,
│   │                      #   withAlpha — the rgba() feed of the compositor-
│   │                      #   blur window base)
│   ├── blurMyShell.ts     # The Blur my Shell integration's PURE decision
│   │                      #   layer (node-testable): bmsWildcardMatch
│   │                      #   mirrors the extension's whitelist matcher
│   │                      #   (wildcards * / ?, everything else literal,
│   │      case-insensitive — wildcardToRegex in its applications.js),
│   │      deriveBmsStatus walks the extension's own gate chain
│   │      (unsupported / notInstalled / extensionDisabled / disabled /
│   │      notListed / blacklisted / active{staticBlur, opacity}) over
│   │      the Rust probe's raw snapshot, composeWhitelist appends our
│   │      wmClass without duplicating an already-covering pattern.
│   ├── motion.ts          # The framer-motion RESIDUE: only the button
│   │                      #   hover/tap spring (whileHoverTap +
│   │                      #   springSnappy) and RollingTitle's timer
│   │                      #   constant survive — every other animation
│   │                      #   is the CSS utilities in main.css (§3.7).
│   ├── surfacePhases.ts   # The session-surface phase machine (pure,
│   │                      #   node-testable): shown / exiting / waiting
│   │                      #   with events retarget·exitEnded·becameReady.
│   │                      #   The sequencing brain of App's SessionSurface —
│   │                      #   strictly sequential (exit completes before the
│   │                      #   successor may mount), idempotent transitions
│   │                      #   (duplicate exitEnded from the fallback timer
│   │                      #   is a no-op), and rapid mid-exit retargets
│   │                      #   re-aim the successor without canceling the
│   │                      #   exit.
│   ├── path.ts            # folderLabel (last path segment) + displayPath
│   │                      #   (project-relative file paths) — shared by the
│   │                      #   sidebar, directory picker and tool cards. node-testable.
│   ├── fileIcons.ts       # fileIconName/fileIconUrl — file path → Material
│   │                      #   Icon Theme SVG (public/icons/files, generated
│   │                      #   by `pnpm gen:icons`; maps in
│   │                      #   fileIcons.generated.ts). Used by composer
│   │                      #   mentions/suggestions/attachment chips and
│   │                      #   tool-card file lines. node-testable.
│   ├── theme.ts           # appThemeFor(systemTheme) — lumina-code follows the system
│   │                      #   light/dark (no per-profile palettes like lumina-terminal)
│   ├── typography.ts      # Custom typography for the General settings:
│   │                      #   sanitize/persist shape, CSS family-stack builder
│   │                      #   (quoted custom family + @theme fallback), and
│   │                      #   applyTypography — runtime overrides of
│   │                      #   --font-sans/--font-mono (verified: preflight
│   │                      #   resolves html's font through them), root
│   │                      #   font-size (UI 字号 = rem zoom) and
│   │                      #   --lum-code-size. node-testable.
│   ├── persist.ts         # loadState/saveState — cross-restart UI state in
│   │                      #   localStorage ("lumina-code:ui-state": open session,
│   │                      #   model, agent, directory). Never throws; built over
│   │                      #   persistedStore.ts like every persisted preference,
│   │                      #   keeping its subscriber-less load/save shape.
│   ├── moduleStore.ts     # THE in-memory store factory (node-testable,
│   │                      #   moduleStore.test.ts): createListeners (the
│   │                      #   listeners+notify+subscribe triple a dozen
│   │                      #   stores hand-rolled before) +
│   │                      #   createModuleStore (single value, eq
│   │                      #   short-circuit) + createKeyedStore (Map +
│   │                      #   lazy entryOf + identity-stable snapshot()
│   │                      #   for useSyncExternalStore). The IN-MEMORY
│   │                      #   counterpart of persistedStore.ts; the
│   │                      #   reference-stable-snapshot and mutable-entry
│   │                      #   disciplines live here, seq in-flight guards
│   │                      #   stay at call sites.
│   ├── persistedStore.ts  # THE persistence factory (node-testable):
│   │                      #   createPersistedStore({key, label, read, write, eq})
│   │                      #   is the ONE implementation behind every
│   │                      #   persisted store — key naming, error
│   │                      #   handling + logging, same-value short-circuit and
│   │                      #   the absence-means-default write semantics (write()
│   │                      #   returning null removes the key) live here and
│   │                      #   nowhere else. MEDIUM: tauri-plugin-store — ONE
│   │                      #   file, state/state.json under the app data dir
│   │                      #   (plugin auto-resolves the path, autoSave
│   │                      #   debounces disk writes), values are the
│   │                      #   per-store serialized strings.
│   │                      #   initPersistedState() — awaited by BOTH entries
│   │                      #   (main.tsx / mobile kv.ts) BEFORE the app bundle
│   │                      #   imports — seeds an in-memory Map from the file,
│   │                      #   which is what keeps every store's creation-time
│   │                      #   read SYNCHRONOUSLY before React mounts
│   │                      #   (typography/language/theme before first paint).
│   │                      #   One-time MIGRATION: legacy `lumina-code:*`
│   │                      #   localStorage keys are harvested into the file
│   │                      #   (flushed first), then removed. Degradation
│   │                      #   ladder: no invoke (plain-browser dev) →
│   │                      #   localStorage; no localStorage (node tests) →
│   │                      #   memory. set() never throws: a failed write is
│   │                      #   logged while the in-memory value still updates
│   │                      #   + notifies.
│   ├── clipboard.ts       # copyText — clipboard write with an execCommand
│   │                      #   fallback for webviews lacking the async API
│   ├── imageCompress.ts   # MOBILE attachment compression (DOM-bound,
│   │                      #   React-free): compressImageFile re-encodes
│   │                      #   images through a canvas — longest edge
│   │                      #   2048, JPEG 0.85 (3–8MB camera photos →
│   │                      #   0.3–0.8MB; also normalizes HEIC picks
│   │                      #   providers can't read). Never a gate:
│   │                      #   non-images, undecodable inputs and
│   │                      #   no-gain results return the ORIGINAL file.
│   │                      #   Wired in ChatInput.addFiles under
│   │                      #   isMobileApp() — the desktop's loopback
│   │                      #   upload keeps originals (the base64 prompt
│   │                      #   POST is the mobile frp route's biggest
│   │                      #   body; see api.ts's UPLOAD_TIMEOUT_MS).
│   ├── dragRegionDoubleClick.ts # pure predicate behind the title-bar double-click
│   ├── backStack.ts      # The mobile BACK-LEVEL STACK (node-testable,
│   │                      #   the persistedStore degradation pattern):
│   │   │                  #   the frontend half of the system-back
│   │                      #   integration — every open "page level"
│   │                      #   (modal, settings second-level page,
│   │                      #   drawer, popover menu, expanded stats
│   │                      #   overlay) pushes one {lumId} history
│   │                      #   entry, and a popstate landing below the
│   │                      #   stack top closes levels down to it
│   │                      #   (wry's back routing — re-enabled in
│   │                      #   MainActivity — turns the system back
│   │                      #   gesture into exactly those pops; at the
│   │                      #   root it falls through to finish, the
│   │                      #   Android convention). UI closes drop
│   │                      #   their entries in one COALESCED
│   │                      #   microtasked go(-n), SKIPPED when a push
│   │                      #   followed the drop batch in the same
│   │                      #   commit (drawer→import, StrictMode
│   │                      #   remount — go would pop the successor);
│   │                      #   those buried stales are eaten by the
│   │                      #   CASCADE (a popstate landing on a stale
│   │                      #   lumId with no live levels issues one
│   │                      #   more go(-1), chaining to the base) so
│   │                      #   "close via X, then back" never dead-
│   │                      #   presses. Consumed ONLY through
│   │                      #   hooks/useBackLevel (isMobileApp-gated).
│   └── exitGate.ts     # Exit-engine logic (node-testable): the animation/
│                        #   transition end-event matchers (target must BE
│                        #   the host; bubbled child events never count),
│                        #   the app-wide EXIT BUDGET ledger (caps
│                        #   concurrent exit holds — bursts skip the
│                        #   choreography instead of dropping frames),
│                        #   mergeExitOrder (a leaving list row collapses
│                        #   IN PLACE, interleaved at its original
│                        #   position between surviving neighbors), and
│                        #   the ENTRANCE gate: rowEnteringKeys — which
│                        #   keys of a list update are live appends
│                        #   (unfurl via .lum-row-enter) vs bulk-mounted
│                        #   history (instant) — over isWholesaleSwap
│                        #   (non-empty prev, zero survivors), which
│                        #   ExitList's enter mode also uses to skip
│                        #   per-row exit holds (instant on BOTH edges).
│                        #   First observation and wholesale swaps (a
│                        #   session switch) are bulk; an EMPTY prev is
│                        #   a watched list sitting empty, so its first
│                        #   arrival IS an append; keys coming back from
│                        #   an exit hold never re-unfurl.
│
├── hooks/                 # React hooks (start with `use`; i18n.tsx provides JSX context)
│   ├── i18n.tsx           # useI18n() → dictionary indexed by TranslationKey;
│   │                      #   language = stored choice → system (zh*) → en-us
│   ├── colors.tsx         # ColorsProvider + useColors() — the app-wide
│   │                      #   SurfaceColors context (App derives the ONE
│   │                      #   palette and provides it; components read
│   │                      #   useColors() instead of threading a colors
│   │                      #   prop through every level).
│   ├── maximized.ts       # useMaximized — computed ONCE in App, passed as prop
│   ├── paddingOffset.ts   # usePaddingOffset(isMaximized) — from App, never from a child
│   ├── surfaceColors.ts   # useSurfaceColors(bg) → derived border/overlay/accent colors
│   ├── useGlass.ts        # backdrop-filter capability (disabled on Linux/WebKitGTK);
│   │                      #   ONLY about the in-page filter — window-level
│   │                      #   translucency on GNOME is useBlurMyShell below
│   ├── useBlurMyShell.ts  # The Blur my Shell integration's stateful half
│   │                      #   (GNOME gives apps no blur API: the extension
│   │                      #   matches wm_class/app_id against a GSettings
│   │                      #   whitelist and blurs BEHIND whitelisted windows;
│   │                      #   "integration" = render translucent pixels +
│   │                      #   join the whitelist + detect the state, so
│   │                      #   non-BMS systems keep the opaque fallback —
│   │                      #   never translucentize unconditionally). Module
│   │                      #   snapshot store (the sessionStopping pattern;
│   │                      #   probes deduped through one in-flight promise)
│   │                      #   over the blur_my_shell_probe Rust command;
│   │                      #   addToBmsWhitelist writes our wmClass into the
│   │                      #   extension's whitelist (blur_my_shell_set_
│   │                      #   whitelist; BMS re-scans all windows on the
│   │                      #   key's changed:: signal, so it takes effect
│   │                      #   immediately); useCompositorBlurActive is the
│   │                      #   RENDER capability (live AND the persisted
│   │                      #   lumina-code:compositor-blur pref on) consumed
│   │                      #   by App's root bg + the chrome glass surfaces
│   │                      #   via glassSurface's compositorBlur option.
│   │                      #   Probes fire BEFORE the window is shown (first
│   │                      #   visible frame already correct; a 400ms race
│   │                      #   caps the wait), on focus REGAIN debounced
│   │                      #   (the user toggles the extension while we are
│   │                      #   unfocused — a stale active would leave the
│   │                      #   window see-through with nothing blurring
│   │                      #   behind it), when the settings row mounts, and
│   │                      #   after our own write.
│   ├── useSystemTheme.ts  # OS light/dark (module-cached)
│   ├── useThemePreference.ts # Manual light/dark override ("system" follows
│   │                      #   the OS) — a persistedStore.ts store, consumed
│   │                      #   once in App to resolve appThemeFor's input.
│   ├── useIsWayland.ts    # cached invoke("is_wayland")
│   ├── useWindowOutline.ts # Linux window-outline toggle (App's inset
│   │                      #   box-shadow edge for DEs without compositor
│   │                      #   shadows): a persistedStore.ts store, default
│   │                      #   on; the settings row is
│   │                      #   Linux-only but App gates on isLinux() too.
│   ├── useSidebarWidth.ts # The sidebar's expanded width — dragged via the
│   │                      #   resize seam (components/SidebarResizer.tsx)
│   │                      #   and persisted across restarts: a
│   │                      #   persistedStore.ts store (absence = 240
│   │                      #   default, clamped [200, 480]) that SessionBar
│   │                      #   reads itself (the sessionStopping module-
│   │                      #   store pattern — per-pointermove re-renders
│   │                      #   stay inside the sidebar, AppBody never
│   │                      #   re-renders). Also hosts the NOT-persisted
│   │                      #   resizing flag (useSidebarResizing) that
│   │                      #   suppresses SessionBar's width transition
│   │                      #   mid-drag. node-testable (dynamic-import
│   │                      #   pattern — the store reads localStorage at
│   │                      #   module load).
│   ├── useStatsPanelMode.ts # Session-activity panel expansion mode
│   │                      #   ("auto" — mounts collapsed, outside click
│   │                      #   / Escape collapse it; "always" — mounts
│   │                      #   expanded and stays open; a manual collapse
│   │                      #   lasts until the card remounts): a
│   │                      #   persistedStore.ts store (legacy
│   │                      #   boolean "false" reads as "always").
│   │                      #   Also exports useStatsExpanded — the
│   │                      #   panel's MANUAL expansion as an in-memory
│   │                      #   module store SURVIVING the card's
│   │                      #   directory-keyed remounts (a session
│   │                      #   switch must not collapse an open panel
│   │                      #   and drop its docked lane; a fresh run
│   │                      #   starts collapsed in "auto" mode, while
│   │                      #   "always" force-expands at every mount).
│   │                      #   Consumed by SessionStatsCard; the
│   │                      #   segmented OptionRow is in GeneralSettings.
│   │                      #   PLUS the cross-surface DRILL request
│   │                      #   store (a StatsDrillRequest union —
│   │                      #   requestStatsFileDrill /
│   │                      #   requestStatsSubagentDrill /
│   │                      #   usePendingStatsDrill): the transcript
│   │                      #   asks the panel — a flex sibling at App
│   │                      #   level, not an ancestor — to expand into
│   │                      #   one detail: a turn-edit row (chat/
│   │                      #   RunFooter) at a file's diff view, a
│   │                      #   SubagentCard row's click at its child
│   │                      #   session's live transcript
│   │                      #   (SessionStatsCard consumes + clears in an
│   │                      #   effect; its outside-click collapse spares
│   │                      #   [data-lum-stats-drill] rows so the re-aim
│   │                      #   doesn't jank through a collapse).
│   ├── useTypography.ts   # Custom fonts/sizes (a persistedStore.ts
│   │                      #   store): applies lib/typography.ts's
│   │                      #   overrides on load + change. Load-order note:
│   │                      #   main.tsx imports main.css BEFORE the App
│   │                      #   tree so the @theme stacks exist at init.
│   ├── useDisabledModels.ts # Models switched OFF in the model settings
│   │                      #   (hidden from the picker — the server has no
│   │                      #   per-model enable API, so this is client-side
│   │                      #   only): a persistedStore.ts store, keys are
│   │                      #   "providerID/modelID".
│   ├── useNotificationMode.ts # The desktop-notification preference: a
│   │                      #   persistedStore.ts store ("lumina-code:
│   │                      #   notifications") holding {mode: off/minimal/
│   │                      #   full, muteFocusedCurrent: boolean}, default
│   │                      #   full + mute on, field-level read fallback,
│   │                      #   defaults persist as absence. Consumed by the
│   │                      #   General pane and re-read at EVENT time by
│   │                      #   useNotifications (a change applies to the
│   │                      #   very next notification).
│   ├── useNotifications.ts # The desktop-notification SUBSCRIBING half,
│   │                      #   mounted once in AppBody: run ends read
│   │                      #   straight off the bus (succeeded/failed only —
│   │                      #   the busy set's diff carries no reason),
│   │                      #   root sessions only (execution events fire
│   │                      #   for subagent/helper sessions too), fired
│   │                      #   after a 1500ms delay cancelled by a restart
│   │                      #   or a new ask in the same session; user
│   │                      #   attention rides pendingCounts' 0→N
│   │                      #   transitions (first snapshot = baseline, so
│   │                      #   connect-time seeds never replay), kinds from
│   │                      #   permissions/forms + peekGateFlags. Sending =
│   │                      #   @tauri-apps/plugin-notification with one
│   │                      #   OS-permission resolution per run (denied
│   │                      #   latches with a warn; transient failures
│   │                      #   retry next event); focus via
│   │                      #   onFocusChanged into a ref. SENDING is
│   │                      #   platform-split: Linux goes through the
│   │                      #   persistent-connection desktop_notify
│   │                      #   command (src-tauri/src/notify.rs) — the
│   │                      #   plugin's per-send D-Bus connection gets
│   │                      #   GNOME 46+ to DESTROY the app-attributed
│   │                      #   source (sender bus name vanishes) with
│   │                      #   banner AND tray entries, live-verified;
│   │                      #   macOS/Windows keep the plugin.
│   ├── useDragRegionDoubleClick.ts # capture-phase mousedown + explicit maximize toggle
│   ├── useBackLevel.ts # Registers one mobile "page level" into the
│   │                      #   system-back navigation (lib/backStack.ts):
│   │                      #   useBackLevel(active, onClose) pushes a
│   │                      #   history entry while active and drops it on
│   │                      #   cleanup — popstate (system back) and the
│   │                      #   UI's own close both land in the same
│   │                      #   onClose, idempotently. Inert on desktop
│   │                      #   (isMobileApp-gated). Wired into Modal
│   │                      #   (every modal), SettingsModal's pushed
│   │                      #   pane, App's drawer, PopoverMenu (every
│   │                      #   picker/menu) and the stats overlay's
│   │                      #   expanded state.
│   ├── useLayoutMode.ts  # The mobile app's LAYOUT mode (tablet mode):
│   │                      #   a persistedStore.ts store
│   │                      #   ("lumina-code:mobile-layout", auto |
│   │                      #   phone | desktop, default auto) splitting
│   │                      #   isMobileApp()'s two jobs apart — the
│   │                      #   DEVICE/connection semantics (remote frp
│   │                      #   route, system-back stack, window
│   │                      #   controls, touch delete surfaces, soft-
│   │                      #   keyboard focus guard) stay on
│   │                      #   isMobileApp() forever, while the LAYOUT
│   │                      #   branches (drawer vs docked sidebar,
│   │                      #   SidebarResizer, two-level settings vs tab
│   │                      #   rail, fullscreen vs centered modals, the
│   │                      #   welcome cluster, mobile.css's phone
│   │                      #   adaptations) read usePhoneLayout() —
│   │                      #   tablet mode (layout "desktop") renders
│   │                      #   the DESKTOP chrome with the remote
│   │                      #   connection untouched. auto resolves by
│   │                      #   the Material breakpoint (shortest side
│   │                      #   >= 600px; WebView CSS px ≈ dp — phones
│   │                      #   ~410, 7" tablets 600, foldables OPENED
│   │                      #   ~674) and tracks viewport changes
│   │                      #   (rotation/fold/split); pinned modes are
│   │                      #   stable. The General tab's Layout row
│   │                      #   (mobile-only) edits it; src/mobile/App.tsx
│   │                      #   mirrors the resolved layout onto #root as
│   │                      #   data-lum-layout DURING RENDER (first
│   │                      #   paint correct — an effect would flash),
│   │                      #   which is mobile.css's hook for scoping
│   │                      #   the phone-sized overrides. The stats
│   │                      #   panel needs NO gating: its always-overlay
│   │                      #   phone behavior is just the phone row
│   │                      #   never reaching the 79rem flex-sibling
│   │                      #   container-query tier — a tablet row
│   │                      #   docks it like the desktop's.
│   ├── useFollowBottom.ts # stream-follow stickiness for inner scroll regions;
│   │                      #   also exposes top/bottom edge flags for the
│   │                      #   conditional .lum-fade-* fades on its boxes
│   ├── useScrollEdges.ts  # scroll-edge tracking (top/bottom/left/right)
│   │                      #   for static scrollers wearing the CONDITIONAL
│   │                      #   edge fades: lists, menus, request cards, the
│   │                      #   shared BodyBox/ToolBodyBox/subagent boxes
│   │                      #   self-track through it (a ResizeObserver
│   │                      #   catches layout-driven flips). The FADE SYSTEM
│   │                      #   (main.css .lum-fade-top/-bottom/-left/
│   │                      #   -right — composable via end-color vars):
│   │                      #   the mask rides the SCROLLER, never a painted
│   │                      #   surface (bordered/washed boxes split
│   │                      #   chrome-outside + scroller-inside); THREE
│   │                      #   TIER classes size the band — .lum-fade-lg
│   │                      #   (51px, transcript-strength: plan/report
│   │                      #   cards, thinking, document previews),
│   │                      #   .lum-fade-md (28px: stats panel, composer
│   │                      #   surfaces, menus, settings panes, output
│   │                      #   boxes), default 12px (small strips);
│   │                      #   padded reading surfaces wear BOTH classes
│   │                      #   statically (padding covers the band —
│   │                      #   resting content stays crisp, no JS); flush
│   │                      #   content goes CONDITIONAL (fade a side only
│   │                      #   while it has hidden content, so short lists
│   │                      #   render fade-free); horizontal fades are
│   │                      #   WIDTH-AWARE (Markdown.tsx's MdPre/MdTable
│   │                      #   overrides — a code block or table that
│   │                      #   fits its column renders mask-free; the
│   │                      #   .lum-md-table wrap hugs at fit-content).
│   ├── useNow.ts          # A ticking "now" for relative-age labels (the
│   │                      #   sidebar + import picker's 30s tickers,
│   │                      #   previously hand-rolled in both).
│   ├── useOutsideDismiss.ts # Capture-phase outside-pointerdown + Escape
│   │                      #   dismissal (PopoverMenu + the stats panel's
│   │                      #   overlay collapse — verbatim-duplicated
│   │                      #   effects before; exempt/escapeBusy params
│   │                      #   carry the stats panel's drill/modal rules).
│   ├── useWindowFirstShow.ts # Show the hidden window after first paint,
│   │                      #   racing the BMS probe (App's old inline
│   │                      #   effect, extracted).
│   ├── useChromeThemeSync.ts # HeroUI dark-class sync + the mobile
│   │                      #   setChromeBackground push (App's old inline
│   │                      #   effects, extracted; the glassSurfaceEquivalent
│   │                      #   derivation note lives there).
│   ├── useIntegrationOAuth.ts # The Model pane's browser-OAuth state machine
│   │                      #   (extracted from ModelSettings.tsx): start /
│   │                      #   2s poll / cancel over one flow at a time.
│   ├── useCopy.ts         # copy feedback shared by run footers and the user
│   │                      #   bubble: copied flag + ✓ linger reset
│   └── useTranscriptScroll.ts # ChatView's scroll machinery: bottom-follow with
│                              #   programmatic-scroll guards, prepend anchoring
│                              #   around render-window growth, geometry re-pin,
│                              #   visibilitychange catch-up, content-shrink-aware
│                              #   unpin (fold collapses above must not read as
│                              #   the reader leaving — the follow used to die
│                              #   mid-stream), and snapToBottom (user actions
│                              #   from mid-history re-arm the follow).
│
└── components/
    ├── TitleBar.tsx       # Drag region + chrome buttons (window controls in
    │                      #   ui/WindowControls.tsx, language menu inline) +
    │                      #   the right-side BRANCH chip (GitBranch icon +
    │                      #   name, non-interactive; null = no repo, hidden)
    │                      #   — App feeds it useDirectoryBranch's reading,
    │                      #   or the welcome screen's STAGED branch. MOBILE:
    │                      #   an optional ⋯ menu (onDeleteSession prop, App
    │                      #   passes it on a phone while a session is open)
    │                      #   carrying 删除会话 — the delete entry's mobile
    │                      #   home, relocated from the sidebar rows (a
    │                      #   finger press synthesizes hover and reveals the
    │                      #   row's X mid-tap: the tap meant to open the
    │                      #   session would delete it). NOTE the bar's root
    │                      #   wears relative z-50: its glass backdrop-filter
    │                      #   creates a STACKING CONTEXT, so the downward
    │                      #   menu panel needs the whole bar hoisted above
    │                      #   the content sibling or it paints UNDER the
    │                      #   conversation (live-observed on Android).
    ├── SessionBar.tsx     # Left glass sidebar shell: brand row, THE MODE
    │                      #   SWITCHER (HeroUI Tabs — 日常/开发, rendered
    │                      #   ONLY once git availability is CONFIRMED;
    │                      #   opencode/appMode.ts), the TWO-PAGE session
    │                      #   slider (both halves stay MOUNTED inside a
    │                      #   w-[200%] strip that translates between them —
    │                      #   collapsed folders, scroll positions and show-
    │                      #   more states survive a switch; a git-less
    │                      #   machine renders the plain single daily page),
    │                      #   folder collapse/expand state,
    │                      #   relative-age ticker,
    │                      #   bottom action rows — new-session plus the
    │                      #   IMPORT entry (FolderInput icon; the trailing
    │                      #   count badge = importable foreign sessions,
    │                      #   AppBody feeds onImport/importableCount and
    │                      #   mounts ImportSessionsModal) plus the
    │                      #   PLUGINS & MCP entry above it (Puzzle icon,
    │                      #   onExtensions → ExtensionsModal); groups render
    │                      #   through SessionFolder, keyed by PROJECT
    │                      #   directory (groupByDirectory + the worktree
    │                      #   bindings — branch sessions merge into the
    │                      #   main repo's folder). Session-row hover
    │                      #   fires onSessionHover → App's
    │                      #   prefetchSessionActivity (warms the stats
    │                      #   card's data before the click). Expanded
    │                      #   width comes from the sidebar-width store
    │                      #   (useSidebarWidth) — transition suppressed
    │                      #   while the seam is dragged.
    ├── ImportSessionsModal.tsx # The session-import picker (the sidebar's
    │                      #   Import row): external OpenCode sessions —
    │                      #   TUI/CLI/other-instance roots in the shared
    │                      #   storage — joining the whitelist. Data via
    │                      #   useSessionData (foreignSessions, live-patched
    │                      #   by the same folds as the sidebar, so another
    │                      #   client's new session appears while open);
    │                      #   importSessions grants membership, the rows
    │                      #   collapse away through ExitList and land in
    │                      #   the sidebar's project folders (nothing is
    │                      #   copied — the transcript already lives on
    │                      #   the server). Grouped like the sidebar
    │                      #   (groupByDirectory + worktree bindings, "" →
    │                      #   "Other Sessions"); the whole row is the
    │                      #   action; "Import All" when >1; busy foreign
    │                      #   sessions wear the pulse dot.
    ├── ExtensionsModal.tsx # The Plugins & MCP manager (the sidebar's
    │                      #   bottom-left entry, above Import): every
    │                      #   user-manageable extension the server
    │                      #   loaded — plugins (non-builtin rows from
    │                      #   GET /api/plugin plus REMOVE-DIRECTIVE
    │                      #   rows the runtime list cannot see) and MCP
    │                      #   servers — each with an enable/disable
    │                      #   Switch. Toggles are config rewrites the
    │                      #   server HOT-RELOADS (opencode/
    │                      #   pluginsMcp.ts); data + actions live in
    │                      #   opencode/useExtensions.ts, App owns only
    │                      #   the open flag (the ImportSessionsModal
    │                      #   ownership shape). lumina-tools carries a
    │                      #   built-in notice (disabling it kills Plan
    │                      #   Mode) but stays toggleable; a plugin that
    │                      #   failed before exporting an id renders
    │                      #   display-only. Each MCP row also carries a
    │                      #   LOG button expanding a per-server log
    │                      #   panel under the row (Reveal unfurl; mono
    │                      #   line list with local-time + level colors,
    │                      #   Refresh re-pull, one panel at a time —
    │                      #   data via opencode/mcpLogs.ts).
    ├── SidebarResizer.tsx # The drag seam between the sidebar and the
    │                      #   conversation area: an invisible OVERLAY sash
    │                      #   (VS Code style) absolutely positioned over the
    │                      #   boundary in AppBody's root (left = stored width
    │                      #   − overlap; .lum-sidebar-resizer in main.css
    │                      #   sizes it and fades in a 2px hairline on
    │                      #   hover/drag). Pointer-capture drag →
    │                      #   setSidebarWidth per move; double-click resets
    │                      #   to the default; mid-drag it raises the
    │                      #   resizing flag + the body[data-lum-sidebar-
    │                      #   resizing] attribute (kills text selection
    │                      #   app-wide). Hint documents the double-click
    │                      #   reset.
    ├── SessionTitle.tsx   # Single-line label: edge-fade truncation + a
    │                      #   hover-debounced HeroUI tooltip when overflowing.
    ├── SessionFolder.tsx  # One PROJECT group: collapsible header (+/chevron),
    │                      #   animated session rows (busy dot; branch-worktree
    │                      #   sessions wear their branch as a quiet chip after
    │                      #   the title — hint carries the worktree path;
    │                      #   pending badge, age and close button share one
    │                      #   cross-fade slot; deleted rows collapse in place
    │                      #   via ExitList, budget-limited), "Show more/less"
    │                      #   expander. `plain` strips the folder chrome
    │                      #   (header + collapse) — the DAILY sidebar half's
    │                      #   flat list (one workspace, no directory header;
    │                      #   SessionBar's renderGroups(list, plain)).
    │                      #   MOBILE rows carry NO delete X and no
    │                      #   hover fade (synthetic hover on touch would
    │                      #   reveal the X mid-tap — deleting on an open
    │                      #   tap); deleting goes through the title-bar ⋯
    │                      #   menu (TitleBar's onDeleteSession).
    ├── sessionGrouping.ts # Pure sidebar mapping: SessionInfo view-model,
    │                      #   relativeAge, groupByDirectory + projectDirOf —
    │                      #   the sidebar groups by PROJECT directory: a
    │                      #   managed worktree's sessions merge into their
    │                      #   main repo's ONE folder (the branch rides the
    │                      #   row as a chip in SessionFolder, never forks a
    │                      #   second block); an unbound worktree dir falls
    │                      #   back to grouping under itself.
    │                      #   node-testable.
    ├── SessionSurface.tsx  # The session ↔ welcome SEQUENTIAL surface swap
    │                      #   (extracted from App.tsx; the phase logic in
    │                      #   lib/surfacePhases.ts: the exit plays out
    │                      #   alone, a not-yet-seeded successor shows the
    │                      #   loading dots, the entrance starts only when
    │                      #   the first frame is renderable).
    ├── StatsCardSwap.tsx  # The stats card's DIRECTORY-keyed swap fade
    │                      #   (extracted from App.tsx): a cross-directory
    │                      #   switch holds the previous card as a frozen
    │                      #   snapshot (.lum-card-hold) for a short fade
    │                      #   while the successor mounts.
    ├── ChatPlaceholder.tsx # Welcome-screen logo + greeting
    │                      #   (picked once per mount via greetings.ts).
    ├── BootScreen.tsx     # THE BOOT GATE (mobile-first): a full-screen
    │                      #   opaque overlay over the whole chrome from
    │                      #   the first frame (MOBILE) / past a 1s grace
    │                      #   (DESKTOP fast path never mounts it) until
    │                      #   the app is genuinely USABLE — connected ∧
    │                      #   sessionsLoaded ∧ catalogLoaded (the
    │                      #   catalog's initial-settle flag, see
    │                      #   useModelCatalog) ∧ the restored session's
    │                      #   message store seeded (warmed HERE at
    │                      #   mount via ensureSessionSeeded, parallel
    │                      #   with the list/catalog fetches — the mobile
    │                      #   route saves a serial round trip; the
    │                      #   reveal lands exactly when the session
    │                      #   surface's entrance starts, both keying the
    │                      #   same seeded flag). ONE-WAY reveal with
    │                      #   three exits: ready / connection error
    │                      #   (immediately — the welcome subtitle keeps
    │                      #   showing the error + settings access, the
    │                      #   mobile credential loop self-heals
    │                      #   underneath) / a 15s valve (the gate only
    │                      #   ADDs a loading state, never traps longer
    │                      #   than the pre-gate UI). Visuals all reused:
    │                      #   CO wordmark + .lum-loading dots +
    │                      #   ExitPresence's .lum-fade-exit; mounted as
    │                      #   AppBody's last child (App.tsx).
    ├── greetings.ts       # Pure welcome-greeting picker: per-language pools
    │                      #   (independent id sets — zh-only memes don't leak
    │                      #   to en), probability-gated special occasions
    │                      #   (1024, Thursday KFC, late night, Friday deploy,
    │                      #   Monday, weekend), {project} interpolation.
    │                      #   node-testable.
    ├── WelcomeScreen.tsx  # The no-session surface: greeting + the staged
    │                      #   composer (session created on first send).
    │                      #   MOBILE: the composer's settings controls
    │                      #   (mode/project/branch via
    │                      #   ComposerSettingsControls + model/depth via
    │                      #   ComposerSelectors) render as a centered,
    │                      #   wrap-friendly cluster BELOW the box and the
    │                      #   toolbar reduces to attach + send
    │                      #   (toolbarMinimal) — five labeled controls
    │                      #   cannot fit one phone row.
    ├── ui/                # Shared primitives (one of each thing)
    │   ├── IconButton.tsx # THE chrome button — never hand-roll <button> hover swaps
    │   ├── Button.tsx     # THE labeled button (primary/ghost) — shared by request
    │   │                  #   cards (re-exported as CardButton) and modals
    │   ├── AttachmentChip.tsx # The ONE attachment-chip family (§3.8):
    │   │                  #   ATTACHMENT_CHIP_CLASS (h-7, radius-sm,
    │   │                  #   activeOverlay — composer staging + message
    │   │                  #   bubbles had drifted apart) + AttachmentChipIcon
    │   │                  #   (image thumb vs file-type icon).
    │   ├── Hint.tsx       # THE hover hint — HeroUI tooltip wrapper (the only
    │   │                  #   replacement for native `title` attributes; falsy
    │   │                  #   label renders the child untouched)
    │   ├── ExitPresence.tsx # THE exit engine (CSS animates; this decides
    │   │                  #   when an exiting element may leave the DOM):
    │   │                  #   ExitPresence holds the children mounted with
    │   │                  #   `closing` until the exit animation/transition
    │   │                  #   actually ENDS on the bound host element
    │   │                  #   (matched by name+target; exitMs is the
    │   │                  #   fallback timer), budget-limited; ExitList is
    │   │                  #   the list form — rows leaving `items` collapse
    │   │                  #   in place (.lum-row-exit grid-rows keyframes).
    │   │                  #   Replaced the old useExitPresence timers.
    │   │                  #   THE ENTRANCE TWIN: ExitList's opt-in `enter`
    │   │                  #   mounts rows APPENDED to a surviving list
    │   │                  #   (rowEnteringKeys gating, render-time against
    │   │                  #   the keys the last commit PAINTED — holds
    │   │                  #   included) through .lum-row-enter (grid
    │   │                  #   0fr→1fr unfurl, the mirror of .lum-row-exit:
    │   │                  #   old content untouched, the bottom edge
    │   │                  #   sweeps down through the new row, and every
    │   │                  #   content-driven container around it — the
    │   │                  #   stats card's border — grows along frame by
    │   │                  #   frame; no pixel anywhere, the browser
    │   │                  #   computes the real height). Children receive
    │   │                  #   `entering` as a 4th render-prop arg and drop
    │   │                  #   their own .lum-enter on those rows (the
    │   │                  #   unfurl already fades them in; a rise on top
    │   │                  #   would compound). WHOLESALE swaps are instant
    │   │                  #   on BOTH edges (isWholesaleSwap: a
    │   │                  #   same-directory session switch skips the
    │   │                  #   per-row exit holds too — no cascade of
    │   │                  #   collapses, no budget burn). Reveal is the
    │   │                  #   single-element form: one optional block that
    │   │                  #   unfurls in on a false→true flip of `present`
    │   │                  #   and collapses out through ExitPresence
    │   │                  #   (.lum-row-exit on the same host,
    │   │                  #   budget={false} — the fold-body doctrine: the
    │   │                  #   container animates while the frozen ghost
    │   │                  #   children just exist, so a section's exit is
    │   │                  #   never budget-dropped; mounted-present renders
    │   │                  #   instantly — callers keep it mounted and hand
    │   │                  #   the old conditional as present; as="span"
    │   │                  #   keeps button innards legal HTML).
    │   ├── Modal.tsx      # Portal-rendered modal chrome (fadeIn backdrop +
    │   │                  #   scaleIn panel, Escape/backdrop close; optional
    │   │                  #   onBack renders a back arrow before the title —
    │   │                  #   the mobile settings pages' header)
    │   ├── MaskedSurface.tsx # SVG rounded-rect clip exposing the glass chrome corners
    │   ├── PopoverMenu.tsx   # Shared dropdown menu
    │   ├── RollingTitle.tsx # Ellipsized title that scrolls on hover
    │   └── WindowControls.tsx # minimize/maximize/close cluster (non-macOS)
    ├── chat/              # The conversation surface
    │   ├── ChatView.tsx   # Transcript column + composer for the active session.
    │   │                  #   SLIMMED in the structure refactor: the queue
    │   │                  #   rows + drag reorder live in QueuedPromptList,
    │   │                  #   the plan-workflow gates in useGateCards, the
    │   │                  #   edit-last-message wiring in useEditLastMessage
    │   │                  #   (all in this directory).
    │   │                  #   Data via the context split (transcript through
    │   │                  #   useSessionTranscript, pending asks through
    │   │                  #   usePendingRequests, catalog through useCatalog) —
    │   │                  #   App's surface choreography has ALREADY seeded
    │   │                  #   the store before this view mounts, so its first
    │   │                  #   frame paints with content. Bounded DOM: only the
    │   │                  #   newest RENDER_LIMIT (60)
    │   │                  #   entries mount; an IntersectionObserver on the
    │   │                  #   top sentinel grows the window (and fetches older
    │   │                  #   pages) on scroll-up. Scrolling lives in
    │   │                  #   hooks/useTranscriptScroll.ts; block folding in
    │   │                  #   transcript.ts; rendering in TranscriptList.tsx.
    │   │                  #   The stats panel is GONE from here (it is a flex
    │   │                  #   sibling of this view at App level); the
    │   │                  #   columns' responsive cap + gutters arrive
    │   │                  #   via the .lum-column container queries.
    │   │                  #   VIRTUALIZATION LESSON: two broader schemes
    │   │                  #   were tried on this transcript and reverted —
    │   │                  #   a hand-rolled flow-windowed virtual list
    │   │                  #   (spacer/anchor compensation fought the
    │   │                  #   scroller) and content-visibility: auto
    │   │                  #   (never-rendered rows materializing from the
    │   │                  #   intrinsic-size estimate shifted the viewport
    │   │                  #   on WebKitGTK). Don't re-add without a plan
    │   │                  #   for those two failure modes. Also owns the
    │   │                  #   plan-workflow's TWO GUI gates (Route A):
    │   │                  #   the APPROVAL — the plan_submit executor
    │   │                  #   blocks inside its call, planApprovalPending
    │   │                  #   derives the pending payload from the
    │   │                  #   transcript, and PlanApprovalCard pins above
    │   │                  #   the composer (approve = switchAgent only —
    │   │                  #   the PLUGIN writes the plan documents into
    │   │                  #   .lumina/tasks/; reject = interrupt) — and
    │   │                  #   the ACCEPTANCE — workApprovalPending /
    │   │                  #   WorkReviewCard (approve = write the
    │   │                  #   .lumina/review/<sessionID>.json marker the
    │   │                  #   blocked executor polls, which then ARCHIVES
    │   │                  #   the plan; reject = interrupt). RESTART
    │   │                  #   ORPHANS: while the session is IDLE a
    │   │                  #   still-running gate part means its executor
    │   │                  #   died with the app (frozen running in
    │   │                  #   storage) — the cards render INTERRUPTED
    │   │                  #   (warning line) and the decisions deliver
    │   │                  #   the verdict as a WAKE PROMPT (approve:
    │   │                  #   switchAgent + sendPrompt with the task
    │   │                  #   list; reject: sendPrompt + gateDecisions
    │   │                  #   record; work-accept also writes the marker
    │   │                  #   for the plugin's sweeper and wakes the
    │   │                  #   session into archival); a zombie work gate
    │   │                  #   whose marker is already on disk is probed
    │   │                  #   once and mirrored into the record. And the
    │   │                  #   EDIT-LAST-
    │   │                  #   MESSAGE state: editingMessageId +
    │   │                  #   lastEditableId (the last plain user
    │   │                  #   message, connected — the pencil is
    │   │                  #   hover-revealed even while BUSY for
    │   │                  #   discoverability but DISABLED mid-run:
    │   │                  #   a revert needs an idle session) fed to
    │   │                  #   TranscriptList as one stable edit bundle
    │   │                  #   (which bubble shows the pencil / the
    │   │                  #   highlight ring); the COMPOSER is the edit
    │   │                  #   surface — ChatView passes editMessage +
    │   │                  #   cancel/submit callbacks to ChatInput;
    │   │                  #   submit = editResend (revert + resend),
    │   │                  #   success snaps to bottom and ends the
    │   │                  #   edit, failure keeps the composer editing.
     │   │                  #   THE QUEUED-PROMPT SITE too: handleSend
     │   │                  #   branches on busy (queue POST vs deliver) —
     │   │                  #   deliverQueued is deliver's twin (same
     │   │                  #   vision divert) feeding the server-native
     │   │                  #   queue POST, and the flush effect is now
     │   │                  #   ONLY the "stop and send" re-POST batch
     │   │                  #   (the regular flush is the SERVER's — see
     │   │                  #   opencode/promptQueue.ts); the rows'
     │   │                  #   ExitList sits at the top of
     │   │                  #   the pinned stack above the composer.
    │   ├── transcript.ts  # Pure blockify(): folds runs of activity-only
    │   │                  #   assistant messages into TranscriptBlocks; a persisted
    │   │                  #   model-switched marker becomes its own model-change
    │   │                  #   divider block (first selection / variant-only changes
    │   │                  #   stay silent). node-testable.
    │   ├── TranscriptList.tsx # Renders the mounted slice as MessageItems /
    │   │                  #   cross-message ActivityGroups + model-switch dividers
    │   │                  #   + run footers. Owns
    │   │                  #   entrance gating: only tail-appended content that
    │   │                  #   appeared live (new ids after the last known one,
    │   │                  #   freshly completed footers) animates in — history
    │   │                  #   bulk-mounted on open/scroll-up renders instantly
    │   │                  #   (concurrent-entrance bursts were the frame drops).
    │   ├── ModelChangeDivider.tsx # The model-switched marker: a hairline broken by
    │   │                  #   the `old → new` names (catalog-resolved, raw-id
    │   │                  #   fallback; absent catalog in subagent transcripts).
    │   ├── MessageItem.tsx # One message: user bubble or assistant document
    │   │                  #   (segmented via messageParts.ts); `enter` prop =
    │   │                  #   apply this message's .lum-enter CSS entrance or not.
    │   │                  #   The user bubble STRIPS the vision-divert note
    │   │                  #   (splitAttachmentNote): it's protocol for a
    │   │                  #   text-only model, never shown — the diverted
    │   │                  #   images surface as attachment chips (original
    │   │                  #   name + file-type icon, hover shows the saved
    │   │                  #   path) and copy/edits work on the clean text;
    │   │                  #   an image-only divert renders chips and no
    │   │                  #   bubble at all. The attachment chips are
    │   │                  #   CLICKABLE previews (attachmentPreview.ts +
    │   │                  #   AttachmentPreview.tsx): one chip at a time
    │   │                  #   expands under the row through ExitPresence —
    │   │                  #   images inline, text/code in the workspace
    │   │                  #   display. The user bubble also carries the EDIT-LAST-
    │   │                  #   MESSAGE entry point: a pencil in the quiet
    │   │                  #   actions row (only the row whose id matches
    │   │                  #   the edit bundle's editableMessageId —
    │   │                  #   ChatView derives "last plain prompt"),
    │   │                  #   hover-revealed like copy INCLUDING mid-run
    │   │                  #   (where it renders disabled: dimmer,
    │   │                  #   inert via an onClick guard — a native
    │   │                  #   disabled button would kill the tooltip —
    │   │                  #   and the tooltip says the AI must be
    │   │                  #   stopped first) — it loads the message
    │   │                  #   into the
    │   │                  #   COMPOSER (ChatInput's edit mode); the row
    │   │                  #   being edited wears a focusRing highlight.
    │   │                  #   The bundle rides TranscriptList
    │   │                  #   → MessageItem as ONE stable prop so memoized
    │   │                  #   rows skip re-renders; subagent transcripts
    │   │                  #   pass none of it.
    │   ├── attachmentPreview.ts # Pure planning for the attachment-chip
    │   │                  #   previews: previewKind (mime wins, file-name
    │   │                  #   extension as the fallback — staged files
    │   │                  #   often carry an EMPTY mime), splitFilePath
    │   │                  #   (file:// URI or absolute path → fs/read's
    │   │                  #   flat directory + name), the per-chip source
    │   │                  #   resolution (data-URI/base64 bytes ride the
    │   │                  #   message → ready source; file:// mentions and
    │   │                  #   the vision divert's saved paths → server
    │   │                  #   read), attachmentChips (the ONE chip item
    │   │                  #   list the chip row and the preview resolve
    │   │                  #   against — keys can't drift), and
    │   │                  #   capPreviewLines (2000-line DOM guard).
    │   │                  #   node-testable.
    │   ├── AttachmentPreview.tsx # The expanded half of the attachment
    │   │                  #   chips: renders one source. Ready sources
    │   │                  #   paint immediately; `read` sources fetch via
    │   │                  #   fs/read (image Blob → object URL, revoked
    │   │                  #   on unmount/swap; text via readTextFile) with
    │   │                  #   .lum-loading / error states. Text/code
    │   │                  #   borrows the WORKSPACE display: the whole
    │   │                  #   file through fragmentHunks → DiffViewBody —
    │   │                  #   as ADDED rows (git-diff-view DROPS
    │   │                  #   all-context hunks: no add/del ⇒ zero rows,
    │   │                  #   verified vs 0.1.7), with the diff semantics
    │   │                  #   (green wash, "+" signs, marker strips, the
    │   │                  #   synthesized hunk header) neutralized by the
    │   │                  #   .lum-attachment-diff scope in diffView.css —
    │   │                  #   plain numbered, highlighted code; truncated
    │   │                  #   past the line cap with a footnote. Mounted
    │   │                  #   KEYED per chip (MessageItem) so switches
    │   │                  #   remount fresh; entrance/exit animation is
    │   │                  #   the parent's ExitPresence.
    │   ├── messageParts.ts # Pure part segmentation: segmentContent,
    │   │                  #   effectiveTailPart, stable part keys.
    │   ├── userMentions.ts # Pure `@path` segmentation of a SENT user
    │   │                  #   prompt (splitUserMentions): the wire text
    │   │                  #   keeps the "@relative" form the server
    │   │                  #   resolves, but the user bubble renders the
    │   │                  #   mentions like the composer's token —
    │   │                  #   icon + file name, no "@" (UserMentionText
    │   │                  #   in MessageItem, the shared
    │   │                  #   .lum-file-mention chrome). CJK-aware
    │   │                  #   boundary + path-shape rules keep emails and
    │   │                  #   plain @words plain; ASCII/CJK punctuation
    │   │                  #   closes a token. node-testable.
    │   ├── ActivityGroup.tsx # Folded run of tool calls / thoughts
    │   │                  #   (a group whose running parts have no live run
    │   │                  #   around them renders FROZEN — stop glyph, no
    │   │                  #   spinner: a restart orphan, see ToolCard)
    │   ├── ThinkingBlock.tsx # Reasoning disclosure (live while streaming)
    │   ├── ToolCard.tsx   # One tool call as a FoldRow (detail/accent lines;
    │   │                  #   file-mutating tools expand to a git-diff view;
    │   │                  #   failed calls show ONLY the error reason — no
    │   │                  #   attempted diff, no accent counts — and fold
    │   │                  #   themselves after ERROR_DISCLOSURE_MS;
    │   │                  #   markdown-flagged tools (webfetch/websearch/
    │   │                  #   vision — output markdown BY SPEC, see
    │   │                  #   toolOutputIsMarkdown) render their expanded
    │   │                  #   output through the Markdown component as
    │   │                  #   prose; every other tool stays the plain mono
    │   │                  #   pre-wrap — verbatim output must never be
    │   │                  #   mangled by a renderer; FROZEN rendering — a
    │   │                  #   running part on an idle session (its run died
    │   │                  #   with the app; the server never settles orphan
    │   │                  #   parts) shows the stop glyph + "已中断" detail
    │   │                  #   suffix instead of pulsing forever, display-only
    │   │                  #   — the parents derive it from the message-level
    │   │                  #   streaming flag, which for a part-carrying
    │   │                  #   message equals the session's busy state)
    │   ├── DiffViewBody.tsx # Shared @git-diff-view/react wrapper (Unified
    │   │                  #   mode, built-in lowlight highlighting keyed off
    │   │                  #   the file name, wrap, theme from SurfaceColors)
    │   │                  #   for BOTH diff surfaces: ToolCard's diff body
    │   │                  #   and ChangesSection's FileDiffBody. Hunks are
    │   │                  #   precomputed in toolDiff.ts and memoized by
    │   │                  #   callers (DiffView rebuilds its DiffFile on data
    │   │                  #   identity change). diffView.css scopes the
    │   │                  #   overrides: transparent rows over the recessed
    │   │                  #   glass, soft add/del washes, the settings
    │   │                  #   code size (!important vs the lib's inline px),
    │   │                  #   and a single narrow NEW-number gutter (the
    │   │                  #   lib's dual old|new one collapsed to one
    │   │                  #   column; content lines AND hunk rows must be
    │   │                  #   overridden together or rows misalign).
    │   ├── toolMeta.ts    # Pure tool display table + input-shape helpers
    │   │                  #   (TOOL_META, toolDisplayName, errorText,
    │   │                  #   inputFilePath for the diff's language
    │   │                  #   detection; patch shares edit's entry).
    │   │                  #   node-testable.
    │   ├── toolDiff.ts    # Pure diff model for edit/apply_patch/write inputs
    │   │                  #   (LCS line diff, patchText coloring, changed-line
    │   │                  #   counts) PLUS the hunk sources git-diff-view
    │   │                  #   renders: patchHunks (real patches keep real line
    │   │                  #   numbers), fragmentHunks (fragment-relative
    │   │                  #   synthesis), toolHunksFor (null exactly where
    │   │                  #   toolDiffFor is, so counts and view agree) —
    │   │                  #   the server never stores the pre-edit file, so
    │   │                  #   diffs derive from tool input alone. The PATCH
    │   │                  #   FAMILY (name `patch` on server v2.0.x, renamed
    │   │                  #   `apply_patch` upstream; GPT-family models ONLY —
    │   │                  #   the server deletes edit/write for them, everyone
    │   │                  #   else never sees it) is multi-file: one call mixes
    │   │                  #   Add/Update(+Move)/Delete sections in an
    │   │                  #   apply_patch envelope (*** Begin Patch …, hunks
    │   │                  #   WITHOUT line numbers). toolPatchFiles builds
    │   │                  #   per-file views — preferring the completed part's
    │   │                  #   metadata.files (server-computed unified diffs
    │   │                  #   with real line numbers), falling back to parsing
    │   │                  #   the envelope (running tools); toolDiffFor
    │   │                  #   flattens them for the accent counts and ToolCard
    │   │                  #   stacks one DiffBody per file. node-testable.
    │   ├── SubagentCard.tsx # Subagent tool renderer. A part carrying
    │   │                  #   metadata.sessionID (running via
    │   │                  #   tool.progress, settled afterwards) has its
    │   │                  #   row CLICK drill the workspace panel into
    │   │                  #   the child's live transcript
    │   │                  #   (requestStatsSubagentDrill) instead of
    │   │                  #   toggling the inline report fold — looks
    │   │                  #   unchanged otherwise; the wrapper div's
    │   │                  #   data-lum-stats-drill exempts the click
    │   │                  #   from the panel's outside-click collapse.
    │   │                  #   Parts without a link keep the fold
    │   ├── RunFooter.tsx + runFooters.ts # Per-turn summary footer (pure collector in
    │   │                  #   runFooters.ts — node-testable; the footer
    │   │                  #   info carries the run's opening userMessageId).
    │   │                  #   Beyond copy + duration, a turn that EDITED
    │   │                  #   files gets the turns-edits CARD below the
    │   │                  #   row — a recessed bordered box (useColors)
    │   │                  #   whose header "N files changed +A −D"
    │   │                  #   expands through the .lum-fold pattern into
    │   │                  #   the file rows (type icon + gray directory
    │   │                  #   prefix + name + per-file counts,
    │   │                  #   DIFF_ADD/DIFF_DEL accents) — and each row
    │   │                  #   DRILLS the right-side stats panel into that
    │   │                  #   file's diff via requestStatsFileDrill
    │   │                  #   (useStatsPanelMode.ts's cross-surface
    │   │                  #   request store; the rows carry
    │   │                  #   data-lum-stats-drill so the panel's
    │   │                  #   outside-click collapse spares them). Data
    │   │                  #   from useTurnEdits.
    │   ├── TailWorking.tsx + tailActivity.ts # The transcript tail's "still
    │   │                  #   working" loop: a label followed by three
    │   │                  #   quiet dots (.lum-loading's small .lum-loading-tail
    │   │                  #   variant) hung under the last transcript
    │   │                  #   block while the session is busy but the
    │   │                  #   tail is SILENT — the first-token wait after
    │   │                  #   a prompt, the gap between model steps (a
    │   │                  #   completed tool, the next step's message not
    │   │                  #   open yet), mid-answer stalls, steps opened
    │   │                  #   with no parts. ANTI-FLICKER state machine
    │   │                  #   (TailWorking's hook): the dots appear only
    │   │                  #   after the tail stays quiet TAIL_QUIET_MS
    │   │                  #   (progress resets via tailProgressSignature,
    │   │                  #   a VALUE signature — array identity is
    │   │                  #   useless under ChatView's per-render
    │   │                  #   filter), ride out the rest of the run once
    │   │                  #   shown, and stand down no sooner than
    │   │                  #   TAIL_MIN_SHOW_MS (the min-dwell idea from
    │   │                  #   useExpansion). Suppressed while the tail
    │   │                  #   self-animates (pending/running tool's
    │   │                  #   pulsing icon — tailSelfAnimating) or the
    │   │                  #   session waits on the USER (ChatView's
    │   │                  #   waitingForUser: permission/question/plan
    │   │                  #   approval cards — a decision, not work); a
    │   │                  #   stalled reasoning stream deliberately still
    │   │                  #   shows it. Label via tailWorkLabel
    │   │                  #   ("Thinking" fresh turn → "Working" once
    │   │                  #   the run has output — no ellipsis; the
    │   │                  #   pulsing dots are the ongoing signal, and
    │   │                  #   the "..." variants belong to ThinkingBlock
    │   │                  #   / ActivityGroup, which have no dots). A
    │   │                  #   PENDING STOP overrides everything: while the
    │   │                  #   sessionStopping marker is up (busy &&
    │   │                  #   stopping), the row force-shows IMMEDIATELY —
    │   │                  #   skipping TAIL_QUIET_MS and the
    │   │                  #   self-animation/waiting suppressions (a running
    │   │                  #   tool is exactly when users press stop) — as
    │   │                  #   "Stopping" instead of the derived label.
    │   │                  #   Subagent transcripts pass busy and
    │   │                  #   get the dots too (SubagentsSection); they
    │   │                  #   never pass stopping.
    │   │                  #   tailActivity.ts is pure + node-testable.
    │   ├── UsageRing.tsx + usageStats.ts # Context/cost ring (pure math in usageStats.ts)
    │   ├── Markdown.tsx   # Shared react-markdown + remark-gfm; links via plugin-opener.
    │   │                  #   Splits text into memoized block chunks (only the
    │   │                  #   tail chunk re-parses per streamed delta) and gates
    │   │                  #   the CSS entrance fade to `live` (streaming)
    │   │                  #   messages — see markdownBlocks.ts + main.css.
    │   │                  #   Code blocks carry a floating COPY chip
    │   │                  #   (top-right, host-span anchored, elevated
    │   │                  #   surface + reveal ladder in main.css):
    │   │                  #   mdCodeText.ts (pure, node-testable)
    │   │                  #   extracts the raw text lazily at click.
    │   │                  #   OFFICE-DOCUMENT LINKS: MdLink (the `a`
    │   │                  #   override, module-scoped for identity
    │   │                  #   stability) reads MarkdownWorkspaceContext —
    │   │                  #   provided ONLY by AssistantBlock with the
    │   │                  #   session directory (a context so the
    │   │                  #   memoized blocks keep stable identities;
    │   │                  #   every other Markdown consumer — gate cards,
    │   │                  #   tool outputs, todos, subagent reports —
    │   │                  #   stays un-provided, plain links) — and an
    │   │                  #   href resolving to a .docx/.pptx (absolute,
    │   │                  #   or relative to that directory; %-decoding
    │   │                  #   tolerated; scheme URLs excluded) renders as
    │   │                  #   the @-file chip look (.lum-file-mention +
    │   │                  #   button.lum-md-doc in main.css) whose click
    │   │                  #   drills the workspace panel into the
    │   │                  #   document's preview
    │   │                  #   (requestStatsDocumentDrill with size 0 =
    │   │                  #   unknown-fresh; the panel's refresh swaps in
    │   │                  #   the scanned row). The write_document tool
    │   │                  #   RESULT instructs the model to emit these
    │   │                  #   [名.docx](./名.docx) links.
    │   ├── markdownBlocks.ts # Pure markdown chunker: cuts at blank-line
    │   │                  #   boundaries outside fenced code, conservatively
    │   │                  #   (loose lists / indented continuations / ref-defs
    │   │                  #   / html blocks never cut — refs & html fall back
    │   │                  #   to a single chunk). Chunks freeze once a later
    │   │                  #   chunk exists, which is what per-chunk memoization
    │   │                  #   relies on. node-testable.
    │   ├── FoldRow.tsx + useExpansion.ts # Disclosure rows with anti-flash minimum open
    │   │                  #   plus a timed self-collapse for terminal error
    │   │                  #   disclosures (the failed-call reason shows itself,
    │   │                  #   then folds like any successful row)
    │   ├── PermissionCard.tsx / QuestionCard.tsx # RequestCards — the ONLY way a blocked
    │   │                  #   session moves forward (answers go to the reply endpoints).
    │   │                  #   All request cards FLOAT ABOVE the composer (the composer is
    │   │                  #   never hidden — a prompt typed while an ask waits queues behind
    │   │                  #   the blocked run). IDENTICAL permission asks (same action +
    │   │                  #   resources — the server fires one assert per tool invocation
    │   │                  #   with no dedup, so parallel external reads stack duplicates)
    │   │                  #   merge into ONE card via permissionGroups.ts (pure,
    │   │                  #   node-testable): one decision replies to the whole group,
    │   │                  #   "always" only to the first (the rule saves once) + "once" to
    │   │                  #   the rest. Shared chrome in RequestCardChrome.tsx; answer
    │   │                  #   rules in formLogic.ts (pure, node-testable).
    │   ├── GateCard.tsx       # The plan workflow's shared GATE chrome — title
    │   │                      #   + icon, restart-orphan warning line, markdown
    │   │                      #   reading area (conditional fades) and the
    │   │                      #   reject/approve pair; PlanApprovalCard and
    │   │                      #   WorkReviewCard are thin wrappers (they were
    │   │                      #   95% identical before this extraction).
    │   ├── QueuedPromptList.tsx # The queued rows above the composer AND their
    │   │                      #   pointer-drag reorder (window listeners +
    │   │                      #   elementFromPoint + the portaled fixed ghost,
    │   │                      #   extracted from ChatView — HTML5 DnD proved
    │   │                      #   unreliable on WebKitGTK). Entrance/exit is
    │   │                      #   the .lum-queue-enter/-exit synced pair.
    │   ├── useGateCards.ts    # The gate cards' DERIVATION + DECISION hook (see
    │   │                      #   ChatView's old inline block): pendingPlan/
    │   │                      #   pendingWork over the transcript with the
    │   │                      #   restart-recovery GateContext, the plan/work
    │   │                      #   decision handlers (switchAgent / the
    │   │                      #   .lumina/review marker file / interrupt),
    │   │                      #   the wake-prompt recovery for restart
    │   │                      #   orphans and the zombie marker probe.
    │   ├── useEditLastMessage.ts # Edit-last-message wiring (ChatView's old
    │   │                      #   inline block): which message qualifies,
    │   │                      #   editing state, the edit bundle threaded to
    │   │                      #   memoized rows, submit = editResend +
    │   │                      #   snapToBottom on success.
    │   ├── UserBubble.tsx     # The USER half of a transcript entry (split from
    │   │                      #   MessageItem.tsx): the accent bubble,
    │   │                      #   attachment chips + previews, the send-failed
    │   │                      #   retry row, the edit pencil — plus
    │   │                      #   TranscriptEditProps (MessageItem re-exports).
    │   ├── AssistantBlock.tsx # The ASSISTANT half of a transcript entry (split
    │   │                      #   from MessageItem.tsx): reasoning disclosure,
    │   │                      #   markdown text, tool cards — folded into
    │   │                      #   activity groups by messageParts.
    │   ├── PlanApprovalCard.tsx # The plan workflow's approval card
    │   │                  #   (Route A): the plan_submit executor
    │   │                  #   BLOCKS inside its tool call, so ChatView
    │   │                  #   derives the pending state from the
    │   │                  #   transcript (sessionActivity.
    │   │                  #   planApprovalPending — a still-running
    │   │                  #   part IS a pending decision) and pins this
    │   │                  #   card above the composer via ExitPresence.
    │   │                  #   批准 = switchAgent("build") (the plugin
    │   │                  #   itself persists the plan documents);
    │   │                  #   驳回 = interrupt (aborts the executor →
    │   │                  #   revision prompt). A malformed payload
    │   │                  #   offers rejection only.
    │   ├── WorkReviewCard.tsx # The plan workflow's ACCEPTANCE card (the
    │   │                  #   second gate): the work_submit executor
    │   │                  #   BLOCKS until the user has TESTED the
    │   │                  #   delivered work — archival certifies
    │   │                  #   "tested and working", never the AI's own
    │   │                  #   claim (workApprovalPending derives the
    │   │                  #   pending report from the transcript).
    │   │                  #   Renders the report markdown + 批准并归档 /
    │   │                  #   驳回; approval = the marker file the
    │   │                  #   executor polls (ChatView writes
    │   │                  #   .lumina/review/<sessionID>.json — the
    │   │                  #   executor then archives to .lumina/archived/
    │   │                  #   and the card collapses as the part
    │   │                  #   settles); rejection = interrupt → fix and
    │   │                  #   resubmit.
    │   ├── QueuedPromptRow.tsx # One queued-prompt row (opencode/
    │   │                  #   promptQueue.ts): recessed row with a drag-
    │   │                  #   grip REORDER — POINTER-EVENT drag
    │   │                  #   coordinated by ChatView (HTML5 DnD proved
    │   │                  #   unreliable in the WebKitGTK webview: the
    │   │                  #   grip's pointerdown opens the session,
    │   │                  #   window listeners resolve the row under
    │   │                  #   the pointer via elementFromPoint — the row
    │   │                  #   root carries data-queued-id — and pointerup
     │   │                  #   root carries data-queued-id — and pointerup
     │   │                  #   commits the rewrite (rewriteQueuedOrder —
     │   │                  #   cancel + re-POST, no server reorder API);
     │   │                  #   Esc/release
     │   │                  #   outside cancels, source dims, target
     │   │                  #   outlines, and a FIXED ghost copy of the
     │   │                  #   row follows the pointer — portaled to
     │   │                  #   document.body (a fixed element inside the
     │   │                  #   tree gets caught by .lum-row's
     │   │                  #   container-type containment and offsets
     │   │                  #   from the cursor), imperative
     │   │                  #   transform writes, pointer-events:none so
     │   │                  #   elementFromPoint still resolves the row
     │   │                  #   beneath it),
     │   │                  #   the text preview (a slash-command entry shows
     │   │                  #   its compact /name args form, not the expanded
     │   │                  #   template; a diverted send strips its
     │   │                  #   protocol note), and stop-and-send (snapshot +
     │   │                  #   interrupt, NEVER a mid-run steer — see
     │   │                  #   promptQueue.ts) / edit / remove. A row whose
     │   │                  #   queue POST DIED renders failed (danger-text
     │   │                  #   label + retry button; a `sending` row dims
     │   │                  #   with its actions disabled).
    │   │                  #   The edit pencil locks while edit-last-message
    │   │                  #   owns the composer (the two buffers must not
    │   │                  #   clobber each other). ENTRANCE is SYNCED
    │   │                  #   two-layer: the ExitList wrapper wears
    │   │                  #   .lum-queue-enter (grid track 0fr→1fr — the
    │   │                  #   content above is pushed up smoothly, in
    │   │                  #   lockstep) while `entering` puts
    │   │                  #   .lum-queue-rise on the row (translate+fade,
    │   │                  #   SAME easing — floats up out of the
    │   │                  #   composer); EXIT fades AND collapses the
    │   │                  #   wrapper's track (1fr→0fr — the remaining
    │   │                  #   rows glide up into the vacated space;
    │   │                  #   ExitList's exitClassName override).
    │   ├── RequestCardChrome.tsx # Card + CardButton + MONO_STYLE (mono
    │   │                  #   family + settings-driven --lum-code-size)
    │   │                  #   shared by the request kinds and tool cards;
    │   │                  #   MONO_ROW_STYLE adds the 1px baseline
    │   │                  #   correction for mono detail text inline in
    │   │                  #   a sans FoldRow row (items-center centers
    │   │                  #   line boxes, not baselines).
    │   └── formLogic.ts   # Pure form-answer rules: fieldVisible (`when`
    │                      #   conditions), normalize (per-type values).
    │
    ├── stats/            # The workspace stats panel — a FLEX SIBLING of
    │                      #   the conversation in App's row, OUTSIDE the
    │                      #   session swap: App mounts the
    │                      #   WorkspaceStatsCard wrapper beside ChatView,
    │                      #   KEYED BY DIRECTORY — same-directory session
    │                      #   switches keep the card mounted (content
    │                      #   swaps in place), cross-directory switches
    │                      #   remount it (the surface swap covers the
    │                      #   transition), and the welcome screen never
    │                      #   shows it. Data:
    │                      #   the directory's working-copy diff
    │                      #   (opencode/useWorkspaceDiff) + the ACTIVE
    │                      #   session's terminals/subagents
    │                      #   (opencode/useSessionActivity over the
    │                      #   message-store snapshot); the panel's
    │                      #   expansion state is useStatsExpanded
    │                      #   (survives the directory-keyed remounts);
    │                      #   expansion is
    │                      #   content-height (detail views cap at the
    │                      #   container's full height, the overview at
    │                      #   75vh); outside-click/Escape collapse is the
    │                      #   useStatsPanelMode "auto" mode)
    │   ├── WorkspaceStatsCard.tsx # The card's data owner: consumes the
    │                      #   context scope hooks (workspace diff by
    │                      #   directory, session terminals/subagents)
    │                      #   PLUS the worktree write-back scope
    │                      #   (useWorktreeSyncOf + the directory's
    │                      #   binding — null for non-managed
    │                      #   directories, hiding pill + section; the
    │                      #   active session's busy→idle flip is one of
    │                      #   the drift probe's refresh triggers),
    │                      #   then renders SessionStatsCard (colors via
    │                      #   context).
    │   ├── SessionStatsCard.tsx # The card (presentation + local
    │                      #   navigation only): collapsed summary rows
    │                      #   (branch-sync drift, plan progress ✓n/N,
    │                      #   +N −N lines, terminal/subagent counts)
    │                      #   expanding into
    │                      #   the detail panel (TodoSection rides ABOVE
    │                      #   BranchSyncSection ABOVE
    │                      #   ChangesSection — see stats/TodoSection;
    │                      #   the write-back's section/pill exist only
    │                      #   for managed-worktree directories with
    │                      #   drift or a last outcome).
    │                      #   ALL motion
    │                      #   is CSS (§3.7): the root wears .lum-enter /
    │                      #   .lum-fade-exit (the exit engine holds the
    │                      #   unmount), the WIDTH transitions between the
    │                      #   fixed overview/detail values while flex
    │                      #   reflows the conversation beside it frame by
    │                      #   frame, height is content-driven (capped by
    │                      #   max-height) and content swaps fade via
    │                      #   .lum-enter — no measuring, no pinning, no
    │                      #   shared-element flights, no settle/arming
    │                      #   protocol (the whole JS box machinery was
    │                      #   deleted). Position comes from the .lum-stats
    │                      #   container-query rule in main.css: collapsed
    │                      #   pill floats; an expanded panel becomes a
    │                      #   real flex sibling once the row fits the
    │                      #   widest panel beside the column's floor.
    │                      #   Kept: the useStatsExpanded module store,
    │                      #   outside-click/Escape collapse, "always" mode,
    │                      #   live drill-entry resolution, and the
    │                      #   same-directory session-switch view reset.
    │                      #   THE UNFURL CHOREOGRAPHY: every collapsible
    │                      #   slot is a Reveal — the four pill rows
    │                      #   (as="span", legal button innards) and the
    │                      #   four overview section slots stay MOUNTED
    │                      #   with their condition as `present`, so a
    │                      #   row/section APPEARING while the card is on
    │                      #   stage unfurls from zero height
    │                      #   (.lum-row-enter) — old content untouched,
    │                      #   the card's border growing along frame by
    │                      #   frame (content drives the outer size; the
    │                      #   section dividers' CSS keys on Reveal
    │                      #   wrappers containing a section via :has).
    │   ├── statsChrome.tsx # Shared stats-panel chrome: StatsSection
    │                      #   header, DrillChevron, StateChip, RollingValue /
    │                      #   FinishedTotal counters (RollingTitle drums),
    │                      #   BodyBox (the drill-body surface), statsRowClass
    │                      #   (the .lum-wash hover row).
    │   ├── ChangesSection.tsx # Whole-session git diff: file rows (icon +
    │   │                  #   status chip + net counts) → FileDiffBody (server
    │   │                  #   patch through chat/DiffViewBody + toolDiff.ts's
    │   │                  #   patchHunks — real line numbers). FileTitle /
    │   │                  #   file row & header layoutIds live here. The
    │   │                  #   file rows live in an ExitList with `enter`:
    │   │                  #   a file the AI newly touches unfurls in, a
    │   │                  #   reverted/checked-out file collapses away;
    │   │                  #   mere re-counts/re-orders render instantly.
    │   ├── DocumentsSection.tsx # THE DAILY workspace section (opencode/
    │   │                  #   workspaceDocuments.ts's data): the folder's
    │   │                  #   document inventory — icon + relative path +
    │   │                  #   新增/变更 chip + humanSize per row. A row
    │   │                  #   CLICK on an OFFICE file DRILLS the panel
    │   │                  #   into its preview (DocumentPreviewBody —
    │   │                  #   setView {kind:"document"}, the same
    │   │                  #   overview→detail model as the file/terminal/
    │   │                  #   subagent rows; requestStatsDocumentDrill is
    │   │                  #   the transcript-side twin); every other file
    │   │                  #   opens in the system's default application
    │   │                  #   (openPath — needs opener:allow-open-path,
    │   │                  #   in all three shells' capabilities). The
    │   │                  #   row-end button reveals it in the file
    │   │                  #   manager (revealItemInDir, opener:default).
    │   │                  #   Rows are DIVS (the nested reveal button
    │   │                  #   would be illegal inside a button) wearing
    │   │                  #   statsRowClass; same ExitList `enter`
    │   │                  #   choreography as the changes rows.
    │   │                  #   SessionStatsCard renders this INSTEAD of
    │   │                  #   ChangesSection for daily sessions
    │   │                  #   (activity.mode / documents —
    │   │                  #   WorkspaceStatsCard picks the scope).
    │   ├── DocumentPreviewBody.tsx # The DAILY side's document-preview
    │   │                  #   DRILL BODY (the office-tools plugin's
    │   │                  #   structure sidecar rendered back —
    │   │                  #   opencode/docstruct.ts's contract): a docx
    │   │                  #   renders as a THEME-COLORED document flow
    │   │                  #   (headings/paragraphs/lists/tables/embedded
    │   │                  #   images — a CONTENT preview: docx pagination
    │   │                  #   is computed by Word's layout engine at
    │   │                  #   render time, so no pages, paper chrome or
    │   │                  #   fixed page width are simulated), a pptx as
    │   │                  #   one 16:9 card
    │   │                  #   per slide (title/bullets/image/notes footer
    │   │                  #   + page chip). Fidelity is "what the
    │   │                  #   document says", not how Word paginates —
    │   │                  #   the action row's system-app buttons cover
    │   │                  #   the real look. No sidecar (user's own/
    │   │                  #   foreign documents) → a notice + the
    │   │                  #   system-app button; a size mismatch (edited
    │   │                  #   in Word since generation) → the staleness
    │   │                  #   banner, still rendered. Images load as
    │   │                  #   blob URLs through readFileBlob (the
    │   │                  #   AttachmentPreview lifecycle — revoked on
    │   │                  #   swap/unmount); unknown block types render
    │   │                  #   as nothing (forward-compatible with a
    │   │                  #   newer plugin). The row resolves LIVE at
    │   │                  #   the card (a re-scan's byte count flows
    │   │                  #   into the staleness check).
    │   ├── TerminalsSection.tsx # Background-shell rows (ExitList with
    │   │                  #   `enter`: a shell moved off the foreground
    │   │                  #   unfurls in at the bottom of the list —
    │   │                  #   bulk mounts, including a same-directory
    │   │                  #   session switch's wholesale swap, keep the
    │   │                  #   plain crossfade; running pulse / exit chip;
    │   │                  #   a running row cross-fades its drill
    │   │                  #   chevron into a hover STOP button — manual kill
    │   │                  #   via DELETE /api/shell/{id}, optimistic in
    │   │                  #   useSessionActivity.stopShell) → TerminalBody:
    │   │                  #   cursor-paginated output polled
    │   │                  #   every 2s while running, follow-bottom, 200k-char tail
    │   │                  #   cap, falls back to the notification's embedded output
    │   │                  #   once the process-local shell registry 404s (a manual
    │   │                  #   stop removes the retained output too, so the
    │   │                  #   fallback is the normal path after one). The api
    │   │                  #   handle comes from useConnection().
    │   ├── SubagentsSection.tsx # Subagent rows (ExitList with `enter`,
    │   │                  #   like TerminalsSection; agent + task
    │   │                  #   label + running
    │                      #   state) → SubagentBody: read-only transcript
    │                      #   through useSessionTranscript (the shared
    │                      #   module-level message store + TranscriptList, so
    │                      #   background children stream in live; mounting the
    │                      #   body seeds the child session's store).
    │   └── TodoSection.tsx # The plan workflow's section — the approved
    │                      #   plan's task list with live statuses (○ pending,
    │                      #   ◐ in-progress = first pending task while the
    │                      #   session is busy — DERIVED, no task_begin tool;
    │                      #   ✓ completed struck through, ⏸ blocked with its
    │                      #   reason). Sits ABOVE ChangesSection by design:
    │                      #   the plan frames the work, the diff is residue.
    │                      #   Statuses swap in place; plan_amend's
    │                      #   structural edits animate — appended tasks
    │                      #   unfurl in, dropped tasks collapse away
    │                      #   (ExitList `enter`, keyed by TITLE — never
    │                      #   the index, so mid-list insertions don't
    │                      #   churn shifted rows into fake exits).
    │                      #   The header count swaps for state chips:
    │                      #   pendingApproval → "waiting for approval",
    │                      #   ALL tasks settled without acceptance →
    │                      #   "awaiting review" (the standing invitation
    │                      #   to test — archival is the user's call),
    │                      #   a completed work_submit → "archived"
    │                      #   (terminal; the record lives in
    │                      #   .lumina/archived/).
    │   └── BranchSyncSection.tsx # The worktree write-back's expanded
    │                      #   section (opencode/worktreeSync.ts runs
    │                      #   the git, useWorktreeSync.ts holds the
    │                      #   state): the binding line (branch → main
    │                      #   repo, full path on hover), the drift
    │                      #   counts (commits ahead / dirty files), the
    │                      #   同步到本地分支 button (disabled while the
    │                      #   session runs — hint explains why) and the
    │                      #   last outcome line (synced summary /
    │                      #   diverged + the exact `git -C <main> merge
    │                      #   <sha>` to run / error + git's own text).
    │                      #   The collapsed pill lives in
    │                      #   SessionStatsCard (attention signal:
    │                      #   drift or an in-flight sync).
    ├── composer/          # The prompt composer
        ├── ChatInput.tsx  # Composer shell: staged attachments (chips),
        │                  #   slash-command fetch (per-directory, retried),
        │                  #   LexicalComposer wiring, toolbar. ALSO THE
        │                  #   EDIT-LAST-MESSAGE surface: editMessage prop
        │                  #   (from ChatView) enters edit mode — the
        │                  #   message's text loads via the editor handle,
        │                  #   its attachments become removable chips, an
        │                  #   "Editing message" banner offers cancel, and
        │                  #   the in-progress draft is STASHED and
        │                  #   restored when the edit ends without a
        │                  #   submit (written back into the draft store
        │                  #   on mid-edit unmount); submit routes to
        │                  #   onSubmitEdit, whose false (revert failed)
        │                  #   keeps the whole buffer. ALSO THE QUEUED
        │                  #   EDIT surface: draftLoad {token, text,
        │                  #   files} (ChatView, from a QueuedPromptRow's
        │                  #   pencil) loads a queued prompt back into the
        │                  #   composer — normal mode only (the pencil
        │                  #   locks while an edit-last-message session is
        │                  #   active) — then fires onDraftLoaded. While
        │                  #   busy the placeholder switches to the
        │                  #   queue hint ("继续输入以排队发送").
        │                  #   toolbarMinimal (MOBILE welcome only)
        │                  #   reduces the toolbar to attach + send —
        │                  #   the below-composer cluster hosts the
        │                  #   settings controls + selectors.
        ├── ComposerCore.tsx # Editor internals: trigger-driven suggestions,
        │                  #   keyboard routing (Enter/arrows/Tab/Esc, IME-safe),
        │                  #   submit serialization, paste-to-attach.
        │                  #   Exposes the imperative handle (submit,
        │                  #   setText/setState — edit-mode entry and
        │                  #   full-fidelity draft restore); onSubmit may
        │                  #   resolve false to KEEP the buffer (edit's
        │                  #   revert failed); Esc with no popup open
        │                  #   cancels an active edit.
        ├── ComposerToolbar.tsx # Bottom toolbar: attach/mode/project on the
        │                  #   left; usage ring, model, thinking depth on
        │                  #   the right. The send/stop slot is CONTENT-
        │                  #   DRIVEN: text ready → send (mid-run it
        │                  #   QUEUES — opencode/promptQueue.ts — instead
        │                  #   of steering the run, and the title says so),
        │                  #   no text while running → stop, idle + empty →
        │                  #   send disabled. The settings controls and
        │                  #   selectors live in EXPORTED components
        │                  #   (same file): ComposerSettingsControls
        │                  #   (mode picker + pre-session directory/
        │                  #   branch pickers) and ComposerSelectors
        │                  #   (usage ring + model + thinking depth with
        │                  #   ALL the catalog wiring: provider groups,
        │                  #   disabled-model filter, context-limit
        │                  #   resolution, variant-preserving switch, the
        │                  #   model-config entry raising
        │                  #   onOpenModelConfig) — because MOBILE's
        │                  #   welcome screen hosts the whole cluster
        │                  #   BELOW the composer (five labeled controls
        │                  #   cannot fit a phone row) while the
        │                  #   in-session toolbar embeds both
        │                  #   (ComposerSelectors' align prop — the
        │                  #   centered welcome cluster passes "auto":
        │                  #   PopoverMenu measures at open and clamps
        │                  #   the panel into the viewport, since a
        │                  #   wrapping chip row has no stable screen
        │                  #   side); minimal={true} strips the
        │                  #   toolbar to attach + send and adds
        │                  #   .lum-toolbar-plain (send keeps its
        │                  #   right-edge spring, main.css).
        ├── composerSerialize.ts # The composer's submit serialization — the
        │                  #   editor-state → {text, paths} walk (mention
        │                  #   tokens re-prefixed "@relative"; the
        │                  #   composerTriggers.ts precedent for extracted
        │                  #   Lexical node algorithms).
        ├── composerTriggers.ts # Lexical node-tree algorithms: `@`/`/` trigger
        │                  #   detection (CJK-aware) + atomic mention ←/→.
        ├── composerAttachments.ts # Data-URI attachment reader + size cap
        │                      #   (10MB; oversize/unreadable picks are
        │                      #   COUNTED back to ChatInput's red notice,
        │                      #   never silently dropped) + filesFromMessage
        │                      #   — the sent-message → attachments rebuild
        │                      #   shared by edit-mode chip staging AND the
        │                      #   failed-send retry (uri riders and
        │                      #   file:// refs pass through verbatim;
        │                      #   node-testable, composerAttachments.test.ts).
        ├── composerDrafts.ts  # In-memory composer draft store (Map keyed
        │                      #   by surface — WELCOME_DRAFT_KEY or the
        │                      #   session id): serialized Lexical
        │                      #   EditorState + staged attachments
        │                      #   survive the session-surface swap's
        │                      #   remounts; cleared on submit.
        ├── InputSuggestions.tsx # Autocomplete popup (@ / / triggers)
        ├── FileMentionNode.tsx / CommandMentionNode.tsx # Lexical token TextNodes
        ├── ToolbarButton.tsx # The composer's compact toolbar control
        ├── DirectoryPicker.tsx # Working-directory chooser (dialog + GET /api/project);
        │                      #   DEV ONLY (ComposerSettingsControls hides
        │                      #   it in daily mode — the workspace is fixed)
        │                      #   and with NO "default directory" item: dev
        │                      #   sessions must name a real project, the
        │                      #   unset state blocks sending
        │                      #   (useSessionFlow's sendBlocked) until a
        │                      #   choice is made, and an unstaged welcome
        │                      #   composer preselects the most recent dev
        │                      #   session's project. The BRANCH binding is
        │                      #   its own sibling button (BranchPicker) —
        │                      #   the two stay independent picks on the
        │                      #   toolbar.
        └── BranchPicker.tsx   # The pre-session BRANCH button (the project
                          #   picker's sibling): the plain LOCAL branch
                          #   list; picking a branch → sendFirst pins the
                          #   next session to a server worktree. The
                          #   repo's DEFAULT branch (remote HEAD symref
                          #   `.git/refs/remotes/<remote>/HEAD`, read via
                          #   fs/read → gitInfo.parseRemoteHead, with the
                          #   conventional main/master fallback of
                          #   pickDefaultBranch; none determinable → no
                          #   chip) wears a 「主分支」chip; the CURRENT
                          #   branch wears 「当前分支」 when it is not the
                          #   default, stays sorted to the TOP, and
                          #   selecting IT means the plain main worktree
                          #   (that row doubles as the default/null
                          #   binding — no isolation, the session runs
                          #   where the user's checkout already is; the
                          #   null binding is tied to the CHECKOUT, never
                          #   to the default branch — picking 「主分支」
                          #   from a `dev` checkout still pins a worktree).
                          #   Remote refs are classified away, not listed.
                          #   The button shows the STAGED branch, else the
                          #   CURRENT one (a "following" state); hidden
                          #   when the staged directory has no branch list
                          #   (no repo / subdir / probe failed). Branch
                          #   list fetched per mount (the vcs warmup
                          #   empty-first-call re-checked once), shaped by
                          #   gitInfo; a DIRECTORY retarget clears the
                          #   staged branch (useSessionFlow's
                          #   changeDirectory — the one place the siblings
                          #   meet).

    └── settings/           # The settings modal (title-bar gear; layout
                           #   follows lumina-terminal's settings pages)
    ├── SettingsModal.tsx # Modal shell; TWO LAYOUTS. Desktop: left tab
    │                      #   rail (General / Model / About) over
    │                      #   ui/Modal; ONE pane mounts at a time
    │                      #   (mount doubles as the pane's open →
    │                      #   ModelSettings loads/resets on mount).
    │                      #   Mobile: TWO-LEVEL page navigation — a
    │                      #   full-width CATEGORY LIST (the tab rows
    │                      #   as h-11 chevron rows) pushes the pane
    │                      #   as a sliding page (.lum-m-page-in from
    │                      #   the right, an absolute overlay over the
    │                      #   always-mounted list; back = Modal's
    │                      #   onBack arrow popping it out through the
    │                      #   exit engine, the frozen-pane ghost kept
    │                      #   by a lastPaneRef). App owns {open, tab}
    │                      #   so entry points deep-link a tab; NULL
    │                      #   tab = the mobile root list (desktop
    │                      #   reads null as "general"), so list rows
    │                      #   and the desktop rail share one
    │                      #   onTabChange and openSettings("model")
    │                      #   lands directly on the second level.
    ├── GeneralSettings.tsx # Language + appearance rows, the
    │                      #   SLIMMED: the system-prompt editor
    │                      #   (SystemPromptSection.tsx) and the Blur my
    │                      #   Shell rows (BlurMyShellSettings.tsx) are files
    │                      #   now; SectionHeader is shared with About.
    │                      #   activity-panel mode OptionRow (auto
    │                      #   collapse / always open), the desktop-
    │                      #   notification tier OptionRow + focus-mute
    │                      #   Switch (useNotificationMode), the
    │                      #   Linux-only window-outline Switch, the
    │                      #   Linux+GNOME Blur my Shell rows (state-
    │                      #   guided: notInstalled/disabled/blacklisted
    │                      #   hint, notListed offers the one-click
    │                      #   "接入" button — addToBmsWhitelist — and
    │                      #   active binds the translucent render's
    │                      #   Switch + the opacity/static-blur advice
    │                      #   lines; the pane mount re-probes), a Fonts
    │                      #   section (AboutSettings-style header; one
    │                      #   control per row — family input / size
    │                      #   stepper — plus reset), and the CUSTOM
    │                      #   SYSTEM PROMPT section — the pane's only
    │                      #   server-backed editor (SystemPromptSection:
    │                      #   loads the plugin-level systemPrompt option
    │                      #   from the global opencode.json on mount,
    │                      #   saves through ensureLuminaToolsPlugin with
    │                      #   withSystemPrompt, JSONC/read-failure
    │                      #   degrade to the manual-edit notice); the
    │                      #   rest acts instantly through
    │                      #   module stores (i18n, useThemePreference,
    │                      #   useStatsPanelMode, useWindowOutline,
    │                      #   useBlurMyShell, useTypography).
    ├── modelSettingsChrome.tsx # Shared chrome for the Model pane's sub-views
    │                      #   (split out of ModelSettings.tsx): Field (the
    │                      #   labeled form row), AccentBadge (the ONE accent
    │                      #   status badge — four hand-rolled copies' text
    │                      #   colors had already drifted), useModelsList
    │                      #   (the cancel-safe listModels effect ToolsTab and
    │                      #   ProviderDetail both ran).
    ├── ToolsTab.tsx      # The Model pane's THIRD tab — Lumina Code's custom
    │                      #   tools (src/plugins/luminaTools.js): the vision
    │                      #   tool's model picker + on/off switch, saved
    │                      #   through the shared installer. Split from
    │                      #   ModelSettings.tsx.
    ├── ProviderDetail.tsx # One provider's auth surface (split from
    │                      #   ModelSettings.tsx): stored credentials
    │                      #   (activate/remove), the API-key form, OAuth
    │                      #   buttons + the device-code status block, the
    │                      #   env hint, per-model picker-visibility toggles.
    ├── CustomProviderForm.tsx # The custom provider add/edit form (split from
    │                      #   ModelSettings.tsx); validation + config-text
    │                      #   building live in modelConfig.ts
    │                      #   (validateCustomProvider / customProviderText).
    ├── SystemPromptSection.tsx # The General pane's custom system prompt
    │                      #   editor (split from GeneralSettings.tsx — a
    │                      #   server-config editor among instant-apply
    │                      #   rows): loads the plugin-level systemPrompt
    │                      #   option, saves through ensureLuminaToolsPlugin
    │                      #   with withSystemPrompt, JSONC/read-failure
    │                      #   degrade to the manual-edit notice.
    ├── BlurMyShellSettings.tsx # The Blur my Shell rows (split from
    │                      #   GeneralSettings.tsx; the isLinux() gate lives
    │                      #   HERE — one check, not one per row).
    ├── SectionHeader.tsx  # The one settings section-header look (General's
    │                      #   Typography group + About's Dependencies —
    │                      #   two identical inline copies before).
    ├── ModelSettings.tsx # Formerly composer/ModelConfigModal: searchable
    │                      #   SLIMMED in the structure refactor: ToolsTab /
    │                      #   ProviderDetail / CustomProviderForm are files
    │                      #   now (this directory), the OAuth state machine
    │                      #   is hooks/useIntegrationOAuth, shared chrome in
    │                      #   modelSettingsChrome.tsx — this file is the pane
    │                      #   shell (tabs, providers list, custom list).
    │                      #   integration list, API-key connect, browser-OAuth
    │                      #   flow with attempt polling, credential
    │                      #   activate/remove, per-provider model switches
    │                      #   (picker visibility via useDisabledModels);
    │                      #   custom OpenAI-compatible providers written to
    │                      #   the global opencode.json (server hot-reloads →
    │                      #   config.updated event); THIRD tab Tools — the
    │                      #   custom-tools surface (ToolsTab): configures
    │                      #   Lumina Code's plugin tools, currently the
    │                      #   vision model (picker over image-capable
    │                      #   catalog models + Off), saving through the
    │                      #   shared installer
    │                      #   (opencode/useLuminaTools.ts; plan_mode needs
    │                      #   no configuration — always-on). The OAuth
    │                      #   PENDING block renders the attempt's
    │                      #   `instructions` — device-code flows (xAI/Grok
    │                      #   SuperGrok, GitHub Copilot, OpenAI Codex)
    │                      #   embed the verification code the browser asks
    │                      #   the user to compare/enter, so
    │                      #   modelConfig.ts's parseOAuthInstructions
    │                      #   (pure) splits it out for a prominent mono
    │                      #   display + copy; code-less instructions
    │                      #   (Snowflake etc.) show as a plain caption.
    ├── ServerSettings.tsx # The Server pane — DUAL-PURPOSE by platform.
    │                      #   Desktop: sign in to a self-hosted
    │                      #   lumina-code-server (url + credentials → the
    │                      #   serverConnection store, picked up live by
    │                      #   useServerFrp), the remote-access Switch
    │                      #   + its LIVE frp connection status row
    │                      #   (useFrpStatus — colored dot + label:
    │                      #   connecting / connected / reconnecting /
    │                      #   retrying / no-frps / error; route id on
    │                      #   success, error text on failure), sign
    │                      #   out (revoke best-effort then clear).
    │                      #   Mobile: the app's
    │                      #   ACCOUNT page — the logged-in server
    │                      #   address + sign out (logout best-effort
    │                      #   then clearMobileConnection, which remounts
    │                      #   the whole tree back to the login screen).
    ├── AboutSettings.tsx # About pane: centered identity hero (icon +
    │                      #   name + app version via getVersion), the
    │                      #   OpenCode server version as a key/value line,
    │                      #   and dependencies as a two-column grid —
    │                      #   whitespace-separated, no hairline rows.
    ├── SettingRow.tsx    # Settings row primitive (ported from
    │                      #   lumina-terminal, reduced to the control row;
    │                      #   the About pane renders its own fact lines).
    ├── Switch.tsx        # The settings pill switch (extracted from
    │                      #   ModelSettings when General needed one too).
    ├── TextInput.tsx     # The settings boxed text input (same extraction).
    ├── TextArea.tsx      # Its multiline twin (same surface language) for
    │                      #   paragraph values — the General tab's custom
    │                      #   system prompt.
    ├── modelConfig.ts    # Pure model-config logic: integration search,
    │                      #   custom-provider config merge/remove/read-back
    │                      #   (globalConfigTarget itself lives in
    │                      #   opencode/configFiles.ts; the custom-tools
    │                      #   twin toolPluginConfig.ts also lives in
    │                      #   opencode/ now). node-testable.
```

### Backend (`src-tauri/src/`) — the webkit shell

Intentionally thin — server lifecycle only (plus the two frontend-serving
odd ones out, notify.rs and blur.rs). All business logic lives in the
frontend. `system.rs` plus the `opencode/` module:

```
src-tauri/src/
├── main.rs        # entry, calls lib::run()
├── lib.rs         # Tauri builder: plugins (log → LogDir "lumina-code" + Webview
│                  #   target, os, opener, dialog, notification, store — the
│                  #   last one being tauri-plugin-store, the file-backed
│                  #   persistence behind lib/persistedStore.ts's state file),
│                  #   Linux env workarounds set BEFORE
│                  #   GTK init (__NV_DISABLE_EXPLICIT_SYNC; GDK_DEBUG=gl-no-fractional
│                  #   for Wayland fractional scaling), invoke_handler, and the Exit
│                  #   hook that kills the owned server (opencode::shutdown).
├── system.rs      # is_wayland command (XDG_SESSION_TYPE, WAYLAND_DISPLAY fallback)
├── lumina_http.rs # lumina_request: the lumina-code-server HTTP transport (the Rust
│                  #   half of opencode/serverConnection.ts's LuminaServerApi).
│                  #   WHY requests to the self-hosted server must NOT ride
│                  #   the webview's fetch (live-observed 2026-10-18, phone
│                  #   -hotspot network + local proxy): tauri/wry's WebKitGTK
│                  #   network stack (libsoup/GnuTLS) failed EVERY path to
│                  #   the server with an opaque `TypeError: Load failed`
│                  #   (system proxy / direct / clean env), while curl
│                  #   (OpenSSL), bare libsoup and a bare WebKitGTK page all
│                  #   succeeded against the same host — a backend channel
│                  #   must not drift with the user's proxy software or the
│                  #   network's TLS-fingerprint handling. So LuminaServerApi
│                  #   invokes this instead of fetch: plain reqwest
│                  #   (native-tls), proxies explicitly DISABLED, 20s
│                  #   timeout, one JSON-in/JSON-out shape ({baseUrl, token,
│                  #   method, path, body?} → {status, body}). Error
│                  #   contract: transport failures are the command's Err;
│                  #   HTTP responses always Ok — the client maps `{error}`
│                  #   bodies + tags `.status` (the old fetch shape). CEF
│                  #   shell mounts it single-source via #[path].
├── frp.rs         # REMOTE ACCESS: the frpc sidecar lifecycle (the tunnel's
│                  #   replacement). frp_start {addr, port, token, routeId,
│                  #   localPort, secure} writes a throwaway frpc.toml into
│                  #   the app data dir (TOML-escaped, routeId
│                  #   charset-validated — it doubles as the frp proxy name
│                  #   AND the nginx /t/<id>/ segment) and spawns the
│                  #   resource sidecar (fetch-frp.mjs; $FRPC_BIN
│                  #   overrides); a monitor thread emits "frp-status"
│                  #   running/exited, frp_stop kills + removes the config,
│                  #   and the app-exit hook calls frp::shutdown so the
│                  #   route drops with the app. TRANSPORT, by the secure
│                  #   flag (server's LUMINA_FRPS_CONTROL decides):
│                  #   secure=true → transport.protocol = "wss" — frpc
│                  #   dials wss://addr:port/~!frp (path FIXED in frp
│                  #   0.71.x) through nginx's WebSocket upgrade; the ONLY
│                  #   shape that passes Cloudflare (CF fronts HTTP(S)
│                  #   only and cuts frp's raw TCP frame — live-observed
│                  #   as "session shutdown"). secure=false → legacy raw
│                  #   TCP + frp's own TLS (direct-reach deployments).
│                  #   Binary resolution mirrors resolve.rs: resource dir →
│                  #   dev checkout binaries/ → PATH. The frontend half is
│                  #   hooks/useServerFrp.ts (registration/heartbeat live
│                  #   there — Rust only supervises the process).
├── notify.rs      # desktop_notify: the Linux notification sender over a
│                  #   PERSISTENT zbus session connection (OnceLock, process
│                  #   lifetime). tauri-plugin-notification/notify-rust drops
│                  #   its per-send connection immediately, and GNOME 46+
│                  #   destroys an app-attributed notification source the
│                  #   moment its sender's bus name vanishes — our window
│                  #   matches the sender pid, so every plugin notification
│                  #   was annihilated (no banner, no tray entry;
│                  #   live-verified against GNOME 50.5 via D-Bus monitor +
│                  #   the extracted shell notificationDaemon source). The
│                  #   app_name matches the installed desktop entry, earning
│                  #   proper "Lumina Code" attribution + icon. Off-Linux the
│                  #   command is a never-routed stub (the plugin serves
│                  #   macOS/Windows); the zbus dep is Linux-gated (already
│                  #   in the tree via notify-rust).
├── blur.rs        # Blur my Shell integration, gsettings IO half (the pure
│                  #   decision layer is src/lib/blurMyShell.ts, the state/
│                  #   render half hooks/useBlurMyShell.ts). GNOME gives apps
│                  #   no blur API — the extension matches wm_class/app_id
│                  #   against its applications whitelist and blurs behind
│                  #   matched windows — but its config is PLAIN GSETTINGS
│                  #   (org.gnome.shell.extensions.blur-my-shell.applications),
│                  #   and the extension re-scans every window on changed::,
│                  #   so a third-party `gsettings set` works live. Two
│                  #   commands: blur_my_shell_probe (spawn_blocking; gate
│                  #   chain: XDG_CURRENT_DESKTOP GNOME token → schema
│                  #   REACHABLE → extension enabled → raw keys blur/
│                  #   enable-all/static-blur/opacity/whitelist/blacklist +
│                  #   our wmClass from current_exe's basename, never
│                  #   hardcoded; GVariant `as` parser — the typed-empty
│                  #   prints as `@as []`, items need trim after ", ")
│                  #   and blur_my_shell_set_whitelist (wholesale write,
│                  #   single-quote escaping). TWO REACHABILITY TRAPS
│                  #   (both live-verified on an extensions.gnome.org
│                  #   install): (1) the schema compiles INSIDE the
│                  #   extension's own schemas/ dir under
│                  #   ~/.local/share/gnome-shell/extensions/<uuid>/,
│                  #   which the gsettings CLI does NOT search (only the
│                  #   shell's in-process loader does) — resolution:
│                  #   plain get first (distro packages install into
│                  #   /usr/share/glib-2.0/schemas), else scan
│                  #   XDG_DATA_HOME/XDG_DATA_DIRS for <uuid>/schemas/
│                  #   gschemas.compiled (UUIDs @aunetx + legacy
│                  #   @aussiedev.me) and pass GSETTINGS_SCHEMA_DIR —
│                  #   LOOKUP-only, dconf storage is identical either
│                  #   way; the resolved source caches (OnceLock) on
│                  #   success only, so a mid-session install is found
│                  #   by the next probe; (2) a present schema ≠ an
│                  #   ENABLED extension — gnome-extensions list
│                  #   --enabled (locale-free UUID lines; failure reads
│                  #   true) gates the chain, else the row would say
│                  #   "active" while nothing blurs. Deliberately does
│                  #   NOT write the extension's global `blur` master
│                  #   switch — joining the whitelist is ours to offer,
│                  #   enabling the extension is the user's call (the
│                  #   settings row hints instead). KNOWN UPSTREAM BUG
│                  #   (BMS #809, open, no fix PR as of 2026-09,
│                  #   live-verified here on GNOME 50.5 + v72): DYNAMIC
│                  #   application blur renders as plain transparency
│                  #   on FLOATING windows ("ghosted") and only works
│                  #   maximized — affects many apps (flathub, Zen…),
│                  #   NOT our integration (the whole chain is proven
│                  #   by the maximized case). Not our bug to fix; do
│                  #   NOT add workarounds gated on maximize state —
│                  #   they become wrong the day upstream fixes it. The
│                  #   user-side fallback is BMS's STATIC blur (Mica-
│                  #   like wallpaper snapshot; works floating).
└── opencode/      # OpenCode server lifecycle, split by concern:
    ├── mod.rs     # Orchestration: OpencodeState/OpencodeConnection types,
    │              #   the `opencode_start` command (spawn `opencode serve` with a
    │              #   generated password + OPENCODE_SERVER_PASSWORD, the webview
    │              #   origin to --cors, version-pin enforcement, monitor thread
    │              #   emitting "opencode-status") and shutdown.
    ├── resolve.rs # Binary discovery ($OPENCODE_BIN → RESOURCE sidecar →
    │              #   dev checkout → PATH → ~/.opencode/bin) +
    │              #   `--version` parsing. The sidecar ships as a Tauri
    │              #   RESOURCE (maps in tauri.*.conf.json) in the app's
    │              #   PRIVATE dir (/usr/lib/Lumina Code/ on Linux
    │              #   packages, Contents/Resources on macOS, install dir
    │              #   on Windows) — NEVER externalBin, whose next-to-exe
    │              #   layout becomes /usr/bin/opencode on deb/rpm (PATH
    │              #   pollution + collision with a user-installed
    │              #   opencode) and whose "next to exe" probe mistook any
    │              #   /usr/bin/opencode for the bundled sidecar.
    ├── probe.rs   # Spawn prerequisites + readiness: free_port, base64,
    │              #   generate_password, and the minimal HTTP GET that polls
    │              #   /api/session WITH auth (unknown routes serve the SPA HTML
    │              #   with HTTP 200, so the probe checks the body is JSON).
    └── reap.rs    # Orphan reaping: every spawn records
                   #   <app_data>/servers/<pid>.txt (body = port + the owning
                   #   app pid; the two-line body makes OLDER builds discard
                   #   instead of kill) and later runs kill only
                   #   provably-ours servers (cmdline check via /proc) whose
                   #   /proc PARENT is not a live app instance — the
                   #   process-tree gate is format-independent, so a sibling
                   #   window running ANY build keeps BOTH its server and its
                   #   record and two app instances coexist; dev rebuilds
                   #   strand several — two servers sharing the user's storage
                   #   cause transiently EMPTY provider reads).
```

### The CEF shell (`cef/src-tauri/`) — the second app crate

The SAME app shipped on the tauri v3 alpha line + `tauri-runtime-cef`
(bundled Chromium 152), Linux-only. It exists as a separate crate because
the dependency graphs are mutually exclusive (CEF requires tauri v3 alpha;
the webkit shell stays on v2 stable) and cargo features cannot switch
dependency versions.

- `cef/package.json` — the CLI package root (`@tauri-apps/cli` v3 alpha,
  own lockfile). The tauri CLI discovers `<cwd>/src-tauri`, which is why
  the shell must live at `cef/src-tauri` — there is no `--project` flag.
- `cef/src-tauri/src/lib.rs` — shell-only wiring: `.runtime(Cef)` (v3's
  DynRuntime — the shared modules' command signatures stay ungenericized),
  `cef_entry_point`, the `LUMINA_DEVTOOLS=1` hook. The five backend modules
  (blur/notify/system/opencode) are mounted **single-source** via
  `#[path = "../../../src-tauri/src/..."]` — child mods resolve relative to
  each file's own directory, so the whole `opencode/` tree comes along.
  **Invariant: the shared modules must compile under BOTH tauri majors**
  (ci-backend.yml checks both crates; a change breaking one shell fails CI).
- `cef/src-tauri/vendor/` — two local patches, both tracked for upstream
  removal (see their inline docs): `tauri-plugin-dialog` (xdg-portal path
  missing `use tauri::Manager`) and `tauri-runtime-cef` (Linux window
  dragging — the CEF browser's X child window starves gtk4-winit's
  `drag_window`; the patch sends the EWMH `_NET_WM_MOVERESIZE` message
  directly, see tauri-apps/tauri#14936).
- Distinguishing the flavors: identifier `com.iewnfod.lumina-code-cef`
  (own data + CEF profile dirs), productName `Lumina Code CEF` (desktop
  entry), `mainBinaryName lumina-code-cef` (parallel-installable with the
  webkit package). **Asset naming (live-observed v0.3.0)**: GitHub's
  release-asset upload replaces spaces with dots, so BOTH flavors' remote
  assets are dotted (`Lumina.Code_0.3.0_amd64.deb`,
  `Lumina.Code.CEF_0.3.0_amd64.deb`) even though the tauri v3 bundler keeps
  the spaces in the local filename — release tooling, PKGBUILD and spec all
  match the DOTTED names (no %20 escapes), while the IN-PACKAGE paths keep
  the spaces (`usr/lib/Lumina Code CEF/`). The v3 deb layout also moves
  the main binary to
  `/usr/share/Lumina Code CEF/` with a `/usr/bin` symlink, and its
  `Depends` list is still the bundler's static gtk3 one although the binary
  links only libgtk-4 (upstream alpha gap; AUR/COPR declare the real deps).
  The frontend detects the runtime via
  `isCefRuntime()` (`lib/platform.ts`, Linux + Chrome UA) and adapts —
  only WINDOW-level corner chrome turns off (the windowOutline inset arc;
  the opaque window's outer corners belong to the WM). The IN-PAGE
  content chrome (MaskedSurface corner clipping + the chrome-glass layer
  beneath the content) stays on under CEF: those corner cutaways expose
  an in-page layer, not the desktop, so the 拼接倒角 at the sidebar seam
  renders like the webkit shell's. One `dist/` serves
  both shells — the v2 npm `@tauri-apps/*` packages are protocol-compatible
  with the v3-alpha core (verified live; the CLI prints a version-mismatch
  notice at build time that is safe to ignore).
- `transparent: false` in its conf — the CEF webview cannot be transparent;
  window corners are the WM's native ones (hence the frontend gate).
- Path asymmetry to remember: config paths (`frontendDist`) are relative to
  the conf file's directory; commands (`beforeDevCommand`) run relative to
  the app dir (`cef/`) — hence `../../dist` vs `--dir ..`.

### The mobile app (`mobile/` + `src/mobile/`) — the desktop tree over the frp route

iOS/Android client on **stable crates.io Tauri 2** (`=`-pinned to the
desktop lock/npm versions — caret CANNOT stay on a minor, see
mobile/README.md). **v2 architecture — the desktop-tree takeover**: the
mobile app mounts the REAL desktop `App` (the whole UI tree: transcript,
composer, settings, drawer sidebar) and talks to the DESKTOP's opencode
**directly** through the server's frp route — `useOpencode`'s
`isMobileApp()` remote branch fetches the credential from
`GET /api/frp/connect` (the account's current route id + the desktop's
opencode password) and connects to `<server>/t/<routeId>/` with
`Basic opencode:<password>`: nginx strips the prefix + rewrites Host to
`<routeId>.frp.internal`, frps routes on the Host, the desktop's frpc
pipes to 127.0.0.1 (spike-verified: SSE streams through with
sub-microsecond overhead; repeatable `--cors` origins let the preflight
through). The branch also owns the remote HEALS: SSE reconnects
re-seed every tracked session (the mobile-network heal), the liveness
gate fast-polls until the route answers then re-issues the api handle
on recovery, and a 401 (desktop restarted → password rotated)
re-fetches the connect info, rebuilds client + stream and reseeds.
The v1 custom screens (SessionList/Session/ComposerBar/ActivityPanel)
are DELETED; only LoginScreen + the kv gate remain under
src/mobile/ (kv.ts now only plants the __LUMINA_MOBILE__ flag and
awaits initPersistedState before importing the app — the old ArkWeb
localStorage shim is gone, replaced by tauri-plugin-store's invoke
channel; the Rust shell's kv_load/kv_set were removed with it).

The route's other halves: **server** `server/src/lib/frp.ts` +
`server/src/app/api/frp/**` (config / routes / connect — the credential
exchange over the `frp_routes` table, one CURRENT route per user with
fresh-route takeover; config also serves the CONTROL-CHANNEL WebSocket
ride `LUMINA_FRPS_CONTROL` → `{control:{host,port,secure}}` — CF-fronted
deployments MUST set it: Cloudflare passes only HTTP(S) and cuts frp's
raw TCP frame at the edge) + the frps container (server/deploy/frps.toml,
mounted by docker-compose: host ports are a contiguous block — 14600
web / 14601 the frpc control channel / 14602 the HTTP vhost (BOTH
published loopback-only by default — the control channel rides nginx's
`location = /~!frp` WebSocket upgrade (frp 0.71.x dials that exact path
with `transport.protocol = "wss"`, frps accepts ws on bindPort natively —
spike-verified); unset LUMINA_FRPS_CONTROL reverts to the legacy direct
TCP mode, which needs 14601 published publicly)); **desktop**
`src-tauri/src/frp.rs` (frpc child lifecycle, the opencode.rs pattern)
driven by `src/hooks/useServerFrp.ts` (AppBody, gated by the Server
settings' 远程访问开关 — registers the password + heartbeat, derives
the local port/password from the OpencodeApi handle) +
`scripts/fetch-frp.mjs` (the pinned frpc resource sidecar — mirror-
aware + sha256-verified; frpc 0.71.1 runs against the compose's
0.71.0-alpine frps — cross-version verified, see §1's version note).
The opencode password DOES live on the server now — a
deliberate trust-model change, documented in server/README.md.

Mobile chrome decisions live in the DESKTOP tree keyed off
`isMobileApp()` (lib/platform.ts — the window flag kv.ts plants before
the app bundle imports): sidebar → TitleBar-hamburger DRAWER (the only
session navigation), the stats panel mounted as an ALWAYS-OVERLAY over
the conversation (mobile.css widens the expanded panel to span the row;
the wide-row flex-sibling tier stays desktop's), SidebarResizer not
mounted, the Server
settings tab mounting as the app's ACCOUNT page (server address + sign
out — see ServerSettings' mobile branch), TitleBar's window controls
hidden. mobile.css carries the
narrow-layout adaptations + the login card — html/body get NO colors
(splash-era inline colors poison the app tree's inherited text) — plus
the settings modal's second-level PAGE animations (.lum-m-page-in/-out,
the push/pop over the category list; see SettingsModal).
TABLET MODE splits that flag's two jobs (hooks/useLayoutMode.ts): the
LAYOUT half of those decisions (drawer, resize seam, settings
navigation, modal shape, welcome cluster, mobile.css's phone
adaptations via #root[data-lum-layout]) reads usePhoneLayout() instead
and resolves to the DESKTOP chrome on tablet-class screens (auto =
Material 600px shortest-side breakpoint; user-pinnable in General →
Layout — phone / auto / tablet), while the DEVICE/connection half
(remote frp-route opencode, system-back stack, hidden window controls,
touch delete surfaces, soft-keyboard focus guard, touch composer
height) stays on isMobileApp() regardless of layout — a tablet in
desktop layout still connects to the DESKTOP's opencode remotely.

- **Frontend = second vite entry**: `mobile/index.html` → `src/mobile/`
  (config `mobile/vite.config.ts`, port 1421, outDir `dist-mobile/`).
  main.css declares an explicit `@source` — Tailwind v4's content
  detection follows the VITE ROOT (mobile/), so without it the desktop
  tree's utilities silently drop out of the bundle.
- **beforeBuildCommand runs at the REPO ROOT** (`pnpm run build:mobile`).
- `gen/android`/`gen/ios` are committed project sources. iOS init/build
  needs macOS; Linux covers `pnpm build:mobile` +
  host/`aarch64-linux-android` `cargo check` only.
- **App icons: the master export is `mobile/src-tauri/icons/icon.png`
  (1024×1024)** — downscaled once (Lanczos) from the designer's
  `Code Icon@3x.png` (3837, the icon.svg 3x export; file at the repo
  root). Never re-render `src/assets/icon.svg` yourself and never let
  the CLI's 512 re-encode become the master (the gen script
  git-restores icons/ after each run — the 1024 master must stay
  committed or reruns will silently drop it back to 512). Desktop + CEF
  icon sets are committed as exported (512 era). The ANDROID half
  (`gen/android` res) is NOT covered by `tauri android init` — init
  plants the tauri template's own mipmaps; regenerate them from the
  master with `pnpm gen:app-icon` (= `tauri icon` run from mobile/,
  then git-restore icons/ + drop the CLI's untracked desktop-only
  extras). tauri-cli ≥2.11 writes
  `mipmap-anydpi-v26/ic_launcher.xml` +
  `values/ic_launcher_background.xml` itself and never the ROUND
  adaptive twin — `ic_launcher_round.xml` is hand-kept next to it
  (manifest carries `android:roundIcon`). The template's leftover
  green-grid background / android-robot foreground drawables and
  purple/teal colors were deleted (unreferenced, trap hand-wiring).
- **The soft keyboard is handled NATIVELY, never in CSS/JS**:
  MainActivity's insets listener pads the content view with
  `max(bars.bottom, ime.bottom)` — under targetSdk 35+ edge-to-edge the
  system does NOT resize the window for the IME at all, so without the
  ime() insets the composer sits behind the keyboard. Deliberately NO
  `WindowInsetsAnimationCompat` per-frame sync (live-observed 2026-10-17:
  per-frame padding resizes the WebView per frame, and WebView resizes
  lag their compositor — the surface buffer scales between frames and
  the whole layout flickered between final and mid-animation states);
  the padding applies once when the IME settles — a single clean jump.
  The manifest's `adjustResize` serves
  only pre-35 devices (it kills adjustPan, which would stack a
  whole-window pan on top of our padding); on 35+ it is ignored. The
  page needs zero JS: the composer's column flow is pure CSS and
  useTranscriptScroll's ResizeObserver re-pins the transcript on the
  shrink. Deliberately NO visualViewport/`--lum-kb` web fallback —
  Android-native is authoritative and the only live platform (a web
  fallback would be untested code; revisit when iOS/ohos resumes).
- **The safe-area bands' background is NATIVE and chrome-synced**: the
  edge-to-edge insets listener pads the content view, so the status /
  nav-bar bands are painted by the Android WINDOW background — the
  theme's `windowBackground` = `lumina_window_bg` (values/values-night
  `colors.xml`, #f0f0f0 / #282828 — NOT the raw chrome bases but their
  GLASS-SURFACE EQUIVALENTS: the chrome the bands adjoin renders as the
  glass tint over the base, derived by lib/glass.ts's
  `glassSurfaceEquivalent` from lib/theme.ts's LIGHT_BG #fafafa /
  DARK_BG #1a1a1a — keep the derivation, not just the values, in
  sync), plus the v31 splash override so the launch never flashes a
  foreign color. Because the manifest swallows the uiMode config
  change, `MainActivity.onConfigurationChanged` re-applies the
  background AND the system-bar icon appearance (enableEdgeToEdge sets
  it once; a day→night switch would otherwise leave dark icons on the
  dark bands). ALSO: enableEdgeToEdge leaves the nav-bar CONTRAST
  ENFORCEMENT on for its default auto() style while hardcoding the
  status-bar twin to false (bytecode-verified, activity 1.10.1
  EdgeToEdgeApi29) — the system would paint a semi-transparent scrim
  over the transparent navigation bar, covering the windowBackground
  (live-observed: bottom band reading ~#fefefe next to a correct
  #f0f0f0 top band), so MainActivity onCreate explicitly sets
  `isNavigationBarContrastEnforced = false` (API 29+). The in-app theme
  preference can disagree with the
  system theme (the static resource follows the system, the chrome
  follows the preference), so the resolved base is PUSHED from the
  frontend: MainActivity's `onWebViewCreate` injects
  `window.__luminaNative` (a JS interface — trusted local content only)
  and InnerApp's effect calls `setChromeBackground(glassSurfaceEquivalent(effectiveBg), dark)`
  (deps include systemTheme so a manual override re-wins after every
  system switch); desktop/CEF have no such object and no-op.
- **The system back gesture closes page levels, not the app**:
  MainActivity overrides `handleBackNavigation = true` (TauriActivity
  hard-disables wry's built-in OnBackPressedCallback routing — back
  would finish the activity outright, i.e. exit on ANY back). Re-
  enabled, wry maps back to the WEBVIEW HISTORY (`canGoBack() →
  goBack()`, else the default finish at the root — the Android
  convention), and the frontend's back-level stack
  (lib/backStack.ts + hooks/useBackLevel.ts) keeps one {lumId}
  history entry per open level: modals (the Modal primitive),
  the settings second-level page, the drawer, popover menus (the
  PopoverMenu primitive) and the expanded stats overlay all close on
  back; desktop is untouched (the hook is isMobileApp-gated, Escape
  paths stay). iOS edge-swipe is FUTURE work: wry 0.55 has
  `with_back_forward_navigation_gestures` but tauri 2.11 does not
  expose it (would need a vendored patch, plus a macOS build host);
  the history-based frontend half already works for it as-is.
- **HarmonyOS is FROZEN on the `feat/mobile-ohos` branch** (branch-patch
  line, blocked on a device black-screen + tauri-plugin-log SIGABRT on
  ohos — this branch's lib.rs must cfg the plugin out if that port
  resumes).

### lumina-code-server (`server/`) — the self-hosted companion server

A pnpm WORKSPACE MEMBER (`pnpm-workspace.yaml` lists `server/`; the
desktop app stays the root package) — a single Next.js App Router
application = **user system + web management UI + remote-access
credential exchange**, backed by ONE SQLite file (better-sqlite3, no
ORM — the queries are a screenful; DDL lives in
`server/src/db/schema.ts` with additive `MIGRATIONS` applied at
startup). Deployed as two Docker services (docker-compose.yml): the
Next.js app (pulls the CI-published `iewnfod/lumina-code-server:latest`
— see docker-server.yml above; `server/Dockerfile` builds it from a
source checkout) + the frps container (`fatedier/frps`, config
`server/deploy/frps.toml`). TLS/组网 is the user's affair (reverse
proxy — see `server/README.md`, which also carries the REQUIRED nginx
`/t/` location for remote access).

ARCHITECTURE — the FRP DIRECT ROUTE (migrated 2026-10, replacing the
relay/mirror model): the agent NEVER runs on the server and NO session
content crosses it anymore. Desktop Lumina Code keeps its local
opencode + local files; while remote access is enabled its frpc holds
an outbound pipe to frps, and the server's whole data-plane job is the
CREDENTIAL EXCHANGE — the desktop registers (and heartbeats) its
current opencode password + route id (`frp_routes`, one CURRENT row
per user; a fresh route id from a second desktop takes over
wholesale), and mobile clients fetch both via `GET /api/frp/connect`
to connect straight to the desktop. The frps auth token is shared
among all accounts and the opencode password lives on the server —
both accepted for the self-hosted single-operator model, documented in
server/README.md. The legacy mirror/relay tables (sessions/messages/
diffs/relay_prompts) stay in the DDL for downgrade safety but have no
code paths.

```
src/
├── db/            schema.ts (DDL + row types + meta-tracked migrations),
│                  db.ts (createDatabase/getDb singleton on globalThis —
│                  Next HMR re-imports must share one connection; WAL +
│                  foreign_keys pragmas; LUMINA_DATA_DIR, default ./data)
├── lib/           pure-ish core + vitest coverage:
│   ├── auth.ts    argon2id (via @node-rs/argon2, no node-gyp) +
│   │              opaque device tokens (`lum_…`, only sha256 stored;
│   │              returned exactly once). FIRST registered user becomes
│   │              admin. login() verifies against a cached DUMMY hash
│   │              for unknown users so timing never reveals usernames.
│   │              tokenFromRequest accepts Bearer OR the httpOnly
│   │              `lumina_session` cookie — ONE credential mechanism
│   │              for API clients and the web UI alike. login()'s
│   │              optional label (sanitized by sanitizeTokenLabel —
│   │              blank/control-char/capped, vitest-covered) names the
│   │              token in the account page: clients send their device
│   │              label ("desktop (myhost)"/"mobile (Pixel 9)"), the
│   │              web console signs in as "web", default "login".
│   ├── rateLimit.ts  in-memory fixed-window limiter (login endpoint;
│   │                 per-instance by design; heavier protection = the
│   │                 reverse proxy's job)
│   ├── frp.ts     the credential-exchange core: frpServerConfig
│   │              (LUMINA_FRPS_* env → bind port + shared token),
│   │              registerFrpRoute (mint/refresh/takeover over the
│   │              frp_routes table — hex-only route ids that nginx's
│   │              `[A-Za-z0-9_-]+` capture and frp's proxy names both
│   │              accept), getFrpConnect (the mobile's read side)
│   └── pageAuth.ts    cookie-side guard for protected pages
├── app/
│   ├── actions.ts    no-JS server actions (login/register/logout/
│   │                 changePassword/admin maintenance) — plain <form>
│   │                 posts, errors via ?error= redirects; every action
│   │                 re-checks auth from the cookie
│   ├── login|register/  public auth pages
│   ├── (protected)/     the console shell (layout redirects to /login):
│   │                 / overview — ROLE-SCOPED (a regular user sees ONLY
│   │                 their own desktop's route + state, never other
│   │                 users' route ids or server counts/paths; admin
│   │                 keeps the full counts + frps state + last route
│   │                 heartbeat view; listFrpRoutes' userId filter is
│   │                 the data half), /users admin
│   │                 management (disable/enable + reset password; you
│   │                 cannot disable yourself), /account (password +
│   │                 device-token revocation)
│   └── api/         auth (register/login/me/logout), tokens (list/
│                    revoke; admin may inspect others), admin/users
│                    (GET/PATCH), frp (config / routes / connect)
└── middleware.ts   CORS for /api/* (webview origins fetch cross-origin
                     with a bearer header; blanket origin allowance is
                     safe because no cookies ride the API path) +
                     preflight answering

Desktop half: `src/opencode/serverConnection.ts` (the connection
persistedStore `"lumina-code:server-connection"` + LuminaServerApi —
the OpencodeApi pattern applied to the companion server; token lives in
the app's state/state.json (lib/persistedStore.ts over
tauri-plugin-store; migrated from the webview's localStorage), revocable
from the web console; the store
shape is {url, token, username, remoteEnabled, frpRouteId?} with
legacy `tunnelEnabled` migrating into remoteEnabled on read.
deviceLoginLabel — the LOGIN's device label: the client kind plus the
device name (desktop = plugin-os hostname(), mobile = the Android
bridge's Build.MODEL via `__luminaNative.deviceName()`, MainActivity;
meaningless readings like Android's "localhost" filter out), falling
back to the bare kind — feeds LuminaServerApi.login's label param;
needs `os:allow-hostname` in every shell's capabilities, which
`os:default` deliberately withholds) and
`src/hooks/useServerFrp.ts` (the engine, mounted once in AppBody:
fetches /api/frp/config, registers the local opencode password —
derived from the OpencodeApi handle's Basic authorization — with a
5-minute heartbeat, supervises the frpc sidecar through the Rust
frp_start/frp_stop commands, and re-runs whenever the local opencode
handle changes [restart = new port + password]; failures log + retry
every 30s — remote access never blocks or degrades the local app).
The engine mirrors every phase into `src/opencode/frpStatus.ts` —
the route's LIVE status as a module store (the sessionStopping
pattern, NOT persisted): off / starting / running / retrying /
unavailable (server has no frps) / exited / error, read by
ServerSettings' connection row; Rust's frp-status "exited" (frpc
process died) also reconnects there on the retry cadence — frpc's
loginFailExit=false only retries the CONNECTION inside a live
process, a dead one needs the engine to restart it (frp_start is
idempotent; its internal stop does not emit, so no self-trigger
loop).
The Rust half is `src-tauri/src/frp.rs` (see the backend map).
LuminaServerApi carries the full surface (auth + frp config/register/
connect) — ONE client for every consumer; its TRANSPORT is the Rust
`lumina_request` command (src-tauri/src/lumina_http.rs — reqwest with
proxies off; the webview fetch path proved unusable on proxy-fronted
networks, see that module's header), so login/settings/frp engine all
bypass the browser network stack; `src/opencode/
mobileConnection.ts` is the MOBILE app's own connection store (login
screen ↔ useOpencode's remote branch).

Scripts (root): `pnpm server:dev|build|test|typecheck`; CI:
`.github/workflows/ci-server.yml` (vitest + next build). Server tests
are vitest (its own runner — the desktop keeps node:test); they invoke
route-level libs directly with :memory: databases.


---

## 3. Design Principles

### 3.1 Layering — one direction of dependency

```
types (opencode/types.ts, i18n keys)  ←  opencode/ + lib/  ←  hooks/  ←  components/  ←  App
```

- `lib/`, `opencode/messageStore.ts` and `opencode/pendingCommands.ts` are
  pure: no React, no JSX. Pure
  modules are what `pnpm test` can load (node:test + type stripping, no
  bundler) — keep new logic testable by keeping it there.
- `opencode/` is the only layer that talks to the server. Components never
  `fetch()` the server directly — they consume the context split
  (`useConnection` / `useCatalog` / `useSessionData` and friends) or go
  through the `use*` hooks.
- `hooks/` may import `lib/` and `opencode/`, never `components/`.
- `App.tsx` owns the connection and distributes it through the providers
  (Connection → Catalog + SessionData); AppBody below them is a consumer
  like any other.

### 3.2 Single Source of Truth (no duplication)

- **Server access** → only through `OpencodeApi` (`opencode/api.ts`) or the
  bus (`subscribe` + `messageStore.applyEvent`). Never a second fetch
  client, and never re-derive wire shapes from the SDK — `types.ts` is the
  authority (verified against the installed server). Components never
  `fetch()` the server directly — the handles flow from App's useOpencode
  through the CONTEXT SPLIT (ConnectionProvider / CatalogProvider /
  SessionDataProvider in `opencode/*Context.tsx`), and data arrives via
  their `use*` bindings or the use* hooks underneath.
- **Platform checks** → `lib/platform.ts`. **Glass/backdrop-filter** →
  `lib/glass.ts` only (inline `backdrop-filter` breaks the Linux fallback).
  **Button springs** → `lib/motion.ts` (everything else is CSS, §3.7).
  **Color math** → `lib/color.ts`.
  **Surface colors** → `useColors()` (`hooks/colors.tsx` context; App is
  the only `useSurfaceColors(bg)` derivation — don't hand-mix variants in
  components).
  **File-type icons** → `lib/fileIcons.ts` (never hand-roll per-extension
  icon tables; regenerate assets via `pnpm gen:icons`).
- **Hover hints** → `components/ui/Hint.tsx` when a hover hint is truly
  needed. Native `title` attribute tooltips are BANNED everywhere — the
  OS-drawn box doesn't follow the app's surface language (e.g. the stats
  panel's todo rows carry no tooltip at all; the row text is the content).
- **Chrome buttons** → `components/ui/IconButton.tsx`. **Dropdowns** →
  `PopoverMenu`. **Rounded chrome clipping** → `MaskedSurface`.
- **Maximized / paddingOffset** → computed once in `App`, passed as props.
  Children must not re-derive them.
- **User-visible strings** → `useI18n()` with a TranslationKey. Add the key
  to `i18n/en-us.ts` (and preferably `zh-cn.ts`) in the same change — raw
  strings in JSX are wrong even for "temporary" copy.
- **Cross-restart state** → `lib/persistedStore.ts`'s `createPersistedStore`
  (one factory: own key per preference, read/write/eq callbacks, never
  throws, logging + same-value short-circuit built in; medium =
  tauri-plugin-store's `state/state.json` under the app data dir — see
  the factory's initPersistedState + migration). The session-flow
  ui-state keeps its `lib/persist.ts` (`loadState`/`saveState`) wrapper.
  Don't hand-roll another store implementation or introduce a second
  persistence mechanism.

Rule of thumb: **if you are about to copy-paste >10 lines from another
file, stop and extract.**

### 3.3 App-level flow facts (easy to break by accident)

- **There is no empty-session view.** A session is created server-side only
  on the first send (`useSessionFlow`'s `sendFirst`); before that the
  welcome screen holds the composer with staged
  `pendingModel/pendingAgent/pendingDirectory`,
  seeded from the last run via `lib/persist.ts`. Changing the project
  directory pre-session stages the choice; inside a conversation-less
  session it drops the empty session and returns to the welcome screen.
- **The message store must outlive ChatView.** Switching away from a
  streaming session and back must not lose deltas (the server snapshot
  carries "" for mid-flight parts). Any change to
  `useSessionMessages`/`messageStore` needs this regression in mind — it's
  covered by `messageStore.test.ts`; run it.
- **Optimistic UI has an undo path.** Slash-command submissions stamp the
  compact form (`prepareCommandSubmission`) and fall back to a plain prompt
  if the command is rejected; busy ids end via events must not be
  resurrected by the active-sessions seed. When adding optimistic patches,
  handle the race the same way.
- **The window is created hidden** (`visible: false` in tauri.conf.json)
  and shown after first paint in App — keep heavy work out of the first
  render path.

### 3.4 Naming & style

- 4-space indent; imports carry explicit `.ts`/`.tsx` extensions
  (`allowImportingTsExtensions`, bundler resolution).
- React hooks: file `hooks/useFoo.ts` (or `opencode/useFoo.ts` for the
  server domain), export `useFoo`. Pure modules export named functions.
- Tests are colocated `*.test.ts` next to the module (only pure modules are
  testable this way — see §3.1).

### 3.5 Logging

One logger: Rust `tauri-plugin-log` writes the rotating
`lumina-code` log file and mirrors to the webview; the frontend's
`@tauri-apps/plugin-log` feeds the same file. Rust uses `log::{debug, info,
warn, error}`; the frontend imports from `@tauri-apps/plugin-log`.

- **Never `console.*`** in app code (it doesn't reach the log file; the one
  existing `console.warn` in `streamServerEvents`' retry loop is legacy,
  don't copy it).
- **Every async operation and error path logs its outcome.** `.then()` with
  no `.catch`, silent `let _ =`, and swallowed rejections are forbidden.
  Follow the existing pattern: `.catch((e) => error(\`…: ${e}\`).catch(() => {}))`
  — the inner `.catch` guards the logger itself.
- Levels: `error` unrecoverable, `warn` degraded fallback, `info` lifecycle
  events a user could correlate, `debug` detail. Don't log hot paths
  (per-delta, per-render).

### 3.6 Tests

`pnpm test` runs node:test over `src/**/*.test.ts` and `src/**/*.test.js`
— pure-logic modules only (message reducer, run-footer collection, usage
math, transcript folding, form answers, session grouping, path display,
tool metadata). The `.test.js` glob exists for one resident:
`src/plugins/luminaTools.test.js`, which imports the PLUGIN source's
named exports directly (plain ESM, no top-level imports — node loads it
without a bundler; tsc/vite never touch .js, tsconfig has no allowJs).
The plugin's pure helpers (slug/naming/document composition/stored-zip)
and its fs-touching plan-document writers (against temp dirs) live under
test there. New pure logic
that matters (reducers, collectors, mapping) belongs in a pure module WITH
a colocated test; UI wiring is verified by `pnpm build` + running the app.
The Rust side currently has no test suite — keep it thin enough not to
need one, and extract anything that grows logic into the frontend's pure
layer instead.

---

### 3.7 Motion & layout — CSS first, browser owns the numbers

The app's animation system is the CSS utility classes in main.css; JS
never runs per frame and never measures/pins/synchronizes layout.

- **Entrances/exits are CSS keyframes**: `.lum-enter` (fade + rise),
  `.lum-fade` (tall panes), `.lum-pop`/`.lum-pop-exit` (modals, menus),
  `.lum-row-exit` (list rows: grid-rows height collapse) and its ENTRANCE
  mirror `.lum-row-enter` (grid-rows 0fr→1fr unfurl — a row appended to a
  surviving list reveals top-to-bottom while every content-driven
  container around it grows along; gated by `rowEnteringKeys` so bulk
  history stays instant). RollingTitle's
  drum is the framer exception below. Exit animations that must keep the
  element mounted go through the EXIT ENGINE
  (`components/ui/ExitPresence.tsx` — `ExitPresence` for single
  surfaces, `ExitList` for rows): CSS animates, the engine removes the
  element from the DOM when the exit animation/transition actually ends
  (event-matched; a fallback timer guards canceled animations), under an
  app-wide exit budget (lib/exitGate.ts) so bursts skip the
  choreography instead of dropping frames — fold-body holds are
  budget-EXEMPT (`budget={false}`: the container animates, the held
  children cost nothing). The hold must START DURING RENDER (the
  engine detects the present edge render-time) — starting it in a
  post-commit effect leaves a one-frame hole where the element is
  already gone.
- **Height animations are the `.lum-fold` grid pattern**
  (`grid-template-rows: 0fr ↔ 1fr`, toggled via `data-open`): the
  browser interpolates the real content height. An element that MOUNTS
  already open renders instantly (no post-mount style change ⇒ no
  transition) — history never animates, live toggles always do.
  **Fold bodies mount CONDITIONALLY** — children render only while open,
  held through the collapse transition by `ExitPresence` (~300ms,
  timer-driven: the grid transition's target is the fold container
  above the held content), then unmount. Fold bodies are the app's
  biggest subtrees (whole git-diff views, terminal output); keeping
  them mounted while collapsed once produced 20k+-node DOM trees and
  froze rendering. Never render a fold's children unconditionally.
- **Animations that affect siblings ride real layout**: an in-flow box
  transitioning `width` (`.lum-stats`) reflows its flex siblings frame
  by frame; `position: absolute` floats out of flow instead of being
  pushed. Never compensate with JS measurements.
- **Responsive width logic is container queries**, not JS: App's
  conversation row (`.lum-row`, `container-type: size`) is the query
  context for the column cap/gutters (`.lum-column`) and the stats
  panel's flow-vs-float (`.lum-stats`). No ResizeObserver, no
  surfaceSize props.
- **framer-motion survives ONLY as the button hover/tap spring**
  (`whileHoverTap`/`springSnappy` in lib/motion.ts) — micro-interactions
  on button primitives, nowhere else — **plus ONE sanctioned exception**:
  RollingTitle's drum roll (`titleRoll` + AnimatePresence
  `mode="popLayout"`), because the effect needs the DEPARTING text pinned
  at its measured spot while both spans turn as one cylinder — an
  exiting-element pairing CSS keyframes can't express (a CSS port lost
  the roll-out half and was reverted). Do not reintroduce AnimatePresence,
  layoutId flights, or variant systems anywhere else.
- **Hover washes are one class**: `.lum-wash` reading the provider-seeded
  `--lum-wash` var (App sets it from SurfaceColors); local overrides
  re-declare the var on the element. Never invent another per-site
  `--lum-*-hover` variable.

### 3.8 Visual surfaces & tokens — the unified style system

Every styled surface derives from ONE token set (main.css `@theme` +
`:root`) plus the runtime palette (`useColors()` / SurfaceColors). The
rules below are what "looks like Lumina Code" means; deviations are bugs.

**Surface families** — a surface picks a FAMILY, which fixes its
background, border, shadow and radius tier together:

| Family | Background | Border | Shadow | Radius | Members |
|---|---|---|---|---|---|
| Elevated (floats over everything) | `var(--color-elevated)` | `colors.glassBorder` | `colors.elevationShadow` | `md`/`lg`/`xl` by size | Modal, PopoverMenu, InputSuggestions, stats panel, the HeroUI tooltip (via the `.tooltip` CSS override) |
| Recessed (in-flow cards over content) | `colors.recessedBg` | `colors.glassBorder` | none | `sm` (bodies) / `lg` (cards) | composer, request cards, tool/subagent output bodies, run-footers' edits card, settings fields, BodyBox |
| Accent (identity bubbles) | `colors.accentOverlay` | none (edit ring: `focusRing`) | none | `lg` | the user message bubble |
| Chrome glass | `glassSurface()` (lib/glass.ts) | `windowOutline` | — | `lg` (window) | window frame, title bar, sidebar |

**Radii** — five tiers, semantic mapping (never write pixel radii):
`xs 6` micro affordances · `sm 8` inline controls (buttons, inputs,
chips, menu items, list rows) · `md 12` secondary floats (menus,
suggestion panels, code blocks) · `lg 16` first-class surfaces (cards,
modals, bubbles, composer, window frame) · `xl 22` the largest float
(stats panel). `rounded-full` only for true circles/pills.

**Colors**:
- Status colors are tokens: `--color-success / warning / danger /
  danger-text / command` and `--color-diff-add / diff-del`. Never write
  their hex values inline. The two JS mirrors that may NOT become var()
  (SVG attributes / data URIs can't resolve CSS vars) carry a
  keep-in-sync comment: UsageRing's arc stroke and
  CommandMentionNode's `COMMAND_MENTION_COLOR`.
- Neutral grays in stylesheets come from the `--lum-neutral-*` ladder
  (wash .04 / fill .10 / hairline .15 / divider .35 / text .55) — no
  ad-hoc `rgba(128,128,128,x)`.
- Panel primary text is `colors.textPrimary` (one value, not per-panel
  0.88 hand-rolls).

**Type scale** — four steps: `text-2xs` 11 (micro rows, uppercase
labels) · `text-xs` 12 (default UI) · `text-sm` 14 (prose) ·
`text-base` 16 (rare). No arbitrary `text-[Npx]`.

**Spacing rhythm** — Tailwind's 4px grid only; the recurring beats:
control heights 24/28/32/44 (`h-6/h-7/h-8/h-11`), card padding
`px-4 py-3` / compact `px-3 py-2.5` / row-internal `px-2.5`, gaps
`gap-1/1.5/2`. Genuine geometric exceptions (Switch's 18px track, the
composer's derived min-height, optical offsets) stay literal but carry
a comment saying why.

**Chips** — attachment chips are ONE family wherever they render
(composer staging and message bubbles): `h-7`, `radius-sm`,
`colors.activeOverlay`.

## 4. Rules for AI Contributors

1. **Do not duplicate.** Grep for existing logic (api methods, hooks, UI
   primitives) before writing new. If signatures differ slightly,
   generalize the existing one rather than adding a parallel one.
2. **Respect the layering** (§3.1). Server access stays in `opencode/`;
   pure logic in `lib/` or pure domain modules; JSX in `components/`.
3. **Bump the OpenCode pin in all three places** (fetch script, Rust
   constant, SDK) or none.
4. **Every async operation and error path logs** via the plugin logger —
   never `console.*`, never a bare `.then()` (§3.5).
5. **All user-visible strings go through `useI18n`**, with keys added to
   `en-us.ts` (and `zh-cn.ts`) in the same change.
6. **Props over re-derivation.** Theme/bg/maximize/padding/api flow down
   from App; children don't recompute them.
7. **No dead code.** If you remove the last consumer of a file, delete the
   file.
8. **Behavior-preserving refactors only** unless explicitly asked. Strings
   coupled across the Rust/frontend boundary (`opencode_start`,
   `opencode-status`, `is_wayland`, and the `OpencodeConnection` camelCase
   fields mirrored in `useOpencode.ts`) must change on both sides or never.
9. **Verify with `pnpm build && pnpm test`** (and `cargo check` for backend
   changes) before claiming done. Strict tsconfig makes unused code a
   build failure.
10. **Don't trust the SDK's shapes.** When a server field behaves
    unexpectedly, verify against the running server and record the quirk in
    `api.ts`/`types.ts` — the inline comments there are the collected
    server-behavior doc for v2.0.x.
11. **Document significant new modules** in §2 (Source Map) so the next
    contributor knows they exist.

---

## 5. When You're Unsure

- **Where does X belong?** §3.1. Server talk → `opencode/`; pure logic →
  `lib/` (or a pure module next to its consumer); React-aware → `hooks/`;
  JSX → `components/`.
- **Is this a duplicate?** Grep. Especially color math, glass, motion,
  buttons, and any `fetch(` outside `opencode/api.ts`.
- **Server returned something weird?** Check `api.ts`/`types.ts` inline
  comments first — envelope unwrapping, `location.directory`, limit caps,
  transient empty reads, and SPA-HTML-on-unknown-routes are all documented
  there. Empty list ≠ no data (storage-lock race → retry, §useModelCatalog).
- **Can I rebuild a message list from the server?** No — streamed parts
  exist only on the bus (§3.3). Merge via `messageStore` helpers.
- **Why doesn't the app start?** Most common: sidecar missing (`pnpm
  fetch:opencode`) or a version-pin mismatch (§1).
