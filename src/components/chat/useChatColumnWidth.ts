import {useEffect, useMemo, useRef, useState} from "react";
import type {CSSProperties, RefObject} from "react";
import {
    CHAT_COLUMN_CAP_REM,
    CHAT_COLUMN_ROOMY_SIDE_PAD_REM,
    chatColumnCapRem,
    chatColumnSidePadRem,
} from "./chatColumn.ts";

/**
 * Responsive width cap + side gutters for the conversation column
 * (components/chat/chatColumn.ts): measures the view root it is attached
 * to and exposes the column style carrying the current cap and padding.
 *
 * - Border-box offsetWidth on purpose: the stats card's docked lane is a
 *   padding-right on the same root, and offsetWidth is stable under it —
 *   the observer neither flaps the tier mid-dock nor feeds back into the
 *   lane's animated padding (same trick as SessionStatsCard's observer).
 *   A docked lane can narrow the column below its cap while the hook
 *   still reports capped — keeping the compact gutters, which is exactly
 *   what statsLayout's dock math assumes.
 * - State only moves on threshold crossings (the wide tier and the
 *   capped/uncapped gutter flip), so resizes within a tier don't
 *   re-render; the change itself snaps like the stats lane's
 *   resize-driven replans (animating resize reads as rubber-banding).
 * - rem is read per measurement so the thresholds track the typography
 *   zoom; a zoom change with no following resize event stays stale until
 *   the next fire — the same accepted limit as statsLayout's remPx.
 */
export function useChatColumnWidth(): {
    ref: RefObject<HTMLDivElement | null>;
    style: CSSProperties;
} {
    const ref = useRef<HTMLDivElement>(null);
    const [tier, setTier] = useState({
        capRem: CHAT_COLUMN_CAP_REM,
        padRem: CHAT_COLUMN_ROOMY_SIDE_PAD_REM,
    });

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => {
            const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            const capRem = chatColumnCapRem(el.offsetWidth, remPx);
            const padRem = chatColumnSidePadRem(el.offsetWidth, remPx);
            setTier((prev) =>
                prev.capRem === capRem && prev.padRem === padRem ? prev : {capRem, padRem},
            );
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const style = useMemo(
        () => ({
            maxWidth: `${tier.capRem}rem`,
            paddingLeft: `${tier.padRem}rem`,
            paddingRight: `${tier.padRem}rem`,
        }),
        [tier],
    );
    return {ref, style};
}
