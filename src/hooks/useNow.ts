import {useEffect, useState} from "react";

/** A ticking "now" (epoch ms) for relative-age labels: re-renders the
 *  caller every `intervalMs` while `active`, so minute-resolution ages
 *  stay fresh without churning the list per second. The initial value is
 *  read once per mount (not per effect run). */
export function useNow(intervalMs: number, active = true): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(timer);
    }, [intervalMs, active]);
    return now;
}
