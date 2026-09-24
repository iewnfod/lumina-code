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

---

## 1. Commands & Toolchain

| Purpose | Command |
|---------|---------|
| Install | `pnpm install` |
| Fetch pinned OpenCode server sidecar (~200 MB, once per version bump) | `pnpm fetch:opencode` (also: `--all` for every target / explicit Rust triples) |
| Run the app | `pnpm tauri dev` |
| Typecheck + build frontend | `pnpm build` (`tsc && vite build`) |
| Unit tests (pure frontend logic) | `pnpm test` (`node --test "src/**/*.test.ts"`) |
| Point dev at a different server binary | `OPENCODE_BIN=/path/to/opencode pnpm tauri dev` |
| Regenerate Material file-type icons (after bumping `material-icon-theme`) | `pnpm gen:icons` (output is committed) |

- `pnpm fetch:opencode` is a **prerequisite** for `tauri dev`/`tauri build`:
  Tauri's `externalBin` (`src-tauri/binaries/opencode`) must exist or the
  bundle step fails. Binaries are gitignored.
- There is no lint/format config and no CI yet; `pnpm build` is the
  guardrail — tsconfig is strict with `noUnusedLocals` /
  `noUnusedParameters` / `noFallthroughCasesInSwitch`, so unused imports and
  vars fail the build. Run it (and `pnpm test`) before claiming done.
