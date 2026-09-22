import {useEffect} from "react";
import {AnimatePresence, motion} from "framer-motion";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {error} from "@tauri-apps/plugin-log";
import TitleBar from "./components/TitleBar.tsx";
import SessionBar from "./components/SessionBar.tsx";
import WelcomeScreen from "./components/WelcomeScreen.tsx";
import ChatView from "./components/chat/ChatView.tsx";
import MaskedSurface from "./components/ui/MaskedSurface.tsx";
import {useMaximized} from "./hooks/maximized.ts";
import {usePaddingOffset} from "./hooks/paddingOffset.ts";
import {useDragRegionDoubleClick} from "./hooks/useDragRegionDoubleClick.ts";
import {useGlass} from "./hooks/useGlass.ts";
import {useI18n} from "./hooks/i18n.tsx";
import {useSystemTheme} from "./hooks/useSystemTheme.ts";
import {glassSurface, windowOutline} from "./lib/glass.ts";
import {fadeIn, springSwap} from "./lib/motion.ts";
import {isLinux} from "./lib/platform.ts";
import {appThemeFor} from "./lib/theme.ts";
import {useOpencode} from "./opencode/useOpencode.ts";
import {useSessionFlow} from "./opencode/useSessionFlow.ts";
import {useSessionRequests} from "./opencode/useSessionRequests.ts";
import {useModelCatalog} from "./opencode/useModelCatalog.ts";
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
    // terminal's palette; lumina-code follows the system light/dark with the
    // same neutral bases (see lib/theme.ts).
    const systemTheme = useSystemTheme();
    const {theme: effectiveTheme, bg: effectiveBg, fg: effectiveFg, dark, contentBg} = appThemeFor(systemTheme);

    // Glass material filling the content area. The chat surface is clipped to
    // a rounded rectangle; its four corners are transparent, exposing this
    // chrome layer beneath — so the chrome reads as a continuous frame
    // wrapping the content with rounded inner corners.
    const {supportsGlass} = useGlass();

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
    const {models, agents, defaultModel} = useModelCatalog(api);
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
    // Cumulative usage of the open session (seeded from the session list,
    // live-patched by session.usage.updated) — feeds the composer's ring.
    const activeUsage: SessionUsage | null = activeSession
        ? {tokens: activeSession.tokens, cost: activeSession.cost}
        : null;
    const connected = connectionStatus.state === "connected";

    const sessionInfos = sessions.map((s) => ({
        id: s.id,
        name: s.title?.trim() || t["Untitled"],
        directory: s.directory ?? s.location?.directory,
        updatedAt: s.time?.updated,
    }));

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
        ? t["Connecting to OpenCode…"]
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
                    // Command palette arrives with the business logic; the
                    // button stays in place so the chrome is final.
                    onOpenCommandPalette={() => {}}
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
                            glass shows through. */}
                        <div
                            className="w-full h-full"
                            style={contentBg ? {background: contentBg} : undefined}
                        >
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
                                        className="w-full h-full"
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
                                            agent={effectiveAgent}
                                            model={effectiveModel}
                                            onAgentChange={changeAgent}
                                            onModelChange={changeModel}
                                            directory={activeSession.directory ?? activeSession.location?.directory ?? null}
                                            onDirectoryChange={changeDirectory}
                                            usage={activeUsage}
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
                                        agent={effectiveAgent}
                                        model={effectiveModel}
                                        onAgentChange={changeAgent}
                                        onModelChange={changeModel}
                                        api={api}
                                        directory={pendingDirectory}
                                        onDirectoryChange={changeDirectory}
                                    />
                                )}
                            </AnimatePresence>
                        </div>
                    </MaskedSurface>
                </div>
            </div>
            {/* Linux window outline: some desktop environments draw no
                compositor shadow, so the borderless window's edge is
                invisible against a matching wallpaper. An inset box-shadow
                overlay (not border/outline) — no layout shift, follows the
                rounded corners, and paints above the content which would
                otherwise cover a container-edge line. Hidden when maximized
                like the rounded-lg above. */}
            <AnimatePresence>
                {isLinux() && !isMaximized && (
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
