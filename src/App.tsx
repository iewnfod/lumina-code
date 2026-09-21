import {useCallback, useEffect, useMemo, useState} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {info, error} from "@tauri-apps/plugin-log";
import TitleBar from "./components/TitleBar.tsx";
import SessionBar, {type SessionInfo} from "./components/SessionBar.tsx";
import ChatPlaceholder from "./components/ChatPlaceholder.tsx";
import MaskedSurface from "./components/ui/MaskedSurface.tsx";
import {useMaximized} from "./hooks/maximized.ts";
import {usePaddingOffset} from "./hooks/paddingOffset.ts";
import {useDragRegionDoubleClick} from "./hooks/useDragRegionDoubleClick.ts";
import {useGlass} from "./hooks/useGlass.ts";
import {useSystemTheme} from "./hooks/useSystemTheme.ts";
import {glassSurface, windowOutline} from "./lib/glass.ts";
import {isLinux} from "./lib/platform.ts";
import {appThemeFor} from "./lib/theme.ts";

/**
 * Layout shell, ported from lumina-terminal's App.tsx: outer transparent
 * window frame with rounded corners, then SessionBar (left glass sidebar) +
 * TitleBar over a MaskedSurface content area that exposes the chrome glass
 * layer through its rounded corners. The terminal pipeline (profiles, PTYs,
 * TUI edge-color spread, tear-off) is replaced by a placeholder session list
 * until the OpenCode business logic lands.
 */

let sessionCounter = 0;

function InnerApp({isMaximized}: {isMaximized: boolean}) {
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

    // --- Placeholder session state (replaced by the OpenCode session store) ---
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [sidebarVisible, setSidebarVisible] = useState(true);
    const toggleSidebar = useCallback(() => {
        setSidebarVisible((v) => !v);
    }, []);

    const newSession = useCallback(() => {
        sessionCounter += 1;
        const id = `session-${sessionCounter}`;
        setSessions((prev) => [...prev, {id, name: `Session ${sessionCounter}`}]);
        setActiveId(id);
        info(`Session created: ${id}`).catch(() => {});
    }, []);

    const closeSession = useCallback((id: string) => {
        setSessions((prev) => prev.filter((s) => s.id !== id));
        setActiveId((cur) => (cur === id ? null : cur));
        info(`Session closed: ${id}`).catch(() => {});
    }, []);

    // The window is created hidden (tauri.conf.json `visible: false`) and
    // shown once the first paint is ready — same pattern as lumina-terminal,
    // minus the window-size decision (no terminal grid to measure here).
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
                            sessionName={activeSession?.name}
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
