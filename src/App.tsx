import {useCallback, useEffect, useState} from "react";
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
import {ColorsProvider} from "./hooks/colors.tsx";
import {useWindowOutline} from "./hooks/useWindowOutline.ts";
import {glassSurface, windowOutline} from "./lib/glass.ts";
import {isLinux} from "./lib/platform.ts";
import {appThemeFor} from "./lib/theme.ts";
import {useOpencode} from "./opencode/useOpencode.ts";
import {useSessionFlow} from "./opencode/useSessionFlow.ts";
import {useSessionRequests} from "./opencode/useSessionRequests.ts";
import {useModelCatalog} from "./opencode/useModelCatalog.ts";
import {prefetchSessionActivity} from "./opencode/useSessionActivity.ts";
import type {SessionUsage} from "./opencode/types.ts";

/**
 * Layout shell, ported from lumina-terminal's App.tsx: outer transparent
 * window frame with rounded corners, then SessionBar (left glass sidebar) +
 * TitleBar over a MaskedSurface content area that exposes the chrome glass
 * layer through its rounded corners. The content swaps between the active
 * session's conversation (ChatView) and the welcome screen; the entering
 * surface rises in via .lum-enter (the old one unmounts immediately, so
 * the two opaque surfaces never overlap).
 *
 * All OpenCode wiring lives in hooks: the connection (useOpencode), the
 * session flow (useSessionFlow), pending requests (useSessionRequests) and
 * the model catalog (useModelCatalog).
 *
 * The conversation row (`.lum-row`) is a CSS size CONTAINER: the
 * conversation column's width tiers and the stats panel's flow-vs-float
 * are container queries in main.css — the browser measures, nothing in
 * JS does. The chrome palette is derived ONCE and provided through
 * ColorsProvider (hooks/colors.tsx) plus the --lum-wash CSS vars seeded
 * on the root.
 */

function InnerApp({isMaximized}: {isMaximized: boolean}) {
    const t = useI18n();
    // Effective theme: lumina-terminal derives this from the active
    // terminal's palette; lumina-code follows the system light/dark with
    // the same neutral bases (see lib/theme.ts). The settings modal's
    // appearance preference can pin light/dark; "system" keeps the live
    // OS setting.
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
    // see the outline overlay near the end of this component.
    const outlineEnabled = useWindowOutline();

    // --- OpenCode connection, session list, active conversation ---
    const {status: connectionStatus, api, subscribe} = useOpencode();
    const {
        permissions: pendingAllPermissions,
        forms: pendingAllForms,
        pendingCounts,
        replyPermission,
        replyForm,
        cancelForm,
    } = useSessionRequests(api, subscribe);
    const {models, agents, defaultModel, catalogOnly} = useModelCatalog(api, subscribe);
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
    } = useSessionFlow(api, subscribe, {models, agents, defaultModel});
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

    // Sidebar hover prefetch: warm a session's activity stats before it
    // is opened, so even a first switch-in this app run paints the stats
    // card from cache as part of the surface's initial layout (sessions
    // already opened stay warm through the module-level activity store).
    const hoverPrefetchSession = useCallback((id: string) => {
        if (!api) return;
        const directory = sessionInfos.find((s) => s.id === id)?.directory ?? null;
        prefetchSessionActivity(api, subscribe, id, directory);
    }, [api, subscribe, sessionInfos]);

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

    const placeholderSubtitle = connectionStatus.state === "connecting"
        ? t["Connecting to OpenCode..."]
        : connectionStatus.state === "error"
            ? connectionStatus.message
            : null;

    // The chrome glass layer is derived per connection state (supportsGlass
    // flips only on platform), so computing it inline is fine — but keep it
    // after the hooks for readability.
    const chromeGlass = glassSurface(effectiveBg, supportsGlass, {blurPx: 16});

    return (
        <ColorsProvider colors={colors}>
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
                                The panel is OUTSIDE the session swap below
                                and keyed by directory; no exit animation on
                                the panel layer itself — the surface swap
                                covers the transition. */}
                            <div className="lum-row relative flex h-full w-full">
                                {/* Session ↔ welcome-screen swap: the entering
                                    surface rises in via .lum-enter; the old
                                    one unmounts immediately, so the two
                                    opaque surfaces never overlap. */}
                                {activeSession ? (
                                    <div
                                        key={`session-${activeSession.id}`}
                                        className="lum-enter h-full min-w-0 flex-1"
                                    >
                                        <ChatView
                                            api={api}
                                            subscribe={subscribe}
                                            sessionId={activeSession.id}
                                            busy={busy}
                                            disabled={!connected}
                                            agents={agents}
                                            models={models}
                                            catalogOnly={catalogOnly}
                                            agent={effectiveAgent}
                                            model={effectiveModel}
                                            onAgentChange={changeAgent}
                                            onModelChange={changeModel}
                                            directory={activeDirectory}
                                            onDirectoryChange={changeDirectory}
                                            onOpenModelConfig={openModelConfig}
                                            usage={activeUsage}
                                            pendingPermissions={pendingAllPermissions.filter((p) => p.sessionID === activeSession.id)}
                                            pendingForms={pendingAllForms.filter((f) => f.sessionID === activeSession.id)}
                                            onPermissionDecision={(request, decision) => void replyPermission(request, decision)}
                                            onFormReply={(form, answer) => void replyForm(form, answer)}
                                            onFormCancel={(form) => void cancelForm(form)}
                                        />
                                    </div>
                                ) : (
                                    <WelcomeScreen
                                        key="welcome"
                                        foregroundColor={effectiveFg}
                                        subtitle={placeholderSubtitle ?? undefined}
                                        disabled={!connected}
                                        onSend={(text, files, fileRefs, command) => void sendFirst(text, files, fileRefs, command)}
                                        agents={agents}
                                        models={models}
                                        catalogOnly={catalogOnly}
                                        agent={effectiveAgent}
                                        model={effectiveModel}
                                        onAgentChange={changeAgent}
                                        onModelChange={changeModel}
                                        api={api}
                                        directory={pendingDirectory}
                                        onDirectoryChange={changeDirectory}
                                        onOpenModelConfig={openModelConfig}
                                    />
                                )}
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
                                        api={api}
                                        subscribe={subscribe}
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
        </ColorsProvider>
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
