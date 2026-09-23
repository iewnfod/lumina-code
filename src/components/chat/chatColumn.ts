/**
 * The conversation column's responsive width cap + side gutters.
 *
 * The transcript + composer column (ChatView) and the welcome screen's
 * composer share one width cap so surfaces don't jump when a session is
 * created or dropped. The cap is TIERED, not fluid: a fixed cap keeps
 * line lengths readable, and the wide tier only engages when the content
 * area affords the wider cap plus comfortable margins on both sides —
 * below that the column stays at the base cap and centers.
 *
 * The side gutters are tiered to the same signal: once the column
 * reaches its cap the centered leftover margins frame it, so the
 * gutters stay compact; below the cap the column spans the full content
 * area and its fixed gutters are the ONLY breathing room from the chrome
 * edges, so they widen. The roomy width (3rem) matches the welcome
 * screen's former stacked p-6 + px-6, so the composer stays put across
 * the welcome → session swap at EVERY window width, not just capped
 * ones. statsLayout.ts assumes the compact gutters whenever a stats
 * panel docks — safe, because docking needs far more width than the
 * base cap the roomy gutters live below.
 *
 * Consumers measure their view root (useChatColumnWidth) — the region
 * beside the sidebar, NOT the window — and pass border-box width here so
 * the tier tracks the space the column actually has. Border-box on
 * purpose: the stats card's docked lane (padding-right on the same root)
 * must not flap the tier while a detail panel docks; the column narrows
 * within its cap through the elastic lane instead (stats/statsLayout.ts).
 *
 * All constants are rem so the thresholds scale with the user's
 * typography zoom (root font size) like the stats-lane math does.
 */

/** Base cap (the old `max-w-3xl`) — every window gets at least this. */
export const CHAT_COLUMN_CAP_REM = 48;
/** Wide-window cap (`max-w-5xl` territory) for reading wide code/diffs. */
export const CHAT_COLUMN_WIDE_CAP_REM = 64;
/** Spare width required PER SIDE before the wide tier engages. */
const WIDE_MARGIN_REM = 8;
/** Side gutter while the column reaches its cap (the old `px-6`) — the
 *  centered leftover margins frame the column, so compact is enough. */
export const CHAT_COLUMN_SIDE_PAD_REM = 1.5;
/** Side gutter while the column CANNOT reach its cap — the fixed
 *  gutters are the only breathing room from the chrome edges. */
export const CHAT_COLUMN_ROOMY_SIDE_PAD_REM = 3;

/**
 * Pick the column's max-width cap for the current container.
 *
 * @param containerWidth The view root's border-box width in px.
 * @param remPx Current px-per-rem (root font size), for zoom scaling.
 */
export function chatColumnCapRem(containerWidth: number, remPx: number): number {
    if (remPx <= 0) return CHAT_COLUMN_CAP_REM;
    const wideAt = (CHAT_COLUMN_WIDE_CAP_REM + 2 * WIDE_MARGIN_REM) * remPx;
    return containerWidth >= wideAt ? CHAT_COLUMN_WIDE_CAP_REM : CHAT_COLUMN_CAP_REM;
}

/**
 * Pick the column's side gutter for the current container: roomy while
 * the column cannot reach its cap (it spans the full width, so the
 * gutters are the only edge breathing room), compact once capped.
 *
 * Same border-box containerWidth + remPx contract as chatColumnCapRem.
 */
export function chatColumnSidePadRem(containerWidth: number, remPx: number): number {
    if (remPx <= 0) return CHAT_COLUMN_ROOMY_SIDE_PAD_REM;
    const capPx = chatColumnCapRem(containerWidth, remPx) * remPx;
    return containerWidth >= capPx ? CHAT_COLUMN_SIDE_PAD_REM : CHAT_COLUMN_ROOMY_SIDE_PAD_REM;
}
