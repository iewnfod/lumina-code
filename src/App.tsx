import {useCallback, useEffect, useMemo, useState} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {error} from "@tauri-apps/plugin-log";
import TitleBar from "./components/TitleBar.tsx";
import SessionBar, {type ConnectionState, type SessionInfo} from "./components/SessionBar.tsx";
import ChatPlaceholder from "./components/ChatPlaceholder.tsx";
import ChatView from "./components/chat/ChatView.tsx";
import ChatInput from "./components/chat/ChatInput.tsx";
import MaskedSurface from "./components/ui/MaskedSurface.tsx";
import {useMaximized} from "./hooks/maximized.ts";
import {usePaddingOffset} from "./hooks/paddingOffset.ts";
import {useDragRegionDoubleClick} from "./hooks/useDragRegionDoubleClick.ts";
import {useGlass} from "./hooks/useGlass.ts";
import {useSurfaceColors} from "./hooks/surfaceColors.ts";
import {useSystemTheme} from "./hooks/useSystemTheme.ts";
import {useI18n} from "./hooks/i18n.tsx";
import {glassSurface, windowOutline} from "./lib/glass.ts";
import {isLinux} from "./lib/platform.ts";
import {appThemeFor} from "./lib/theme.ts";
import {useOpencode} from "./opencode/useOpencode.ts";
import {useSessions} from "./opencode/useSessions.ts";
import {useModelCatalog} from "./opencode/useModelCatalog.ts";
import type {ComposerAttachment, SessionModelRef} from "./opencode/types.ts";

