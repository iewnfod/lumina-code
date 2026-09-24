import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import {AnimatePresence, motion} from "framer-motion";
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
import {useWindowOutline} from "./hooks/useWindowOutline.ts";
import {glassSurface, windowOutline} from "./lib/glass.ts";
import {fadeIn, springSwap} from "./lib/motion.ts";
import {chatColumnCapRem, chatColumnSidePadRem} from "./components/chat/chatColumn.ts";
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
 * session's conversation (ChatView) and the welcome screen, spring-animated
 * via AnimatePresence.
 *
 * All OpenCode wiring lives in hooks: the connection (useOpencode), the
 * session flow (useSessionFlow), pending requests (useSessionRequests) and
 * the model catalog (useModelCatalog).
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
    // The modal's surface derives from the same chrome bg as everything else.
    const settingsColors = useSurfaceColors(effectiveBg);

    // --- Conversation surface geometry (App-owned) -----------------------------------
    // App measures the conversation SURFACE — the flex row beside the
    // sidebar — once (pre-paint, layout effect) and on every resize
    // (window, sidebar toggle, maximize: anything that moves it). That
    // ONE measurement feeds everything geometric downstream:
    // - the stats panel's flow-vs-float decision (statsLayout.ts — the
    //   panel is a real flex sibling in the row, so "docked" needs no
    //   lane, no reporting, no timing: flex pushes the conversation
    //   left and re-centers it as the panel grows/shrinks), and
    // - the conversation column's responsive cap + gutters
    //   (chatColumn.ts), derived here and passed down as a style prop.
    // A SESSION SWITCH never re-measures: the row is
    // session-independent; the remounting ChatView/WelcomeScreen and
    // the directory-keyed card all plan against the same live numbers
    // in their first commit.
    const surfaceRef = useRef<HTMLDivElement>(null);
    const [surfaceSize, setSurfaceSize] = useState({w: 0, h: 0});
    useLayoutEffect(() => {
        const el = surfaceRef.current;
        if (!el) return;
        const measure = () => setSurfaceSize((prev) =>
            prev.w === el.offsetWidth && prev.h === el.offsetHeight ? prev : {w: el.offsetWidth, h: el.offsetHeight},
        );
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    // The conversation column's tier (cap + gutters), derived from the
    // surface width — stable while the stats panel expands beside the
    // column, because the ROW's width doesn't change; only the flex-1
    // conversation narrows within it. Shared by ChatView and the
    // welcome screen so the composer stays put across their swap.
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const columnStyle = useMemo(() => {
        const capRem = chatColumnCapRem(surfaceSize.w, remPx);
        const padRem = chatColumnSidePadRem(surfaceSize.w, remPx);
        return {maxWidth: `${capRem}rem`, paddingLeft: `${padRem}rem`, paddingRight: `${padRem}rem`};
    }, [surfaceSize.w, remPx]);

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
        <div
            className="relative w-full h-full overflow-hidden flex flex-row"
            style={{background: effectiveBg}}
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
                            ref={surfaceRef}
                            className="relative w-full h-full"
                            style={contentBg ? {background: contentBg} : undefined}
                        >
                            {/* The flex ROW — conversation and workspace
                                stats panel as REAL siblings, no lane
                                bookkeeping: the conversation is flex-1
                                (min-w-0 so long content can't force the
                                row wide) and the panel either floats
                                (absolute, out of flow) or sits in flow
                                at its planned width, where flex pushes
                                the conversation left and re-centers it
                                as the panel grows or shrinks. The panel
                                is OUTSIDE the session swap below and
                                keyed by directory; no exit animation on
                                the panel layer itself — an exiting
                                in-flow panel would double-reserve row
                                space during the swap, and the surface
                                swap already covers the visual
                                transition. */}
                            <div className="relative flex h-full w-full">
                                {/* Session ↔ welcome-screen swap, spring-animated
                                    via AnimatePresence (mode="wait": the old
                                    surface exits before the new one enters, so
                                    the two opaque surfaces never overlap). */}
                                <AnimatePresence mode="wait" initial={false}>
                                    {activeSession ? (
                                        <motion.div
                                            key={`session-${activeSession.id}`}
                                            variants={springSwap}
                                            initial="hidden"
                                            animate="show"
                                            exit="exit"
                                            className="h-full min-w-0 flex-1"
                                        >
                                            <ChatView
                                                api={api}
                                                subscribe={subscribe}
                                                sessionId={activeSession.id}
                                                backgroundColor={effectiveBg}
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
                                                columnStyle={columnStyle}
                                                pendingPermissions={pendingAllPermissions.filter((p) => p.sessionID === activeSession.id)}
                                                pendingForms={pendingAllForms.filter((f) => f.sessionID === activeSession.id)}
                                                onPermissionDecision={(request, decision) => void replyPermission(request, decision)}
                                                onFormReply={(form, answer) => void replyForm(form, answer)}
                                                onFormCancel={(form) => void cancelForm(form)}
                                            />
                                        </motion.div>
                                    ) : (
                                        <WelcomeScreen
                                            key="welcome"
                                            backgroundColor={effectiveBg}
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
                                            columnStyle={columnStyle}
                                        />
                                    )}
                                </AnimatePresence>
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
                                        backgroundColor={effectiveBg}
                                        directory={activeDirectory}
                                        busyIds={busyIds}
                                        surfaceSize={surfaceSize}
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
                colors={settingsColors}
                serverVersion={connected ? connectionStatus.version : null}
            />
            {/* Linux window outline: some desktop environments draw no
                compositor shadow, so the borderless window's edge is
                invisible against a matching wallpaper. An inset box-shadow
                overlay (not border/outline) — no layout shift, follows the
                rounded corners, and paints above the content which would
                otherwise cover a container-edge line. Hidden when maximized
                like the rounded-lg above; toggleable in General settings. */}
            <AnimatePresence>
                {isLinux() && !isMaximized && outlineEnabled && (
                    <motion.div
                        aria-hidden
                        variants={fadeIn}
                        initial="hidden"
                        animate="show"
                        exit="exit"
                        className="absolute inset-0 rounded-lg pointer-events-none"
                        style={{
                            boxShadow: `inset 0 0 0 1px ${windowOutline(effectiveBg)}`,
                            zIndex: 9999,
                        }}
                    />
                )}
            </AnimatePresence>
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
