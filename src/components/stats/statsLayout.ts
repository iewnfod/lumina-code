/**
 * Pure layout planning for the session-stats card's DOCKED detail mode.
 *
 * In a detail view (file diff / terminal / subagent transcript) the panel
 * wants to be wider than the floating card. When the conversation column
 * can spare the width, the card DOCKS: it widens and reserves a right
 * lane (padding-right on ChatView's root) so the `max-w-3xl mx-auto`
 * column re-centers in the remaining space instead of being covered.
 * Below the crossover the card keeps the overlay behavior (float over
 * the column, exactly today's layout).
 *
 * The panel is ELASTIC: it shrinks toward its minimum before giving up,
 * so the dock/overlay boundary is continuous rather than a jump — and
 * because the column is capped at max-w-3xl, wide windows dock with ZERO
 * text reflow (the column only re-centers; medium windows narrow it a
 * little, never below the readable floor).
 *
 * All rem constants scale with the root font size (user zoom), so the
 * caller passes the current px-per-rem.
 */

export interface StatsLanePlan {
    mode: "dock" | "overlay";
    /** Docked panel width in px (0 in overlay). */
    panelWidth: number;
    /** Reserved right lane in px (0 in overlay) — applied as
     *  padding-right on ChatView's root. */
    laneWidth: number;
}

/** Preferred detail-panel width (the cap; the panel shrinks below it). */
const PANEL_WIDE_REM = 40;
/** Below this the card overlays instead of docking (today's width). */
const PANEL_MIN_REM = 26;
/** The conversation column never narrows past this while docked. */
const COLUMN_FLOOR_REM = 36;
/** The column's own px-6 gutters (both sides). */
const COLUMN_PAD_REM = 3;
/** The card's right-4 offset (fixed px, not rem-scaled). */
const CARD_RIGHT_PX = 16;
/** Breathing room between the column's edge and the docked panel. */
const LANE_GAP_PX = 12;

const OVERLAY: StatsLanePlan = {mode: "overlay", panelWidth: 0, laneWidth: 0};

/**
 * Decide dock vs overlay for the current container width.
 *
 * @param containerWidth ChatView root width in px (border-box — stable
 *        under the lane's own padding-right).
 * @param remPx Current px-per-rem (root font size), for zoom scaling.
 * @param detail Whether a detail view is showing (expanded && not the
 *        overview list) — the only state that docks.
 */
export function planStatsLayout(containerWidth: number, remPx: number, detail: boolean): StatsLanePlan {
    if (!detail || remPx <= 0) return OVERLAY;
    // Width the conversation can spare: everything left after the column
    // keeps its floor + gutters, minus the card's right offset and gap.
    const budget =
        containerWidth - (COLUMN_FLOOR_REM + COLUMN_PAD_REM) * remPx - CARD_RIGHT_PX - LANE_GAP_PX;
    if (budget < PANEL_MIN_REM * remPx) return OVERLAY;
    // Elastic: take the full preferred width only when affordable.
    const panelWidth = Math.floor(Math.min(budget, PANEL_WIDE_REM * remPx));
    return {mode: "dock", panelWidth, laneWidth: panelWidth + CARD_RIGHT_PX + LANE_GAP_PX};
}