/**
 * Layout shell, ported from lumina-terminal's App.tsx: outer transparent
 * window frame with rounded corners, then SessionBar (left glass sidebar) +
 * TitleBar over a MaskedSurface content area that exposes the chrome glass
 * layer through its rounded corners.
 *
 * The sidebar mirrors the OpenCode server's session list (live-patched from
 * the event bus); the content area shows the active session's conversation,
 * streaming in real time.
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
    const chromeGlass = useMemo(
        () => glassSurface(effectiveBg, supportsGlass, {blurPx: 16}),
        [effectiveBg, supportsGlass],
    );
    // Surface colors for the welcome-screen composer (ChatView derives its
    // own internally).
    const composerColors = useSurfaceColors(effectiveBg);

    // --- OpenCode connection, session list, active conversation ---
    const {status: connectionStatus, api, subscribe} = useOpencode();
    const {sessions, busyIds, create, remove, patch} = useSessions(api, subscribe);
    const {models, agents, defaultModel} = useModelCatalog(api);
    const [activeId, setActiveId] = useState<string | null>(null);
    const busy = activeId !== null && busyIds.has(activeId);
    const activeSession = sessions.find((s) => s.id === activeId) ?? null;
    const connected = connectionStatus.state === "connected";

    // --- Composer selections ---
    // Once a session exists, its model/agent drive the composer and changes
    // hit the switch endpoints (optimistically patched into the list).
    // Before that, pending* state rides along into the session we create on
    // the first send — including the working directory.
    const [pendingModel, setPendingModel] = useState<SessionModelRef | null>(null);
    const [pendingAgent, setPendingAgent] = useState<string | null>(null);
    const [pendingDirectory, setPendingDirectory] = useState<string | null>(null);

    // Preselect the server's default model when it survived the catalog
    // filter; otherwise the first (newest-first) own model. None until the
    // catalog loads.
    const fallbackModel = useMemo(() => {
        const inCatalog = defaultModel
            ? models.some(
                (m) => m.providerID === defaultModel.providerID && m.modelID === defaultModel.modelID,
            )
            : false;
        const chosen = inCatalog ? defaultModel : models[0];
        return chosen
            ? {id: chosen.modelID, providerID: chosen.providerID, variant: chosen.variants?.[0]?.id}
            : null;
    }, [defaultModel, models]);
    const effectiveModel = activeSession?.model ?? pendingModel ?? fallbackModel;
    const effectiveAgent = activeSession?.agent ?? pendingAgent ?? agents[0]?.id ?? "build";

    const changeModel = useCallback((ref: SessionModelRef) => {
        if (activeId) {
            patch(activeId, {model: ref});
            api?.switchModel(activeId, ref).catch((e) => {
                error(`Failed to switch model: ${e}`).catch(() => {});
            });
        } else {
            setPendingModel(ref);
        }
    }, [activeId, api, patch]);

    const changeAgent = useCallback((id: string) => {
        if (activeId) {
            patch(activeId, {agent: id});
            api?.switchAgent(activeId, id).catch((e) => {
                error(`Failed to switch agent: ${e}`).catch(() => {});
            });
        } else {
            setPendingAgent(id);
        }
    }, [activeId, api, patch]);

    const newSession = useCallback(async (directory?: string) => {
        const created = await create(directory);
        if (created) setActiveId(created.id);
    }, [create]);

    /** First send from the welcome screen: create the session (in the chosen
     *  directory), apply the staged model/agent, then deliver the prompt. */
    const sendFirst = useCallback(async (text: string, files: ComposerAttachment[]) => {
        if (!api) return;
        const created = await create(pendingDirectory ?? undefined);
        if (!created) return;
        if (pendingModel) {
            await api.switchModel(created.id, pendingModel).catch((e) => {
                error(`Failed to switch model: ${e}`).catch(() => {});
            });
        }
        if (pendingAgent) {
            await api.switchAgent(created.id, pendingAgent).catch((e) => {
                error(`Failed to switch agent: ${e}`).catch(() => {});
            });
        }
        setActiveId(created.id);
        await api.sendPrompt(
            created.id,
            text,
            files.map((f) => ({uri: f.uri, name: f.name})),
        ).catch((e) => {
            error(`Failed to send prompt: ${e}`).catch(() => {});
        });
    }, [api, create, pendingAgent, pendingDirectory, pendingModel]);

    const deleteSession = useCallback((id: string) => {
        void remove(id);
        setActiveId((cur) => (cur === id ? null : cur));
    }, [remove]);

    const sessionInfos: SessionInfo[] = useMemo(
        () =>
            sessions.map((s) => ({
                id: s.id,
                name: s.title?.trim() || "Untitled",
                directory: s.directory ?? s.location?.directory,
            })),
        [sessions],
    );

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

    const connection: ConnectionState = connectionStatus.state === "connecting"
        ? {state: "connecting", label: t["Connecting to OpenCode…"]}
        : connectionStatus.state === "connected"
            ? {state: "connected", label: `OpenCode v${connectionStatus.version}`}
            : {state: "error", label: t["Connection error"], detail: connectionStatus.message};

    const placeholderSubtitle = connectionStatus.state === "connecting"
        ? t["Connecting to OpenCode…"]
        : connectionStatus.state === "error"
            ? connectionStatus.message
            : t["Create a session to start"];

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
                connection={connection}
                busyIds={busyIds}
            />
            <div className="flex-1 flex flex-col min-w-0">
                <TitleBar
                    theme={effectiveTheme}
                    title={activeSession ? activeSession.title?.trim() || "Untitled" : null}
                    // Command palette + settings arrive with the business
                    // logic; the buttons stay in place so the chrome is final.
                    onOpenCommandPalette={() => {}}
                    onOpenSettings={() => {}}
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
                            {activeSession ? (
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
                                />
                            ) : (
                                <div className="flex flex-col h-full w-full">
                                    <ChatPlaceholder
                                        foregroundColor={effectiveFg}
                                        subtitle={placeholderSubtitle}
                                    />
                                    <div className="shrink-0 max-w-3xl mx-auto w-full px-6 pb-4">
                                        <ChatInput
                                            colors={composerColors}
                                            disabled={!connected}
                                            busy={false}
                                            onSend={(text, files) => void sendFirst(text, files)}
                                            onInterrupt={() => {}}
                                            agents={agents}
                                            models={models}
                                            agent={effectiveAgent}
                                            model={effectiveModel}
                                            onAgentChange={changeAgent}
                                            onModelChange={changeModel}
                                            sessionStarted={false}
                                            api={api}
                                            directory={pendingDirectory}
                                            onDirectoryChange={setPendingDirectory}
                                        />
                                    </div>
                                </div>
                            )}
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
            {isLinux() && !isMaximized && (
                <div
                    aria-hidden
                    className="absolute inset-0 rounded-lg pointer-events-none"
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