- Rust backend: `cargo check` / `cargo build` via
  `--manifest-path src-tauri/Cargo.toml`. The lib crate is
  `lumina_code_lib` (needed if you ever add integration tests).

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
│                          #   (useOpencode, useSessionRequests, useModelCatalog,
│                          #   useSessionFlow) and the session ↔ welcome-screen
│                          #   swap. App() wraps InnerApp with
│                          #   useMaximized/usePaddingOffset/useDragRegionDoubleClick.
│                          #   Also owns the conversation surface
│                          #   geometry: the content is a FLEX ROW —
│                          #   conversation (flex-1, the session ↔
│                          #   welcome swap inside it) + the workspace
│                          #   stats panel as a REAL sibling, KEYED BY
│                          #   DIRECTORY (same-directory session
│                          #   switches keep it mounted;
│                          #   cross-directory switches remount it,
│                          #   the surface swap covering the
│                          #   transition; never on the welcome
│                          #   screen). The panel is position:
│                          #   absolute when floating / out of flow
│                          #   empty, in normal flow (fixed width)
│                          #   when wide — flex pushes the
│                          #   conversation left with NO lane
│                          #   bookkeeping. App measures the ROW
│                          #   (layout effect + RO, session-
│                          #   independent) and derives both the
│                          #   panel's flow/float input and the
│                          #   conversation column's responsive cap +
│                          #   gutters (chatColumn.ts), passed down
│                          #   as a shared columnStyle prop.
├── main.tsx               # ReactDOM entry (React.StrictMode) + attachConsole
├── constants.ts           # CHROME_TITLE_BAR_HEIGHT
├── i18n/                  # en-us.ts (source of truth: keys ARE the English
│                          #   strings) + zh-cn.ts (partial OK; per-lookup fallback)
│
├── plugins/               # Plugin SOURCES shipped with the app (plain JS, no
│   └── luminaTools.js     #   imports — a bare default export loads on server
│                          #   v2.0.11). The custom-tools host: Model settings →
│                          #   Tools writes it verbatim under the global config's
│                          #   `plugins/lumina-tools/` and references it from
│                          #   opencode.json's `plugins` array with per-tool
│                          #   options; the server hot-reloads on config change.
│                          #   TOOLS registry inside = one entry per tool
│                          #   (enabled/agentId/tool). v2.0.11 facts encoded
│                          #   here: plugin tools default to CODE MODE exposure
│                          #   — `codemode: false` makes them NATIVE tools
│                          #   (verified live; the code-mode path has a step
│                          #   budget and degrades to hallucinated text when
│                          #   exhausted); the agent transform has no add() —
│                          #   restricted helper agents are defined in the
│                          #   config's `agents` section (written by
│                          #   toolPluginConfig.ts); the plugin ctx has no
│                          #   session delete — helper sessions carry
│                          #   metadata {source: "lumina-tools"} and the
│                          #   frontend deletes them (useSessions.ts). First
│                          #   resident: vision (识图) — a text-only model asks
│                          #   a configured vision model about an image file
│                          #   via a transient helper session (askModel).
│
├── opencode/              # THE domain layer — everything talking to the server
│   ├── api.ts             # OpencodeApi: hand-rolled typed REST client (fetch +
│   │                      #   basic auth, `{"data": …}` envelope unwrap).
│   │                      #   Hand-rolled on purpose: the SDK's generated
│   │                      #   client drifts from the installed v2.0.x server
│   │                      #   (paths & body encoding); the SDK is imported
│   │                      #   types-only. Server quirks documented inline:
│   │                      #   messages `limit` caps at 200; session create sends
│   │                      #   `location.directory` (a flat `directory` is silently
│   │                      #   ignored); `?roots=true` doesn't work (root sessions are
│   │                      #   filtered client-side); questions are forms on this
│   │                      #   server generation; GET /api/session/active seeds busy
│   │                      #   state predating the event stream.
│   ├── configFiles.ts     # globalConfigTarget — where the global opencode.json
│   │                      #   lives, derived from GET /api/config (pure; shared
│   │                      #   by the settings config editor and the attachment
│   │                      #   divert). node-testable via its consumers.
│   ├── visionAttachments.ts # The vision tool's sending half (pure planning +
│   │                      #   one api-bound writer): when the model a prompt is
│   │                      #   bound for lacks image input (catalog
│   │                      #   capabilities.input; unknown = keep inline, zero
│   │                      #   regression), image attachments are NOT inlined as
│   │                      #   prompt parts but written under the global
│   │                      #   config's attachments/ (api.writeBinaryFile) and a
│   │                      #   one-line note with the saved paths is appended to
│   │                      #   the prompt — the model then calls the vision tool
│   │                      #   on them. A failed write falls back to inline.
│   │                      #   Wired into BOTH send paths (ChatView.handleSend,
│   │                      #   useSessionFlow.sendFirst). node-testable.
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
│   ├── pendingCommands.ts # Pure registry of pending slash-command submissions
│   │                      #   (compact `/name args` forms stamped onto the
│   │                      #   confirming enqueue event; per-session FIFO + undo).
│   ├── useOpencode.ts     # Server connection: invoke("opencode_start") → API client
│   │                      #   + auth token + event stream; subscribe() fans frames out
│   │                      #   to handlers. Server lifecycle is Rust-owned — the effect
│   │                      #   cleanup deliberately does NOT stop it, so StrictMode's
│   │                      #   mount/unmount/mount can't tear it down. "opencode-status"
│   │                      #   events surface async exits as {state:"error"}.
│   ├── useSessions.ts     # Sidebar list: seeded from GET /api/session, live-patched
│   │                      #   from the bus; root sessions only (subagent children carry
│   │                      #   parentID and would flood the list; the tools plugin's
│   │                      #   helper sessions hide via their {source:
│   │                      #   "lumina-tools"} metadata marker — and are DELETED
│   │                      #   by this hook once their execution ends, plus a
│   │                      #   one-per-connection sweep of leftovers, because
│   │                      #   v2.0.11's plugin API has no session delete); busy set seeded from
│   │                      #   GET /api/session/active (a stale busy id blocks the
│   │                      #   composer forever — the seed must not resurrect ids watched
│   │                      #   end); create/remove/patch (optimistic model/agent).
│   ├── useSessionMessages.ts # React binding over a MODULE-LEVEL store (one entry per
│   │                      #   session, surviving ChatView unmounts AND webview reloads
│   │                      #   — backgrounded sessions keep accumulating deltas; entries
│   │                      #   drop on session.deleted). One global bus handler applies
│   │                      #   events to every tracked session. Cursor-based loadOlder;
│   │                      #   `seeding` tells consumers (the stats card's subagent
│   │                      #   drill) whether an empty list is still loading. The
│   │                      #   messages state seeds from the store at FIRST RENDER
│   │                      #   (not first effect) — a session switched back to paints
│   │                      #   in the mounting commit. Exports
│   │                      #   subscribeSessionMessages/peekSessionMessages for the
│   │                      #   activity store's background freshness, plus
│   │                      #   useSessionMessagesSnapshot — a read-only
│   │                      #   useSyncExternalStore binding for consumers that
│   │                      #   outlive session switches (the stats card).
│   │                      #   prepareCommandSubmission pre-creates the entry so a
│   │                      #   first-send slash command keeps its enqueue frame;
│   │                      #   a session.model.selected event re-pulls the newest
│   │                      #   page — the model-switch marker it persists has no
│   │                      #   message frame, so the divider lands live.
│   ├── useSessionFlow.ts  # App-level session flow: active session id + composer
│   │                      #   staging (pendingModel/pendingAgent/pendingDirectory
│   │                      #   seeded from lib/persist.ts), changeModel/changeAgent/
│   │                      #   changeDirectory/newSession/deleteSession, sendFirst
│   │                      #   (create-then-deliver with the slash-command fallback),
│   │                      #   and the cross-restart save. Wraps useSessions.
│   ├── useSessionRequests.ts # Pending server→user asks across ALL sessions (permission
│   │                      #   requests + forms), seeded from the list endpoints then
│   │                      #   bus-maintained; a pending ask blocks the session's
│   │                      #   execution server-side. Global, not per-session, so sidebar
│   │                      #   badges work for inactive sessions.
│   ├── sessionActivity.ts # Pure stats-card derivations from a session's messages:
│   │                      #   background shells (tool-part metadata.shellID — only
│   │                      #   background results carry it) with their completion
│   │                      #   notifications (marker messages with metadata.source ===
│   │                      #   "shell"), subagent child sessions (part metadata.sessionID,
│   │                      #   deduped — continuation reuses the child id), and the
│   │                      #   mutation signature (file-mutation count + last confirmed
│   │                      #   user message id — streamed frames never move it).
│   │                      #   node-testable.
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
│   │                      #   prefetchSessionActivity (sidebar hover, wired
│   │                      #   in App) warms both ahead of the click.
│   │                      #   Derived arrays are identity-stable across
│   │                      #   streamed frames.
│   └── useModelCatalog.ts # Providers/agents/models + server default, fetched per
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
│
├── lib/                   # Pure, framework-agnostic (NO React) — ported from
│   │                      #   lumina-terminal; keep in sync with its sibling when fixed.
│   ├── platform.ts        # isMacOS / isLinux
│   ├── glass.ts           # glassSurface / windowOutline — the ONLY place
│   │                      #   backdrop-filter is written (Wayland fallback lives here)
│   ├── color.ts           # color math (luminance, foreground, adjust)
│   ├── motion.ts          # framer-motion presets (fadeIn, springSwap, …)
│   ├── arrival.ts        # Arrival timing for box-size animations: the
│   │                      #   distance-scaled duration (160-260ms) injected
│   │                      #   per animation as --lum-size-dur. The CURVE is
│   │                      #   the --ease-arrival token in main.css (CSS
│   │                      #   standard ease). History: a JS rAF loop fought
│   │                      #   the content mounting inside the growing box —
│   │                      #   every starved frame was a visible skip — and a
│   │                      #   spring charges ~84% then brakes into an
│   │                      #   exponential tail the eye reads as a knee +
│   │                      #   crawl; the engine-owned transition removed the
│   │                      #   per-frame JS and made mid-flight retargeting
│   │                      #   native. node-testable.
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
│   │                      #   model, agent, directory). Never throws.
│   ├── clipboard.ts       # copyText — clipboard write with an execCommand
│   │                      #   fallback for webviews lacking the async API
│   └── dragRegionDoubleClick.ts # pure predicate behind the title-bar double-click
│
├── hooks/                 # React hooks (start with `use`; i18n.tsx provides JSX context)
│   ├── i18n.tsx           # useI18n() → dictionary indexed by TranslationKey;
│   │                      #   language = stored choice → system (zh*) → en-us
│   ├── maximized.ts       # useMaximized — computed ONCE in App, passed as prop
│   ├── paddingOffset.ts   # usePaddingOffset(isMaximized) — from App, never from a child
│   ├── surfaceColors.ts   # useSurfaceColors(bg) → derived border/overlay/accent colors
│   ├── useGlass.ts        # backdrop-filter capability (disabled on Linux/WebKitGTK)
│   ├── useSystemTheme.ts  # OS light/dark (module-cached)
│   ├── useThemePreference.ts # Manual light/dark override ("system" follows
│   │                      #   the OS) — module store + own localStorage key
│   │                      #   (same pattern as i18n), consumed once in App
│   │                      #   to resolve appThemeFor's input.
│   ├── useIsWayland.ts    # cached invoke("is_wayland")
│   ├── useWindowOutline.ts # Linux window-outline toggle (App's inset
│   │                      #   box-shadow edge for DEs without compositor
│   │                      #   shadows): module store + own localStorage
│   │                      #   key, default on; the settings row is
│   │                      #   Linux-only but App gates on isLinux() too.
│   ├── useStatsPanelMode.ts # Session-activity panel expansion mode
│   │                      #   ("auto" — mounts collapsed, outside click
│   │                      #   / Escape collapse it; "always" — mounts
│   │                      #   expanded and stays open; a manual collapse
│   │                      #   lasts until the card remounts): module
│   │                      #   store + own localStorage key (legacy
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
│   ├── useTypography.ts   # Custom fonts/sizes (useThemePreference
│   │                      #   pattern): applies lib/typography.ts's
│   │                      #   overrides on load + change. Load-order note:
│   │                      #   main.tsx imports main.css BEFORE the App
│   │                      #   tree so the @theme stacks exist at init.
│   ├── useDisabledModels.ts # Models switched OFF in the model settings
│   │                      #   (hidden from the picker — the server has no
│   │                      #   per-model enable API, so this is client-side
│   │                      #   only): module store + own localStorage key
│   │                      #   (useThemePreference pattern), keys are
│   │                      #   "providerID/modelID".
│   ├── useDragRegionDoubleClick.ts # capture-phase mousedown + explicit maximize toggle
│   ├── useFollowBottom.ts # stream-follow stickiness for inner scroll regions
│   ├── useCopy.ts         # copy feedback shared by run footers and the user
│   │                      #   bubble: copied flag + ✓ linger reset
│   └── useTranscriptScroll.ts # ChatView's scroll machinery: bottom-follow with
│                              #   programmatic-scroll guards, prepend anchoring
│                              #   around render-window growth, geometry re-pin,
│                              #   visibilitychange catch-up.
│
└── components/
    ├── TitleBar.tsx       # Drag region + chrome buttons (window controls in
    │                      #   ui/WindowControls.tsx, language menu inline)
    ├── SessionBar.tsx     # Left glass sidebar shell: brand row, folder
    │                      #   collapse/expand state, relative-age ticker,
    │                      #   bottom new-session button; groups render
    │                      #   through SessionFolder. Session-row hover
    │                      #   fires onSessionHover → App's
    │                      #   prefetchSessionActivity (warms the stats
    │                      #   card's data before the click).
    ├── SessionTitle.tsx   # Single-line label: edge-fade truncation + a
    │                      #   hover-debounced HeroUI tooltip when overflowing.
    ├── SessionFolder.tsx  # One directory group: collapsible header (+/chevron),
    │                      #   animated session rows (busy dot; pending badge,
    │                      #   age and close button share one cross-fade slot),
    │                      #   "Show more/less" expander.
    ├── sessionGrouping.ts # Pure sidebar mapping: SessionInfo view-model,
    │                      #   relativeAge, groupByDirectory. node-testable.
    ├── ChatPlaceholder.tsx # Welcome-screen logo + greeting
    │                      #   (picked once per mount via greetings.ts).
    ├── greetings.ts       # Pure welcome-greeting picker: per-language pools
    │                      #   (independent id sets — zh-only memes don't leak
    │                      #   to en), probability-gated special occasions
    │                      #   (1024, Thursday KFC, late night, Friday deploy,
    │                      #   Monday, weekend), {project} interpolation.
    │                      #   node-testable.
    ├── WelcomeScreen.tsx  # The no-session surface: greeting + the staged
    │                      #   composer (session created on first send).
    ├── ui/                # Shared primitives (one of each thing)
    │   ├── IconButton.tsx # THE chrome button — never hand-roll <button> hover swaps
    │   ├── Button.tsx     # THE labeled button (primary/ghost) — shared by request
    │   │                  #   cards (re-exported as CardButton) and modals
    │   ├── Hint.tsx       # THE hover hint — HeroUI tooltip wrapper (the only
    │   │                  #   replacement for native `title` attributes; falsy
    │   │                  #   label renders the child untouched)
    │   ├── Modal.tsx      # Portal-rendered modal chrome (fadeIn backdrop +
    │   │                  #   scaleIn panel, Escape/backdrop close)
    │   ├── MaskedSurface.tsx # SVG rounded-rect clip exposing the glass chrome corners
    │   ├── PopoverMenu.tsx   # Shared dropdown menu
    │   ├── RollingTitle.tsx # Ellipsized title that scrolls on hover
    │   └── WindowControls.tsx # minimize/maximize/close cluster (non-macOS)
    ├── chat/              # The conversation surface
    │   ├── ChatView.tsx   # Transcript column + composer for the active session.
    │   │                  #   Bounded DOM: only RENDER_LIMIT (60) newest entries mount;
    │   │                  #   IntersectionObserver on the top sentinel grows the window
    │   │                  #   (and fetches older pages) on scroll-up. Scrolling lives
    │   │                  #   in hooks/useTranscriptScroll.ts; block folding in
    │   │                  #   transcript.ts; rendering in TranscriptList.tsx. The
    │   │                  #   stats panel is GONE from here (it is a flex
    │   │                  #   sibling of this view at App level); the
    │   │                  #   columns' responsive cap + gutters arrive
    │   │                  #   as App's columnStyle prop.
     │   ├── chatColumn.ts # The conversation column's responsive width
     │   │                  #   cap + side gutters: 48rem base cap, a
     │   │                  #   64rem wide tier once the content area
     │   │                  #   affords the cap + 8rem margins per
     │   │                  #   side; gutters are compact (1.5rem)
     │   │                  #   while the column reaches its cap,
     │   │                  #   roomy (3rem) below it — there the fixed
     │   │                  #   gutters are the only edge breathing
     │   │                  #   room (and they keep the composer
     │   │                  #   aligned with the welcome screen's
     │   │                  #   across the first-send swap). App
     │   │                  #   measures the conversation SURFACE (the
     │   │                  #   flex row beside the sidebar — not the
     │   │                  #   conversation's own flex-1 box), so the
     │   │                  #   tier stays put while a stats panel
     │   │                  #   expands in flow beside the column, and
     │   │                  #   derives the style prop ChatView and the
     │   │                  #   welcome screen share. Cap + gutter math
     │   │                  #   node-testable.
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
    │   │                  #   animate this message's framer entrances or not.
    │   ├── messageParts.ts # Pure part segmentation: segmentContent,
    │   │                  #   effectiveTailPart, stable part keys.
    │   ├── ActivityGroup.tsx # Folded run of tool calls / thoughts
    │   ├── ThinkingBlock.tsx # Reasoning disclosure (live while streaming)
    │   ├── ToolCard.tsx   # One tool call as a FoldRow (detail/accent lines;
    │   │                  #   file-mutating tools expand to a git-diff view;
    │   │                  #   failed calls show ONLY the error reason — no
    │   │                  #   attempted diff, no accent counts — and fold
    │   │                  #   themselves after ERROR_DISCLOSURE_MS)
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
    │   ├── SubagentCard.tsx # Subagent tool renderer
    │   ├── RunFooter.tsx + runFooters.ts # Per-turn summary footer (pure collector in
    │   │                  #   runFooters.ts — node-testable)
    │   ├── UsageRing.tsx + usageStats.ts # Context/cost ring (pure math in usageStats.ts)
    │   ├── Markdown.tsx   # Shared react-markdown + remark-gfm; links via plugin-opener.
    │   │                  #   Splits text into memoized block chunks (only the
    │   │                  #   tail chunk re-parses per streamed delta) and gates
    │   │                  #   the CSS entrance fade to `live` (streaming)
    │   │                  #   messages — see markdownBlocks.ts + main.css.
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
    │   │                  #   Shared chrome in RequestCardChrome.tsx; answer rules in
    │   │                  #   formLogic.ts (pure, node-testable).
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
    │   ├── WorkspaceStatsCard.tsx # The card's data owner: owns the two
    │                      #   scope hooks (workspace diff by directory,
    │                      #   session terminals/subagents) + surface
    │                      #   colors, then renders SessionStatsCard.
    │   ├── SessionStatsCard.tsx # The card (presentation +
    │                      #   local navigation only): collapsed summary rows
    │   │                  #   (+N −N lines, terminal/subagent counts — presence-
    │   │                  #   animated rows via popLayout: the pill never
    │   │                  #   scrolls, and old rows must pop out of the
    │   │                  #   stack while fading (a same-directory session
    │   │                  #   swap, first activity arriving)
    │   │                  #   rows only) expanding into the detail panel via a
    │   │                  #   SHARED-ELEMENT transition, all validated against a
    │   │                  #   headless-browser repro (see git history): the box
    │   │                  #   animates REAL style.width/height as a CSS
    │   │                  #   TRANSITION (transition-[width,height] +
    │   │                  #   --ease-arrival; JS only pins imperatively in
    │   │                  #   the click, measures the incoming content,
    │   │                  #   writes the target + the distance-scaled
    │   │                  #   --lum-size-dur, and releases to auto on
    │   │                  #   transitionend with a timer fallback. ASYNC
    │   │                  #   drill views (terminal output, subagent
    │   │                  #   transcript) HOLD the pinned pre-drill size
    │   │                  #   until their onSettled fires (first page
    │   │                  #   landed): measuring the loading shell targeted
    │   │                  #   a stub — the box shrank to it, then SNAPPED to
    │   │                  #   the real height at release (auto height never
    │   │                  #   transitions), which read as a too-fast drill
    │   │                  #   with a wrong target; during the hold the view
    │   │                  #   also plans as the overview (width, lane, caps
    │   │                  #   stay pre-drill) so everything morphs together
    │   │                  #   on settle. History: a JS
    │   │                  #   rAF loop fought the content mounting inside
    │   │                  #   the box, every starved frame a visible skip;
    │   │                  #   framer proved unreliable here too — its
    │   │                  #   values apply on animation frames and its
    │   │                  #   auto-target handling pollutes measurements),
    │   │                  #   and the tail window is kept EMPTY so the
    │   │                  #   curve's slowest part never drops frames: the
    │   │                  #   elevation shadow rides the same transition
    │   │                  #   (single-layer values interpolate natively —
    │   │                  #   no framer JS per frame), expand-content fades
    │   │                  #   start past the landing (0.22s), and the
    │   │                  #   expand-time refreshDiff is deferred 320ms so
    │   │                  #   its panel re-render lands after the box. The
    │   │                  #   measure
    │   │                  #   wrapper carries shrink-0 (a flex child squeezed by
    │   │                  #   the pinned container corrupts every measurement),
    │   │                  #   layoutId flights (±counts, file/terminal/subagent
    │   │                  #   titles) fly only where reliable — rows ARM their
    │   │                  #   layoutIds on pointer-down so mounting never pairs
    │   │                  #   against stale registry boxes (phantom flights) —
    │   │                  #   and everything else fades (FadeIn; expand waits
    │   │                  #   150ms for the box, in-panel navigation is instant).
    │   │                  #   Outside-click/Escape collapse (capture-phase).
    │   │                  #   A SEEDED mount (data already in the module
    │   │                  #   stores at first render — a session switched
    │   │                  #   back to, or hover-prefetched) is initial
    │   │                  #   layout, not a late arrival: the card enters
    │   │                  #   at its final state and rides the surface's
    │   │                  #   swap animation like the transcript (sections
    │   │                  #   skip their staggered fades; the card box
    │   │                  #   itself still enters animated — it only ever
    │   │                  #   mounts as a real arrival outside the swap).
    │   │                  #   The conversation surface's size arrives
    │   │                  #   PRE-MEASURED from App (surfaceSize prop,
    │   │                  #   seeded in App's own layout effect), so a
    │   │                  #   seeded card that mounts already expanded
    │   │                  #   sits in flow at its planned width in the
    │   │                  #   FIRST COMMIT — the conversation column
    │   │                  #   starts at its correct width beside it,
    │   │                  #   pure flex layout, no transition tricks
    │   │                  #   (only a panel appearing within an
    │   │                  #   already-laid-out conversation reflows it,
    │   │                  #   riding the box's own width transition,
    │   │                  #   like a manual expand — statsLayout.ts).
    │   │                  #   Activity that
    │   │                  #   first appears later still enters animated. A
    │   │                  #   same-directory session switch KEEPS the card
    │   │                  #   mounted but RESETS any open drill view to the
    │   │                  #   overview (the drill pointed at the previous
    │   │                  #   session's row — the inherited-content bug
    │   │                  #   class), morphing like back(); the overview's
    │   │                  #   sections sit in exit-only presence wrappers
    │   │                  #   (entrance stays each section's own FadeIn — a
    │   │                  #   wrapper enter fade would compound opacities),
    │   │                  #   so a section emptying out or leaving with a
    │   │                  #   session switch fades instead of snapping.
    │   ├── statsChrome.tsx # Shared section header + row/hover classes
    │   │                  #   (the MenuItem pattern via a CSS var),
    │   │                  #   statsRowPresence/statsSectionExit (the
    │   │                  #   enter/exit fades for session-scoped rows and
    │   │                  #   section wrappers that swap in place inside
    │   │                  #   the directory-keyed card), and
    │   │                  #   BodyBox, the drill-body surface (fill mode
    │   │                  #   stretches with the panel instead of the
    │   │                  #   55vh cap).
    │   ├── statsLayout.ts # Pure position planning for the stats
    │   │                  #   panel, ONE rule with three gates: a card
    │   │                  #   showing nothing (no diff/terminals/
    │   │                  #   subagents) or COLLAPSED floats —
    │   │                  #   position: absolute, out of the row ⇒ the
    │   │                  #   conversation keeps the full width, no
    │   │                  #   exceptions; an EXPANDED panel reads the
    │   │                  #   conversation surface's WIDTH
    │   │                  #   (App-measured, beside the sidebar) — wide
    │   │                  #   enough to fit the WIDEST panel (40rem
    │   │                  #   detail) beside the column's readable
    │   │                  #   floor → IN FLOW at a FIXED width (overview
    │   │                  #   26rem, detail 40rem): a real flex sibling,
    │   │                  #   flex pushes the conversation left and
    │   │                  #   re-centers it as the panel's own width
    │   │                  #   transitions — zero bookkeeping; anything
    │   │                  #   narrower → FLOAT (cover, no push). The
    │   │                  #   mode is a window-size property — drilling
    │   │                  #   never flips it. node-testable.
    │   ├── ChangesSection.tsx # Whole-session git diff: file rows (icon +
    │   │                  #   status chip + net counts) → FileDiffBody (server
    │   │                  #   patch through chat/DiffViewBody + toolDiff.ts's
    │   │                  #   patchHunks — real line numbers). FileTitle /
    │   │                  #   file row & header layoutIds live here.
    │   ├── TerminalsSection.tsx # Background-shell rows (each row
    │   │                  #   presence-animated — statsRowPresence: the rows
    │   │                  #   are session-scoped inside the directory-keyed
    │   │                  #   card, so a same-directory session switch swaps
    │   │                  #   them in place with a crossfade; running pulse /
    │   │                  #   exit chip; a running row cross-fades its drill
    │   │                  #   chevron into a hover STOP button — manual kill
    │   │                  #   via DELETE /api/shell/{id}, optimistic in
    │   │                  #   useSessionActivity.stopShell) → TerminalBody:
    │   │                  #   cursor-paginated output polled
    │   │                  #   every 2s while running, follow-bottom, 200k-char tail
    │   │                  #   cap, falls back to the notification's embedded output
    │   │                  #   once the process-local shell registry 404s (a manual
    │   │                  #   stop removes the retained output too, so the
    │   │                  #   fallback is the normal path after one). Fires
    │   │                  #   onSettled when the first page (or terminal
    │   │                  #   failure) lands — releases the card's drill
    │   │                  #   hold.
    │   └── SubagentsSection.tsx # Subagent rows (presence-animated per
    │   │                  #   row, like TerminalsSection; agent + task
    │   │                  #   label + running
    │                      #   state) → SubagentBody: read-only transcript reusing
    │                      #   the module-level message store + TranscriptList, so
    │                      #   background children stream in live; fires onSettled
    │                      #   when the seed page lands (useSessionMessages'
    │                      #   `seeding`) — releases the card's drill hold.
    ├── composer/          # The prompt composer
        ├── ChatInput.tsx  # Composer shell: staged attachments (chips),
        │                  #   slash-command fetch (per-directory, retried),
        │                  #   LexicalComposer wiring, toolbar.
        ├── ComposerCore.tsx # Editor internals: trigger-driven suggestions,
        │                  #   keyboard routing (Enter/arrows/Tab/Esc, IME-safe),
        │                  #   submit serialization, paste-to-attach.
        ├── ComposerToolbar.tsx # Bottom toolbar: attach/mode/project on the
        │                  #   left; usage ring, model, thinking depth,
        │                  #   send/stop on the right. Owns the catalog →
        │                  #   picker mapping (provider groups, variants) and
        │                  #   the model-config entry (empty-state "no models
        │                  #   configured" when catalogOnly, and the
        │                  #   scrollable list's last "configure models…"
        │                  #   row) raising onOpenModelConfig (App opens
        │                  #   Settings on Model).
        ├── composerTriggers.ts # Lexical node-tree algorithms: `@`/`/` trigger
        │                  #   detection (CJK-aware) + atomic mention ←/→.
        ├── composerAttachments.ts # Data-URI attachment reader + size cap
        ├── InputSuggestions.tsx # Autocomplete popup (@ / / triggers)
        ├── FileMentionNode.tsx / CommandMentionNode.tsx # Lexical token TextNodes
        ├── ToolbarButton.tsx # The composer's compact toolbar control
        └── DirectoryPicker.tsx # Working-directory chooser (dialog + GET /api/project)

    └── settings/           # The settings modal (title-bar gear; layout
                           #   follows lumina-terminal's settings pages)
    ├── SettingsModal.tsx # Modal shell: left tab rail (General / Model /
    │                      #   About) over ui/Modal; ONE pane mounts at a
    │                      #   time (mount doubles as the pane's open →
    │                      #   ModelSettings loads/resets on mount). App owns
    │                      #   {open, tab} so entry points deep-link a tab.
    ├── GeneralSettings.tsx # Language + appearance rows, the
    │                      #   activity-panel mode OptionRow (auto
    │                      #   collapse / always open), the
    │                      #   Linux-only window-outline Switch, and a Fonts section
    │                      #   (AboutSettings-style header; one control per
    │                      #   row — family input / size stepper — plus
    │                      #   reset); everything acts instantly through
    │                      #   module stores (i18n, useThemePreference,
    │                      #   useStatsPanelMode, useWindowOutline,
    │                      #   useTypography).
    ├── ModelSettings.tsx # Formerly composer/ModelConfigModal: searchable
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
    │                      #   catalog models + Off), which writes the
    │                      #   plugin file + merges its entry/agent into the
    │                      #   global config via toolPluginConfig.ts.
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
    ├── modelConfig.ts    # Pure model-config logic: integration search,
    │                      #   custom-provider config merge/remove/read-back
    │                      #   (globalConfigTarget itself lives in
    │                      #   opencode/configFiles.ts). node-testable.
    └── toolPluginConfig.ts # Pure custom-tools config logic: the
                           #   lumina-tools plugin entry upsert/remove/
                           #   read-back in the global opencode.json's
                           #   `plugins` array (per-tool options, foreign
                           #   entries preserved) + the restricted helper
                           #   agents in the config's `agents` section
                           #   (v2.0.11 has no plugin-side agent add) +
                           #   the vision-capable model filter. node-testable.
