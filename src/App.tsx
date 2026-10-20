import {useCallback, useState} from "react";
import TitleBar from "./components/TitleBar.tsx";
import SessionSurface from "./components/SessionSurface.tsx";
import StatsCardSwap from "./components/StatsCardSwap.tsx";
import SessionBar from "./components/SessionBar.tsx";
import SidebarResizer from "./components/SidebarResizer.tsx";
import WelcomeScreen from "./components/WelcomeScreen.tsx";
import BootScreen from "./components/BootScreen.tsx";
import ChatView from "./components/chat/ChatView.tsx";
import WorkspaceStatsCard from "./components/stats/WorkspaceStatsCard.tsx";
import SettingsModal, {type SettingsTab} from "./components/settings/SettingsModal.tsx";
import ImportSessionsModal from "./components/ImportSessionsModal.tsx";
import ExtensionsModal from "./components/ExtensionsModal.tsx";
import MaskedSurface from "./components/ui/MaskedSurface.tsx";
import {useMaximized} from "./hooks/maximized.ts";
import {usePaddingOffset} from "./hooks/paddingOffset.ts";
import {useDragRegionDoubleClick} from "./hooks/useDragRegionDoubleClick.ts";
import {useGlass} from "./hooks/useGlass.ts";
import {useI18n} from "./hooks/i18n.tsx";
import {usePhoneLayout} from "./hooks/useLayoutMode.ts";
import {useSystemTheme} from "./hooks/useSystemTheme.ts";
import {useThemePreference} from "./hooks/useThemePreference.ts";
import {useSurfaceColors} from "./hooks/surfaceColors.ts";
import {ColorsProvider, useColors} from "./hooks/colors.tsx";
import {useWindowOutline} from "./hooks/useWindowOutline.ts";
import {useBmsFocusRefresh, useCompositorBlurActive} from "./hooks/useBlurMyShell.ts";
import {useWindowFirstShow} from "./hooks/useWindowFirstShow.ts";
import {useChromeThemeSync} from "./hooks/useChromeThemeSync.ts";
import {useNotifications} from "./hooks/useNotifications.ts";
import {useServerFrp} from "./hooks/useServerFrp.ts";
import {useBackLevel} from "./hooks/useBackLevel.ts";
import {glassSurface, windowOutline} from "./lib/glass.ts";
import {isColorDark, withAlpha} from "./lib/color.ts";
import {isLinux, isCefRuntime, isMobileApp} from "./lib/platform.ts";
import {appThemeFor, type ChromeTheme} from "./lib/theme.ts";
import {useOpencode} from "./opencode/useOpencode.ts";
import {useSessionFlow} from "./opencode/useSessionFlow.ts";
import {useDirectoryBranch} from "./opencode/useDirectoryBranch.ts";
import {useLuminaToolsInstall} from "./opencode/useLuminaTools.ts";
import {CatalogProvider} from "./opencode/catalogContext.tsx";
import {ConnectionProvider, useConnection} from "./opencode/connectionContext.tsx";
import {SessionDataProvider, useSessionData} from "./opencode/sessionDataContext.tsx";
import {ensureSessionSeeded} from "./opencode/useSessionMessages.ts";
import {prefetchSessionActivity} from "./opencode/useSessionActivity.ts";
import type {SessionUsage} from "./opencode/types.ts";

/**
 * Layout shell, ported from lumina-terminal's App.tsx: outer transparent
 * window frame with rounded corners, then SessionBar (left glass sidebar) +
 * TitleBar over a MaskedSurface content area that exposes the chrome glass
 * layer through its rounded corners.
 *
 * Split in two since the context refactor: InnerApp is the connection +
 * theme shell (useOpencode, the palette, the three providers), AppBody is
 * everything else — it consumes the contexts (connection / catalog /
 * session data) and hosts the session flow, the surface choreography and
 * the chrome.
 *
 * The conversation row (`.lum-row`) is a CSS size CONTAINER: the
 * conversation column's width tiers and the stats panel's flow-vs-float
 * are container queries in main.css — the browser measures, nothing in
 * JS does. The chrome palette is derived ONCE and provided through
 * ColorsProvider (hooks/colors.tsx) plus the --lum-wash CSS vars seeded
 * on the root.
 */

