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
├── main.tsx               # ReactDOM entry (React.StrictMode) + attachConsole
├── constants.ts           # CHROME_TITLE_BAR_HEIGHT
├── i18n/                  # en-us.ts (source of truth: keys ARE the English
│                          #   strings) + zh-cn.ts (partial OK; per-lookup fallback)
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
│   │                      #   parentID and would flood the list); busy set seeded from
│   │                      #   GET /api/session/active (a stale busy id blocks the
│   │                      #   composer forever — the seed must not resurrect ids watched
│   │                      #   end); create/remove/patch (optimistic model/agent).
│   ├── useSessionMessages.ts # React binding over a MODULE-LEVEL store (one entry per
│   │                      #   session, surviving ChatView unmounts AND webview reloads
│   │                      #   — backgrounded sessions keep accumulating deltas; entries
│   │                      #   drop on session.deleted). One global bus handler applies
│   │                      #   events to every tracked session. Cursor-based loadOlder.
│   │                      #   prepareCommandSubmission pre-creates the entry so a
│   │                      #   first-send slash command keeps its enqueue frame.
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
│   │                      #   file-mutation count signature. node-testable.
│   ├── useSessionActivity.ts # Stats-card state: the whole-session git diff
│   │                      #   (GET /api/session/{id}/diff anchored to the first/last
│   │                      #   user message — no anchors would diff only the newest
│   │                      #   turn; re-pulled debounced when the mutation signature
│   │                      #   moves), the live running-shell set (listShells seed +
│   │                      #   global shell.created/exited bus events) and subagent
│   │                      #   running flags (the App busy set — children report
│   │                      #   execution events too). Derived arrays are
│   │                      #   identity-stable across streamed frames.
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
│   ├── useAlwaysOnTop.ts  # per-window pin (no-op on Wayland)
│   ├── useWindowOutline.ts # Linux window-outline toggle (App's inset
│   │                      #   box-shadow edge for DEs without compositor
│   │                      #   shadows): module store + own localStorage
│   │                      #   key, default on; the settings row is
│   │                      #   Linux-only but App gates on isLinux() too.
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
    │                      #   through SessionFolder.
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
    │   │                  #   transcript.ts; rendering in TranscriptList.tsx. Also
    │   │                  #   owns useSessionActivity and floats stats/
    │   │                  #   SessionStatsCard over the transcript (busyIds flow in
    │   │                  #   from App for the subagent running flags).
    │   ├── transcript.ts  # Pure blockify(): folds runs of activity-only
    │   │                  #   assistant messages into TranscriptBlocks. node-testable.
    │   ├── TranscriptList.tsx # Renders the mounted slice as MessageItems /
    │   │                  #   cross-message ActivityGroups + run footers. Owns
    │   │                  #   entrance gating: only tail-appended content that
    │   │                  #   appeared live (new ids after the last known one,
    │   │                  #   freshly completed footers) animates in — history
    │   │                  #   bulk-mounted on open/scroll-up renders instantly
    │   │                  #   (concurrent-entrance bursts were the frame drops).
    │   ├── MessageItem.tsx # One message: user bubble or assistant document
    │   │                  #   (segmented via messageParts.ts); `enter` prop =
    │   │                  #   animate this message's framer entrances or not.
    │   ├── messageParts.ts # Pure part segmentation: segmentContent,
    │   │                  #   effectiveTailPart, stable part keys.
    │   ├── ActivityGroup.tsx # Folded run of tool calls / thoughts
    │   ├── ThinkingBlock.tsx # Reasoning disclosure (live while streaming)
    │   ├── ToolCard.tsx   # One tool call as a FoldRow (detail/accent lines;
    │   │                  #   file-mutating tools expand to a git-diff view)
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
    │   │                  #   detection). node-testable.
    │   ├── toolDiff.ts    # Pure diff model for edit/apply_patch/write inputs
    │   │                  #   (LCS line diff, patchText coloring, changed-line
    │   │                  #   counts) PLUS the hunk sources git-diff-view
    │   │                  #   renders: patchHunks (real patches keep real line
    │   │                  #   numbers), fragmentHunks (fragment-relative
    │   │                  #   synthesis), toolHunksFor (null exactly where
    │   │                  #   toolDiffFor is, so counts and view agree) —
    │   │                  #   the server never stores the pre-edit file, so
    │   │                  #   diffs derive from tool input alone.
    │   │                  #   node-testable.
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
    │   ├── PermissionCard.tsx / QuestionCard.tsx # RequestCards — the ONLY way a blocked
    │   │                  #   session moves forward (answers go to the reply endpoints).
    │   │                  #   Shared chrome in RequestCardChrome.tsx; answer rules in
    │   │                  #   formLogic.ts (pure, node-testable).
    │   ├── RequestCardChrome.tsx # Card + CardButton + MONO_STYLE (mono
    │   │                  #   family + settings-driven --lum-code-size)
    │   │                  # shared by the request kinds and tool cards.
    │   └── formLogic.ts   # Pure form-answer rules: fieldVisible (`when`
    │                      #   conditions), normalize (per-type values).
    │
    ├── stats/            # The session-activity stats card (floats over the
    │                      #   transcript's right margin; data from
    │                      #   opencode/useSessionActivity, owned by ChatView)
    │   ├── SessionStatsCard.tsx # The floating card: collapsed summary rows
    │   │                  #   (+N −N lines, terminal/subagent counts — non-empty
    │   │                  #   rows only) expanding into the detail panel via a
    │   │                  #   SHARED-ELEMENT transition, all validated against a
    │   │                  #   headless-browser repro (see git history): the box
    │   │                  #   springs REAL style.width/height through a
    │   │                  #   HAND-ROLLED integrator (imperative pin in the click
    │   │                  #   → measure the incoming content → spring → release
    │   │                  #   to auto; framer proved unreliable here — its values
    │   │                  #   apply on animation frames and its auto-target
    │   │                  #   handling pollutes measurements), the measure
    │   │                  #   wrapper carries shrink-0 (a flex child squeezed by
    │   │                  #   the pinned container corrupts every measurement),
    │   │                  #   layoutId flights (±counts, file/terminal/subagent
    │   │                  #   titles) fly only where reliable — rows ARM their
    │   │                  #   layoutIds on pointer-down so mounting never pairs
    │   │                  #   against stale registry boxes (phantom flights) —
    │   │                  #   and everything else fades (FadeIn; expand waits
    │   │                  #   150ms for the box, in-panel navigation is instant).
    │   │                  #   Outside-click/Escape collapse (capture-phase).
    │   ├── statsChrome.tsx # Shared section header + row/hover classes
    │   │                  #   (the MenuItem pattern via a CSS var).
    │   ├── ChangesSection.tsx # Whole-session git diff: file rows (icon +
    │   │                  #   status chip + net counts) → FileDiffBody (server
    │   │                  #   patch through chat/DiffViewBody + toolDiff.ts's
    │   │                  #   patchHunks — real line numbers). FileTitle /
    │   │                  #   file row & header layoutIds live here.
    │   ├── TerminalsSection.tsx # Background-shell rows (running pulse / exit
    │   │                  #   chip) → TerminalBody: cursor-paginated output polled
    │   │                  #   every 2s while running, follow-bottom, 200k-char tail
    │   │                  #   cap, falls back to the notification's embedded output
    │   │                  #   once the process-local shell registry 404s.
    │   └── SubagentsSection.tsx # Subagent rows (agent + task label + running
    │                      #   state) → SubagentBody: read-only transcript reusing
    │                      #   the module-level message store + TranscriptList, so
    │                      #   background children stream in live.
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
    ├── GeneralSettings.tsx # Language + appearance rows, the Linux-only
    │                      #   window-outline Switch, and a Fonts section
    │                      #   (AboutSettings-style header; one control per
    │                      #   row — family input / size stepper — plus
    │                      #   reset); everything acts instantly through
    │                      #   module stores (i18n, useThemePreference,
    │                      #   useWindowOutline, useTypography).
    ├── ModelSettings.tsx # Formerly composer/ModelConfigModal: searchable
    │                      #   integration list, API-key connect, browser-OAuth
    │                      #   flow with attempt polling, credential
    │                      #   activate/remove, per-provider model switches
    │                      #   (picker visibility via useDisabledModels);
    │                      #   custom OpenAI-compatible providers written to
    │                      #   the global opencode.json (server hot-reloads →
    │                      #   config.updated event).
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
    └── modelConfig.ts    # Pure model-config logic: integration search,
                          #   custom-provider config merge/remove/read-back,
                          #   global-config-target discovery. node-testable.
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