```

### Backend (`src-tauri/src/`)

Intentionally thin — server lifecycle only. All business logic lives in the
frontend. `system.rs` plus the `opencode/` module:

```
src-tauri/src/
├── main.rs        # entry, calls lib::run()
├── lib.rs         # Tauri builder: plugins (log → LogDir "lumina-code" + Webview
│                  #   target, os, opener, dialog), Linux env workarounds set BEFORE
│                  #   GTK init (__NV_DISABLE_EXPLICIT_SYNC; GDK_DEBUG=gl-no-fractional
│                  #   for Wayland fractional scaling), invoke_handler, and the Exit
│                  #   hook that kills the owned server (opencode::shutdown).
├── system.rs      # is_wayland command (XDG_SESSION_TYPE, WAYLAND_DISPLAY fallback)
└── opencode/      # OpenCode server lifecycle, split by concern:
    ├── mod.rs     # Orchestration: OpencodeState/OpencodeConnection types,
    │              #   the `opencode_start` command (spawn `opencode serve` with a
    │              #   generated password + OPENCODE_SERVER_PASSWORD, the webview
    │              #   origin to --cors, version-pin enforcement, monitor thread
    │              #   emitting "opencode-status") and shutdown.
    ├── resolve.rs # Binary discovery ($OPENCODE_BIN → bundled sidecar → PATH →
    │              #   ~/.opencode/bin) + `--version` parsing.
    ├── probe.rs   # Spawn prerequisites + readiness: free_port, base64,
    │              #   generate_password, and the minimal HTTP GET that polls
    │              #   /api/session WITH auth (unknown routes serve the SPA HTML
    │              #   with HTTP 200, so the probe checks the body is JSON).
    └── reap.rs    # Orphan reaping: every spawn records
                   #   <app_data>/servers/<pid>.txt (body = port) and later runs
                   #   kill only provably-ours servers (cmdline check via /proc;
                   #   dev rebuilds strand several — two servers sharing the
                   #   user's storage cause transiently EMPTY provider reads).
