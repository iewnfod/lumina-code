import {error as logError} from "@tauri-apps/plugin-log";

/**
 * Clipboard write with a legacy fallback for webviews without the async
 * Clipboard API. Returns whether the text made it out; both paths failing
 * is logged — a silent failure would read as a dead copy button.
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        let ok = false;
        try {
            ok = document.execCommand("copy");
        } catch {
            // stays false
        }
        area.remove();
        if (!ok) {
            logError("Clipboard write failed (async API and execCommand fallback)").catch(() => {});
        }
        return ok;
    }
}
