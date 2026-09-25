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
| Run the app | `pnpm tauri dev` |
| Typecheck + build frontend | `pnpm build` (`tsc && vite build`) |
| Unit tests (pure frontend logic) | `pnpm test` (`node --test "src/**/*.test.ts"`) |
| Point dev at a different server binary | `OPENCODE_BIN=/path/to/opencode pnpm tauri dev` |
| Regenerate Material file-type icons (after bumping `material-icon-theme`) | `pnpm gen:icons` (output is committed) |

- `pnpm fetch:opencode` is a **prerequisite** for `tauri dev`/`tauri build`:
  Tauri's `externalBin` (`src-tauri/binaries/opencode`) must exist or the
  bundle step fails. Binaries are gitignored. The sidecar is also a hard
  dependency of the BUILD SCRIPT — `cargo check` alone fails without it, and
  every CI job fetches it first.
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
  Linux/Windows/macOS. Fetches the host sidecar via
  `node scripts/fetch-opencode.mjs` (tauri-build needs it even for check)
  and drops a placeholder `dist/index.html` for `generate_context!`.
- **release.yml** — on a **published GitHub release** (or manual dispatch
  with a `tag` input): builds the 5-target matrix (linux amd64/arm64,
  windows x64, macos amd64/arm64), fetching the sidecar for the exact
  matrix target first, and attaches bundles to the release. Hand-written
  release notes are snapshotted and echoed back so the concurrent matrix
  never overwrites them. No updater signing (the Tauri updater is not
  configured for this app).