function InnerApp({isMaximized}: {isMaximized: boolean}) {
    const themePreference = useThemePreference();
    const systemTheme = useSystemTheme();
    const resolvedTheme = themePreference === "system" ? systemTheme : themePreference;
    const {theme: effectiveTheme, bg: effectiveBg, fg: effectiveFg, dark, contentBg} = appThemeFor(resolvedTheme);

    // The ONE palette derivation: provided via ColorsProvider and seeded
    // as the app-wide hover-wash CSS vars below.
    const colors = useSurfaceColors(effectiveBg);

    // Glass material filling the content area. The chat surface is clipped to
    // a rounded rectangle; its four corners are transparent, exposing this
    // chrome layer beneath — so the chrome reads as a continuous frame
    // wrapping the content with rounded inner corners.
    const {supportsGlass} = useGlass();

    // Compositor blur (GNOME + Blur my Shell): when live, the window
    // base paints translucent and the extension blurs behind the whole
    // window — see hooks/useBlurMyShell.ts.
    const compositorBlur = useCompositorBlurActive();

    // The Linux window outline is a user preference (General settings);
    // see the outline overlay in AppBody.
    const outlineEnabled = useWindowOutline();

    // --- OpenCode connection (the context split's base layer) ---
    const {status: connectionStatus, api, subscribe} = useOpencode();

    useWindowFirstShow();

    // The user may toggle Blur my Shell (or its applications component)
    // in GNOME's UI while Lumina is unfocused — re-probe on focus regain
    // so a stale "active" can't leave the window see-through without
    // blur. No-op off Linux.
    useBmsFocusRefresh();

    useChromeThemeSync(effectiveBg, dark, systemTheme);

    // The chrome glass layer is derived per connection state (supportsGlass
    // flips only on platform; compositorBlur on the BMS probe), so
    // computing it inline is fine.
    const chromeGlass = glassSurface(effectiveBg, supportsGlass, {blurPx: 16, compositorBlur});

    return (
        <ColorsProvider colors={colors}>
        <ConnectionProvider api={api} subscribe={subscribe} status={connectionStatus}>
            <CatalogProvider>
                <SessionDataProvider>
                    <AppBody
                        isMaximized={isMaximized}
                        effectiveTheme={effectiveTheme}
                        effectiveBg={effectiveBg}
                        effectiveFg={effectiveFg}
                        contentBg={contentBg}
                        chromeGlass={chromeGlass}
                        outlineEnabled={outlineEnabled}
                        compositorBlur={compositorBlur}
                    />
                </SessionDataProvider>
            </CatalogProvider>
        </ConnectionProvider>
        </ColorsProvider>
    );
}

