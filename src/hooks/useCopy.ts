import {useCallback, useEffect, useRef, useState} from "react";
import {copyText} from "../lib/clipboard.ts";

/** How long the ✓ confirmation lingers before reverting to the copy icon. */
const COPIED_RESET_MS = 2000;

/**
 * Copy-affordance state shared by the run footer and the user bubble:
 * `copied` flips true when a write lands and resets after a short linger,
 * so the ✓ stays legible even after the pointer leaves the row.
 */
export function useCopy() {
    const [copied, setCopied] = useState(false);
    const resetTimer = useRef<number>(0);

    // A pending reset must never outlive the caller.
    useEffect(() => () => window.clearTimeout(resetTimer.current), []);

    const copy = useCallback(async (text: string) => {
        if (!(await copyText(text))) return;
        setCopied(true);
        window.clearTimeout(resetTimer.current);
        resetTimer.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    }, []);

    return {copied, copy};
}