- **pkg-trigger.yml → aur.yml / copr.yml** — after Release succeeds,
  republish the .deb/.rpm assets as `lumina-code-bin` (AUR) and `lumina-code`
  (Fedora COPR) from the `.aur/PKGBUILD` / `.copr/lumina-code.spec`
  templates. One-time repo secrets: `AUR_SSH_PRIVATE_KEY`, `COPR_CONFIG`
  (plus a manually created COPR project `iewnfod/lumina-code`).

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
│                          #   mounted; cross-directory switches remount it;
│                          #   never on the welcome screen). App measures
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
├── main.tsx               # ReactDOM entry (React.StrictMode) + attachConsole
├── constants.ts           # CHROME_TITLE_BAR_HEIGHT
├── i18n/                  # en-us.ts (source of truth: keys ARE the English
│                          #   strings) + zh-cn.ts (partial OK; per-lookup fallback)
│
├── plugins/               # Plugin SOURCES shipped with the app (plain JS, no
│   └── luminaTools.js     #   imports — a bare default export loads on server
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
│                          #   its model option — and plan_mode (always-on
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
│                          #   plan_amend close the loop around plan mode —
│                          #   the plan agent submits {title, plan, todos}
│                          #   and the executor BLOCKS as the approval
│                          #   gate (Route A): v2.0.11 has NO
│                          #   execution-time permission check for
│                          #   plugin tools (binary-verified:
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
│                          #   otherwise. Task titles must be SHORT
│                          #   (protocol text). Build then reports via
│                          #   task_complete {title} under STRICT
│                          #   validation (title must equal the NEXT
│                          #   open task's title, whitespace-normalized,
│                          #   no skipping/revisiting; blocked:true +
│                          #   reason is the honest exit), plan_amend
│                          #   {todos} replaces the remaining tail.
│                          #   Validation state is DERIVED FROM THE
│                          #   TRANSCRIPT each call (ctx.session.context:
│                          #   last completed plan_submit + subsequent
│                          #   completed task_complete/plan_amend parts —
│                          #   planStateFromEntries; no plugin-side mutable
│                          #   state; subagent child sessions self-scope-out,
│                          #   their transcripts hold no plan). Every result
│                          #   echoes the checklist (compaction self-healing).
│                          #   setup() also rides the v2.0.11 session hook —
│                          #   ctx.session.hook("context", e => e.system.push)
│                          #   appends HOST_IDENTITY (the harness identity:
│                          #   "you run inside Lumina Code, the desktop GUI
│                          #   client for OpenCode — not the TUI") and the
│                          #   PLAN_WORKFLOW protocol to every model call
│                          #   (binary-verified; runtime-probed,
│                          #   degrades to tool descriptions when absent).
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
│   ├── useLuminaTools.ts  # The custom-tools plugin's install half:
│   │                      #   ensureLuminaToolsPlugin(api, options?) writes the
│   │                      #   plugin file + the config entry (diff-gated — the
│   │                      #   server hot-reloads on every config write), and
│   │                      #   useLuminaToolsInstall (AppBody, once per
│   │                      #   connection) keeps both current so the always-on
│   │                      #   plan_mode tool exists from the first prompt on.
│   │                      #   Passing options REPLACES the stored per-tool
│   │                      #   options (the Tools tab's saves go through it);
│   │                      #   omitting them preserves what's configured.
│   │                      #   Failures log and degrade to "tool absent".
│   ├── toolPluginConfig.ts # Pure custom-tools config logic (moved out of
│   │                      #   components/settings when useLuminaTools needed
│   │                      #   it — layering, §3.1): the lumina-tools plugin
│   │                      #   entry upsert/read-back/entry-present probe in
│   │                      #   the global opencode.json's `plugins` array
│   │                      #   (per-tool options, foreign entries preserved;
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
│   │                      #   useSessionData() (list/busy/CRUD/pending asks),
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
│   ├── useSessions.ts     # Sidebar list: seeded from GET /api/session, live-patched
│   │                      #   from the bus; root sessions only (subagent children carry
│   │                      #   parentID and would flood the list; the tools plugin's
│   │                      #   helper sessions hide via their {source:
│   │                      #   "lumina-tools"} metadata marker — and are DELETED
│   │                      #   by this hook once their execution ends, plus a
│   │                      #   one-per-connection sweep of leftovers, because
│   │                      #   v2.0.11's plugin API has no session delete);
│   │                      #   session.agent.selected patches the mode in place
│   │                      #   (covers the model switching itself into Plan
│   │                      #   Mode via the plan_mode tool); busy set seeded from
│   │                      #   GET /api/session/active (a stale busy id blocks the
│   │                      #   composer forever — the seed must not resurrect ids watched
│   │                      #   end); create/remove/patch (optimistic model/agent).
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
│   │                      #   would loop forever).
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
│   │                      #   and the cross-restart save. Consumes the context
│   │                      #   split (connection handles + catalog + the
│   │                      #   provider-hosted session list) — no parameters.
│   ├── useSessionRequests.ts # Pending server→user asks across ALL sessions (permission
│   │                      #   requests + forms), seeded from the list endpoints then
│   │                      #   bus-maintained; a pending ask blocks the session's
│   │                      #   execution server-side. Global, not per-session, so sidebar
│   │                      #   badges work for inactive sessions. The plan workflow's
│   │                      #   pending APPROVAL folds into the same pendingCounts via
│   │                      #   a module store over the message transcript
│   │                      #   (planApprovalPending — Route A; see
│   │                      #   PlanApprovalCard) — same badge as questions.
│   ├── sessionActivity.ts # Pure stats-card derivations from a session's messages:
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
│   │                      #   advance it; the FRONTEND MIRROR of the plugin's
│   │                      #   planStateFromEntries fold — keep the two in sync) +
│   │                      #   findPlanSubmitInput (locates a pending request's plan
│   │                      #   payload via its permission source part id, falling
│   │                      #   back to the last plan_submit; a located-but-malformed
│   │                      #   source never substitutes another plan) +
│   │                      #   planApprovalPending (the LAST plan_submit
│   │                      #   part while still running — Route A's
│   │                      #   pending-approval signal, driving the
│   │                      #   approval card).
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
│   │                      #   (3) the active session's plan-workflow TODOS —
│   │                      #   a pure collectSessionTodos fold over the same
│   │                      #   snapshot (identity-cached like the others), no
│   │                      #   endpoints or bus of its own.
│   │                      #   prefetchSessionActivity (sidebar hover, wired
│   │                      #   in App) warms the scopes ahead of the click.
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
│   │                      #   model, agent, directory). Never throws.
│   ├── planFiles.ts       # Plan-workflow document persistence (pure): the
│   │                      #   CJK-safe filename slug, the dated
│   │                      #   `.lumina/plans/YYYY-MM-DD-<slug>.md` name with
│   │                      #   collision suffixes (async exists-probe — the
│   │                      #   fs/read round-trip), and composePlanDocument
│   │                      #   (plan markdown + checklist appendix, self-
│   │                      #   contained). The write itself is the approval
│   │                      #   card's job (it owns the api + directory).
│   │                      #   node-testable.
│   ├── clipboard.ts       # copyText — clipboard write with an execCommand
│   │                      #   fallback for webviews lacking the async API
│   ├── dragRegionDoubleClick.ts # pure predicate behind the title-bar double-click
│   └── exitGate.ts     # Exit-engine logic (node-testable): the animation/
│                        #   transition end-event matchers (target must BE
│                        #   the host; bubbled child events never count),
│                        #   the app-wide EXIT BUDGET ledger (caps
│                        #   concurrent exit holds — bursts skip the
│                        #   choreography instead of dropping frames), and
│                        #   mergeExitOrder (a leaving list row collapses
│                        #   IN PLACE, interleaved at its original
│                        #   position between surviving neighbors).
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
    │                      #   age and close button share one cross-fade slot;
    │                      #   deleted rows collapse in place via ExitList,
    │                      #   budget-limited), "Show more/less" expander.
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
    │   ├── Modal.tsx      # Portal-rendered modal chrome (fadeIn backdrop +
    │   │                  #   scaleIn panel, Escape/backdrop close)
    │   ├── MaskedSurface.tsx # SVG rounded-rect clip exposing the glass chrome corners
    │   ├── PopoverMenu.tsx   # Shared dropdown menu
    │   ├── RollingTitle.tsx # Ellipsized title that scrolls on hover
    │   └── WindowControls.tsx # minimize/maximize/close cluster (non-macOS)
    ├── chat/              # The conversation surface
    │   ├── ChatView.tsx   # Transcript column + composer for the active session.
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
    │   │                  #   plan-workflow APPROVAL (Route A): the
    │   │                  #   plan_submit executor blocks inside its
    │   │                  #   call, planApprovalPending derives the
    │   │                  #   pending payload from the transcript, and
    │   │                  #   PlanApprovalCard pins above the composer
    │   │                  #   (approve = switchAgent + plan-file save;
    │   │                  #   reject = interrupt).
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
    │   │                  #   / ActivityGroup, which have no dots).
    │   │                  #   Subagent transcripts pass busy and
    │   │                  #   get the dots too (SubagentsSection).
    │   │                  #   tailActivity.ts is pure + node-testable.
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
    │   ├── PlanApprovalCard.tsx # The plan workflow's approval card
    │   │                  #   (Route A): the plan_submit executor
    │   │                  #   BLOCKS inside its tool call, so ChatView
    │   │                  #   derives the pending state from the
    │   │                  #   transcript (sessionActivity.
    │   │                  #   planApprovalPending — a still-running
    │   │                  #   part IS a pending decision) and pins this
    │   │                  #   card above the composer via ExitPresence.
    │   │                  #   批准 = switchAgent("build") + best-effort
    │   │                  #   plan-document save (lib/planFiles.ts →
    │   │                  #   .lumina/plans/); 驳回 = interrupt (aborts
    │   │                  #   the executor → revision prompt). A
    │   │                  #   malformed payload offers rejection only.
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
    │                      #   two context scope hooks (workspace diff by
    │                      #   directory, session terminals/subagents),
    │                      #   then renders SessionStatsCard (colors via
    │                      #   context).
    │   ├── SessionStatsCard.tsx # The card (presentation + local
    │                      #   navigation only): collapsed summary rows
    │                      #   (plan progress ✓n/N, +N −N lines,
    │                      #   terminal/subagent counts) expanding into
    │                      #   the detail panel (TodoSection rides ABOVE
    │                      #   ChangesSection — see stats/TodoSection).
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
    │   ├── statsChrome.tsx # Shared stats-panel chrome: StatsSection
    │                      #   header, DrillChevron, StateChip, RollingValue /
    │                      #   FinishedTotal counters (RollingTitle drums),
    │                      #   BodyBox (the drill-body surface), statsRowClass
    │                      #   (the .lum-wash hover row).
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
    │   │                  #   fallback is the normal path after one). The api
    │   │                  #   handle comes from useConnection().
    │   ├── SubagentsSection.tsx # Subagent rows (presence-animated per
    │   │                  #   row, like TerminalsSection; agent + task
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
    │                      #   Static rows (statuses swap in place, nothing
    │                      #   unmounts — no presence animation needed);
    │                      #   pendingApproval swaps the header count for a
    │                      #   "waiting for approval" chip.
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
        ├── composerDrafts.ts  # In-memory composer draft store (Map keyed
        │                      #   by surface — WELCOME_DRAFT_KEY or the
        │                      #   session id): serialized Lexical
        │                      #   EditorState + staged attachments
        │                      #   survive the session-surface swap's
        │                      #   remounts; cleared on submit.
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
    │                      #   catalog models + Off), saving through the
    │                      #   shared installer
    │                      #   (opencode/useLuminaTools.ts; plan_mode needs
    │                      #   no configuration — always-on).
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
    │                      #   opencode/configFiles.ts; the custom-tools
    │                      #   twin toolPluginConfig.ts also lives in
    │                      #   opencode/ now). node-testable.
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

### 3.7 Motion & layout — CSS first, browser owns the numbers

The app's animation system is the CSS utility classes in main.css; JS
never runs per frame and never measures/pins/synchronizes layout.

- **Entrances/exits are CSS keyframes**: `.lum-enter` (fade + rise),
  `.lum-fade` (tall panes), `.lum-pop`/`.lum-pop-exit` (modals, menus),
  `.lum-row-exit` (list rows: grid-rows height collapse). RollingTitle's
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