function AppBody({
    isMaximized,
    effectiveTheme,
    effectiveBg,
    effectiveFg,
    contentBg,
    chromeGlass,
    outlineEnabled,
    compositorBlur,
}: {
    isMaximized: boolean;
    effectiveTheme: ChromeTheme;
    effectiveBg: string;
    effectiveFg: string;
    contentBg: string | null;
    chromeGlass: React.CSSProperties;
    outlineEnabled: boolean;
    compositorBlur: boolean;
}) {
    const t = useI18n();
    const colors = useColors();
    const {api, subscribe, status: connectionStatus} = useConnection();
    const {pendingCounts, foreignSessions} = useSessionData();
    const {
        sessions,
        busyIds,
        activeId,
        setActiveId,
        activeSession,
        effectiveModel,
        effectiveAgent,
        pendingDirectory,
        pendingBranch,
        changeModel,
        changeAgent,
        changeStagedBranch,
        newSession,
        changeDirectory,
        sendFirst,
        deleteSession,
    } = useSessionFlow();
    const busy = activeId !== null && busyIds.has(activeId);
    // The active session's working directory — scopes the stats card's
    // workspace diff AND keys the card layer: same-directory session
    // switches keep the card mounted (no exit/enter animation), a
    // cross-directory switch remounts it so it animates with the swap.
    const activeDirectory = activeSession
        ? activeSession.directory ?? activeSession.location?.directory ?? null
        : null;
    // The title bar's branch chip: the ACTIVE session's directory, or
    // the welcome screen's staged project (useDirectoryBranch caches per
    // directory, so switches paint instantly). On the welcome screen a
    // STAGED branch wins — that is the branch the first send will pin.
    const titleBranch = useDirectoryBranch(api, activeDirectory ?? pendingDirectory);
    const shownBranch = activeSession ? titleBranch : (pendingBranch ?? titleBranch);
    // Cumulative usage of the open session (seeded from the session list,
    // live-patched by session.usage.updated) — feeds the composer's ring.
    const activeUsage: SessionUsage | null = activeSession
        ? {tokens: activeSession.tokens, cost: activeSession.cost}
        : null;
    const connected = connectionStatus.state === "connected";

    // Keep Lumina Code's custom-tools plugin installed on the server (its
    // always-on plan_mode tool — the model's way to switch the session
    // into Plan Mode — must exist from the first prompt on). No-op once
    // current; failures only log.
    useLuminaToolsInstall();

    // Desktop notifications (Settings → General → Notifications): watches
    // run ends and user-attention events across every root session, gated
    // by the stored mode + focus mute. Pure decisions live in
    // opencode/notificationTriggers.ts.
    useNotifications(activeId);

    // REMOTE ACCESS (frp direct route): while the server connection is
    // configured AND remote-enabled, registers the local opencode
    // password with the server and supervises the frpc sidecar — mobile
    // clients then hit this machine's opencode directly through
    // /t/<routeId>/ on the server (see hooks/useServerFrp.ts +
    // src-tauri/src/frp.rs). No-op on mobile.
    useServerFrp();

    // The settings modal: the title-bar gear opens it, and the model
    // picker's "Configure models…" deep-links to its Model tab. App owns
    // open + tab so entry points can preselect the pane. A NULL tab is
    // the mobile root (the settings CATEGORY LIST — the second-level
    // page navigation); the desktop modal reads it as "general".
    const [settings, setSettings] = useState<{open: boolean; tab: SettingsTab | null}>({open: false, tab: null});
    const openSettings = useCallback((tab: SettingsTab | null = null) => {
        setSettings({open: true, tab});
    }, []);

    // The MOBILE chrome splits along the device/layout line (see
    // hooks/useLayoutMode.ts — tablet mode): `mobile` keeps the DEVICE
    // semantics that never change with the layout (the TitleBar ⋯
    // delete entry below — touch has no hover, SessionFolder's row X
    // stays off), while `phoneLayout` drives the LAYOUT branches — the
    // sidebar as a DRAWER (TitleBar hamburger, the only session
    // navigation on a phone) vs DOCKED, the stats resize seam, the
    // corner cutaways. In tablet mode (layout pinned/auto-resolved to
    // "desktop") the sidebar docks like the desktop's, the resize seam
    // mounts, and the stats panel's flex-sibling container-query tier
    // becomes reachable (a wide row) with no further gating here.
    const mobile = isMobileApp();
    const phoneLayout = usePhoneLayout();
    const [drawerOpen, setDrawerOpen] = useState(false);
    const closeDrawer = useCallback(() => setDrawerOpen(false), []);
    // SYSTEM BACK closes the drawer (phone layout): it is the top page
    // level while open — same as tapping the scrim.
    useBackLevel(phoneLayout && drawerOpen, closeDrawer);
    const closeSettings = useCallback(() => {
        setSettings((prev) => ({...prev, open: false}));
    }, []);
    const changeSettingsTab = useCallback((tab: SettingsTab | null) => {
        setSettings((prev) => (prev.tab === tab ? prev : {...prev, tab}));
    }, []);
    // Stable so the memoized ChatView/ChatInput subtree skips re-rendering.
    const openModelConfig = useCallback(() => openSettings("model"), [openSettings]);

    // The session-import picker (the sidebar's Import row): external
    // OpenCode sessions (TUI/CLI/other instances) joining the whitelist.
    // The modal consumes the session-data context itself; App owns only
    // the open flag, like the settings modal.
    const [importOpen, setImportOpen] = useState(false);
    const openImportPicker = useCallback(() => setImportOpen(true), []);
    const closeImportPicker = useCallback(() => setImportOpen(false), []);

    // The Plugins & MCP manager (the sidebar's bottom-left entry): same
    // ownership shape — the modal's useExtensions owns its data, App
    // owns only the open flag.
    const [extensionsOpen, setExtensionsOpen] = useState(false);
    const openExtensions = useCallback(() => setExtensionsOpen(true), []);
    const closeExtensions = useCallback(() => setExtensionsOpen(false), []);

    const sessionInfos = sessions.map((s) => ({
        id: s.id,
        name: s.title?.trim() || t["Untitled"],
        directory: s.directory ?? s.location?.directory,
        updatedAt: s.time?.updated,
    }));

    // Sidebar hover prefetch: warm a session's activity stats AND its
    // message store before it is opened, so a click lands on cached data
    // — the surface choreography then skips its loading phase entirely
    // and the entrance starts right after the exit.
    const hoverPrefetchSession = useCallback((id: string) => {
        if (!api) return;
        const directory = sessionInfos.find((s) => s.id === id)?.directory ?? null;
        prefetchSessionActivity(api, subscribe, id, directory);
        ensureSessionSeeded(api, id);
    }, [api, subscribe, sessionInfos]);

    const placeholderSubtitle = connectionStatus.state === "connecting"
        ? t["Connecting to OpenCode..."]
        : connectionStatus.state === "error"
            ? connectionStatus.message
            : null;

    return (
        <div
            className="relative w-full h-full overflow-hidden flex flex-row"
            style={{
                // The window's base. Opaque by default; under compositor
                // blur (GNOME + Blur my Shell) it goes translucent so the
                // extension's blur behind the window shows through — the
                // chrome surfaces above keep their own tints. Dark keeps
                // slightly more ink than light (readability over the
                // blurred desktop).
                background: compositorBlur
                    ? withAlpha(effectiveBg, isColorDark(effectiveBg) ? 0.9 : 0.88)
                    : effectiveBg,
                // App-wide hover-wash defaults (the .lum-wash class reads
                // them): one place instead of a per-site CSS var.
                "--lum-wash": colors.hoverOverlay,
                "--lum-wash-active": colors.activeOverlay,
                "--lum-wash-accent": colors.accentOverlay,
                // The runtime glass hairline, exposed for stylesheets that
                // can't reach the React context (the HeroUI tooltip
                // override in main.css).
                "--lum-glass-border": colors.glassBorder,
            } as React.CSSProperties}
        >
            {/* The sidebar: DOCKED (desktop + tablet mode) or the phone
             * layout's DRAWER (TitleBar hamburger, the only session
             * navigation on a phone). The props are identical — only the
             * three action callbacks wrap closeDrawer in the drawer — so
             * they are built once here. */}
            {(() => {
                const sidebar = (
                    <SessionBar
                        sessions={sessionInfos}
                        activeId={activeId}
                        onSelect={phoneLayout ? (id: string) => {
                            setActiveId(id);
                            closeDrawer();
                        } : setActiveId}
                        onClose={deleteSession}
                        onNew={phoneLayout ? () => {
                            newSession();
                            closeDrawer();
                        } : newSession}
                        onImport={phoneLayout ? () => {
                            openImportPicker();
                            closeDrawer();
                        } : openImportPicker}
                        onExtensions={phoneLayout ? () => {
                            openExtensions();
                            closeDrawer();
                        } : openExtensions}
                        importableCount={foreignSessions.length}
                        onSessionHover={hoverPrefetchSession}
                        backgroundColor={effectiveBg}
                        foregroundColor={effectiveFg}
                        collapsed={false}
                        brandTitle="Lumina Code"
                        busyIds={busyIds}
                        pendingCounts={pendingCounts}
                    />
                );
                if (!phoneLayout) return sidebar;
                return drawerOpen ? (
                    <div className="lum-m-drawer-scrim" onClick={closeDrawer}>
                        <div
                            className="lum-m-drawer"
                            onClick={(e) => e.stopPropagation()}
                            // The glass base: SessionBar's surface is TRANSLUCENT glass,
                            // which on desktop composites over the app's opaque base. In
                            // the drawer it would composite over the scrim (this div is
                            // the scrim's child) — glass over 40% black = a much darker
                            // sidebar than desktop. Painting the app base here restores
                            // the desktop composite: glass tint over effectiveBg.
                            style={{background: effectiveBg}}
                        >
                            {sidebar}
                        </div>
                    </div>
                ) : null;
            })()}
            <div className="flex-1 flex flex-col min-w-0">
                <TitleBar
                    theme={effectiveTheme}
                    title={activeSession ? activeSession.title?.trim() || t["Untitled"] : null}
                    branch={shownBranch}
                    onOpenSettings={() => openSettings()}
                    isMaximized={isMaximized}
                    onMenu={phoneLayout ? () => setDrawerOpen(true) : undefined}
                    // MOBILE delete entry: only while a session is open
                    // (TitleBar renders the ⋯ menu only when this is
                    // passed — desktop never does, its sidebar row X
                    // stays).
                    onDeleteSession={mobile && activeId ? () => deleteSession(activeId) : undefined}
                />
                <div className="flex-1 relative overflow-hidden">
                    {/* Chrome glass layer filling the content area. The
                        surface above is clipped to a rounded rectangle, so
                        its four corners are transparent and expose this
                        layer — making the chrome read as a continuous frame
                        wrapping the content. cef 分支注：这层露角与
                        MaskedSurface 的圆角裁剪都是页内 chrome（露出的是
                        本层，不是桌面），不透明窗口下照常工作，CEF 不归零
                        —— 曾经把二者当"透明窗口时代的设计"一并关闭，拼角
                        处的圆滑倒角随之消失。CEF 真正不能自绘的只有窗口
                        级的 windowOutline（WM 原生圆角半径对不上）。 */}
                    <div
                        aria-hidden
                        className="absolute inset-0"
                        style={{...chromeGlass, zIndex: 0}}
                    />
                    <MaskedSurface
                        className="absolute inset-0"
                        style={{zIndex: 1}}
                        // Phone layout: square corners — the rounded
                        // cutaways (the desktop 拼接倒角 seam aesthetic)
                        // read as window chrome and have no place on a
                        // fullscreen phone. Tablet mode keeps them: they
                        // are IN-PAGE chrome (they expose the glass layer
                        // below, never the desktop) and read as the
                        // desktop layout's aesthetic, not window chrome.
                        radius={phoneLayout ? 0 : undefined}
                    >
                        {/* The conversation canvas — its own opaque bg in
                            light mode, distinct from the chrome glass frame
                            around it. Dark mode stays transparent so the
                            glass shows through. `relative` anchors the
                            stats card layer below. */}
                        <div
                            className="relative w-full h-full"
                            style={contentBg ? {background: contentBg} : undefined}
                        >
                            {/* The flex ROW — conversation and workspace
                                stats panel as REAL siblings. `.lum-row` is
                                the CSS size container the column tiers and
                                the stats panel's flow/float query against
                                (main.css) — the browser measures, no JS.
                                The panel is OUTSIDE the surface swap below
                                and keyed by directory; no exit animation on
                                the panel layer itself — the surface swap
                                covers the transition. */}
                            <div className="lum-row relative flex h-full w-full">
                                {/* Session ↔ welcome-screen swap THROUGH
                                    SessionSurface: SEQUENTIAL phases —
                                    exit plays out, a loading loop covers
                                    the successor's fetch, and the
                                    entrance starts only once the
                                    successor's first frame is
                                    renderable (see SessionSurface). */}
                                <SessionSurface
                                    targetKey={activeSession ? `session-${activeSession.id}` : "welcome"}
                                    render={(key) =>
                                        key === "welcome" ? (
                                            <WelcomeScreen
                                                foregroundColor={effectiveFg}
                                                subtitle={placeholderSubtitle ?? undefined}
                                                disabled={!connected}
                                                onSend={(text, files, fileRefs, command) => void sendFirst(text, files, fileRefs, command)}
                                                agent={effectiveAgent}
                                                model={effectiveModel}
                                                onAgentChange={changeAgent}
                                                onModelChange={changeModel}
                                                directory={pendingDirectory}
                                                onDirectoryChange={changeDirectory}
                                                stagedBranch={pendingBranch}
                                                onStagedBranchChange={changeStagedBranch}
                                                onOpenModelConfig={openModelConfig}
                                            />
                                        ) : (
                                            <ChatView
                                                sessionId={activeSession?.id ?? ""}
                                                busy={busy}
                                                disabled={!connected}
                                                agent={effectiveAgent}
                                                model={effectiveModel}
                                                onAgentChange={changeAgent}
                                                onModelChange={changeModel}
                                                directory={activeDirectory}
                                                onDirectoryChange={changeDirectory}
                                                stagedBranch={pendingBranch}
                                                onStagedBranchChange={(branch) => {
                                                    // A branch pick on an EXISTING (empty) session
                                                    // cannot rehome it — the session's directory
                                                    // is immutable server-side — so it takes the
                                                    // changeDirectory route: drop the empty
                                                    // session (nothing to lose before the first
                                                    // message), stage the branch, back to the
                                                    // welcome screen where sendFirst honors it.
                                                    if (branch !== null && activeId) {
                                                        changeDirectory(activeDirectory);
                                                    }
                                                    changeStagedBranch(branch);
                                                }}
                                                onOpenModelConfig={openModelConfig}
                                                usage={activeUsage}
                                            />
                                        )
                                    }
                                />
                                {/* Workspace stats panel — shows the DIRECTORY's
                                    working-copy diff plus the ACTIVE session's
                                    terminals/subagents. Keyed by directory so
                                    same-directory session switches keep it
                                    mounted (content swaps in place, instantly
                                    on wholesale swaps — ExitList enter); a
                                    cross-directory switch goes through
                                    StatsCardSwap: the previous card fades out
                                    (frozen snapshot) while the successor
                                    mounts. Never rendered on the welcome
                                    screen. On the MOBILE app the panel mounts
                                    too — on the phone layout it is always an
                                    overlay over the conversation (mobile.css
                                    widens the expanded panel to span the row;
                                    a phone row can never reach the wide-row
                                    flex-sibling tier), while tablet mode
                                    (hooks/useLayoutMode.ts) lets the
                                    container-query tiers decide exactly like
                                    a desktop window. */}
                                <StatsCardSwap
                                    swapKey={activeSession ? (activeDirectory ?? "") : null}
                                    render={(dir) => (
                                        <WorkspaceStatsCard
                                            key={dir}
                                            sessionId={activeSession!.id}
                                            directory={activeDirectory}
                                            busyIds={busyIds}
                                            agent={effectiveAgent}
                                        />
                                    )}
                                />
                            </div>
                        </div>
                    </MaskedSurface>
                </div>
            </div>
            {/* The drag seam between the sidebar and the conversation
                area: an invisible overlay sash over the boundary — drag
                to resize (persisted), double-click to reset. Rendered
                AFTER the content column so its absolute box (main.css)
                paints above it; hidden with the sidebar when collapsed.
                Off the PHONE layout only — tablet mode docks the
                sidebar and the seam (pointer-capture drag) works on
                touch. */}
            {!phoneLayout && <SidebarResizer collapsed={false}/>}
            {/* The settings modal (title-bar gear; the model picker
                deep-links to its Model tab). */}
            <SettingsModal
                open={settings.open}
                tab={settings.tab}
                onTabChange={changeSettingsTab}
                onClose={closeSettings}
                api={api}
            />
            {/* The session-import picker (the sidebar's Import row). */}
            <ImportSessionsModal
                open={importOpen}
                onClose={closeImportPicker}
            />
            {/* The Plugins & MCP manager (the sidebar's bottom-left
             * entry) — every loaded plugin and MCP server with
             * enable/disable toggles (hot-reloaded config rewrites). */}
            <ExtensionsModal
                open={extensionsOpen}
                onClose={closeExtensions}
            />
            {/* Linux window outline: some desktop environments draw no
                compositor shadow, so the borderless window's edge is
                invisible against a matching wallpaper. An inset box-shadow
                overlay (not border/outline) — no layout shift, follows the
                rounded corners, and paints above the content which would
                otherwise cover a container-edge line. Hidden when maximized
                like the rounded frame above; toggleable in General settings.
                Not drawn under the CEF shell either — its window is opaque
                with the WM's native corners (see the cef note above). */}
            {isLinux() && !isCefRuntime() && !isMaximized && outlineEnabled && (
                <div
                    aria-hidden
                    className="lum-enter absolute inset-0 rounded-[var(--radius-lg)] pointer-events-none"
                    style={{
                        boxShadow: `inset 0 0 0 1px ${windowOutline(effectiveBg)}`,
                        zIndex: 9999,
                    }}
                />
            )}
            {/* The boot gate (see components/BootScreen.tsx): a full-screen
                overlay covering the whole chrome until the app is genuinely
                usable — connection + session list + model catalog + the
                restored session's seed all landed. Mobile shows it from the
                first frame (the remote route's latency is the norm there);
                desktop only intervenes past a grace period, so the local
                fast path never sees it. Renders null permanently once
                revealed. */}
            <BootScreen activeId={activeId} bg={effectiveBg} fg={effectiveFg}/>
        </div>
    );
}

function App() {
    const isMaximized = useMaximized();
    const paddingOffset = usePaddingOffset(isMaximized);
    useDragRegionDoubleClick();

    return (
        <div
            className="w-screen h-screen overflow-hidden relative"
            style={{
                padding: paddingOffset,
                background: "transparent",
            }}
        >
            {/* The rounded window frame is DESKTOP chrome — the mobile app
             * IS the screen (fullscreen activity), where the rounding cuts
             * the title bar's top corners open against the transparent
             * html behind. Mobile stays square. */}
            <div className={`w-full h-full overflow-hidden ${isMaximized || isMobileApp() ? "" : "rounded-[var(--radius-lg)]"}`}>
                <InnerApp isMaximized={isMaximized}/>
            </div>
        </div>
    );
}

export default App;
