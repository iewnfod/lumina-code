import {LucideMaximize, LucideMinimize, LucideMinus, LucideX} from "lucide-react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {info, error} from "@tauri-apps/plugin-log";
import IconButton from "./IconButton.tsx";

/**
 * The platform window controls (minimize / maximize-restore / close),
 * non-macOS layout. Ported from lumina-terminal's TitleBar along with the
 * rest of the chrome.
 */
export default function WindowControl({size, isMaximized, hoverOverlay, activeOverlay, closeHover, fg}: {
    size: number;
    isMaximized: boolean;
    hoverOverlay: string;
    activeOverlay: string;
    /** Brand-tinted wash for the close button on hover. */
    closeHover: string;
    fg: string;
}) {
    const handleMinimize = () => {
        info("Window minimized");
        getCurrentWindow().minimize().catch((e) => {
            error(`Failed to minimize window: ${e}`).catch(() => {});
        });
    }

    const handleMaximize = () => {
        info("Window maximized");
        getCurrentWindow().maximize().catch((e) => {
            error(`Failed to maximize window: ${e}`).catch(() => {});
        });
    }

    const handleUnmaximize = () => {
        info("Window unmaximized");
        getCurrentWindow().unmaximize().catch((e) => {
            error(`Failed to unmaximize window: ${e}`).catch(() => {});
        });
    }

    const handleClose = () => {
        info("Window close requested");
        getCurrentWindow().close().catch((e) => {
            error(`Failed to close window: ${e}`).catch(() => {});
        });
    }

    return (
        <div className="flex flex-row justify-end items-center" style={{height: size}}>
            <IconButton
                size={size}
                hoverOverlay={hoverOverlay}
                activeOverlay={activeOverlay}
                style={{color: fg, borderRadius: 0}}
                onClick={handleMinimize}
            >
                <LucideMinus size={16}/>
            </IconButton>
            {isMaximized ? (
                <IconButton
                    size={size}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg, borderRadius: 0}}
                    onClick={handleUnmaximize}
                >
                    <LucideMinimize size={16}/>
                </IconButton>
            ) : (
                <IconButton
                    size={size}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg, borderRadius: 0}}
                    onClick={handleMaximize}
                >
                    <LucideMaximize size={16}/>
                </IconButton>
            )}
            <IconButton
                size={size}
                hoverOverlay={closeHover}
                activeOverlay={closeHover}
                style={{color: fg, borderRadius: 0}}
                onClick={handleClose}
            >
                <LucideX size={16}/>
            </IconButton>
        </div>
    );
}
