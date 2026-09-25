import {useCallback, useEffect, useRef, useState} from "react";
import type {ReactNode} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {error} from "@tauri-apps/plugin-log";
import TitleBar from "./components/TitleBar.tsx";
import SessionBar from "./components/SessionBar.tsx";
import WelcomeScreen from "./components/WelcomeScreen.tsx";
import ChatView from "./components/chat/ChatView.tsx";
import WorkspaceStatsCard from "./components/stats/WorkspaceStatsCard.tsx";
import SettingsModal, {type SettingsTab} from "./components/settings/SettingsModal.tsx";
import MaskedSurface from "./components/ui/MaskedSurface.tsx";
import {useMaximized} from "./hooks/maximized.ts";
import {usePaddingOffset} from "./hooks/paddingOffset.ts";
import {useDragRegionDoubleClick} from "./hooks/useDragRegionDoubleClick.ts";
import {useGlass} from "./hooks/useGlass.ts";
import {useI18n} from "./hooks/i18n.tsx";
import {useSystemTheme} from "./hooks/useSystemTheme.ts";
import {useThemePreference} from "./hooks/useThemePreference.ts";
import {useSurfaceColors} from "./hooks/surfaceColors.ts";
import {ColorsProvider, useColors} from "./hooks/colors.tsx";
import {useWindowOutline} from "./hooks/useWindowOutline.ts";
import {glassSurface, windowOutline} from "./lib/glass.ts";
import {isLinux} from "./lib/platform.ts";
import {appThemeFor, type ChromeTheme} from "./lib/theme.ts";
import {liveSurfaceKey, nextSurfacePhase, type SurfacePhase} from "./lib/surfacePhases.ts";
import {matchesAnimationEvent} from "./lib/exitGate.ts";
import {useOpencode} from "./opencode/useOpencode.ts";
import {useSessionFlow} from "./opencode/useSessionFlow.ts";
import {useLuminaToolsInstall} from "./opencode/useLuminaTools.ts";
import {CatalogProvider} from "./opencode/catalogContext.tsx";
import {ConnectionProvider, useConnection} from "./opencode/connectionContext.tsx";
import {SessionDataProvider, useSessionData} from "./opencode/sessionDataContext.tsx";
import {ensureSessionSeeded, useSessionSeeded} from "./opencode/useSessionMessages.ts";
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

/** The exit key the loading/entrance phases hand off through. */
const SURFACE_EXIT_ANIMATION = "lum-surface-exit";
/** Fallback for a canceled exit animation (display:none, tab hidden) —
 *  matches the CSS duration of .lum-surface-exit plus slack. */
const SURFACE_EXIT_MS = 400;

/**
 * The session ↔ welcome surface choreography — SEQUENTIAL, replacing the
 * old crossfading SurfaceSwap. A switch plays in strict phases:
 *
 *   1. retarget: the leaving surface starts its exit IMMEDIATELY (the
 *      fetch for the successor starts in the same tick, in parallel);
 *   2. the exit plays to completion — the leaving surface is alone on
 *      stage, so it may travel (rise out) where the old crossfade had
 *      to stay opacity-only (two glass surfaces translating against
 *      each other smeared);
 *   3. once the exit ends: a ready successor enters right away; an
 *      unready one shows the looping loading dots until its seed
 *      lands, then enters.
 *
 * "Ready" = the successor's newest message page has landed in the store
 * (useSessionSeeded), so the entering surface's FIRST FRAME already
 * carries its content — the entrance animation starts exactly when
 * there is something to reveal, which is what makes it cover the load
 * whatever the latency (a fixed-duration animation played at click time
 * always finished before the data arrived; the content then popped in
 * bare — the bug this choreography exists to fix).
 *
 * The phase logic lives in lib/surfacePhases.ts (pure, tested); this
 * component only feeds it events: render-time retarget edges (React's
 * derived-state pattern — the re-render lands before commit, so the
 * flipped commit already paints the exit layer), the exit layer's
 * animationend (name+target matched via exitGate, with a timer
 * fallback for canceled animations), and readiness flips. The exit
 * layer renders a frozen ReactNode snapshot captured AT retarget time
 * — the element keeps the props it was built with, so the leaving
 * session's view renders untouched for the exit's duration — and it is
 * absolutely positioned (out of flow): the successor only mounts in
 * phase 3, so nothing ever overlaps.
 */
