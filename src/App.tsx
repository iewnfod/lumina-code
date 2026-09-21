import {useCallback, useEffect, useMemo, useState} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {info, error} from "@tauri-apps/plugin-log";
import TitleBar from "./components/TitleBar.tsx";
import SessionBar, {type ConnectionState, type SessionInfo} from "./components/SessionBar.tsx";
import ChatPlaceholder from "./components/ChatPlaceholder.tsx";
import MaskedSurface from "./components/ui/MaskedSurface.tsx";
import {useMaximized} from "./hooks/maximized.ts";
import {usePaddingOffset} from "./hooks/paddingOffset.ts";
import {useDragRegionDoubleClick} from "./hooks/useDragRegionDoubleClick.ts";
import {useGlass} from "./hooks/useGlass.ts";
import {useSystemTheme} from "./hooks/useSystemTheme.ts";
import {useI18n} from "./hooks/i18n.tsx";
import {glassSurface, windowOutline} from "./lib/glass.ts";
import {isLinux} from "./lib/platform.ts";
import {appThemeFor} from "./lib/theme.ts";
import {useOpencode} from "./opencode/useOpencode.ts";
import type {Session} from "./opencode/api.ts";

/**
 * Layout shell, ported from lumina-terminal's App.tsx: outer transparent
 * window frame with rounded corners, then SessionBar (left glass sidebar) +
 * TitleBar over a MaskedSurface content area that exposes the chrome glass
 * layer through its rounded corners.
 *
 * Sessions are OpenCode sessions (via the SDK client from useOpencode): the
 * sidebar shows the OPEN sessions (like tabs); closing a row only removes it
 * from view — the OpenCode session data itself is never deleted here.
 */

function InnerApp({isMaximized}: {isMaximized: boolean}) {
    const t = useI18n();
    // Effective theme: lumina-terminal derives this from the active
    // terminal's palette; lumina-code follows the system light/dark with the
    // same neutral bases (see lib/theme.ts).
    const systemTheme = useSystemTheme();
    const {theme: effectiveTheme, bg: effectiveBg, fg: effectiveFg, dark} = appThemeFor(systemTheme);

    // Glass material filling the content area. The chat surface is clipped to
    // a rounded rectangle; its four corners are transparent, exposing this
    // chrome layer beneath — so the chrome reads as a continuous frame
    // wrapping the content with rounded inner corners.
    const {supportsGlass} = useGlass();
    const chromeGlass = useMemo(
        () => glassSurface(effectiveBg, supportsGlass, {blurPx: 16}),
        [effectiveBg, supportsGlass],
    );

    // --- OpenCode connection + open-session ("tab") state ---
    const {status: connectionStatus, api, subscribe} = useOpencode();
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [sidebarVisible, setSidebarVisible] = useState(true);
    const toggleSidebar = useCallback(() => {
        setSidebarVisible((v) => !v);
    }, []);

    const newSession = useCallback(async () => {
        if (!api) return;
        try {
            const created = await api.createSession({});
            setSessions((prev) => [
                ...prev,
                {id: created.id, name: created.title?.trim() || `Session ${prev.length + 1}`},
            ]);
            setActiveId(created.id);
            info(`OpenCode session created: ${created.id}`).catch(() => {});
        } catch (e) {
            error(`Failed to create OpenCode session: ${e}`).catch(() => {});
        }
    }, [api]);

    const closeSession = useCallback((id: string) => {
        // Removes the row from the sidebar only — the OpenCode session and
        // its history stay intact (re-openable once the session browser
        // lands).
        setSessions((prev) => prev.filter((s) => s.id !== id));
        setActiveId((cur) => (cur === id ? null : cur));
    }, []);

    // Keep sidebar titles live: OpenCode retitles sessions as the
    // conversation develops (the session.updated frame carries the fresh
    // Session under its `data` field).
    useEffect(() => {
        return subscribe((event) => {
            if (event.type !== "session.updated") return;
            const updated = (event.data as {info?: Session} | null)?.info;
            if (!updated) return;
            setSessions((prev) =>
                prev.some((s) => s.id === updated.id)
                    ? prev.map((s) =>
                        s.id === updated.id
                            ? {...s, name: updated.title?.trim() || s.name, subtitle: s.subtitle}
                            : s,
                    )
                    : prev,
            );
        });
    }, [subscribe]);

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

    const activeSession = sessions.find((s) => s.id === activeId) ?? null;

    const connection: ConnectionState = connectionStatus.state === "connecting"
        ? {state: "connecting", label: t["Connecting to OpenCode…"]}
        : connectionStatus.state === "connected"
            ? {state: "connected", label: `OpenCode v${connectionStatus.version}`}
            : {state: "error", label: t["Connection error"], detail: connectionStatus.message};

    const placeholderSubtitle = connectionStatus.state === "connecting"
        ? t["Connecting to OpenCode…"]
        : connectionStatus.state === "error"
            ? connectionStatus.message
            : (activeSession?.name ?? t["Create a session to start"]);

    return (
        <div
            className="relative w-full h-full overflow-hidden flex flex-row"
            style={{background: effectiveBg}}
        >
            <SessionBar
                sessions={sessions}
                activeId={activeId}
                onSelect={setActiveId}
                onClose={closeSession}
                onNew={newSession}
                backgroundColor={effectiveBg}
                foregroundColor={effectiveFg}
                collapsed={!sidebarVisible}
                brandTitle="Lumina Code"
                connection={connection}
            />
            <div className="flex-1 flex flex-col min-w-0">
                <TitleBar
                    theme={effectiveTheme}
                    tabBarVisible={sidebarVisible}
                    onToggleTabBar={toggleSidebar}
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
                        <ChatPlaceholder
                            foregroundColor={effectiveFg}
                            subtitle={placeholderSubtitle}
                        />
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