```

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
  `fetch()` the server directly — they receive `api`/`subscribe` as props
  from App and go through the `use*` hooks.
- `hooks/` may import `lib/` and `opencode/`, never `components/`.
- `App.tsx` owns the connection and hands `api` + `subscribe` down.

### 3.2 Single Source of Truth (no duplication)

- **Server access** → only through `OpencodeApi` (`opencode/api.ts`) or the
  bus (`subscribe` + `messageStore.applyEvent`). Never a second fetch
  client, and never re-derive wire shapes from the SDK — `types.ts` is the
  authority (verified against the installed server).
- **Platform checks** → `lib/platform.ts`. **Glass/backdrop-filter** →
  `lib/glass.ts` only (inline `backdrop-filter` breaks the Linux fallback).
  **Motion presets** → `lib/motion.ts`. **Color math** → `lib/color.ts`.
  **Surface colors** → `hooks/surfaceColors.ts` (or the `SurfaceColors`
  prop it produces — don't hand-mix variants in components).
  **File-type icons** → `lib/fileIcons.ts` (never hand-roll per-extension
  icon tables; regenerate assets via `pnpm gen:icons`).
- **Chrome buttons** → `components/ui/IconButton.tsx`. **Dropdowns** →
  `PopoverMenu`. **Rounded chrome clipping** → `MaskedSurface`.
- **Maximized / paddingOffset** → computed once in `App`, passed as props.
  Children must not re-derive them.
- **User-visible strings** → `useI18n()` with a TranslationKey. Add the key
  to `i18n/en-us.ts` (and preferably `zh-cn.ts`) in the same change — raw
  strings in JSX are wrong even for "temporary" copy.
- **Cross-restart state** → `lib/persist.ts` (`loadState`/`saveState`), one
  localStorage key. Don't grow a second persistence mechanism.

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

`pnpm test` runs node:test over `src/**/*.test.ts` — pure-logic modules
only (message reducer, run-footer collection, usage math, transcript
folding, form answers, session grouping, path display, tool metadata). New
pure logic
that matters (reducers, collectors, mapping) belongs in a pure module WITH
a colocated test; UI wiring is verified by `pnpm build` + running the app.
The Rust side currently has no test suite — keep it thin enough not to
need one, and extract anything that grows logic into the frontend's pure
layer instead.

---

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
