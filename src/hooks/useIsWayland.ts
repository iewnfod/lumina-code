import {useEffect, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {error} from "@tauri-apps/plugin-log";

// Module-level cache: the session type never changes during an app run, so we
// resolve the backend `is_wayland` call once and reuse the result for every
// caller. Ported as-is from lumina-terminal.

let cached: boolean | null = null;
let pending: Promise<boolean> | null = null;

/**
 * True when the app is running under a Wayland session.
 */
export function useIsWayland(): boolean {
    const [isWayland, setIsWayland] = useState<boolean>(cached ?? false);

    useEffect(() => {
        if (cached !== null) {
            setIsWayland(cached);
            return;
        }
        if (!pending) {
            pending = invoke<boolean>("is_wayland")
                .then((result) => {
                    cached = result;
                    return result;
                })
                .catch((e) => {
                    // Fall back to false (assume not Wayland) so features stay
                    // visible rather than vanishing on a probe failure.
                    error(`Failed to probe Wayland session: ${e}`).catch(() => {});
                    cached = false;
                    return false;
                });
        }
        pending.then(setIsWayland);
    }, []);

    return isWayland;
}