function SessionSurface({targetKey, render}: {targetKey: string; render: (key: string) => ReactNode}) {
    const t = useI18n();
    const {api} = useConnection();
    // Readiness of the TARGET surface: welcome (null session) is always
    // ready; a session is ready once its newest page has seeded.
    const targetSessionId = targetKey === "welcome" ? null : targetKey.replace(/^session-/, "");
    const targetReady = useSessionSeeded(targetSessionId);
    const readyRef = useRef(targetReady);
    readyRef.current = targetReady;

    const [phase, setPhase] = useState<SurfacePhase>(() => ({kind: "shown", key: targetKey}));
    // The exit layer's frozen snapshot (captured during the retarget
    // render, before prevNode is cleared for the successor).
    const [held, setHeld] = useState<{key: string; node: ReactNode} | null>(null);
    const prevKeyRef = useRef(targetKey);
    const prevNodeRef = useRef<ReactNode>(null);
    const timerRef = useRef(0);

    if (prevKeyRef.current !== targetKey) {
        const prevKey = prevKeyRef.current;
        const prevNode = prevNodeRef.current;
        prevKeyRef.current = targetKey;
        prevNodeRef.current = null;
        if (prevKey !== targetKey) {
            // Only a shown→exiting transition mounts a new exit layer
            // (mid-exit re-aims keep the current one playing).
            const next = nextSurfacePhase(phase, {type: "retarget", key: targetKey, ready: targetReady});
            setPhase(next);
            if (phase.kind === "shown" && next.kind === "exiting" && prevNode !== null) {
                setHeld({key: prevKey, node: prevNode});
            }
        }
    }

    // Warm the target's store at switch time (in parallel with the
    // exit). For an already-seeded session this is a no-op; for the
    // welcome surface there is nothing to warm.
    useEffect(() => {
        if (api && targetSessionId !== null) ensureSessionSeeded(api, targetSessionId);
    }, [api, targetSessionId]);

    // A readiness flip ends the waiting phase (idempotent otherwise).
    useEffect(() => {
        if (targetReady) setPhase((p) => nextSurfacePhase(p, {type: "becameReady"}));
    }, [targetReady]);

    // End-of-exit: the animationend event when it fires on the exit
    // host itself (bubbled child events never match), with a fallback
    // timer — canceled animations (hidden window, display:none) never
    // send events, and the phase machine treats duplicates as no-ops.
    // Armed per exit-layer mount; a mid-exit re-aim keeps the same
    // layer (and timer) running.
    const exitEnded = useCallback(() => {
        setPhase((p) => nextSurfacePhase(p, {type: "exitEnded", ready: readyRef.current}));
        setHeld(null);
    }, []);
    const exiting = phase.kind === "exiting" && held !== null;
    useEffect(() => {
        if (!exiting) return;
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(exitEnded, SURFACE_EXIT_MS);
        return () => window.clearTimeout(timerRef.current);
    }, [exiting, exitEnded]);
    useEffect(() => () => window.clearTimeout(timerRef.current), []);

    const liveKey = liveSurfaceKey(phase);
    const node = liveKey !== null ? render(liveKey) : null;
    if (liveKey !== null) prevNodeRef.current = node;

    return (
        <>
            {/* The live slot keeps its flex geometry through every phase
                so the stats panel beside it never shifts; BOTH the frozen
                exit layer and the entering content are absolutely
                positioned INSIDE it — the exit layer must never span the
                whole row (.lum-row), or the frozen view would re-layout
                at full width and its centered column would visibly jump
                under the stats panel the frame the exit starts. During
                the exit phase the slot renders ONLY the frozen layer —
                the leaving surface is alone on stage (the dots cover
                just the waiting phase, after the exit completes). */}
            <div className="relative h-full min-w-0 flex-1">
                {exiting && (
                    <div
                        key={`exit-${held.key}`}
                        aria-hidden
                        className={`absolute inset-0 overflow-hidden ${SURFACE_EXIT_ANIMATION} pointer-events-none`}
                        onAnimationEnd={(e) => {
                            if (matchesAnimationEvent(e, {animation: SURFACE_EXIT_ANIMATION})) {
                                window.clearTimeout(timerRef.current);
                                exitEnded();
                            }
                        }}
                    >
                        {held.node}
                    </div>
                )}
                {liveKey !== null ? (
                    <div key={liveKey} className="absolute inset-0 lum-enter">
                        {node}
                    </div>
                ) : phase.kind === "waiting" ? (
                    <div
                        key="loading"
                        role="status"
                        aria-label={t["Loading conversation…"]}
                        className="lum-loading absolute inset-0"
                    >
                        <span/>
                        <span/>
                        <span/>
                    </div>
                ) : null}
            </div>
        </>
    );
}

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

    // The Linux window outline is a user preference (General settings);
    // see the outline overlay in AppBody.
    const outlineEnabled = useWindowOutline();

    // --- OpenCode connection (the context split's base layer) ---
    const {status: connectionStatus, api, subscribe} = useOpencode();

    // The window is created hidden (tauri.conf.json `visible: false`) and
    // shown once the first paint is ready — same pattern as lumina-terminal.
    useEffect(() => {
        const win = getCurrentWindow();
        win.show().then(() => {
            win.setFocus().catch(() => {});
        }).catch((e) => {
            error(`Failed to show window: ${e}`).catch(() => {});
        });
    }, []);

    // Sync the HeroUI light/dark class on <html> with the resolved theme so
    // framework controls (tooltips, …) match the chrome.
    useEffect(() => {
        const root = document.documentElement;
        root.classList.toggle("dark", dark);
        root.classList.toggle("light", !dark);
        root.setAttribute("data-theme", dark ? "dark" : "light");
    }, [dark]);

    // The chrome glass layer is derived per connection state (supportsGlass
    // flips only on platform), so computing it inline is fine.
    const chromeGlass = glassSurface(effectiveBg, supportsGlass, {blurPx: 16});

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
}: {
    isMaximized: boolean;
    effectiveTheme: ChromeTheme;
    effectiveBg: string;
    effectiveFg: string;
    contentBg: string | null;
    chromeGlass: React.CSSProperties;
    outlineEnabled: boolean;
}) {
    const t = useI18n();
    const colors = useColors();
    const {api, subscribe, status: connectionStatus} = useConnection();
    const {pendingCounts} = useSessionData();
    const {
        sessions,
        busyIds,
        activeId,
        setActiveId,
        activeSession,
        effectiveModel,
        effectiveAgent,
        pendingDirectory,
        changeModel,
        changeAgent,
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

    // The settings modal: the title-bar gear opens it, and the model
    // picker's "Configure models…" deep-links to its Model tab. App owns
    // open + tab so entry points can preselect the pane.
    const [settings, setSettings] = useState<{open: boolean; tab: SettingsTab}>({open: false, tab: "general"});
    const openSettings = useCallback((tab: SettingsTab = "general") => {
        setSettings({open: true, tab});
    }, []);
    const closeSettings = useCallback(() => {
        setSettings((prev) => ({...prev, open: false}));
    }, []);
    const changeSettingsTab = useCallback((tab: SettingsTab) => {
        setSettings((prev) => (prev.tab === tab ? prev : {...prev, tab}));
    }, []);
    // Stable so the memoized ChatView/ChatInput subtree skips re-rendering.
    const openModelConfig = useCallback(() => openSettings("model"), [openSettings]);

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
                background: effectiveBg,
                // App-wide hover-wash defaults (the .lum-wash class reads
                // them): one place instead of a per-site CSS var.
                "--lum-wash": colors.hoverOverlay,
                "--lum-wash-active": colors.activeOverlay,
                "--lum-wash-accent": colors.accentOverlay,
            } as React.CSSProperties}
        >
            <SessionBar
                sessions={sessionInfos}
                activeId={activeId}
                onSelect={setActiveId}
                onClose={deleteSession}
                onNew={newSession}
                onSessionHover={hoverPrefetchSession}
                backgroundColor={effectiveBg}
                foregroundColor={effectiveFg}
                collapsed={false}
                brandTitle="Lumina Code"
                busyIds={busyIds}
                pendingCounts={pendingCounts}
            />
            <div className="flex-1 flex flex-col min-w-0">
                <TitleBar
                    theme={effectiveTheme}
                    title={activeSession ? activeSession.title?.trim() || t["Untitled"] : null}
                    onOpenSettings={() => openSettings()}
                    isMaximized={isMaximized}
                />
                <div className="flex-1 relative overflow-hidden">
                    {/* Chrome glass layer filling the content area. The
                        surface above is clipped to a rounded rectangle, so
                        its four corners are transparent and expose this
                        layer — making the chrome read as a continuous frame
                        wrapping the content. */}
                    <div
                        aria-hidden
                        className="absolute inset-0"
                        style={{...chromeGlass, zIndex: 0}}
                    />
                    <MaskedSurface className="absolute inset-0" style={{zIndex: 1}}>
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
                                    mounted (content swaps in place), while a
                                    cross-directory switch remounts it with the
                                    surface swap covering the transition. Never
                                    rendered on the welcome screen. */}
                                {activeSession && (
                                    <WorkspaceStatsCard
                                        key={activeDirectory ?? ""}
                                        sessionId={activeSession.id}
                                        directory={activeDirectory}
                                        busyIds={busyIds}
                                    />
                                )}
                            </div>
                        </div>
                    </MaskedSurface>
                </div>
            </div>
            {/* The settings modal (title-bar gear; the model picker
                deep-links to its Model tab). */}
            <SettingsModal
                open={settings.open}
                tab={settings.tab}
                onTabChange={changeSettingsTab}
                onClose={closeSettings}
                api={api}
                serverVersion={connected ? connectionStatus.version : null}
            />
            {/* Linux window outline: some desktop environments draw no
                compositor shadow, so the borderless window's edge is
                invisible against a matching wallpaper. An inset box-shadow
                overlay (not border/outline) — no layout shift, follows the
                rounded corners, and paints above the content which would
                otherwise cover a container-edge line. Hidden when maximized
                like the rounded-lg above; toggleable in General settings. */}
            {isLinux() && !isMaximized && outlineEnabled && (
                <div
                    aria-hidden
                    className="lum-enter absolute inset-0 rounded-lg pointer-events-none"
                    style={{
                        boxShadow: `inset 0 0 0 1px ${windowOutline(effectiveBg)}`,
                        zIndex: 9999,
                    }}
                />
            )}
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
            <div className={`w-full h-full overflow-hidden ${isMaximized ? "" : "rounded-lg"}`}>
                <InnerApp isMaximized={isMaximized}/>
            </div>
        </div>
    );
}

export default App;
